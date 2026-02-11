import type {
  LeadStatus,
  Task,
  Team,
  TeamConfig,
  TeamStatus,
  Teammate,
  TeammateStatus,
} from "./types.js";
import { loadConfig } from "../../config/config.js";
import { onAgentEvent } from "../../infra/agent-events.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { setCommandLaneConcurrency } from "../../process/command-queue.js";
import { CommandLane } from "../../process/lanes.js";
import {
  CHORE_TEAMMATE_ID,
  ensureChoreTeammate,
  PR_REVIEWER_TEAMMATE_ID,
  ensurePrReviewerTeammate,
  startChoreWatcher,
  stopAllChoreWatchers,
  stopChoreWatcher,
} from "./chore-watch.js";
import { resolvePrimaryContextTaskId } from "./task-context.js";
import { addTask, claimTask, listTasks } from "./task-list.js";
import {
  TASK_BROADCAST_ANSWER,
  TASK_INIT,
  TASK_LEAD_REVIEW,
  TASK_REVIEW_QUESTION,
  isQuestionRequestTitle,
} from "./task-taxonomy.js";
import { deleteTeamFromDisk, loadAllTeamsFromDisk, saveTeamToDisk } from "./team-registry.store.js";
import {
  LEAD_STATUS_IDLE,
  LEAD_STATUS_WORKING,
  TEAMMATE_STATUS_INIT,
  TEAMMATE_STATUS_IDLE,
  TEAMMATE_STATUS_WORKING,
  TEAMMATE_STATUS_FAILED,
} from "./types.js";

// In-memory state
const activeTeams = new Map<string, Team>();
const runIdToTeammate = new Map<string, { teamId: string; teammateId: string }>();
const runIdToLead = new Map<string, string>();
let listenerStarted = false;
let listenerStop: (() => void) | null = null;
const idleClaimTimers = new Map<string, NodeJS.Timeout>();
const lastLeadDispatchTaskId = new Map<string, string>();
// Use var to avoid TDZ when init runs across circular imports during bootstrap.
var restoreAttempted = false;

// 3 Hz idle-claim heartbeat (override via OPENCLAW_TEAM_IDLE_CLAIM_MS).
const DEFAULT_IDLE_CLAIM_MS = 333;

function getIdleClaimIntervalMs(): number {
  const raw = Number(process.env.OPENCLAW_TEAM_IDLE_CLAIM_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_IDLE_CLAIM_MS;
}

function idleClaimKey(teamId: string, teammateId: string): string {
  return `${teamId}:${teammateId}`;
}

function stopIdleClaimHeartbeat(teamId: string, teammateId: string): void {
  const key = idleClaimKey(teamId, teammateId);
  const timer = idleClaimTimers.get(key);
  if (timer) {
    clearInterval(timer);
    idleClaimTimers.delete(key);
  }
}

function startIdleClaimHeartbeat(teamId: string, teammateId: string): void {
  const key = idleClaimKey(teamId, teammateId);
  if (idleClaimTimers.has(key)) {
    return;
  }
  const intervalMs = getIdleClaimIntervalMs();
  const timer = setInterval(() => {
    const team = activeTeams.get(teamId);
    const teammate = team?.teammates[teammateId];
    if (!team || !teammate || teammate.status !== TEAMMATE_STATUS_IDLE) {
      stopIdleClaimHeartbeat(teamId, teammateId);
      return;
    }
    const claimed = autoClaimNextTaskForTeammate(teamId, teammateId);
    if (claimed) {
      stopIdleClaimHeartbeat(teamId, teammateId);
    }
  }, intervalMs);
  idleClaimTimers.set(key, timer);
}

function clearIdleClaimTimersForTeam(teamId: string): void {
  for (const key of idleClaimTimers.keys()) {
    if (key.startsWith(`${teamId}:`)) {
      const timer = idleClaimTimers.get(key);
      if (timer) {
        clearInterval(timer);
      }
      idleClaimTimers.delete(key);
    }
  }
}

function normalizeTeamId(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
  return normalized || "team";
}

function resolveTeamIdFromName(teamName: string): string {
  const base = normalizeTeamId(teamName);
  const existing = new Set<string>([
    ...activeTeams.keys(),
    ...Array.from(loadAllTeamsFromDisk().keys()),
  ]);
  if (!existing.has(base)) {
    return base;
  }
  for (let i = 1; i < 1000; i += 1) {
    const candidate = `${base}-${i}`;
    if (!existing.has(candidate)) {
      return candidate;
    }
  }
  return `${base}-${Date.now()}`;
}

function isTeamOpenStatus(status: TeamStatus): boolean {
  return status !== "idle";
}

function isTeamWorkingStatus(status: TeamStatus): boolean {
  return status === "working";
}

const PRIORITY_ORDER = { critical: 4, high: 3, normal: 2, low: 1 } as const;

function sortByPriorityThenCreated(a: Task, b: Task): number {
  const aPriority = PRIORITY_ORDER[a.priority];
  const bPriority = PRIORITY_ORDER[b.priority];
  if (aPriority !== bPriority) {
    return bPriority - aPriority;
  }
  if (a.createdAt !== b.createdAt) {
    return a.createdAt - b.createdAt;
  }
  return a.taskId.localeCompare(b.taskId);
}

function readTaskIdFromMetadata(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = metadata?.[key];
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  return undefined;
}

function readFirstTaskIdFromMetadataList(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = metadata?.[key];
  if (!Array.isArray(value)) {
    return undefined;
  }
  const first = value.find(
    (entry): entry is string => typeof entry === "string" && entry.length > 0,
  );
  return first;
}

function resolveTaskPrimaryContext(task: Task, allTasks: Task[]): string | undefined {
  const metadata = task.metadata;

  // Context for review tasks is derived at dispatch-time from the pointed task.
  if (task.title === TASK_LEAD_REVIEW || task.title === TASK_REVIEW_QUESTION) {
    const contextTaskId =
      readTaskIdFromMetadata(metadata, "context_task_id") ??
      readTaskIdFromMetadata(metadata, "source_task_id") ??
      readFirstTaskIdFromMetadataList(metadata, "taskIds") ??
      readFirstTaskIdFromMetadataList(metadata, "targetTaskIds");
    if (!contextTaskId) {
      return undefined;
    }
    return resolvePrimaryContextTaskId(contextTaskId, allTasks);
  }

  // qn_request primary context is derived from the pointed dependency task.
  if (isQuestionRequestTitle(task.title)) {
    const contextTaskId =
      readTaskIdFromMetadata(metadata, "prev_task_id") ??
      readTaskIdFromMetadata(metadata, "context_task_id") ??
      readTaskIdFromMetadata(metadata, "source_task_id");
    if (!contextTaskId) {
      return undefined;
    }
    return resolvePrimaryContextTaskId(contextTaskId, allTasks);
  }

  const fromMetadata = readTaskIdFromMetadata(metadata, "primary_context_task_id");
  if (fromMetadata) {
    return fromMetadata;
  }
  return resolvePrimaryContextTaskId(task.taskId, allTasks);
}

function formatContextSwitchMessage(task: Task, primaryContextTaskId?: string): string {
  const description = task.description ? `\nDescription: ${task.description}` : "";
  const contextLine = primaryContextTaskId
    ? `Primary context task: ${primaryContextTaskId}`
    : "Primary context task: none";
  return (
    `Task context switched.\n` +
    `Assigned task: "${task.title}" (taskId: ${task.taskId}).\n` +
    `${contextLine}.\n` +
    "Use only this primary context for task-specific reasoning." +
    `${description}`
  );
}

function recomputeTeamLaneConcurrency(): void {
  const totalMembers = Array.from(activeTeams.values())
    .filter((team) => isTeamOpenStatus(team.status))
    .reduce(
      (sum, team) => sum + 1 + Object.values(team.teammates).filter((tm) => !tm.isChore).length,
      0,
    );
  setCommandLaneConcurrency(CommandLane.Team, totalMembers > 0 ? totalMembers : 1);
}

function ensureSystemTeammates(team: Team): void {
  ensureChoreTeammate(team);
  ensurePrReviewerTeammate(team);
}

/**
 * Create a new team.
 * Uses teamName as teamId (with numeric prefix on collision).
 */
export function createTeam(params: {
  teamName: string;
  description?: string;
  creatorSessionKey?: string;
  teamAgentId?: string;
  leadSessionKey?: string;
  config: TeamConfig;
  persistent?: boolean;
  boundSessionKey?: string;
}): Team {
  const teamId = resolveTeamIdFromName(params.teamName);
  const teamAgentId = params.teamAgentId ?? `team-${teamId}`;
  const leadSessionKey = params.leadSessionKey ?? `agent:${teamAgentId}:lead`;
  const now = Date.now();
  const persistent = params.persistent ?? false; // default to false (auto-cleanup)

  const leadStatus = LEAD_STATUS_IDLE;

  const team: Team = {
    teamId,
    teamName: params.teamName,
    description: params.description,
    creatorSessionKey: params.creatorSessionKey,
    teamAgentId,
    leadSessionKey,
    status: "init",
    persistent,
    boundSessionKey: !persistent ? params.boundSessionKey : undefined,
    createdAt: now,
    updatedAt: now,
    teammates: {},
    config: params.config,
    leadStatus,
    answerBroadcasted: false,
  };

  ensureSystemTeammates(team);
  activeTeams.set(teamId, team);
  persistTeam(team);
  recomputeTeamLaneConcurrency();
  startChoreWatcher(teamId);

  return team;
}

/**
 * Get a team by ID.
 * Returns null if not found.
 */
export function getTeam(teamId: string): Team | null {
  return activeTeams.get(teamId) ?? null;
}

/**
 * List all active teams.
 */
export function listActiveTeams(): Team[] {
  return Array.from(activeTeams.values()).filter((team) => isTeamOpenStatus(team.status));
}

/**
 * List active teams created by a given session key.
 */
export function listCreatorTeams(creatorSessionKey: string): Team[] {
  return listActiveTeams().filter((team) => team.creatorSessionKey === creatorSessionKey);
}

/**
 * List all teams (any status).
 */
export function listAllTeams(): Team[] {
  return Array.from(activeTeams.values());
}

/**
 * Add a teammate to a team.
 * Resets the idle-notification guard so the lead can be re-notified
 * once this new teammate finishes.
 */
export function addTeammate(teamId: string, teammate: Teammate): void {
  const team = activeTeams.get(teamId);
  if (!team) {
    throw new Error(`Team ${teamId} not found`);
  }

  team.teammates[teammate.teammateId] = teammate;
  team.idleNotificationSent = false;
  team.updatedAt = Date.now();
  persistTeam(team);
  recomputeTeamLaneConcurrency();
  if (!teammate.isChore && teammate.status === TEAMMATE_STATUS_IDLE) {
    startIdleClaimHeartbeat(teamId, teammate.teammateId);
  }
}

/**
 * Remove a teammate from a team.
 */
export function removeTeammate(teamId: string, teammateId: string): void {
  const team = activeTeams.get(teamId);
  if (!team) {
    return;
  }
  if (teammateId === CHORE_TEAMMATE_ID || teammateId === PR_REVIEWER_TEAMMATE_ID) {
    return;
  }

  stopIdleClaimHeartbeat(teamId, teammateId);
  delete team.teammates[teammateId];
  team.updatedAt = Date.now();
  persistTeam(team);
  recomputeTeamLaneConcurrency();
}

/**
 * Update a teammate's status.
 */
export function updateTeammateStatus(
  teamId: string,
  teammateId: string,
  status: TeammateStatus,
): void {
  const team = activeTeams.get(teamId);
  if (!team) {
    return;
  }

  const teammate = team.teammates[teammateId];
  if (!teammate) {
    return;
  }

  teammate.status = status;
  team.updatedAt = Date.now();
  persistTeam(team);

  if (status === TEAMMATE_STATUS_IDLE) {
    startIdleClaimHeartbeat(teamId, teammateId);
  } else {
    stopIdleClaimHeartbeat(teamId, teammateId);
  }
}

export function setTeammateWorkspace(
  teamId: string,
  teammateId: string,
  workspaceDir: string,
): void {
  const team = activeTeams.get(teamId);
  if (!team) {
    return;
  }
  const teammate = team.teammates[teammateId];
  if (!teammate) {
    return;
  }
  teammate.workspaceDir = workspaceDir;
  team.updatedAt = Date.now();
  persistTeam(team);
}

export function setLeadWorkspace(teamId: string, workspaceDir: string): void {
  const team = activeTeams.get(teamId);
  if (!team) {
    return;
  }
  team.leadWorkspaceDir = workspaceDir;
  team.updatedAt = Date.now();
  persistTeam(team);
}

/**
 * Update a team's status.
 */
export function updateTeamStatus(teamId: string, status: TeamStatus): void {
  const team = activeTeams.get(teamId);
  if (!team) {
    return;
  }

  team.status = status;
  team.updatedAt = Date.now();
  persistTeam(team);
  if (status === "idle") {
    lastLeadDispatchTaskId.delete(teamId);
  }
  recomputeTeamLaneConcurrency();
}

/**
 * Transition a teammate to "idle" status when they have no current task.
 * This is called when a teammate completes a task and no new task is assigned.
 * Also allows transition from failure states back to idle for persistent teams.
 */
export function transitionTeammateToIdle(teamId: string, teammateId: string): void {
  const team = activeTeams.get(teamId);
  if (!team) {
    return;
  }

  const teammate = team.teammates[teammateId];
  if (!teammate) {
    return;
  }

  // Allow transition from "init", "working", or "failed" to "idle".
  if (
    teammate.status === TEAMMATE_STATUS_INIT ||
    teammate.status === TEAMMATE_STATUS_WORKING ||
    teammate.status === TEAMMATE_STATUS_FAILED
  ) {
    teammate.status = TEAMMATE_STATUS_IDLE;
    teammate.currentTask = undefined;
    teammate.currentTaskId = undefined;
    team.updatedAt = Date.now();
    persistTeam(team);
    const claimed = autoClaimNextTaskForTeammate(teamId, teammateId);
    if (!claimed) {
      startIdleClaimHeartbeat(teamId, teammateId);
    } else {
      stopIdleClaimHeartbeat(teamId, teammateId);
    }
  }
}

function autoClaimNextTaskForTeammate(teamId: string, teammateId: string): boolean {
  const team = activeTeams.get(teamId);
  if (!team) {
    return false;
  }
  const teammate = team.teammates[teammateId];
  if (!teammate || teammate.isChore) {
    return false;
  }

  let allTasks: Task[] = [];
  let readyTasks: ReturnType<typeof listTasks>["tasks"] = [];
  try {
    const { tasks } = listTasks(teamId, { includeCompleted: true });
    allTasks = tasks;
    readyTasks = tasks
      .filter((task) => task.assignee === teammateId && task.status === "pending")
      .toSorted(sortByPriorityThenCreated);
  } catch {
    return false;
  }

  const next = readyTasks[0];
  if (!next) {
    return false;
  }

  const claimResult = claimTask(teamId, { taskId: next.taskId, claimerId: teammateId });
  if (!claimResult.success || !claimResult.task) {
    return false;
  }

  teammate.status = TEAMMATE_STATUS_WORKING;
  teammate.currentTask = claimResult.task.title;
  teammate.currentTaskId = claimResult.task.taskId;
  teammate.claimedTasks++;
  team.updatedAt = Date.now();
  persistTeam(team);
  stopIdleClaimHeartbeat(teamId, teammateId);

  const primaryContextTaskId = resolveTaskPrimaryContext(claimResult.task, allTasks);
  enqueueSystemEvent(formatContextSwitchMessage(claimResult.task, primaryContextTaskId), {
    sessionKey: teammate.sessionKey,
  });

  return true;
}

export function dispatchLeadPendingTask(teamId: string): void {
  const team = activeTeams.get(teamId);
  if (!team || team.status === "idle") {
    return;
  }

  let nextLeadTask: Task | undefined;
  let allTasks: Task[] = [];
  try {
    const listed = listTasks(teamId, { includeCompleted: true }).tasks;
    allTasks = listed;
    nextLeadTask = listed
      .filter((task) => task.assignee === "lead" && task.status === "pending")
      .toSorted(sortByPriorityThenCreated)[0];
  } catch {
    return;
  }

  if (!nextLeadTask) {
    lastLeadDispatchTaskId.delete(teamId);
    return;
  }

  if (lastLeadDispatchTaskId.get(teamId) === nextLeadTask.taskId) {
    return;
  }

  const primaryContextTaskId = resolveTaskPrimaryContext(nextLeadTask, allTasks);
  enqueueSystemEvent(formatContextSwitchMessage(nextLeadTask, primaryContextTaskId), {
    sessionKey: team.leadSessionKey,
  });
  lastLeadDispatchTaskId.set(teamId, nextLeadTask.taskId);
}

export function autoClaimIdleTeammateTasks(teamId: string): void {
  const team = activeTeams.get(teamId);
  if (!team || !isTeamWorkingStatus(team.status)) {
    return;
  }

  for (const teammate of Object.values(team.teammates)) {
    if (teammate.isChore || teammate.status !== TEAMMATE_STATUS_IDLE) {
      continue;
    }
    autoClaimNextTaskForTeammate(teamId, teammate.teammateId);
  }
}

export function notifyLeadIfTeamIdle(teamId: string): void {
  const team = activeTeams.get(teamId);
  if (!team) {
    return;
  }

  // Only notify for working teams.
  if (!isTeamWorkingStatus(team.status)) {
    return;
  }

  if (team.answerBroadcasted) {
    return;
  }

  // Check if any teammates are still initializing or working.
  const busy = Object.values(team.teammates).filter(
    (tm) => tm.status === TEAMMATE_STATUS_INIT || tm.status === TEAMMATE_STATUS_WORKING,
  );
  if (busy.length > 0) {
    return;
  }

  try {
    const { tasks } = listTasks(teamId, { includeCompleted: true });
    if (tasks.length === 0) {
      return;
    }

    const hasOpenTerminalTask = tasks.some(
      (task) =>
        task.title === TASK_BROADCAST_ANSWER &&
        task.assignee === "lead" &&
        task.status !== "completed" &&
        task.status !== "failed",
    );
    if (hasOpenTerminalTask) {
      return;
    }

    const hasIncompleteNonTerminal = tasks.some((task) => {
      if (task.status === "completed" || task.status === "failed") {
        return false;
      }
      return !(task.title === TASK_BROADCAST_ANSWER && task.assignee === "lead");
    });
    if (hasIncompleteNonTerminal) {
      return;
    }

    const hasCompletedTerminal = tasks.some(
      (task) =>
        task.title === TASK_BROADCAST_ANSWER &&
        task.assignee === "lead" &&
        (task.status === "completed" || task.status === "failed"),
    );
    if (hasCompletedTerminal) {
      return;
    }

    addTask(teamId, {
      title: TASK_BROADCAST_ANSWER,
      description:
        "All work is complete. Broadcast the final answer to the caller using team_broadcast_answer.",
      assignTo: "lead",
      priority: "critical",
      metadata: {
        source: "system_terminal",
      },
    });
  } catch {
    // If we can't load tasks, don't create terminal task.
    return;
  }
}

/**
 * Reset the idle-notification guard so the lead gets notified again
 * after new work is introduced (new teammate spawned or new task added).
 */
export function resetIdleNotification(teamId: string): void {
  const team = activeTeams.get(teamId);
  if (team && team.idleNotificationSent) {
    team.idleNotificationSent = false;
    persistTeam(team);
  }
}

/**
 * Find a teammate by session key within a team.
 */
export function getTeammateBySessionKey(teamId: string, sessionKey: string): Teammate | null {
  const team = activeTeams.get(teamId);
  if (!team) {
    return null;
  }

  for (const teammate of Object.values(team.teammates)) {
    if (teammate.sessionKey === sessionKey) {
      return teammate;
    }
  }

  return null;
}

/**
 * Check if a session key is the team lead.
 */
export function isTeamLead(teamId: string, sessionKey: string): boolean {
  const team = activeTeams.get(teamId);
  if (!team) {
    return false;
  }

  return team.leadSessionKey === sessionKey;
}

/**
 * Resolve the team context for a given session key.
 * Returns team + role info if the session key belongs to a team.
 */
export function resolveCallerTeamContext(
  sessionKey: string,
): { team: Team; isLead: boolean; teammate?: Teammate } | null {
  for (const team of activeTeams.values()) {
    // Check if it's the lead
    if (team.leadSessionKey === sessionKey) {
      return { team, isLead: true };
    }

    // Check if it's a teammate
    for (const teammate of Object.values(team.teammates)) {
      if (teammate.sessionKey === sessionKey) {
        return { team, isLead: false, teammate };
      }
    }
  }

  return null;
}

export function resolveTeamSessionWorkspace(sessionKey: string): string | undefined {
  const context = resolveCallerTeamContext(sessionKey);
  if (!context) {
    return undefined;
  }
  if (context.isLead) {
    return context.team.leadWorkspaceDir;
  }
  return context.teammate?.workspaceDir;
}

/**
 * Register a runId -> teammate mapping for lifecycle tracking.
 */
export function registerTeammateRun(runId: string, teamId: string, teammateId: string): void {
  runIdToTeammate.set(runId, { teamId, teammateId });
}

/**
 * Register a runId -> lead mapping for lifecycle tracking.
 */
export function registerLeadRun(teamId: string, runId: string): void {
  runIdToLead.set(runId, teamId);
}

/**
 * Unregister a runId -> lead mapping.
 */
export function unregisterLeadRun(runId: string): void {
  runIdToLead.delete(runId);
}

/**
 * Update a lead's status.
 */
export function updateLeadStatus(teamId: string, status: LeadStatus): void {
  const team = activeTeams.get(teamId);
  if (!team) {
    return;
  }

  team.leadStatus = status;
  team.updatedAt = Date.now();
  persistTeam(team);
}

export function recomputeLeadStatusFromTasks(teamId: string): void {
  const team = activeTeams.get(teamId);
  if (!team) {
    return;
  }
  if (team.status === "idle") {
    return;
  }
  try {
    const { tasks } = listTasks(teamId, { includeCompleted: true });
    const hasLeadWork = tasks.some(
      (task) => task.assignee === "lead" && task.status !== "completed" && task.status !== "failed",
    );
    const next = hasLeadWork ? LEAD_STATUS_WORKING : LEAD_STATUS_IDLE;
    if (team.leadStatus !== next) {
      updateLeadStatus(teamId, next);
    }
  } catch {
    // Ignore task read errors; keep last known status.
  }
}

export function recomputeTeamStatusFromTasks(teamId: string): void {
  const team = activeTeams.get(teamId);
  if (!team) {
    return;
  }
  if (team.answerBroadcasted) {
    if (team.status !== "idle") {
      updateTeamStatus(teamId, "idle");
    }
    return;
  }
  try {
    const { tasks } = listTasks(teamId, { includeCompleted: true });
    const initTask = tasks.find((task) => task.title === TASK_INIT && task.assignee === "lead");
    if (initTask) {
      if (initTask.status === "failed" || initTask.metadata?.initFailure === true) {
        if (team.status !== "failed") {
          updateTeamStatus(teamId, "failed");
        }
        return;
      }
      const initHandled =
        initTask.status === "claimed" ||
        initTask.status === "in-progress" ||
        initTask.status === "completed";
      const nextStatus: TeamStatus = initHandled ? "working" : "init";
      if (team.status !== nextStatus) {
        updateTeamStatus(teamId, nextStatus);
      }
      return;
    }

    const hasOpenWork = tasks.some(
      (task) => task.status !== "completed" && task.status !== "failed",
    );
    if (hasOpenWork && team.status !== "working") {
      updateTeamStatus(teamId, "working");
    }
  } catch {
    // Ignore task read errors; keep last known team status.
  }
}

export function updateLeadSessionKey(
  teamId: string,
  leadSessionKey: string,
  boundSessionKey?: string,
): void {
  const team = activeTeams.get(teamId);
  if (!team) {
    return;
  }

  team.leadSessionKey = leadSessionKey;
  team.boundSessionKey = boundSessionKey;
  team.updatedAt = Date.now();
  persistTeam(team);
}

export function updateTeamTmuxPanes(params: {
  teamId: string;
  sessionName: string;
  leadPaneId?: string;
  teammatePaneIds: Record<string, string>;
}): void {
  const team = activeTeams.get(params.teamId);
  if (!team) {
    return;
  }
  team.tmuxPanes = {
    sessionName: params.sessionName,
    leadPaneId: params.leadPaneId,
    teammatePaneIds: { ...params.teammatePaneIds },
    updatedAt: Date.now(),
  };
  team.updatedAt = Date.now();
  persistTeam(team);
}

export function updateTeamAgentId(teamId: string, teamAgentId: string): void {
  const team = activeTeams.get(teamId);
  if (!team) {
    return;
  }

  team.teamAgentId = teamAgentId;
  team.updatedAt = Date.now();
  persistTeam(team);
}

/**
 * Mark that the lead has broadcasted its answer to the user.
 */
export function markAnswerBroadcasted(teamId: string): void {
  const team = activeTeams.get(teamId);
  if (!team) {
    return;
  }

  team.answerBroadcasted = true;
  team.updatedAt = Date.now();
  persistTeam(team);
}

/**
 * Unregister a runId -> teammate mapping.
 */
export function unregisterTeammateRun(runId: string): void {
  runIdToTeammate.delete(runId);
}

/**
 * Initialize the team registry.
 * Loads teams from disk and starts lifecycle listener.
 */
export function initTeamRegistry(): void {
  restoreTeamsOnce();
  recomputeTeamLaneConcurrency();
  ensureListener();
}

/**
 * Reset the team registry (for tests).
 */
export function resetTeamRegistryForTests(): void {
  activeTeams.clear();
  runIdToTeammate.clear();
  runIdToLead.clear();
  lastLeadDispatchTaskId.clear();
  stopAllChoreWatchers();
  if (listenerStop) {
    listenerStop();
    listenerStop = null;
  }
  listenerStarted = false;
  restoreAttempted = false;
}

/**
 * Find the active team for a given lead session key.
 * Returns the first active team where the session key is the lead.
 */
export function findTeamByLeadSession(leadSessionKey: string): Team | null {
  for (const team of activeTeams.values()) {
    if (isTeamOpenStatus(team.status) && team.leadSessionKey === leadSessionKey) {
      return team;
    }
  }
  return null;
}

/**
 * Find the active team for any session key (lead or teammate).
 */
export function findTeamBySession(sessionKey: string): Team | null {
  for (const team of activeTeams.values()) {
    if (!isTeamOpenStatus(team.status)) {
      continue;
    }
    if (team.leadSessionKey === sessionKey) {
      return team;
    }
    for (const teammate of Object.values(team.teammates)) {
      if (teammate.sessionKey === sessionKey) {
        return team;
      }
    }
  }
  return null;
}

/**
 * Find any team (including completed/failed) for a session key.
 * Returns the first match only.
 */
export function findTeamBySessionAny(sessionKey: string): Team | null {
  for (const team of activeTeams.values()) {
    if (team.leadSessionKey === sessionKey) {
      return team;
    }
    for (const teammate of Object.values(team.teammates)) {
      if (teammate.sessionKey === sessionKey) {
        return team;
      }
    }
  }
  return null;
}

/**
 * Find ALL teams (including completed/failed) for a session key.
 * Unlike findTeamBySessionAny, this returns every matching team.
 */
export function findAllTeamsBySessionAny(sessionKey: string): Team[] {
  const result: Team[] = [];
  for (const team of activeTeams.values()) {
    if (team.leadSessionKey === sessionKey) {
      result.push(team);
      continue;
    }
    for (const teammate of Object.values(team.teammates)) {
      if (teammate.sessionKey === sessionKey) {
        result.push(team);
        break;
      }
    }
  }
  return result;
}

// ---- Internal functions ----

function createLeadReviewForTeammateLifecycleIssue(
  teamId: string,
  teammateId: string,
  params: {
    reason: string;
    kind: "failed" | "ended";
    tasks?: Array<{ taskId: string; title?: string; status?: string }>;
  },
): void {
  try {
    const team = activeTeams.get(teamId);
    if (!team) {
      return;
    }
    const { tasks } = listTasks(teamId, { includeCompleted: true });
    const contextTaskId =
      params.tasks?.[0]?.taskId ?? tasks.find((task) => task.assignee === teammateId)?.taskId;
    const hasOpenReview = tasks.some(
      (task) =>
        task.title === TASK_LEAD_REVIEW &&
        task.assignee === "lead" &&
        task.status !== "completed" &&
        task.status !== "failed" &&
        task.metadata?.source === "teammate_lifecycle" &&
        task.metadata?.teammateId === teammateId,
    );
    if (hasOpenReview) {
      return;
    }

    addTask(teamId, {
      title: TASK_LEAD_REVIEW,
      description: params.reason,
      assignTo: "lead",
      priority: "critical",
      metadata: {
        source: "teammate_lifecycle",
        kind: params.kind,
        teammateId,
        context_task_id: contextTaskId,
        taskIds: params.tasks?.map((task) => task.taskId),
      },
    });
  } catch {
    // Best-effort notification; don't break the lifecycle flow
  }
}

/**
 * Persist a team to disk.
 */
function persistTeam(team: Team): void {
  try {
    const cfg = loadConfig();
    saveTeamToDisk(team, cfg);
  } catch {
    // Ignore persistence failures
  }
}

/**
 * Start the lifecycle event listener.
 * Updates teammate status based on agent lifecycle events.
 */
function ensureListener(): void {
  if (listenerStarted) {
    return;
  }
  listenerStarted = true;

  listenerStop = onAgentEvent((evt) => {
    if (evt.stream !== "lifecycle") {
      return;
    }

    const mapping = runIdToTeammate.get(evt.runId);
    const leadTeamId = runIdToLead.get(evt.runId);
    const phase = evt.data.phase as string | undefined;

    // 1. Handle Team Lead lifecycle events
    if (leadTeamId || evt.sessionKey) {
      for (const team of activeTeams.values()) {
        const isLeadSession =
          team.leadSessionKey === evt.sessionKey || team.boundSessionKey === evt.sessionKey;
        const isLeadRun = leadTeamId === team.teamId;

        if (isLeadSession || isLeadRun) {
          if (phase === "start") {
            if (evt.runId && !leadTeamId) {
              registerLeadRun(team.teamId, evt.runId);
            }
            lastLeadDispatchTaskId.delete(team.teamId);
            dispatchLeadPendingTask(team.teamId);
          } else if (phase === "end" || phase === "error") {
            if (evt.runId) {
              unregisterLeadRun(evt.runId);
            }
            lastLeadDispatchTaskId.delete(team.teamId);
          }
        }

        // 1a. Handle Team Lead session end for Auto-cleanup Teams (Clean on Lead End)
        if (isLeadSession && !team.persistent && (phase === "end" || phase === "error")) {
          // Check if all tasks are complete
          try {
            const { summary } = listTasks(team.teamId, { includeCompleted: true });
            const hasIncompleteTasks =
              summary.pending > 0 || summary.blocked > 0 || summary.inProgress > 0;
            if (!hasIncompleteTasks && team.answerBroadcasted) {
              cleanupTeam(team.teamId);
            }
          } catch {
            // ignore
          }
        }
      }
    }

    // 2. Handle Teammate status updates
    if (!mapping) {
      return;
    }

    const { teamId, teammateId } = mapping;

    if (phase === "start") {
      updateTeammateStatus(teamId, teammateId, TEAMMATE_STATUS_IDLE);
    } else if (phase === "end") {
      let incompleteAssigned: Array<{ taskId: string; title?: string; status?: string }> = [];
      try {
        const { tasks } = listTasks(teamId, { includeCompleted: true });
        incompleteAssigned = tasks.filter(
          (task) =>
            task.assignee === teammateId && task.status !== "completed" && task.status !== "failed",
        );
      } catch {
        // Ignore task lookup errors
      }

      if (incompleteAssigned.length > 0) {
        updateTeammateStatus(teamId, teammateId, TEAMMATE_STATUS_FAILED);
        const team = activeTeams.get(teamId);
        const teammate = team?.teammates[teammateId];
        const roleLabel = teammate?.role ?? teammateId;
        const lines: string[] = [];
        lines.push(`Teammate "${roleLabel}" ended before completing assigned tasks.`);
        if (incompleteAssigned.length > 0) {
          lines.push("");
          lines.push("Assigned tasks still incomplete:");
          for (const task of incompleteAssigned.slice(0, 3)) {
            const title = task.title ? ` ${task.title}` : "";
            const status = task.status ? ` (${task.status})` : "";
            lines.push(`- ${task.taskId}${title}${status}`);
          }
          if (incompleteAssigned.length > 3) {
            lines.push(`- ...and ${incompleteAssigned.length - 3} more`);
          }
        }
        lines.push("");
        lines.push("Decide whether to retry, reassign, or replace this teammate.");
        createLeadReviewForTeammateLifecycleIssue(teamId, teammateId, {
          kind: "ended",
          reason: lines.join("\n"),
          tasks: incompleteAssigned,
        });
        transitionTeammateToIdle(teamId, teammateId);
      } else {
        transitionTeammateToIdle(teamId, teammateId);
      }

      unregisterTeammateRun(evt.runId);
      // Notify the lead if the whole team is now idle
      notifyLeadIfTeamIdle(teamId);
    } else if (phase === "error") {
      updateTeammateStatus(teamId, teammateId, TEAMMATE_STATUS_FAILED);
      unregisterTeammateRun(evt.runId);
      const team = activeTeams.get(teamId);
      const teammate = team?.teammates[teammateId];
      const roleLabel = teammate?.role ?? teammateId;
      createLeadReviewForTeammateLifecycleIssue(teamId, teammateId, {
        kind: "failed",
        reason:
          `Teammate "${roleLabel}" failed unexpectedly.` +
          "\nDecide whether to retry, reassign, or replace this teammate.",
      });
      transitionTeammateToIdle(teamId, teammateId);
      // Notify the lead if the whole team is now idle
      notifyLeadIfTeamIdle(teamId);

      // Lead decides how to handle teammate failures (retry/adjust tasks/abort).
    }
  });
}

/**
 * Clean up a team: remove it from memory and delete all its files on disk.
 * This should be called by the team lead when work is complete.
 */
export function cleanupTeam(teamId: string): { success: boolean; error?: string } {
  try {
    const team = activeTeams.get(teamId);
    if (!team) {
      return { success: false, error: "Team not found" };
    }

    stopChoreWatcher(teamId);
    clearIdleClaimTimersForTeam(teamId);
    lastLeadDispatchTaskId.delete(teamId);
    // Remove from memory
    activeTeams.delete(teamId);
    recomputeTeamLaneConcurrency();

    // Delete team directory from disk
    deleteTeamFromDisk(teamId);

    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: `Cleanup failed: ${message}` };
  }
}

/**
 * Restore teams from disk on startup.
 * Marks any init/working teammates as idle (graceful degradation).
 */
function restoreTeamsOnce(): void {
  if (restoreAttempted) {
    return;
  }
  restoreAttempted = true;

  try {
    const cfg = loadConfig();
    const restored = loadAllTeamsFromDisk(cfg);

    for (const [teamId, team] of restored.entries()) {
      if (!team.persistent) {
        const retentionDays = cfg.gateway?.teams?.retentionDays;
        if (retentionDays && team.updatedAt) {
          const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
          if (team.updatedAt < cutoff) {
            deleteTeamFromDisk(teamId);
            continue;
          }
        }
      }

      // Mark any teammates that were mid-run as failed after restart, then return them to idle.
      for (const teammate of Object.values(team.teammates)) {
        if (
          teammate.status === TEAMMATE_STATUS_INIT ||
          teammate.status === TEAMMATE_STATUS_WORKING
        ) {
          teammate.status = TEAMMATE_STATUS_FAILED;
          if (!teammate.isChore) {
            teammate.currentTask = undefined;
            teammate.currentTaskId = undefined;
          }
          teammate.status = TEAMMATE_STATUS_IDLE;
        }
      }

      if (!team.persistent) {
        try {
          if (team.answerBroadcasted) {
            const { summary } = listTasks(team.teamId, { includeCompleted: true });
            const hasIncompleteTasks =
              summary.pending > 0 || summary.blocked > 0 || summary.inProgress > 0;
            if (!hasIncompleteTasks) {
              deleteTeamFromDisk(team.teamId);
              continue;
            }
          }
        } catch {
          // ignore restore cleanup errors
        }
      }

      activeTeams.set(teamId, team);
      ensureSystemTeammates(team);
      recomputeLeadStatusFromTasks(teamId);
      startChoreWatcher(teamId);
      dispatchLeadPendingTask(teamId);
    }
  } catch {
    // Ignore restore failures
  }
}
