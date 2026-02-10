import type {
  LeadStatus,
  Team,
  TeamConfig,
  TeamStatus,
  Teammate,
  TeammateStatus,
} from "./types.js";
import { loadConfig } from "../../config/config.js";
import { onAgentEvent } from "../../infra/agent-events.js";
import { setCommandLaneConcurrency } from "../../process/command-queue.js";
import { CommandLane } from "../../process/lanes.js";
import { sendMessage as sendMailboxMessage } from "./mailbox.js";
import { listTasks } from "./task-list.js";
import { deleteTeamFromDisk, loadAllTeamsFromDisk, saveTeamToDisk } from "./team-registry.store.js";
import {
  LEAD_STATUS_IDLE,
  LEAD_STATUS_WORKING,
  TEAMMATE_STATUS_SPAWNING,
  TEAMMATE_STATUS_ACTIVE,
  TEAMMATE_STATUS_IDLE,
  TEAMMATE_STATUS_COMPLETED,
  TEAMMATE_STATUS_FAILED,
  TEAMMATE_STATUS_INTERRUPTED,
} from "./types.js";

// In-memory state
const activeTeams = new Map<string, Team>();
const runIdToTeammate = new Map<string, { teamId: string; teammateId: string }>();
const runIdToLead = new Map<string, string>();
let listenerStarted = false;
let listenerStop: (() => void) | null = null;
// Use var to avoid TDZ when init runs across circular imports during bootstrap.
var restoreAttempted = false;

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

function recomputeTeamLaneConcurrency(): void {
  const totalMembers = Array.from(activeTeams.values())
    .filter((team) => team.status === "active")
    .reduce((sum, team) => sum + 1 + Object.keys(team.teammates).length, 0);
  setCommandLaneConcurrency(CommandLane.Team, totalMembers > 0 ? totalMembers : 1);
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

  const leadStatus = persistent ? LEAD_STATUS_IDLE : LEAD_STATUS_WORKING;

  const team: Team = {
    teamId,
    teamName: params.teamName,
    description: params.description,
    creatorSessionKey: params.creatorSessionKey,
    teamAgentId,
    leadSessionKey,
    status: "active",
    persistent,
    boundSessionKey: !persistent ? params.boundSessionKey : undefined,
    createdAt: now,
    updatedAt: now,
    teammates: {},
    config: params.config,
    leadStatus,
    answerBroadcasted: false,
  };

  activeTeams.set(teamId, team);
  persistTeam(team);
  recomputeTeamLaneConcurrency();

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
  return Array.from(activeTeams.values()).filter((team) => team.status === "active");
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
}

/**
 * Remove a teammate from a team.
 */
export function removeTeammate(teamId: string, teammateId: string): void {
  const team = activeTeams.get(teamId);
  if (!team) {
    return;
  }

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
  recomputeTeamLaneConcurrency();
}

/**
 * Transition a teammate to "idle" status when they have no current task.
 * This is called when a teammate completes a task and no new task is assigned.
 * Also allows transition from terminal states (completed/failed) to idle for persistent teams.
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

  // Allow transition from "active", "completed", or "failed" to "idle"
  if (
    teammate.status === TEAMMATE_STATUS_ACTIVE ||
    teammate.status === TEAMMATE_STATUS_COMPLETED ||
    teammate.status === TEAMMATE_STATUS_FAILED
  ) {
    teammate.status = TEAMMATE_STATUS_IDLE;
    teammate.currentTask = undefined;
    team.updatedAt = Date.now();
    persistTeam(team);
  }
}

/**
 * Notify the lead when all teammates are idle and no incomplete tasks remain.
 * Does NOT auto-transition team status — the lead decides lifecycle.
 * Sends at most one notification per idle window; resets when a teammate
 * is spawned or a task is added (via {@link resetIdleNotification}).
 */

export function notifyLeadIfTeamIdle(teamId: string): void {
  const team = activeTeams.get(teamId);
  if (!team) {
    return;
  }

  // Only notify for active teams
  if (team.status !== "active") {
    return;
  }

  // Already notified for this idle window
  if (team.idleNotificationSent) {
    return;
  }

  // Check if any teammates are still active or spawning
  const busy = Object.values(team.teammates).filter(
    (tm) => tm.status === "active" || tm.status === "spawning",
  );
  if (busy.length > 0) {
    return;
  }

  // Check task completion status
  try {
    const { summary } = listTasks(teamId, { includeCompleted: true });

    const hasIncompleteTasks = summary.pending > 0 || summary.blocked > 0 || summary.inProgress > 0;

    if (hasIncompleteTasks) {
      return;
    }
  } catch {
    // If we can't load tasks, don't notify/cleanup
    return;
  }

  // --- Auto-cleanup Team Notification ---
  if (!team.persistent) {
    if (team.idleNotificationSent) {
      return;
    }
    team.idleNotificationSent = true;
    persistTeam(team);

    sendMailboxMessage({
      teamId,
      from: "system",
      to: "lead",
      message: `Ephemeral team "${team.teamName}" has completed all tasks. Mission accomplished. I will automatically disband the team once you finish your current session.`,
      priority: "normal",
    });
    return;
  }

  // --- Persistent Team Notification ---

  // All teammates idle and no incomplete tasks — notify the lead once
  team.idleNotificationSent = true;
  persistTeam(team);

  sendMailboxMessage({
    teamId,
    from: "system",
    to: "lead",
    message:
      "All teammates have finished and no incomplete tasks remain. " +
      "You can shut down idle teammates with teammate_shutdown, " +
      "synthesize results, and close the team with team_complete / team_cleanup.",
    priority: "normal",
  });
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
  if (team.status !== "active") {
    return;
  }
  if (!team.persistent) {
    if (team.leadStatus !== LEAD_STATUS_WORKING) {
      updateLeadStatus(teamId, LEAD_STATUS_WORKING);
    }
    return;
  }
  try {
    const { summary } = listTasks(teamId, { includeCompleted: true });
    const hasIncomplete = summary.pending > 0 || summary.blocked > 0 || summary.inProgress > 0;
    const next = hasIncomplete ? LEAD_STATUS_WORKING : LEAD_STATUS_IDLE;
    if (team.leadStatus !== next) {
      updateLeadStatus(teamId, next);
    }
  } catch {
    // Ignore task read errors; keep last known status.
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
 * Check if all teammates are cleaned up (in terminal states or removed).
 */
function areAllTeammatesCleaned(team: Team): boolean {
  const teammates = Object.values(team.teammates);
  if (teammates.length === 0) return true;
  return teammates.every(
    (tm) =>
      tm.status === TEAMMATE_STATUS_COMPLETED ||
      tm.status === TEAMMATE_STATUS_FAILED ||
      tm.status === TEAMMATE_STATUS_INTERRUPTED,
  );
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
    if (team.status === "active" && team.leadSessionKey === leadSessionKey) {
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
    if (team.status !== "active") {
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

/**
 * Notify the lead that a teammate has finished (completed or failed).
 * Sends a mailbox message so the lead gets an automatic update.
 */
function notifyLeadOfTeammateFinish(
  teamId: string,
  teammateId: string,
  status: "completed" | "failed",
): void {
  try {
    const team = activeTeams.get(teamId);
    if (!team) {
      return;
    }
    const teammate = team.teammates[teammateId];
    const roleLabel = teammate?.role ?? teammateId;
    const statusLabel = status === "completed" ? "finished" : "failed";
    const priority = status === "failed" ? "urgent" : "normal";

    sendMailboxMessage({
      teamId,
      from: teammateId,
      to: "lead",
      message: `Teammate "${roleLabel}" has ${statusLabel}.`,
      priority,
    });
  } catch {
    // Best-effort notification; don't break the lifecycle flow
  }
}

function notifyLeadOfTeammateInterrupted(
  teamId: string,
  teammateId: string,
  tasks: Array<{ taskId: string; title?: string; status?: string }>,
): void {
  try {
    const team = activeTeams.get(teamId);
    if (!team) {
      return;
    }
    const teammate = team.teammates[teammateId];
    const roleLabel = teammate?.role ?? teammateId;
    const lines: string[] = [];
    lines.push(`Teammate "${roleLabel}" ended before completing assigned tasks.`);
    if (tasks.length > 0) {
      lines.push("");
      lines.push("Assigned tasks still incomplete:");
      for (const task of tasks.slice(0, 3)) {
        const title = task.title ? ` ${task.title}` : "";
        const status = task.status ? ` (${task.status})` : "";
        lines.push(`- ${task.taskId}${title}${status}`);
      }
      if (tasks.length > 3) {
        lines.push(`- ...and ${tasks.length - 3} more`);
      }
    }
    lines.push("");
    lines.push("Reassign or retry these tasks.");

    sendMailboxMessage({
      teamId,
      from: teammateId,
      to: "lead",
      message: lines.join("\n"),
      priority: "urgent",
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
          } else if (phase === "end" || phase === "error") {
            if (evt.runId) {
              unregisterLeadRun(evt.runId);
            }
          }
        }

        // 1a. Handle Team Lead session end for Auto-cleanup Teams (Clean on Lead End)
        if (isLeadSession && !team.persistent && (phase === "end" || phase === "error")) {
          // Check if all tasks are complete
          try {
            const { summary } = listTasks(team.teamId, { includeCompleted: true });
            const hasIncompleteTasks =
              summary.pending > 0 || summary.blocked > 0 || summary.inProgress > 0;
            const allTeammatesCleaned = areAllTeammatesCleaned(team);
            if (!hasIncompleteTasks && team.answerBroadcasted && allTeammatesCleaned) {
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
      updateTeammateStatus(teamId, teammateId, TEAMMATE_STATUS_ACTIVE);
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
        updateTeammateStatus(teamId, teammateId, TEAMMATE_STATUS_INTERRUPTED);
        notifyLeadOfTeammateInterrupted(teamId, teammateId, incompleteAssigned);
      } else {
        const team = activeTeams.get(teamId);
        const teammate = team?.teammates[teammateId];
        if (team && teammate) {
          teammate.status = TEAMMATE_STATUS_IDLE;
          teammate.currentTask = undefined;
          team.updatedAt = Date.now();
          persistTeam(team);
        } else {
          updateTeammateStatus(teamId, teammateId, TEAMMATE_STATUS_IDLE);
        }
      }

      unregisterTeammateRun(evt.runId);
      // Notify the lead if the whole team is now idle
      notifyLeadIfTeamIdle(teamId);
    } else if (phase === "error") {
      updateTeammateStatus(teamId, teammateId, TEAMMATE_STATUS_FAILED);
      unregisterTeammateRun(evt.runId);
      // Auto-notify the lead that this teammate failed
      notifyLeadOfTeammateFinish(teamId, teammateId, "failed");
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
 * Marks any spawning/active teammates as idle (graceful degradation).
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

      // Mark any teammates that were mid-run as interrupted after restart
      for (const teammate of Object.values(team.teammates)) {
        if (
          teammate.status === TEAMMATE_STATUS_SPAWNING ||
          teammate.status === TEAMMATE_STATUS_ACTIVE
        ) {
          teammate.status = TEAMMATE_STATUS_INTERRUPTED;
        }
      }

      if (team.persistent) {
        if (team.status === "interrupted") {
          team.status = "active";
        }
      } else {
        if (team.status === "active") {
          team.status = "interrupted";
        }
        try {
          if (team.answerBroadcasted) {
            const { summary } = listTasks(team.teamId, { includeCompleted: true });
            const hasIncompleteTasks =
              summary.pending > 0 || summary.blocked > 0 || summary.inProgress > 0;
            const allTeammatesCleaned = areAllTeammatesCleaned(team);
            if (!hasIncompleteTasks && allTeammatesCleaned) {
              deleteTeamFromDisk(team.teamId);
              continue;
            }
          }
        } catch {
          // ignore restore cleanup errors
        }
      }

      activeTeams.set(teamId, team);
      recomputeLeadStatusFromTasks(teamId);
    }
  } catch {
    // Ignore restore failures
  }
}
