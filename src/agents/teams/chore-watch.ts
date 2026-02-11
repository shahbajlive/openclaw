import type { Task, Team } from "./types.js";
import { loadConfig } from "../../config/config.js";
import { callGateway } from "../../gateway/call.js";
import { addTask, listTasks, updateTask } from "./task-list.js";
import { TASK_LEAD_REVIEW, TASK_REVIEW_QUESTION, isOpen } from "./task-taxonomy.js";
import { getTeam, resetIdleNotification, transitionTeammateToIdle } from "./team-registry.js";

export const CHORE_TEAMMATE_ID = "chore";
export const CHORE_ROLE = "chore";
export const PR_REVIEWER_TEAMMATE_ID = "pr_reviewer";
export const PR_REVIEWER_ROLE = "pr_reviewer";

// Chore runs on the same heartbeat as idle-claim (3 Hz).
const DEFAULT_CHORE_INTERVAL_MS = 333;
const DEFAULT_STALL_MS = 15 * 60_000;
const DEFAULT_LEAD_REVIEW_STALE_MS = 15 * 60_000;
const DEFAULT_BACKLOG_LIMIT = 50;

const choreTimers = new Map<string, NodeJS.Timeout>();

export type ChoreViolation = {
  type:
    | "stalled_task"
    | "blocked_active"
    | "missing_dependency"
    | "lead_review_stale"
    | "invalid_assignee"
    | "backlog_overflow";
  message: string;
  taskIds?: string[];
  teammateId?: string;
  violationKey: string;
};

function getStallMs(): number {
  const raw = Number(process.env.OPENCLAW_TEAM_CHORE_STALL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_STALL_MS;
}

function getLeadReviewStaleMs(): number {
  const raw = Number(process.env.OPENCLAW_TEAM_CHORE_REVIEW_STALE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_LEAD_REVIEW_STALE_MS;
}

function getBacklogLimit(): number {
  const raw = Number(process.env.OPENCLAW_TEAM_CHORE_BACKLOG_LIMIT);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_BACKLOG_LIMIT;
}

function buildViolationKey(params: {
  type: ChoreViolation["type"];
  taskIds?: string[];
  teammateId?: string;
}): string {
  const taskPart = params.taskIds?.slice().sort().join(",") ?? "";
  return `${params.type}:${params.teammateId ?? ""}:${taskPart}`;
}

function findExistingChoreReview(tasks: Task[], violationKey: string): Task | undefined {
  return tasks.find(
    (task) =>
      task.title === TASK_LEAD_REVIEW &&
      isOpen(task) &&
      task.metadata?.source === "chore" &&
      task.metadata?.violationKey === violationKey,
  );
}

function collectOpenChoreLeadReviewIds(tasks: Task[]): Set<string> {
  const ids = new Set<string>();
  for (const task of tasks) {
    if (task.title === TASK_LEAD_REVIEW && isOpen(task) && task.metadata?.source === "chore") {
      ids.add(task.taskId);
    }
  }
  return ids;
}

function hasTeammateGraphEscalation(tasks: Task[], teammateId: string): boolean {
  const openChoreLeadReviews = collectOpenChoreLeadReviewIds(tasks);
  if (openChoreLeadReviews.size === 0) {
    return false;
  }
  return tasks.some((task) => {
    if (!isOpen(task) || task.assignee !== teammateId) {
      return false;
    }
    if (task.title === TASK_REVIEW_QUESTION && task.metadata?.source === "chore") {
      return true;
    }
    return task.dependsOn.some((depId) => openChoreLeadReviews.has(depId));
  });
}

function addDependency(task: Task, dependencyId: string): string[] {
  const deps = new Set(task.dependsOn);
  deps.add(dependencyId);
  return Array.from(deps);
}

function shouldSkipTask(task: Task): boolean {
  return task.status === "completed" || task.status === "failed";
}

function describeTask(task: Task): string {
  const title = task.title ? `"${task.title}"` : task.taskId;
  return `${title} (${task.taskId.slice(0, 8)})`;
}

export function ensureChoreTeammate(team: Team): void {
  if (team.teammates[CHORE_TEAMMATE_ID]) {
    return;
  }
  team.teammates[CHORE_TEAMMATE_ID] = {
    teammateId: CHORE_TEAMMATE_ID,
    role: CHORE_ROLE,
    sessionKey: `agent:${team.teamAgentId}:chore`,
    status: "idle",
    model: undefined,
    isChore: true,
    requirePlanApproval: false,
    planApproved: true,
    currentTask: undefined,
    currentTaskId: undefined,
    claimedTasks: 0,
    completedTasks: 0,
    createdAt: Date.now(),
  };
}

export function ensurePrReviewerTeammate(team: Team): void {
  if (team.teammates[PR_REVIEWER_TEAMMATE_ID]) {
    return;
  }
  team.teammates[PR_REVIEWER_TEAMMATE_ID] = {
    teammateId: PR_REVIEWER_TEAMMATE_ID,
    role: PR_REVIEWER_ROLE,
    sessionKey: `agent:${team.teamAgentId}:teammate:pr-reviewer`,
    status: "idle",
    model: undefined,
    requirePlanApproval: false,
    planApproved: true,
    currentTask: undefined,
    currentTaskId: undefined,
    claimedTasks: 0,
    completedTasks: 0,
    createdAt: Date.now(),
  };
}

function detectViolations(team: Team, tasks: Task[], now: number): ChoreViolation[] {
  const tasksById = new Map(tasks.map((task) => [task.taskId, task]));
  const violations: ChoreViolation[] = [];
  const stallMs = getStallMs();
  const reviewStaleMs = getLeadReviewStaleMs();
  const backlogLimit = getBacklogLimit();

  const pendingTasks = tasks.filter((task) => task.status === "pending");
  const pendingCount = pendingTasks.length;
  if (pendingCount > backlogLimit) {
    const pendingIds = pendingTasks.map((task) => task.taskId);
    const message = `Backlog overflow: ${pendingCount} pending tasks (limit ${backlogLimit}).`;
    violations.push({
      type: "backlog_overflow",
      message,
      taskIds: pendingIds,
      violationKey: buildViolationKey({ type: "backlog_overflow" }),
    });
  }

  for (const task of tasks) {
    if (task.assignee && !team.teammates[task.assignee]) {
      const message = `Task ${describeTask(task)} assigned to unknown teammate "${task.assignee}".`;
      violations.push({
        type: "invalid_assignee",
        message,
        taskIds: [task.taskId],
        violationKey: buildViolationKey({ type: "invalid_assignee", taskIds: [task.taskId] }),
      });
    }

    if (task.dependsOn.length > 0) {
      const missing = task.dependsOn.filter((depId) => !tasksById.has(depId));
      if (missing.length > 0) {
        const message = `Task ${describeTask(task)} depends on missing task(s): ${missing
          .map((id) => id.slice(0, 8))
          .join(", ")}.`;
        violations.push({
          type: "missing_dependency",
          message,
          taskIds: [task.taskId],
          violationKey: buildViolationKey({ type: "missing_dependency", taskIds: [task.taskId] }),
        });
      }
    }

    if ((task.status === "claimed" || task.status === "in-progress") && task.claimedAt) {
      const ageMs = now - task.claimedAt;
      if (ageMs > stallMs) {
        const message = `Task ${describeTask(task)} has been claimed for ${Math.round(
          ageMs / 1000,
        )}s without completion.`;
        violations.push({
          type: "stalled_task",
          message,
          taskIds: [task.taskId],
          teammateId: task.assignee,
          violationKey: buildViolationKey({
            type: "stalled_task",
            taskIds: [task.taskId],
            teammateId: task.assignee,
          }),
        });
      }
    }

    if (task.status === "blocked" && task.assignee) {
      const teammate = team.teammates[task.assignee];
      if (teammate && teammate.status === "working") {
        const message = `Task ${describeTask(task)} is blocked but teammate "${task.assignee}" remains working.`;
        violations.push({
          type: "blocked_active",
          message,
          taskIds: [task.taskId],
          teammateId: task.assignee,
          violationKey: buildViolationKey({
            type: "blocked_active",
            taskIds: [task.taskId],
            teammateId: task.assignee,
          }),
        });
      }
    }

    if (
      task.title === TASK_LEAD_REVIEW &&
      (task.status === "pending" || task.status === "blocked")
    ) {
      const ageMs = now - task.createdAt;
      if (ageMs > reviewStaleMs) {
        const message = `Lead review ${describeTask(task)} is stale (${Math.round(
          ageMs / 1000,
        )}s).`;
        violations.push({
          type: "lead_review_stale",
          message,
          taskIds: [task.taskId],
          violationKey: buildViolationKey({ type: "lead_review_stale", taskIds: [task.taskId] }),
        });
      }
    }
  }

  return violations;
}

function escalateViolation(params: { team: Team; tasks: Task[]; violation: ChoreViolation }): {
  leadReviewId?: string;
  reviewQuestionId?: string;
} {
  const { team, tasks, violation } = params;
  const existing = findExistingChoreReview(tasks, violation.violationKey);
  if (existing) {
    return { leadReviewId: existing.taskId };
  }

  const leadReview = addTask(team.teamId, {
    title: TASK_LEAD_REVIEW,
    description: `Chore flagged: ${violation.message}`,
    assignTo: "lead",
    priority: "critical",
    metadata: {
      source: "chore",
      violationType: violation.type,
      violationKey: violation.violationKey,
      targetTaskIds: violation.taskIds,
      targetTeammateId: violation.teammateId,
    },
  });

  resetIdleNotification(team.teamId);

  let reviewQuestionId: string | undefined;
  if (violation.teammateId && team.teammates[violation.teammateId]) {
    const reviewQuestion = addTask(team.teamId, {
      title: TASK_REVIEW_QUESTION,
      description: violation.message,
      assignTo: violation.teammateId,
      priority: "high",
      metadata: {
        source: "chore",
        violationKey: violation.violationKey,
        questionText: violation.message,
        targetTaskIds: violation.taskIds,
      },
    });
    reviewQuestionId = reviewQuestion.taskId;
    resetIdleNotification(team.teamId);

    try {
      updateTask(team.teamId, leadReview.taskId, {
        dependsOn: addDependency(leadReview, reviewQuestion.taskId),
      });
    } catch {
      // ignore dependency update failures
    }
  }

  if (violation.taskIds) {
    for (const taskId of violation.taskIds) {
      const task = tasks.find((t) => t.taskId === taskId);
      if (!task || shouldSkipTask(task)) {
        continue;
      }
      try {
        updateTask(
          team.teamId,
          taskId,
          {
            dependsOn: addDependency(task, leadReview.taskId),
          },
          {
            allowMissingDependencies: violation.type === "missing_dependency",
          },
        );
        if (task.assignee) {
          transitionTeammateToIdle(team.teamId, task.assignee);
          const teammate = team.teammates[task.assignee];
          if (teammate?.sessionKey) {
            const cfg = loadConfig();
            setTimeout(() => {
              callGateway({
                config: cfg,
                method: "chat.abort",
                params: { sessionKey: teammate.sessionKey },
                timeoutMs: 5_000,
              }).catch(() => {});
            }, 0);
          }
        }
      } catch {
        // ignore dependency update failures
      }
    }
  }

  return { leadReviewId: leadReview.taskId, reviewQuestionId };
}

export function runChoreCheckNow(teamId: string): {
  violations: ChoreViolation[];
  createdReviews: Array<{ leadReviewId: string; reviewQuestionId?: string }>;
} {
  const team = getTeam(teamId);
  if (!team || team.status !== "working") {
    return { violations: [], createdReviews: [] };
  }

  let currentTasks = listTasks(teamId, { includeCompleted: true }).tasks;
  const violations = detectViolations(team, currentTasks, Date.now());
  if (violations.length === 0) {
    return { violations, createdReviews: [] };
  }

  const createdReviews: Array<{ leadReviewId: string; reviewQuestionId?: string }> = [];
  for (const violation of violations) {
    if (violation.teammateId && hasTeammateGraphEscalation(currentTasks, violation.teammateId)) {
      continue;
    }
    const result = escalateViolation({ team, tasks: currentTasks, violation });
    if (result.leadReviewId) {
      createdReviews.push({
        leadReviewId: result.leadReviewId,
        reviewQuestionId: result.reviewQuestionId,
      });
      currentTasks = listTasks(teamId, { includeCompleted: true }).tasks;
    }
  }

  return { violations, createdReviews };
}

export function startChoreWatcher(teamId: string): void {
  const cfg = loadConfig();
  if (!cfg.gateway?.teams?.enabled) {
    return;
  }
  if (choreTimers.has(teamId)) {
    return;
  }

  const intervalMs = DEFAULT_CHORE_INTERVAL_MS;
  const timer = setInterval(() => {
    runChoreCheckNow(teamId);
  }, intervalMs);
  timer.unref();
  choreTimers.set(teamId, timer);
}

export function stopChoreWatcher(teamId: string): void {
  const timer = choreTimers.get(teamId);
  if (timer) {
    clearInterval(timer);
    choreTimers.delete(teamId);
  }
}

export function stopAllChoreWatchers(): void {
  for (const [teamId, timer] of choreTimers.entries()) {
    clearInterval(timer);
    choreTimers.delete(teamId);
  }
}
