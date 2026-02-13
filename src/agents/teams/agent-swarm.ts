import { DepGraph } from "dependency-graph";
import fs from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../../config/io.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { jsonResult, readStringParam } from "../tools/common.js";
import {
  MATE_STATUS,
  PRIORITY_ORDER,
  RESERVED_MATE_ID,
  TEAM_STATUS,
  TASK_STATUS,
  type SwarmAddTaskParams,
  type SwarmAskMode,
  type SwarmTask,
  type SwarmTaskNode,
  type SwarmTeamMember,
  type SwarmTeamRecord,
} from "./types.js";

export type AgentSwarmOptions = {
  agentSessionKey?: string;
  sessionHooks?: {
    sendBootstrap?: (params: {
      teamId: string;
      teammateId: string;
      taskId: string;
      sessionKey: string;
      title: string;
      instruction: string;
    }) => void | Promise<void>;
    appendSessionNote?: (params: {
      teamId: string;
      sessionKey: string;
      note: string;
    }) => void | Promise<void>;
    interruptSession?: (params: {
      teamId: string;
      teammateId: string;
      sessionKey: string;
      reason: string;
    }) => void | Promise<void>;
  };
};

const TASK_INIT = "Create Subtask";
const WORKTREE_ROOT = "openclaw";
const GIT_TIMEOUT_MS = 15_000;
const TEAM_WORKTREE_DIR = "_team";

class Team {
  private static readonly teams = new Map<string, SwarmTeamRecord>();

  public static create(params: {
    teamName: string;
    instruction: string;
    creatorSessionKey?: string;
  }): SwarmTeamRecord {
    const teamId = this.resolveTeamId(params.teamName);
    const teamAgentId = `team-${teamId}`;
    const now = Date.now();

    const lead = {
      teammateId: RESERVED_MATE_ID.LEAD,
      status: MATE_STATUS.INIT,
      createdAt: now,
      updatedAt: now,
    } as unknown as SwarmTeamMember;

    const team = {
      teamId,
      teamName: params.teamName,
      instruction: params.instruction,
      creatorSessionKey: params.creatorSessionKey,
      teamAgentId,
      status: TEAM_STATUS.INIT,
      createdAt: now,
      updatedAt: now,
      teammates: this.createTeammatesCollection(lead),
    } as unknown as SwarmTeamRecord;

    this.teams.set(teamId, team);
    return team;
  }

  public static listActive(): SwarmTeamRecord[] {
    return Array.from(this.teams.values());
  }

  public static get(teamId: string): SwarmTeamRecord | undefined {
    return this.teams.get(teamId);
  }

  public static setWorking(teamId: string, teammateId: string, taskId: string): void {
    const team = this.teams.get(teamId);
    if (!team) {
      return;
    }

    const teammate = this.ensureTeammate(team, teammateId);
    teammate.status = MATE_STATUS.WORKING;
    teammate.currentTaskId = taskId;
    teammate.updatedAt = Date.now();
    this.setTeamStatus(team, TEAM_STATUS.WORKING);
    this.touchTeam(team);
  }

  // Side effects (interrupt/bootstrap/checker registration) are handled in AgentSwarm.
  public static setIdle(teamId: string, teammateId: string): void {
    const team = this.teams.get(teamId);
    if (!team) {
      return;
    }

    const teammate = this.ensureTeammate(team, teammateId);
    teammate.status = MATE_STATUS.IDLE;
    teammate.currentTaskId = undefined;
    teammate.updatedAt = Date.now();
    // at least one teammate working, update team status to working
    const hasWorking = this.teammateValues(team).some(
      (member) => member.status === MATE_STATUS.WORKING,
    );
    this.setTeamStatus(team, hasWorking ? TEAM_STATUS.WORKING : TEAM_STATUS.IDLE);
    this.touchTeam(team);
  }

  private static ensureTeammate(team: SwarmTeamRecord, teammateId: string): SwarmTeamMember {
    const existing = this.teammateGet(team, teammateId);
    if (existing) {
      return existing;
    }

    const created = {
      teammateId,
      status: MATE_STATUS.IDLE,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as unknown as SwarmTeamMember;

    this.teammateSet(team, teammateId, created);
    this.touchTeam(team);
    return created;
  }

  private static createTeammatesCollection(lead: SwarmTeamMember): SwarmTeamRecord["teammates"] {
    return new Map([[lead.teammateId, lead]]) as unknown as SwarmTeamRecord["teammates"];
  }

  private static teammatesOf(
    team: SwarmTeamRecord,
  ): Map<string, SwarmTeamMember> | Record<string, SwarmTeamMember> {
    return (
      team as unknown as {
        teammates: Map<string, SwarmTeamMember> | Record<string, SwarmTeamMember>;
      }
    ).teammates;
  }

  private static teammateGet(
    team: SwarmTeamRecord,
    teammateId: string,
  ): SwarmTeamMember | undefined {
    const teammates = this.teammatesOf(team);
    if (teammates instanceof Map) {
      return teammates.get(teammateId);
    }
    return teammates[teammateId];
  }

  private static teammateSet(
    team: SwarmTeamRecord,
    teammateId: string,
    teammate: SwarmTeamMember,
  ): void {
    const teammates = this.teammatesOf(team);
    if (teammates instanceof Map) {
      teammates.set(teammateId, teammate);
      return;
    }
    teammates[teammateId] = teammate;
  }

  private static teammateValues(team: SwarmTeamRecord): SwarmTeamMember[] {
    const teammates = this.teammatesOf(team);
    if (teammates instanceof Map) {
      return Array.from(teammates.values());
    }
    return Object.values(teammates);
  }

  private static setTeamStatus(
    team: SwarmTeamRecord,
    status: (typeof TEAM_STATUS)[keyof typeof TEAM_STATUS],
  ): void {
    (team as unknown as { status?: string }).status = status;
  }

  private static touchTeam(team: SwarmTeamRecord): void {
    (team as unknown as { updatedAt?: number }).updatedAt = Date.now();
  }

  private static resolveTeamId(teamName: string): string {
    const base =
      teamName
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^[-_]+|[-_]+$/g, "") || "team";

    if (!this.teams.has(base)) {
      return base;
    }

    for (let i = 1; i < 1000; i += 1) {
      const candidate = `${base}-${i}`;
      if (!this.teams.has(candidate)) {
        return candidate;
      }
    }

    return `${base}-${Date.now()}`;
  }
}

class Graph {
  private readonly teamId: string;
  private readonly tasks = new Map<string, SwarmTask>();
  private readonly dag = new DepGraph<SwarmTaskNode>();
  private taskSeq = 0;

  constructor(teamId: string) {
    this.teamId = teamId;
  }

  public addTask(params: SwarmAddTaskParams & { assignee?: string }): SwarmTask {
    const taskId = this.nextTaskId();
    const dependsOn = this.normalizeDependsOn(params.dependsOn);
    const taskClass = params.taskClass ?? "secondary";

    this.assertNoCycle(taskId, dependsOn);

    const task: SwarmTask = {
      taskId,
      title: params.title,
      instruction: params.instruction ?? params.title,
      submit: "",
      status: params.status ?? (dependsOn.length > 0 ? TASK_STATUS.BLOCKED : TASK_STATUS.PENDING),
      assignee: params.assignTo ?? params.assignee ?? RESERVED_MATE_ID.LEAD,
      contextSessionKey: params.contextSessionKey ?? `task:${taskId}`,
      dependsOn,
      priority: this.normalizePriority(params.priority),
      taskClass,
      createdAt: Date.now(),
      claimedAt: 0,
      completedAt: 0,
      clones: 1,
      onSubmit: params.onSubmit,
    };

    this.tasks.set(taskId, task);
    this.dag.addNode(taskId, { taskId, assignee: task.assignee, status: task.status });
    for (const depId of dependsOn) {
      this.ensureNode(depId);
      if (!this.dag.directDependenciesOf(taskId).includes(depId)) {
        this.dag.addDependency(taskId, depId);
      }
    }
    this.refreshBlockedState(taskId);
    return this.mustGetTask(taskId);
  }

  public getTask(taskId: string): SwarmTask | undefined {
    return this.tasks.get(taskId);
  }

  public listActiveTasksBySession(sessionKey: string): SwarmTask[] {
    return this.listTasks().filter((task) => {
      if (task.contextSessionKey !== sessionKey) {
        return false;
      }
      return task.status !== TASK_STATUS.COMPLETED && task.status !== TASK_STATUS.FAILED;
    });
  }

  public claimIfPending(taskId: string): SwarmTask {
    const task = this.mustGetTask(taskId);
    if (task.status !== TASK_STATUS.PENDING) {
      return task;
    }
    return this.updateTask(taskId, { status: TASK_STATUS.CLAIMED, claimedAt: Date.now() });
  }

  public listTasks(): SwarmTask[] {
    return Array.from(this.tasks.values());
  }

  public updateTask(taskId: string, patch: Partial<SwarmTask>): SwarmTask {
    const task = this.mustGetTask(taskId);

    const nextDependsOn =
      patch.dependsOn !== undefined ? this.normalizeDependsOn(patch.dependsOn) : task.dependsOn;

    if (patch.dependsOn !== undefined) {
      this.assertNoCycle(taskId, nextDependsOn);
      this.syncDependencies(taskId, nextDependsOn);
    }

    const next: SwarmTask = {
      ...task,
      ...patch,
      dependsOn: nextDependsOn,
    };

    this.tasks.set(taskId, next);
    if (this.dag.hasNode(taskId)) {
      this.dag.setNodeData(taskId, {
        taskId: next.taskId,
        assignee: next.assignee,
        status: next.status,
      });
    } else {
      this.dag.addNode(taskId, {
        taskId: next.taskId,
        assignee: next.assignee,
        status: next.status,
      });
    }

    if (patch.dependsOn !== undefined && patch.status === undefined) {
      this.refreshBlockedState(taskId);
    }

    return this.mustGetTask(taskId);
  }

  public addDependency(taskId: string, dependencyId: string): SwarmTask {
    const task = this.mustGetTask(taskId);
    if (task.dependsOn.includes(dependencyId)) {
      return task;
    }

    const updated = this.updateTask(taskId, {
      dependsOn: [...task.dependsOn, dependencyId],
    });

    if (
      updated.status !== TASK_STATUS.CLAIMED &&
      updated.status !== TASK_STATUS.IN_PROGRESS &&
      updated.status !== TASK_STATUS.COMPLETED &&
      updated.status !== TASK_STATUS.FAILED
    ) {
      return this.updateTask(taskId, { status: TASK_STATUS.BLOCKED });
    }

    return updated;
  }

  public removeDependency(taskId: string, dependencyId: string): SwarmTask {
    const task = this.mustGetTask(taskId);
    if (!task.dependsOn.includes(dependencyId)) {
      return task;
    }

    const updated = this.updateTask(taskId, {
      dependsOn: task.dependsOn.filter((id) => id !== dependencyId),
    });

    this.refreshBlockedState(taskId);
    return updated;
  }

  public getAllChildren(taskId: string): string[] {
    if (!this.dag.hasNode(taskId)) {
      return [];
    }
    return this.dag.dependantsOf(taskId).filter((childId) => this.getTask(childId) !== undefined);
  }

  public completeTask(params: { taskId: string; result: "success" | "failure" }): {
    taskId: string;
    status: SwarmTask["status"];
    unblockedTasks: string[];
  } {
    const status = params.result === "failure" ? TASK_STATUS.FAILED : TASK_STATUS.COMPLETED;
    const task = this.updateTask(params.taskId, {
      status,
      completedAt: Date.now(),
    });

    const unblockedTasks: string[] = [];
    if (status === TASK_STATUS.COMPLETED) {
      if (this.dag.hasNode(params.taskId)) {
        for (const childId of this.dag.directDependantsOf(params.taskId)) {
          if (this.getTask(childId) && this.refreshBlockedState(childId)) {
            unblockedTasks.push(childId);
          }
        }
      }
    }

    return { taskId: task.taskId, status, unblockedTasks };
  }

  private normalizePriority(value?: SwarmTask["priority"] | keyof typeof PRIORITY_ORDER): number {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value in PRIORITY_ORDER) {
      return PRIORITY_ORDER[value];
    }
    return PRIORITY_ORDER.normal;
  }

  private normalizeDependsOn(dependsOn?: string[]): string[] {
    if (!dependsOn || dependsOn.length === 0) {
      return [];
    }
    return Array.from(new Set(dependsOn));
  }

  private nextTaskId(): string {
    this.taskSeq += 1;
    return `${this.teamId}:t${this.taskSeq}`;
  }

  private mustGetTask(taskId: string): SwarmTask {
    const task = this.getTask(taskId);
    if (!task) {
      throw new Error(`Task "${taskId}" not found.`);
    }
    return task;
  }

  private ensureNode(taskId: string): void {
    if (this.dag.hasNode(taskId)) {
      return;
    }
    const task = this.getTask(taskId);
    this.dag.addNode(taskId, {
      taskId,
      assignee: task?.assignee ?? "unknown",
      status: task?.status ?? TASK_STATUS.BLOCKED,
    });
  }

  private syncDependencies(taskId: string, nextDependsOn: string[]): void {
    this.ensureNode(taskId);

    const current = this.dag.directDependenciesOf(taskId);
    for (const depId of current) {
      if (!nextDependsOn.includes(depId)) {
        this.dag.removeDependency(taskId, depId);
      }
    }

    for (const depId of nextDependsOn) {
      this.ensureNode(depId);
      if (!this.dag.directDependenciesOf(taskId).includes(depId)) {
        this.dag.addDependency(taskId, depId);
      }
    }
  }

  private assertNoCycle(taskId: string, nextDependsOn: string[]): void {
    const trial = this.dag.clone();

    if (!trial.hasNode(taskId)) {
      trial.addNode(taskId, {
        taskId,
        assignee: this.getTask(taskId)?.assignee ?? "unknown",
        status: this.getTask(taskId)?.status ?? TASK_STATUS.BLOCKED,
      });
    }

    const current = trial.directDependenciesOf(taskId);
    for (const depId of current) {
      if (!nextDependsOn.includes(depId)) {
        trial.removeDependency(taskId, depId);
      }
    }

    for (const depId of nextDependsOn) {
      if (!trial.hasNode(depId)) {
        trial.addNode(depId, {
          taskId: depId,
          assignee: this.getTask(depId)?.assignee ?? "unknown",
          status: this.getTask(depId)?.status ?? TASK_STATUS.BLOCKED,
        });
      }
      if (!trial.directDependenciesOf(taskId).includes(depId)) {
        trial.addDependency(taskId, depId);
      }
    }

    trial.overallOrder();
  }

  private refreshBlockedState(taskId: string): boolean {
    const task = this.getTask(taskId);
    if (!task) {
      return false;
    }

    if (
      task.status === TASK_STATUS.COMPLETED ||
      task.status === TASK_STATUS.FAILED ||
      task.status === TASK_STATUS.CLAIMED ||
      task.status === TASK_STATUS.IN_PROGRESS
    ) {
      return false;
    }

    const isUnblocked = task.dependsOn.every((depId) => {
      const dep = this.getTask(depId);
      return !dep || dep.status === TASK_STATUS.COMPLETED;
    });

    const nextStatus = isUnblocked ? TASK_STATUS.PENDING : TASK_STATUS.BLOCKED;
    if (task.status === nextStatus) {
      return false;
    }

    this.updateTask(taskId, { status: nextStatus });
    return nextStatus === TASK_STATUS.PENDING;
  }
}

export class AgentSwarm {
  private static readonly graphsByTeam = new Map<string, Graph>();
  private static readonly idleCheckers = new Map<string, ReturnType<typeof setInterval>>();
  private static readonly idleClaimsInFlight = new Set<string>();
  private readonly opts: AgentSwarmOptions;

  constructor(opts?: AgentSwarmOptions) {
    this.opts = opts ?? {};
  }

  public async teamCreate(_toolCallId: string, args: unknown) {
    const cfg = loadConfig();
    if (!cfg.gateway?.teams?.enabled) {
      return jsonResult({ status: "error", error: "Teams are not enabled." });
    }

    try {
      const params = this.readParams(args);
      const teamName = readStringParam(params, "teamName", { required: true });
      const instruction = readStringParam(params, "instruction", { required: true });

      const duplicate = Team.listActive().find((team) => team.teamName === teamName);
      if (duplicate) {
        return jsonResult({
          status: "error",
          error: `Team "${teamName}" already exists (ID: ${duplicate.teamId}).`,
        });
      }

      const team = Team.create({
        teamName,
        instruction,
        creatorSessionKey: this.opts.agentSessionKey,
      });

      const initTask = this.graphFor(team.teamId).addTask({
        title: TASK_INIT,
        instruction,
        assignTo: RESERVED_MATE_ID.LEAD,
        priority: "critical",
        taskClass: "primary",
        contextSessionKey: this.resolveLeadSessionKey(team),
      });

      // !Important.
      this.setIdle(team.teamId, RESERVED_MATE_ID.LEAD);

      return jsonResult({
        status: "created",
        teamId: team.teamId,
        teamName: team.teamName,
        teamAgentId: this.readTeamAgentId(team),
        initTaskId: initTask.taskId,
      });
    } catch (err) {
      return jsonResult({ status: "error", error: this.message(err, "failed to create team") });
    }
  }

  public async askQuestion(_toolCallId: string, args: unknown) {
    const cfg = loadConfig();
    if (!cfg.gateway?.teams?.enabled) {
      return jsonResult({ status: "error", error: "Teams are not enabled." });
    }

    try {
      const params = this.readParams(args);
      const teamId = readStringParam(params, "teamId", { required: true });
      const teammateId = readStringParam(params, "teammateId", { required: true });
      const taskId = readStringParam(params, "taskId", { required: true });
      const dependencyTaskId = readStringParam(params, "dependencyTaskId", { required: true });
      const questionText = readStringParam(params, "questionText", { required: true });
      const mode = this.readAskMode(params.mode);

      const team = Team.get(teamId);
      if (!team) {
        return jsonResult({ status: "error", error: `Team "${teamId}" not found.` });
      }

      const currentTask = this.graphFor(teamId).getTask(taskId);
      if (!currentTask) {
        return jsonResult({ status: "error", error: `Task "${taskId}" not found.` });
      }
      const currentTaskId = currentTask.taskId;
      if (currentTask.assignee !== teammateId) {
        return jsonResult({ status: "error", error: "You can only ask for your assigned task." });
      }

      const targetTask = this.graphFor(teamId).getTask(dependencyTaskId);
      if (!targetTask) {
        return jsonResult({ status: "error", error: `Task "${dependencyTaskId}" not found.` });
      }
      if (!currentTask.dependsOn.includes(dependencyTaskId)) {
        return jsonResult({
          status: "error",
          error: `Task "${dependencyTaskId}" is not a dependency of "${currentTaskId}".`,
        });
      }

      const questionTask = this.graphFor(teamId).addTask({
        title: "qn_request",
        instruction: questionText,
        assignTo: targetTask.assignee,
        priority: "high",
        taskClass: "secondary",
        contextSessionKey: targetTask.contextSessionKey,
        onSubmit: (taskId: string, reply: string) => {
          this.insertQuestionAnswerForChildren(teamId, {
            questionTaskId: taskId,
            question: questionText,
            answer: reply,
          });
        },
      });
      this.ensureIdleCheckerForAssignee(teamId, questionTask.assignee);
      let blockedTaskId = currentTaskId;
      let blockedDependsOn: string[];
      let requesterCloneId: string | undefined;
      let targetCloneId: string | undefined;

      if (mode === "edit") {
        const children = this.graphFor(teamId).getAllChildren(currentTaskId);
        for (const childId of children) {
          this.graphFor(teamId).removeDependency(childId, currentTaskId);
        }

        const targetClone = this.cloneTask(teamId, targetTask, {
          taskClass: "primary",
          status: TASK_STATUS.BLOCKED,
          dependsOn: [currentTaskId],
        });
        targetCloneId = targetClone.taskId;

        const requesterClone = this.cloneTask(teamId, currentTask, {
          taskClass: "primary",
          status: TASK_STATUS.BLOCKED,
          dependsOn: [targetClone.taskId, questionTask.taskId],
        });
        requesterCloneId = requesterClone.taskId;

        for (const childId of children) {
          this.graphFor(teamId).addDependency(childId, requesterClone.taskId);
        }

        this.graphFor(teamId).completeTask({
          taskId: currentTaskId,
          result: "success",
        });

        blockedTaskId = requesterClone.taskId;
        blockedDependsOn = requesterClone.dependsOn;
      } else {
        this.graphFor(teamId).addDependency(currentTaskId, questionTask.taskId);
        const blocked = this.graphFor(teamId).updateTask(currentTaskId, {
          status: TASK_STATUS.BLOCKED,
        });
        blockedDependsOn = blocked.dependsOn;
      }

      this.setIdle(teamId, teammateId);

      return jsonResult({
        status: "queued",
        teamId,
        questionTaskId: questionTask.taskId,
        blockedTaskId,
        dependsOn: blockedDependsOn,
        mode,
        requesterCloneId,
        targetCloneId,
      });
    } catch (err) {
      return jsonResult({ status: "error", error: this.message(err, "question failed") });
    }
  }

  public async taskSubmit(_toolCallId: string, args: unknown) {
    const cfg = loadConfig();
    if (!cfg.gateway?.teams?.enabled) {
      return jsonResult({ status: "error", error: "Teams are not enabled." });
    }

    try {
      const params = this.readParams(args);
      const teamId = readStringParam(params, "teamId", { required: true });
      const teammateId = readStringParam(params, "teammateId", { required: true });
      const taskId = readStringParam(params, "taskId", { required: true });
      const answer = readStringParam(params, "answer", { required: true });
      const errorText =
        this.readOptionalError(params.errorText) ?? this.readOptionalError(params.error);

      const task = this.graphFor(teamId).getTask(taskId);
      if (!task) {
        return jsonResult({ status: "error", error: `Task "${taskId}" not found.` });
      }
      if (task.assignee !== teammateId) {
        return jsonResult({ status: "error", error: "You can only submit your assigned task." });
      }
      if (task.status === TASK_STATUS.BLOCKED) {
        return jsonResult({
          status: "error",
          error: `Task "${task.taskId}" is blocked by dependencies and cannot be submitted.`,
        });
      }

      if (errorText) {
        await this.discardFailedTaskChanges(teamId, task).catch(() => {});
        const failed = this.graphFor(teamId).completeTask({
          taskId,
          result: "failure",
        });
        // Force to go idle.
        this.setIdle(teamId, teammateId);
        return jsonResult({
          status: "failed",
          taskId,
          taskStatus: failed.status,
          unblockedTasks: failed.unblockedTasks,
          error: errorText,
        });
      }

      this.graphFor(teamId).updateTask(taskId, { submit: answer });
      let primaryCommitId: string | undefined;
      let primaryPrRef: string | undefined;
      let primaryMergedTo: string | undefined;
      if (task.taskClass === "primary") {
        try {
          const integrated = await this.commitRaisePrAndMerge(teamId, task, answer);
          primaryCommitId = integrated.commitId;
          primaryPrRef = integrated.prRef;
          primaryMergedTo = integrated.teamBranch;
          this.graphFor(teamId).updateTask(taskId, { commitId: integrated.commitId });
        } catch (err) {
          await this.discardFailedTaskChanges(teamId, task).catch(() => {});
          const failed = this.graphFor(teamId).completeTask({
            taskId,
            result: "failure",
          });
          this.setIdle(teamId, teammateId);
          return jsonResult({
            status: "failed",
            taskId,
            taskStatus: failed.status,
            unblockedTasks: failed.unblockedTasks,
            error: this.message(err, "primary task merge failed"),
          });
        }
      } else if (task.onSubmit) {
        // Hook to insert secondary answer submit to session chat.
        task.onSubmit(taskId, answer);
      }

      const completed = this.graphFor(teamId).completeTask({
        taskId,
        result: "success",
      });
      this.setIdle(teamId, teammateId);

      return jsonResult({
        status: "completed",
        taskId: completed.taskId,
        taskStatus: completed.status,
        unblockedTasks: completed.unblockedTasks,
        commitId: primaryCommitId,
        prRef: primaryPrRef,
        mergedTo: primaryMergedTo,
      });
    } catch (err) {
      return jsonResult({ status: "error", error: this.message(err, "submit failed") });
    }
  }

  private cloneTask(
    teamId: string,
    source: SwarmTask,
    patch: {
      taskClass: SwarmTask["taskClass"];
      status: SwarmTask["status"];
      dependsOn: string[];
    },
  ) {
    const cloned = this.graphFor(teamId).addTask({
      title: source.title,
      instruction: source.instruction,
      assignTo: source.assignee,
      priority: source.priority,
      dependsOn: patch.dependsOn,
      taskClass: patch.taskClass,
      status: patch.status,
      contextSessionKey: source.contextSessionKey,
      onSubmit: source.onSubmit,
    });

    this.graphFor(teamId).updateTask(cloned.taskId, { clones: (source.clones ?? 1) + 1 });
    this.ensureIdleCheckerForAssignee(teamId, cloned.assignee);
    return cloned;
  }

  private resolveLeadSessionKey(team: SwarmTeamRecord): string {
    const session = (this.opts.agentSessionKey ?? "").trim();
    if (session) {
      return session;
    }
    return `agent:${this.readTeamAgentId(team)}:${RESERVED_MATE_ID.LEAD}`;
  }

  private graphFor(teamId: string): Graph {
    const existing = AgentSwarm.graphsByTeam.get(teamId);
    if (existing) {
      return existing;
    }
    const created = new Graph(teamId);
    AgentSwarm.graphsByTeam.set(teamId, created);
    return created;
  }

  private setIdle(teamId: string, teammateId: string): void {
    const previousTask = this.currentTaskForTeammate(teamId, teammateId);
    if (
      previousTask &&
      previousTask.status !== TASK_STATUS.COMPLETED &&
      previousTask.status !== TASK_STATUS.FAILED
    ) {
      this.emitInterrupt({
        teamId,
        teammateId,
        sessionKey: previousTask.contextSessionKey,
        reason: `Task "${previousTask.taskId}" was interrupted because teammate transitioned to idle.`,
      });
    }
    Team.setIdle(teamId, teammateId);
    this.registerIdleTaskChecker(teamId, teammateId);
  }

  private sendTaskToTeammate(teamId: string, teammateId: string, taskId: string): void {
    this.clearIdleTaskChecker(teamId, teammateId);
    Team.setWorking(teamId, teammateId, taskId);
    const task = this.graphFor(teamId).getTask(taskId);
    if (!task) {
      return;
    }
    this.emitBootstrap({
      teamId,
      teammateId,
      taskId,
      sessionKey: task.contextSessionKey,
      title: task.title,
      instruction: task.instruction,
    });
  }

  private registerIdleTaskChecker(teamId: string, teammateId: string): void {
    this.clearIdleTaskChecker(teamId, teammateId);
    const key = this.idleCheckerKey(teamId, teammateId);

    const pid = setInterval(() => {
      if (AgentSwarm.idleClaimsInFlight.has(key)) {
        return;
      }
      AgentSwarm.idleClaimsInFlight.add(key);
      void this.claimPendingForIdle(teamId, teammateId)
        .catch(() => {
          // Keep idle checker alive; next tick can retry when transient git/worktree issues clear.
        })
        .finally(() => {
          AgentSwarm.idleClaimsInFlight.delete(key);
        });
    }, 333);

    AgentSwarm.idleCheckers.set(key, pid);
  }

  private clearIdleTaskChecker(teamId: string, teammateId: string): void {
    const key = this.idleCheckerKey(teamId, teammateId);
    const existing = AgentSwarm.idleCheckers.get(key);
    if (!existing) {
      return;
    }
    clearInterval(existing);
    AgentSwarm.idleCheckers.delete(key);
    AgentSwarm.idleClaimsInFlight.delete(key);
  }

  private idleCheckerKey(teamId: string, teammateId: string): string {
    return `${teamId}:${teammateId}`;
  }

  private readAskMode(value: unknown): SwarmAskMode {
    return value === "edit" ? "edit" : "read";
  }

  private readOptionalError(value: unknown): string | undefined {
    if (typeof value === "string") {
      const text = value.trim();
      return text || undefined;
    }
    if (value === true) {
      return "Task failed due to execution error.";
    }
    if (!value || typeof value !== "object") {
      return undefined;
    }

    const asRecord = value as Record<string, unknown>;
    const code = typeof asRecord.code === "string" ? asRecord.code.trim() : "";
    const message =
      typeof asRecord.message === "string"
        ? asRecord.message.trim()
        : typeof asRecord.error === "string"
          ? asRecord.error.trim()
          : "";
    const text = [code, message].filter(Boolean).join(": ");
    return text || undefined;
  }

  private readParams(args: unknown): Record<string, unknown> {
    if (!args || typeof args !== "object") {
      throw new Error("Invalid tool arguments");
    }
    return args as Record<string, unknown>;
  }

  private message(err: unknown, fallback: string): string {
    return err instanceof Error ? err.message : typeof err === "string" ? err : fallback;
  }

  private readTeamAgentId(team: SwarmTeamRecord): string {
    const explicit = (team as unknown as { teamAgentId?: string }).teamAgentId;
    if (explicit && explicit.trim()) {
      return explicit;
    }
    return `team-${team.teamId}`;
  }

  private ensureIdleCheckerForAssignee(teamId: string, assignee: string): void {
    const team = Team.get(teamId);
    if (!team) {
      return;
    }

    const teammate = this.findTeammate(team, assignee);
    if (!teammate) {
      this.setIdle(teamId, assignee);
      return;
    }
    if (teammate.status === MATE_STATUS.IDLE) {
      this.registerIdleTaskChecker(teamId, assignee);
    }
  }

  private currentTaskForTeammate(teamId: string, teammateId: string): SwarmTask | undefined {
    const team = Team.get(teamId);
    if (!team) {
      return undefined;
    }
    const teammate = this.findTeammate(team, teammateId);
    const taskId = teammate?.currentTaskId;
    if (!taskId) {
      return undefined;
    }
    return this.graphFor(teamId).getTask(taskId);
  }

  private findTeammate(team: SwarmTeamRecord, teammateId: string): SwarmTeamMember | undefined {
    const teammates = (
      team as unknown as {
        teammates: Map<string, SwarmTeamMember> | Record<string, SwarmTeamMember>;
      }
    ).teammates;
    if (teammates instanceof Map) {
      return teammates.get(teammateId);
    }
    return teammates[teammateId];
  }

  private emitBootstrap(params: {
    teamId: string;
    teammateId: string;
    taskId: string;
    sessionKey: string;
    title: string;
    instruction: string;
  }): void {
    const send = this.opts.sessionHooks?.sendBootstrap;
    if (!send) {
      return;
    }
    this.runSessionHook(send(params));
  }

  private emitSessionNote(params: { teamId: string; sessionKey: string; note: string }): void {
    const append = this.opts.sessionHooks?.appendSessionNote;
    if (!append) {
      return;
    }
    this.runSessionHook(append(params));
  }

  private emitInterrupt(params: {
    teamId: string;
    teammateId: string;
    sessionKey: string;
    reason: string;
  }): void {
    const interrupt = this.opts.sessionHooks?.interruptSession;
    if (!interrupt) {
      return;
    }
    this.runSessionHook(interrupt(params));
  }

  private runSessionHook(result: void | Promise<void>): void {
    if (!result) {
      return;
    }
    void result.catch(() => {
      // hooks are best-effort and must not break task orchestration
    });
  }

  private insertQuestionAnswerForChildren(
    teamId: string,
    params: { questionTaskId: string; question: string; answer: string },
  ): void {
    const question = params.question.trim();
    const answer = params.answer.trim();
    if (!question || !answer) {
      return;
    }

    const graph = this.graphFor(teamId);
    const descendantTaskIds = graph.getAllChildren(params.questionTaskId);
    if (descendantTaskIds.length === 0) {
      return;
    }

    const contextSessionKeys = new Set<string>();
    for (const taskId of descendantTaskIds) {
      const task = graph.getTask(taskId);
      if (!task) {
        continue;
      }
      const sessionKey = task.contextSessionKey.trim();
      if (!sessionKey) {
        continue;
      }
      contextSessionKeys.add(sessionKey);
    }

    const transcript = `Dependency Q&A:\nQ: ${question}\nA: ${answer}`;
    const appendHook = this.opts.sessionHooks?.appendSessionNote;
    if (appendHook) {
      for (const sessionKey of contextSessionKeys) {
        this.emitSessionNote({ teamId, sessionKey, note: transcript });
      }
      return;
    }

    // Fallback when no session hook is wired: append to task instruction so context is still retained.
    for (const sessionKey of contextSessionKeys) {
      const activeTasks = graph.listActiveTasksBySession(sessionKey);
      for (const targetTask of activeTasks) {
        const nextInstruction = `${targetTask.instruction}\n\n${transcript}`;
        graph.updateTask(targetTask.taskId, { instruction: nextInstruction });
      }
    }
  }

  private async discardFailedTaskChanges(teamId: string, task: SwarmTask): Promise<void> {
    const sessionName = task.contextSessionKey.trim();
    if (!sessionName) {
      return;
    }

    const workspaceDir = this.sessionWorkspaceDir(teamId, sessionName);
    if (!(await this.pathExists(workspaceDir))) {
      return;
    }

    const restore = await runCommandWithTimeout(
      ["git", "-C", workspaceDir, "restore", "--worktree", "--staged", "."],
      { timeoutMs: GIT_TIMEOUT_MS },
    );
    if (restore.code === 0) {
      return;
    }

    await runCommandWithTimeout(["git", "-C", workspaceDir, "checkout", "--", "."], {
      timeoutMs: GIT_TIMEOUT_MS,
    });
  }

  private async claimPendingForIdle(teamId: string, teammateId: string): Promise<void> {
    const graph = this.graphFor(teamId);
    const claimTask = graph
      .listTasks()
      .filter((task) => task.assignee === teammateId && task.status === TASK_STATUS.PENDING)
      .toSorted((a, b) => {
        const byPriority = b.priority - a.priority;
        if (byPriority !== 0) {
          return byPriority;
        }
        return a.createdAt - b.createdAt;
      })[0];

    if (!claimTask) {
      return;
    }

    const claimed = graph.claimIfPending(claimTask.taskId);
    if (claimed.status === TASK_STATUS.CLAIMED) {
      try {
        await this.switchTaskWorktreeAndBranch(teamId, claimed);
      } catch (err) {
        graph.updateTask(claimed.taskId, { status: TASK_STATUS.PENDING, claimedAt: 0 });
        throw err;
      }
      this.sendTaskToTeammate(teamId, teammateId, claimed.taskId);
    }
  }

  private async switchTaskWorktreeAndBranch(
    teamId: string,
    task: SwarmTask,
    opts?: { syncWithTeam?: boolean },
  ): Promise<void> {
    const syncWithTeam = opts?.syncWithTeam ?? true;
    const sessionName = task.contextSessionKey.trim();
    if (!sessionName) {
      throw new Error(`Task "${task.taskId}" has no session name.`);
    }

    const gitRoot = await this.detectGitRoot(process.cwd());
    if (!gitRoot) {
      return;
    }

    const workspaceDir = this.sessionWorkspaceDir(teamId, sessionName);
    await fs.mkdir(path.dirname(workspaceDir), { recursive: true });

    await this.ensureWorktree(gitRoot, workspaceDir, `session "${sessionName}"`);
    await this.ensureTeamBranchWorktree(teamId, gitRoot);
    const teamBranch = this.teamBranchName(teamId);
    const branchExists = await this.branchExists(workspaceDir, sessionName);
    if (!branchExists) {
      await this.switchBranch(workspaceDir, sessionName, teamBranch);
      return;
    }

    await this.switchBranch(workspaceDir, sessionName);
    if (!syncWithTeam) {
      return;
    }

    const dirty = await this.isWorktreeDirty(workspaceDir);
    if (dirty) {
      throw new Error(
        `Task "${task.taskId}" branch "${sessionName}" has local changes; cannot rebase before starting work.`,
      );
    }

    const rebase = await runCommandWithTimeout(["git", "-C", workspaceDir, "rebase", teamBranch], {
      timeoutMs: GIT_TIMEOUT_MS,
    });
    if (rebase.code !== 0) {
      await runCommandWithTimeout(["git", "-C", workspaceDir, "rebase", "--abort"], {
        timeoutMs: GIT_TIMEOUT_MS,
      });
      throw new Error(
        `Failed to rebase branch "${sessionName}" onto "${teamBranch}" before starting task "${task.taskId}".`,
      );
    }
  }

  private async detectGitRoot(cwd: string): Promise<string | undefined> {
    const res = await runCommandWithTimeout(["git", "-C", cwd, "rev-parse", "--show-toplevel"], {
      timeoutMs: GIT_TIMEOUT_MS,
    });
    if (res.code !== 0) {
      return undefined;
    }
    const root = res.stdout.trim();
    return root ? path.resolve(root) : undefined;
  }

  private async hasWorktree(gitRoot: string, workspaceDir: string): Promise<boolean> {
    const res = await runCommandWithTimeout(
      ["git", "-C", gitRoot, "worktree", "list", "--porcelain"],
      { timeoutMs: GIT_TIMEOUT_MS },
    );
    if (res.code !== 0) {
      return false;
    }
    const target = path.resolve(workspaceDir);
    for (const line of res.stdout.split("\n")) {
      if (!line.startsWith("worktree ")) {
        continue;
      }
      const listed = path.resolve(line.slice("worktree ".length).trim());
      if (listed === target) {
        return true;
      }
    }
    return false;
  }

  private async pathExists(target: string): Promise<boolean> {
    try {
      await fs.access(target);
      return true;
    } catch {
      return false;
    }
  }

  private async commitRaisePrAndMerge(
    teamId: string,
    task: SwarmTask,
    answer: string,
  ): Promise<{ commitId: string; prRef: string; teamBranch: string }> {
    const sessionName = task.contextSessionKey.trim();
    if (!sessionName) {
      throw new Error(`Task "${task.taskId}" has no session name.`);
    }

    const gitRoot = await this.detectGitRoot(process.cwd());
    if (!gitRoot) {
      throw new Error("Git root not found.");
    }

    await this.switchTaskWorktreeAndBranch(teamId, task, { syncWithTeam: false });
    const sourceWorkspace = this.sessionWorkspaceDir(teamId, sessionName);
    const teamWorkspace = await this.ensureTeamBranchWorktree(teamId, gitRoot);
    const teamBranch = this.teamBranchName(teamId);

    await this.gitOrThrow(
      ["git", "-C", sourceWorkspace, "add", "-A"],
      "Failed to stage task changes.",
    );

    const commitTitle = `task_submit: ${task.title} (${task.taskId})`;
    const commitBody = answer.trim() ? answer.trim() : "No answer body provided.";
    await this.gitOrThrow(
      [
        "git",
        "-C",
        sourceWorkspace,
        "commit",
        "--allow-empty",
        "-m",
        commitTitle,
        "-m",
        commitBody,
      ],
      `Failed to commit task "${task.taskId}".`,
    );

    const commitRes = await this.gitOrThrow(
      ["git", "-C", sourceWorkspace, "rev-parse", "HEAD"],
      "Failed to resolve commit SHA.",
    );
    const commitId = commitRes.stdout.trim();
    const prRef = `pr:${sessionName}->${teamBranch}:${commitId.slice(0, 12)}`;

    const merge = await runCommandWithTimeout(
      ["git", "-C", teamWorkspace, "merge", "--no-ff", "--no-edit", sessionName],
      { timeoutMs: GIT_TIMEOUT_MS },
    );
    if (merge.code !== 0) {
      await runCommandWithTimeout(["git", "-C", teamWorkspace, "merge", "--abort"], {
        timeoutMs: GIT_TIMEOUT_MS,
      });
      throw new Error(`Failed to merge "${sessionName}" into "${teamBranch}".`);
    }

    return { commitId, prRef, teamBranch };
  }

  private async ensureTeamBranchWorktree(teamId: string, gitRoot: string): Promise<string> {
    const teamWorkspace = this.teamWorkspaceDir(teamId);
    await fs.mkdir(path.dirname(teamWorkspace), { recursive: true });
    await this.ensureWorktree(gitRoot, teamWorkspace, `team "${teamId}"`);
    await this.switchBranch(teamWorkspace, this.teamBranchName(teamId));
    return teamWorkspace;
  }

  private async ensureWorktree(
    gitRoot: string,
    workspaceDir: string,
    label: string,
  ): Promise<void> {
    const isRegistered = await this.hasWorktree(gitRoot, workspaceDir);
    if (isRegistered) {
      return;
    }
    const exists = await this.pathExists(workspaceDir);
    if (exists) {
      return;
    }
    const add = await runCommandWithTimeout(
      ["git", "-C", gitRoot, "worktree", "add", "--detach", workspaceDir],
      { timeoutMs: GIT_TIMEOUT_MS },
    );
    if (add.code !== 0) {
      throw new Error(`Failed to create worktree for ${label}.`);
    }
  }

  private async switchBranch(
    workspaceDir: string,
    branchName: string,
    startPoint?: string,
  ): Promise<void> {
    const exists = await this.branchExists(workspaceDir, branchName);
    const switchArgs = exists
      ? ["git", "-C", workspaceDir, "switch", branchName]
      : startPoint
        ? ["git", "-C", workspaceDir, "switch", "-c", branchName, startPoint]
        : ["git", "-C", workspaceDir, "switch", "-c", branchName];
    await this.gitOrThrow(switchArgs, `Failed to switch branch "${branchName}".`);
  }

  private async branchExists(workspaceDir: string, branchName: string): Promise<boolean> {
    const branchRef = `refs/heads/${branchName}`;
    const exists = await runCommandWithTimeout(
      ["git", "-C", workspaceDir, "show-ref", "--verify", "--quiet", branchRef],
      { timeoutMs: GIT_TIMEOUT_MS },
    );
    return exists.code === 0;
  }

  private async isWorktreeDirty(workspaceDir: string): Promise<boolean> {
    const status = await this.gitOrThrow(
      ["git", "-C", workspaceDir, "status", "--porcelain"],
      "Failed to inspect task branch status.",
    );
    return status.stdout.trim().length > 0;
  }

  private async gitOrThrow(
    command: string[],
    message: string,
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    const res = await runCommandWithTimeout(command, { timeoutMs: GIT_TIMEOUT_MS });
    if (res.code !== 0) {
      throw new Error(message);
    }
    return { code: 0, stdout: res.stdout, stderr: res.stderr };
  }

  private sessionWorkspaceDir(teamId: string, sessionName: string): string {
    return path.resolve(WORKTREE_ROOT, teamId, sessionName);
  }

  private teamWorkspaceDir(teamId: string): string {
    return path.resolve(WORKTREE_ROOT, teamId, TEAM_WORKTREE_DIR);
  }

  private teamBranchName(teamId: string): string {
    return `team-${teamId}`;
  }
}
