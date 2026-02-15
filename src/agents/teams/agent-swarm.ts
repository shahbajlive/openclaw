import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { createHash } from "node:crypto";
import { loadConfig } from "../../config/io.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { jsonResult, readNumberParam, readStringParam } from "../tools/common.js";
import { Graph, PendingTaskQueue } from "./graph.js";
import {
  type AgentSwarmOptions,
  type DependencyNote,
  type DependencyNotesByTaskId,
  type EndTaskChronologyCacheEntry,
  type PropagationMetrics,
  RESERVED_MATE_ID,
  TASK_STATUS,
  type TaskFrontierVector,
  type TaskPlanItem,
  type TaskChatCheckpoint,
  type TaskStructuredEvent,
  type TaskRevisionCause,
  type TaskRevisionRecord,
  type TaskRevisionRegistry,
  type SwarmAddTaskParams,
  type SwarmAskMode,
  type SwarmTask,
} from "./types.js";
import { TeamWorktree } from "./worktree.js";

const TASK_INIT = "Create Subtask";
const TASK_END = "end_task";
const TASK_ACCUMULATOR = "task_accumulator";
const SYSTEM_AUTO_ASSIGNEE = "__system__";
const GIT_TIMEOUT_MS = 15_000;
type SwarmRunRecord = {
  teamId: string;
  teamName: string;
  instruction: string;
  creatorSessionKey?: string;
  teamAgentId: string;
  endTaskId?: string;
  createdAt: number;
  updatedAt: number;
};

const STRUCTURED_EVENT_TOKEN_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "if",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "to",
  "with",
]);

export class AgentSwarm {
  private static readonly runsByTeam = new Map<string, SwarmRunRecord>();
  private static readonly graphsByTeam = new Map<string, Graph>();
  private static readonly revisionsByTeam = new Map<string, TaskRevisionRegistry>();
  private static readonly readyQueuesBySession = new Map<string, PendingTaskQueue>();
  private static readonly sessionClaimsQueued = new Set<string>();
  private static readonly sessionClaimsInFlight = new Set<string>();
  private static readonly activeTaskBySession = new Map<string, string>();
  private static readonly propagationQueueByTeam = new Map<string, Set<string>>();
  private static readonly propagationInFlightByTeam = new Set<string>();
  private static readonly frontierMemoByTeam = new Map<string, Map<string, TaskFrontierVector>>();
  private static readonly latestRevisionCacheByTeam = new Map<string, Map<string, number>>();
  private static readonly propagationMetricsByTeam = new Map<string, PropagationMetrics>();
  private static readonly endTaskChronologyCacheByTeam = new Map<
    string,
    EndTaskChronologyCacheEntry
  >();
  private static readonly completionEvalQueuedByTeam = new Set<string>();
  private static readonly interruptQueueByTeam = new Map<string, Set<string>>();
  private static readonly interruptDispatchQueuedByTeam = new Set<string>();
  private static readonly deliveredDependencyNotesByTeam = new Map<
    string,
    Map<string, Record<string, number>>
  >();
  private static readonly FRONTIER_MEMO_LIMIT = 512;
  private static readonly REVISION_CACHE_LIMIT = 2048;
  private readonly opts: AgentSwarmOptions;
  private readonly worktree = new TeamWorktree({ gitTimeoutMs: GIT_TIMEOUT_MS });

  constructor(opts?: AgentSwarmOptions) {
    this.opts = opts ?? {};
  }

  private listRuns(): SwarmRunRecord[] {
    return Array.from(AgentSwarm.runsByTeam.values());
  }

  private getRun(teamId: string): SwarmRunRecord | undefined {
    return AgentSwarm.runsByTeam.get(teamId);
  }

  private createRun(params: {
    teamName: string;
    instruction: string;
    creatorSessionKey?: string;
  }): SwarmRunRecord {
    const teamId = this.resolveRunId(params.teamName);
    const now = Date.now();
    const run = {
      teamId,
      teamName: params.teamName,
      instruction: params.instruction,
      creatorSessionKey: params.creatorSessionKey,
      teamAgentId: `team-${teamId}`,
      createdAt: now,
      updatedAt: now,
    } as SwarmRunRecord;
    AgentSwarm.runsByTeam.set(teamId, run);
    return run;
  }

  private setRunEndTaskId(teamId: string, endTaskId?: string): void {
    const run = this.getRun(teamId);
    if (!run) return;
    run.endTaskId = endTaskId?.trim() || undefined;
    run.updatedAt = Date.now();
  }

  private resolveRunId(teamName: string): string {
    const base =
      teamName
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^[-_]+|[-_]+$/g, "") || "team";

    if (!AgentSwarm.runsByTeam.has(base)) return base;
    for (let i = 1; i < 1000; i += 1) {
      const candidate = `${base}-${i}`;
      if (!AgentSwarm.runsByTeam.has(candidate)) return candidate;
    }
    return `${base}-${Date.now()}`;
  }

  public async teamCreate(_toolCallId: string, args: unknown): Promise<AgentToolResult<unknown>> {
    return this.withTeamsTool("failed to create team", async () => {
      const params = this.readParams(args);
      const teamName = readStringParam(params, "teamName", { required: true });
      const instruction = readStringParam(params, "instruction", { required: true });

      const duplicate = this.listRuns().find((run) => run.teamName === teamName);
      if (duplicate)
        return this.errorResult(`Team "${teamName}" already exists (ID: ${duplicate.teamId}).`);

      const team = this.createRun({
        teamName,
        instruction,
        creatorSessionKey: this.opts.agentSessionKey,
      });

      const initTask = this.addTaskWithRevision(team.teamId, {
        title: TASK_INIT,
        instruction: `Skill: task planner.\n${instruction}`,
        assignTo: RESERVED_MATE_ID.LEAD,
        priority: 2,
        taskClass: "primary",
        contextSessionKey: this.resolveLeadSessionKey(team),
      });

      this.scheduleSessionClaimIfIdle(team.teamId, this.taskSessionKey(initTask));

      return jsonResult({
        status: "created",
        teamId: team.teamId,
        teamName: team.teamName,
        teamAgentId: this.readTeamAgentId(team),
        initTaskId: initTask.taskId,
        propagation: this.propagationDebugStatus(team.teamId),
      });
    });
  }

  public async askQuestion(_toolCallId: string, args: unknown): Promise<AgentToolResult<unknown>> {
    return this.withTeamsTool("question failed", async () => {
      const params = this.readParams(args);
      const { teamId, sessionKey, taskId } = this.resolveTeamToolContext(params, {
        requireTaskId: true,
      });
      const dependencyTaskId = readStringParam(params, "dependencyTaskId", { required: true });
      const questionText = readStringParam(params, "questionText", { required: true });
      const mode = this.readAskMode(params.mode);

      const team = this.getRun(teamId);
      if (!team) return this.errorResult(`Team "${teamId}" not found.`);
      const graph = this.graphFor(teamId);

      const currentTask = graph.getTask(taskId);
      if (!currentTask) return this.errorResult(`Task "${taskId}" not found.`);
      if (currentTask.status === TASK_STATUS.DELETED)
        return this.errorResult(`Task "${taskId}" is deleted.`);
      const currentTaskId = currentTask.taskId;
      if (sessionKey && this.taskSessionKey(currentTask) !== sessionKey) {
        return this.errorResult("You can only ask for your active session task.");
      }

      const targetTask = graph.getTask(dependencyTaskId);
      if (!targetTask) return this.errorResult(`Task "${dependencyTaskId}" not found.`);
      if (targetTask.status === TASK_STATUS.DELETED)
        return this.errorResult(`Task "${dependencyTaskId}" is deleted.`);
      if (!currentTask.dependsOn.includes(dependencyTaskId))
        return this.errorResult(
          `Task "${dependencyTaskId}" is not a dependency of "${currentTaskId}".`,
        );
      let blockedTaskId = currentTaskId;
      let pausedDependsOn: string[] = [];
      let requesterCloneId: string | undefined;
      let targetCloneId: string | undefined;
      let clonedDescendantTaskIds: string[] = [];
      let supersededTaskIds: string[] = [];
      let interruptedSessions: string[] = [];

      if (mode === "edit") {
        const interrupted = new Set<string>();
        this.withGraphMutation(graph, () => {
          const targetSessionKey = this.taskSessionKey(targetTask);
          if (
            (targetTask.status === TASK_STATUS.CLAIMED ||
              targetTask.status === TASK_STATUS.IN_PROGRESS ||
              targetTask.status === TASK_STATUS.PAUSED) &&
            this.currentTaskForSession(teamId, targetSessionKey)?.taskId === targetTask.taskId
          ) {
            interrupted.add(targetSessionKey);
          }

          const nextTargetStatus = this.resolvePropagationTaskStatus(teamId, targetTask);
          const revisedTarget = graph.updateTask(targetTask.taskId, {
            instruction: questionText,
            status: nextTargetStatus,
            claimedAt: 0,
            completedAt: 0,
            submit: "",
            commitId: undefined,
          });
          const targetRevision = this.createTaskRevision(teamId, {
            task: revisedTarget,
            cause: "manual",
            causeTaskId: currentTaskId,
            causeRevision: currentTask.revision,
            forceNewRevision: true,
          });
          this.setLatestRevisionCacheEntry(teamId, targetTask.taskId, targetRevision.revision);

          const paused = graph.updateTask(currentTaskId, {
            status: TASK_STATUS.PAUSED,
          });
          pausedDependsOn = paused.dependsOn;
        });
        interruptedSessions = Array.from(interrupted);
        this.interruptAndPropagateRevisionFromSource(
          teamId,
          targetTask.taskId,
          interruptedSessions,
        );
        requesterCloneId = currentTaskId;
        targetCloneId = targetTask.taskId;
        blockedTaskId = currentTaskId;
      } else {
        const questionTask = this.addTaskWithRevision(teamId, {
          title: "qn_request",
          instruction: questionText,
          assignTo: targetTask.assignee,
          priority: 1,
          taskClass: "secondary",
          contextSessionKey: targetTask.contextSessionKey,
        });
        graph.addDependency(currentTaskId, questionTask.taskId);
        const paused = graph.updateTask(currentTaskId, {
          status: TASK_STATUS.PAUSED,
        });
        pausedDependsOn = paused.dependsOn;
      }

      if (sessionKey) this.setSessionIdle(teamId, sessionKey);

      return jsonResult({
        status: "queued",
        teamId,
        blockedTaskId,
        dependsOn: pausedDependsOn,
        mode,
        requesterCloneId,
        targetCloneId,
        clonedDescendantTaskIds,
        supersededTaskIds,
        interruptedSessions,
      });
    });
  }

  public async taskSearch(_toolCallId: string, args: unknown): Promise<AgentToolResult<unknown>> {
    return this.withTeamsTool("dependency read failed", async () => {
      const params = this.readParams(args);
      const { teamId, sessionKey, taskId } = this.resolveTeamToolContext(params, {
        requireTaskId: true,
      });
      const dependencyTaskId = readStringParam(params, "dependencyTaskId");
      const mode = this.taskSearchMode(params.mode);
      const sinceRevisionId = readStringParam(params, "sinceRevisionId");
      const limit = Math.max(
        1,
        Math.min(50, readNumberParam(params, "limit", { integer: true }) ?? 10),
      );
      const includeChat = params.includeChat === true;
      const chatLimit = Math.max(
        1,
        Math.min(50, readNumberParam(params, "chatLimit", { integer: true }) ?? 10),
      );
      const graph = this.graphFor(teamId);
      const task = graph.getTask(taskId);
      if (!task) return this.errorResult(`Task "${taskId}" not found.`);
      if (task.status === TASK_STATUS.DELETED)
        return this.errorResult(`Task "${taskId}" is deleted.`);
      if (sessionKey && this.taskSessionKey(task) !== sessionKey) {
        return this.errorResult(`Task "${taskId}" is not assigned to current session.`);
      }

      if (dependencyTaskId && !task.dependsOn.includes(dependencyTaskId)) {
        return this.errorResult(`Task "${dependencyTaskId}" is not a dependency of "${taskId}".`);
      }
      const dependencyIds = dependencyTaskId
        ? [dependencyTaskId]
        : Array.from(new Set(task.dependsOn)).toSorted((a, b) => a.localeCompare(b));
      const registry = this.revisionRegistryFor(teamId);
      const notesByDependency = task.dependencyNotes ?? {};
      const dependencies = await Promise.all(
        dependencyIds.map(async (depTaskId) => {
          const dependencyTask = graph.getTask(depTaskId);
          const history = registry.byTaskId.get(depTaskId) ?? [];
          const delta = this.revisionDeltaSince(history, sinceRevisionId);
          const notes = notesByDependency[depTaskId] ?? [];
          const notesSince = this.dependencyNotesSince(notes, delta, sinceRevisionId);
          const revisionSource =
            mode === "history"
              ? delta.revisions
              : sinceRevisionId && delta.found
                ? delta.revisions
                : history;
          const revisionLimit = mode === "history" ? limit : 1;
          const revisions = revisionSource
            .slice(Math.max(0, revisionSource.length - revisionLimit))
            .map((entry) => this.serializeDependencyRevision(entry, mode === "current"));
          const latestStructuredEvents = this.currentStructuredEventsFromRevision(
            history[history.length - 1]?.structuredEvents,
          );
          const dependency = {
            taskId: depTaskId,
            title: dependencyTask?.title,
            status: dependencyTask?.status ?? TASK_STATUS.DELETED,
            latestRevisionId: dependencyTask?.revisionId,
            latestSubmit: dependencyTask?.submit ?? "",
            notesCount: notesSince.length,
            notes: notesSince.slice(Math.max(0, notesSince.length - limit)),
            revisionsCount: history.length,
            revisions,
            latestState: latestStructuredEvents,
            openRisks: latestStructuredEvents.filter((event) => event.kind === "risk"),
            ...(sinceRevisionId
              ? {
                  changesSince: {
                    sinceRevisionId,
                    found: delta.found,
                    revisionsCount: delta.found ? delta.revisions.length : 0,
                    notesCount: delta.found ? notesSince.length : 0,
                    ...(delta.found
                      ? {
                          latestRevisionId: delta.revisions[delta.revisions.length - 1]?.revisionId,
                        }
                      : {}),
                  },
                }
              : {}),
          };

          if (!includeChat) return dependency;
          const sessionKey = dependencyTask?.contextSessionKey?.trim();
          if (!sessionKey) {
            return { ...dependency, chat: [], chatUnavailable: "missing_session_key" };
          }

          const readHistory = this.opts.platform?.readSessionHistory;
          if (!readHistory) {
            return { ...dependency, chat: [], chatUnavailable: "history_hook_unavailable" };
          }

          try {
            const historyResult = await readHistory({ teamId, sessionKey, limit: chatLimit });
            const chat = this.serializeDependencyChat(historyResult.messages, chatLimit);
            return {
              ...dependency,
              chatSessionId: historyResult.sessionId,
              chat,
              chatCount: chat.length,
            };
          } catch {
            return { ...dependency, chat: [], chatUnavailable: "history_read_failed" };
          }
        }),
      );

      return jsonResult({
        status: "ok",
        teamId,
        taskId,
        mode,
        ...(sinceRevisionId ? { sinceRevisionId } : {}),
        includeChat,
        dependencyCount: dependencies.length,
        dependencies,
      });
    });
  }

  public async taskSubmit(_toolCallId: string, args: unknown): Promise<AgentToolResult<unknown>> {
    return this.withTeamsTool("submit failed", async () => {
      const params = this.readParams(args);
      const { teamId, sessionKey, taskId } = this.resolveTeamToolContext(params, {
        requireTaskId: true,
      });
      const submittedRevisionId = readStringParam(params, "revisionId");
      const answer = readStringParam(params, "answer", { required: true });
      const errorText =
        this.readOptionalError(params.errorText) ?? this.readOptionalError(params.error);

      const graph = this.graphFor(teamId);
      const task = graph.getTask(taskId);
      if (!task) return this.errorResult(`Task "${taskId}" not found.`);
      if (task.status === TASK_STATUS.COMPLETED || task.status === TASK_STATUS.FAILED) {
        return this.errorResult(`Task "${task.taskId}" is already ${task.status}.`);
      }
      const requiredFrontier = this.buildRequiredFrontier(
        teamId,
        task.dependsOn,
        undefined,
        this.frontierMemoFor(teamId),
        task.taskId,
      );
      const activeTask = sessionKey ? this.currentTaskForSession(teamId, sessionKey) : undefined;
      if (sessionKey && (!activeTask || activeTask.taskId !== taskId)) {
        return this.staleTaskSubmitResult(task, {
          status: "stale",
          error:
            `Task "${taskId}" is no longer assigned to your session. ` +
            "Submit against the latest assigned revision.",
          activeTaskId: activeTask?.taskId,
          activeRevisionId: activeTask?.revisionId,
          requiredFrontier,
        });
      }
      if (sessionKey && this.taskSessionKey(task) !== sessionKey) {
        return this.errorResult("You can only submit your session-assigned task.");
      }
      if (task.status === TASK_STATUS.DELETED)
        return this.errorResult(`Task "${task.taskId}" is deleted and cannot be submitted.`);
      if (task.status === TASK_STATUS.BLOCKED)
        return this.errorResult(
          `Task "${task.taskId}" is blocked by dependencies and cannot be submitted.`,
        );
      if (submittedRevisionId && task.revisionId && submittedRevisionId !== task.revisionId) {
        return this.staleTaskSubmitResult(task, {
          status: "stale",
          error:
            `Task "${task.taskId}" revision mismatch. ` +
            `Submitted "${submittedRevisionId}", latest is "${task.revisionId}".`,
          submittedRevisionId,
          requiredFrontier,
        });
      }
      const taskRevision = this.createTaskRevision(teamId, { task, cause: "manual" });
      if (!this.frontiersEqual(taskRevision.basedOnFrontier, requiredFrontier)) {
        return this.staleTaskSubmitResult(task, {
          status: "stale",
          error:
            `Task "${task.taskId}" is stale due to upstream revisions. ` +
            "Re-run against latest dependency revisions.",
          revisionId: taskRevision.revisionId,
          taskRevision: taskRevision.revision,
          basedOnFrontier: taskRevision.basedOnFrontier,
          requiredFrontier,
        });
      }
      const chatCheckpoint = await this.captureTaskChatCheckpoint(teamId, task);
      if (errorText) {
        await this.discardFailedTaskChanges(teamId, task).catch(() => {});
        const structuredEvents = this.buildStructuredEventsForSubmission({
          task,
          answer,
          errorText,
        });
        const failed = this.finalizeFailedTaskSubmission(
          teamId,
          sessionKey ?? this.taskSessionKey(task),
          taskId,
          answer,
          {
            chatCheckpoint,
            structuredEvents,
          },
        );
        return this.failedTaskSubmitResult(teamId, taskId, failed, errorText);
      }

      graph.updateTask(taskId, { submit: answer });
      let primaryCommitId: string | undefined;
      let primaryPrRef: string | undefined;
      let primaryMergedTo: string | undefined;
      if (task.taskClass === "primary") {
        try {
          const integrated = await this.worktree.commitRaisePrAndMerge(teamId, task, answer);
          primaryCommitId = integrated.commitId;
          primaryPrRef = integrated.prRef;
          primaryMergedTo = integrated.teamBranch;
          graph.updateTask(taskId, { commitId: integrated.commitId });
        } catch (err) {
          await this.discardFailedTaskChanges(teamId, task).catch(() => {});
          const mergeError = this.message(err, "primary task merge failed");
          const structuredEvents = this.buildStructuredEventsForSubmission({
            task,
            answer,
            errorText: mergeError,
          });
          const failed = this.finalizeFailedTaskSubmission(
            teamId,
            sessionKey ?? this.taskSessionKey(task),
            taskId,
            answer,
            {
              chatCheckpoint,
              structuredEvents,
            },
          );
          return this.failedTaskSubmitResult(teamId, taskId, failed, mergeError);
        }
        this.updateTaskRevisionRecord(teamId, taskId, {
          commitId: primaryCommitId,
        });
      }
      const completed = graph.completeTask({
        taskId,
        result: "success",
      });
      this.updateTaskRevisionRecord(teamId, taskId, {
        status: completed.status,
        submit: answer,
        ...(chatCheckpoint ? { chatCheckpoint } : {}),
        structuredEvents: this.buildStructuredEventsForSubmission({
          task,
          answer,
          commitId: primaryCommitId,
        }),
        completedAt: Date.now(),
        ...(primaryCommitId ? { commitId: primaryCommitId } : {}),
      });
      this.enqueueDownstreamPropagation(teamId, taskId);
      this.emitSubmitDependencyChange(teamId, taskId);
      if (task.title === "qn_request") {
        this.insertQuestionAnswerForChildren(teamId, {
          questionTaskId: taskId,
          question: task.instruction,
          answer,
        });
      }

      const isEndTask = this.isEndTask(teamId, task.taskId);
      // If its end_task and handle it differently
      let broadcasted = false;
      let broadcastSessionKey: string | undefined;
      if (isEndTask) {
        const team = this.getRun(teamId);
        const creatorSessionKey = team?.creatorSessionKey?.trim();
        if (creatorSessionKey) {
          const announced = this.emitSessionAnnouncement({
            teamId,
            sessionKey: creatorSessionKey,
            message: this.buildTeamFinalReportAnnouncement(answer),
          });
          if (!announced) {
            this.emitSessionNote({
              teamId,
              sessionKey: creatorSessionKey,
              note: `Team Final Report:\n${answer}`,
            });
          }
          broadcasted = true;
          broadcastSessionKey = creatorSessionKey;
        }
      }
      this.setSessionIdle(teamId, sessionKey ?? this.taskSessionKey(task));

      return jsonResult({
        status: "completed",
        taskId: completed.taskId,
        taskStatus: completed.status,
        unblockedTasks: completed.unblockedTasks,
        commitId: primaryCommitId,
        prRef: primaryPrRef,
        mergedTo: primaryMergedTo,
        ...(isEndTask
          ? {
              broadcasted,
              broadcastSessionKey,
            }
          : {}),
        propagation: this.propagationDebugStatus(teamId),
      });
    });
  }

  public async taskPlan(_toolCallId: string, args: unknown): Promise<AgentToolResult<unknown>> {
    return this.withTeamsTool("task planning failed", async () => {
      const params = this.readParams(args);
      const { teamId, sessionKey } = this.resolveTeamToolContext(params, {
        requireTaskId: false,
      });
      const items = this.readTaskPlanItems(params.tasks);
      if (items.length === 0) throw new Error("task_plan requires tasks.");
      const graph = this.graphFor(teamId);

      const activeTask = this.currentTaskForSession(teamId, sessionKey);
      if (!activeTask) return this.errorResult("No active assigned task for current session.");
      const parentTaskId = activeTask.taskId;
      const parentTask = graph.getTask(parentTaskId);
      if (!parentTask) return this.errorResult(`Task "${parentTaskId}" not found.`);
      if (this.taskSessionKey(parentTask) !== sessionKey) {
        return this.errorResult(`Task "${parentTaskId}" is not assigned to current session.`);
      }
      if (parentTask.status === TASK_STATUS.COMPLETED || parentTask.status === TASK_STATUS.FAILED)
        return this.errorResult(`Task "${parentTaskId}" is already ${parentTask.status}.`);
      const insertion = this.insertDagWithAccumulator(teamId, parentTask, items);
      const plannerSubmit = [
        `task_plan applied to ${parentTaskId}.`,
        `created=${insertion.createdTaskIds.length}`,
        `rewired=${insertion.rewiredChildTaskIds.length}`,
        `accumulator=${insertion.accumulatorTaskId}`,
      ].join(" ");
      graph.updateTask(parentTaskId, { submit: plannerSubmit });
      const chatCheckpoint = await this.captureTaskChatCheckpoint(teamId, parentTask);
      const completedParent = graph.completeTask({
        taskId: parentTaskId,
        result: "success",
      });
      this.updateTaskRevisionRecord(teamId, parentTaskId, {
        status: completedParent.status,
        submit: plannerSubmit,
        ...(chatCheckpoint ? { chatCheckpoint } : {}),
        structuredEvents: this.buildStructuredEventsForPlan(parentTask, {
          createdCount: insertion.createdTaskIds.length,
          rewiredCount: insertion.rewiredChildTaskIds.length,
        }),
        completedAt: Date.now(),
      });
      this.emitSubmitDependencyChange(teamId, parentTaskId);
      this.interruptAndPropagateRevisionFromSource(
        teamId,
        parentTask.taskId,
        insertion.interruptedSessions,
      );
      this.setSessionIdle(teamId, sessionKey);

      return jsonResult({
        status: "planned_and_completed",
        teamId,
        parentTaskId,
        parentTaskStatus: completedParent.status,
        unblockedTasks: completedParent.unblockedTasks,
        createdCount: insertion.createdTaskIds.length,
        createdTaskIds: insertion.createdTaskIds,
        rewiredChildCount: insertion.rewiredChildTaskIds.length,
        rewiredChildTaskIds: insertion.rewiredChildTaskIds,
        accumulatorTaskId: insertion.accumulatorTaskId,
        mode: "dag_insert",
        propagation: this.propagationDebugStatus(teamId),
      });
    });
  }

  private finalizeFailedTaskSubmission(
    teamId: string,
    sessionKey: string,
    taskId: string,
    answer: string,
    opts?: { chatCheckpoint?: TaskChatCheckpoint; structuredEvents?: TaskStructuredEvent[] },
  ): { taskId: string; status: SwarmTask["status"]; unblockedTasks: string[] } {
    const graph = this.graphFor(teamId);
    graph.updateTask(taskId, { submit: answer });
    const failed = graph.completeTask({
      taskId,
      result: "failure",
    });
    this.updateTaskRevisionRecord(teamId, taskId, {
      status: failed.status,
      submit: answer,
      ...(opts?.chatCheckpoint ? { chatCheckpoint: opts.chatCheckpoint } : {}),
      ...(opts?.structuredEvents ? { structuredEvents: opts.structuredEvents } : {}),
      completedAt: Date.now(),
    });
    this.enqueueDownstreamPropagation(teamId, taskId);
    this.setSessionIdle(teamId, sessionKey);
    return failed;
  }

  private addTaskWithRevision(
    teamId: string,
    params: SwarmAddTaskParams & {
      assignee?: string;
      revisionCause?: TaskRevisionCause;
      causeTaskId?: string;
      causeRevision?: number;
      previousRevisionId?: string;
      forceNewRevision?: boolean;
    },
  ): SwarmTask {
    const {
      revisionCause,
      causeTaskId,
      causeRevision,
      previousRevisionId,
      forceNewRevision,
      ...taskParams
    } = params;
    const created = this.graphFor(teamId).addTask(taskParams);
    this.createTaskRevision(teamId, {
      task: created,
      cause: revisionCause ?? "create",
      causeTaskId,
      causeRevision,
      previousRevisionId,
      forceNewRevision,
    });
    return this.graphFor(teamId).getTask(created.taskId) ?? created;
  }

  private resolveLeadSessionKey(team: SwarmRunRecord): string {
    const session = (this.opts.agentSessionKey ?? "").trim();
    if (session) return session;
    return `agent:${this.readTeamAgentId(team)}:${RESERVED_MATE_ID.LEAD}`;
  }

  private getOrInitMapValue<K, V>(map: Map<K, V>, key: K, create: () => V): V {
    const existing = map.get(key);
    if (existing !== undefined) return existing;
    const created = create();
    map.set(key, created);
    return created;
  }

  private graphFor(teamId: string): Graph {
    return this.getOrInitMapValue(
      AgentSwarm.graphsByTeam,
      teamId,
      () =>
        new Graph(teamId, {
          onTaskPending: (task) => {
            if (this.completeSystemAutoTaskIfPending(teamId, task)) return;
            this.enqueueReadyTask(teamId, task);
            this.scheduleSessionClaimIfIdle(teamId, this.taskSessionKey(task));
          },
          onGraphChanged: () => {
            this.scheduleTeamCompletionEvaluation(teamId);
          },
        }),
    );
  }

  private revisionRegistryFor(teamId: string): TaskRevisionRegistry {
    return this.getOrInitMapValue(AgentSwarm.revisionsByTeam, teamId, () => ({
      byRevisionId: new Map<string, TaskRevisionRecord>(),
      latestByTaskId: new Map<string, TaskRevisionRecord>(),
      byTaskId: new Map<string, TaskRevisionRecord[]>(),
      byTaskAndFrontierKey: new Map<string, TaskRevisionRecord>(),
      historyIndexByRevisionId: new Map<string, number>(),
    }));
  }

  private frontierMemoFor(teamId: string): Map<string, TaskFrontierVector> {
    return this.getOrInitMapValue(
      AgentSwarm.frontierMemoByTeam,
      teamId,
      () => new Map<string, TaskFrontierVector>(),
    );
  }

  private latestRevisionCacheFor(teamId: string): Map<string, number> {
    return this.getOrInitMapValue(
      AgentSwarm.latestRevisionCacheByTeam,
      teamId,
      () => new Map<string, number>(),
    );
  }

  private propagationMetricsFor(teamId: string): PropagationMetrics {
    return this.getOrInitMapValue(AgentSwarm.propagationMetricsByTeam, teamId, () => ({
      enqueuedSources: 0,
      maxQueueDepth: 0,
      drainRuns: 0,
      drainedSources: 0,
      descendantsVisited: 0,
      revisedDescendants: 0,
      skippedByShortCircuit: 0,
      skippedByFrontierDedupe: 0,
      interruptedSessions: 0,
      lastUpdatedAt: Date.now(),
    }));
  }

  private markPropagationMetricUpdate(teamId: string): void {
    this.propagationMetricsFor(teamId).lastUpdatedAt = Date.now();
  }

  private setFrontierMemoEntry(
    teamId: string,
    memoKey: string,
    frontier: TaskFrontierVector,
    memo?: Map<string, TaskFrontierVector>,
  ): void {
    const target = memo ?? this.frontierMemoFor(teamId);
    if (target.has(memoKey)) {
      target.delete(memoKey);
    }
    target.set(memoKey, this.copyFrontier(frontier));
    while (target.size > AgentSwarm.FRONTIER_MEMO_LIMIT) {
      const oldestKey = target.keys().next().value;
      if (!oldestKey) {
        break;
      }
      target.delete(oldestKey);
    }
  }

  private getFrontierMemoEntry(
    teamId: string,
    memoKey: string,
    memo?: Map<string, TaskFrontierVector>,
  ): TaskFrontierVector | undefined {
    const target = memo ?? this.frontierMemoFor(teamId);
    const existing = target.get(memoKey);
    if (!existing) return undefined;
    // Touch for LRU behavior.
    target.delete(memoKey);
    target.set(memoKey, existing);
    return this.copyFrontier(existing);
  }

  private setLatestRevisionCacheEntry(
    teamId: string,
    taskId: string,
    revision: number,
    scopedCache?: Map<string, number>,
  ): void {
    if (scopedCache) {
      scopedCache.set(taskId, revision);
    }

    const shared = this.latestRevisionCacheFor(teamId);
    if (shared.has(taskId)) {
      shared.delete(taskId);
    }
    shared.set(taskId, revision);
    while (shared.size > AgentSwarm.REVISION_CACHE_LIMIT) {
      const oldestKey = shared.keys().next().value;
      if (!oldestKey) {
        break;
      }
      shared.delete(oldestKey);
    }
  }

  private propagationDebugStatus(teamId: string): {
    metrics: PropagationMetrics;
    queueDepth: number;
    inFlight: boolean;
    frontierMemoSize: number;
    latestRevisionCacheSize: number;
  } {
    const metrics = this.propagationMetricsFor(teamId);
    return {
      metrics: { ...metrics },
      queueDepth: AgentSwarm.propagationQueueByTeam.get(teamId)?.size ?? 0,
      inFlight: AgentSwarm.propagationInFlightByTeam.has(teamId),
      frontierMemoSize: this.frontierMemoFor(teamId).size,
      latestRevisionCacheSize: this.latestRevisionCacheFor(teamId).size,
    };
  }

  private copyFrontier(frontier: TaskFrontierVector): TaskFrontierVector {
    return Object.fromEntries(
      Object.entries(frontier).map(([taskId, revision]) => [taskId, revision]),
    );
  }

  private canonicalFrontierKey(frontier: TaskFrontierVector): string {
    return Object.entries(frontier)
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([taskId, revision]) => `${taskId}:${revision}`)
      .join("|");
  }

  private taskFrontierKey(taskId: string, frontier: TaskFrontierVector): string {
    return `${taskId}|${this.canonicalFrontierKey(frontier)}`;
  }

  private applyTaskRevisionToGraph(
    teamId: string,
    taskId: string,
    revision: TaskRevisionRecord,
  ): void {
    this.graphFor(teamId).updateTask(taskId, {
      revisionId: revision.revisionId,
      revision: revision.revision,
      dependsOnRevisionFrontier: this.copyFrontier(revision.dependsOnRevisionFrontier),
      basedOnFrontier: this.copyFrontier(revision.basedOnFrontier),
      previousRevisionId: revision.previousRevisionId,
      cause: revision.cause,
      causeTaskId: revision.causeTaskId,
      causeRevision: revision.causeRevision,
      supersededByRevisionId: revision.supersededByRevisionId,
    });
  }

  private frontiersEqual(a: TaskFrontierVector, b: TaskFrontierVector): boolean {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    for (const key of aKeys) {
      if (a[key] !== b[key]) return false;
    }
    return true;
  }

  private buildRequiredFrontier(
    teamId: string,
    dependsOnTaskIds: string[],
    latestRevisionCache?: Map<string, number>,
    frontierMemo?: Map<string, TaskFrontierVector>,
    memoTaskId?: string,
  ): TaskFrontierVector {
    const frontierEntries: Array<[string, number]> = [];
    const graph = this.graphFor(teamId);
    const uniqueDependsOn = Array.from(new Set(dependsOnTaskIds)).toSorted((a, b) =>
      a.localeCompare(b),
    );
    for (const depTaskId of uniqueDependsOn) {
      const depTask = graph.getTask(depTaskId);
      if (!depTask || depTask.status === TASK_STATUS.DELETED) {
        continue;
      }
      const revision = this.latestRevisionForTaskCached(teamId, depTaskId, latestRevisionCache);
      if (revision > 0) {
        frontierEntries.push([depTaskId, revision]);
      }
    }

    if (memoTaskId && frontierMemo) {
      const memoKey = `${memoTaskId}|${frontierEntries
        .map(([depTaskId, revision]) => `${depTaskId}:${revision}`)
        .join("|")}`;
      const memoHit = this.getFrontierMemoEntry(teamId, memoKey, frontierMemo);
      if (memoHit) return memoHit;
      const frontier = Object.fromEntries(frontierEntries);
      this.setFrontierMemoEntry(teamId, memoKey, frontier, frontierMemo);
      return frontier;
    }

    return Object.fromEntries(frontierEntries);
  }

  private latestRevisionForTaskCached(
    teamId: string,
    taskId: string,
    latestRevisionCache?: Map<string, number>,
  ): number {
    if (latestRevisionCache?.has(taskId)) return latestRevisionCache.get(taskId) ?? 0;
    const shared = this.latestRevisionCacheFor(teamId);
    if (shared.has(taskId)) {
      const revision = shared.get(taskId) ?? 0;
      latestRevisionCache?.set(taskId, revision);
      return revision;
    }
    const revision = this.latestRevisionForTask(teamId, taskId);
    this.setLatestRevisionCacheEntry(teamId, taskId, revision, latestRevisionCache);
    return revision;
  }

  private hasFrontierMismatchFast(
    teamId: string,
    task: SwarmTask,
    latestRevisionCache: Map<string, number>,
  ): boolean {
    const graph = this.graphFor(teamId);
    const basedOnFrontier = task.basedOnFrontier ?? {};
    const activeDependsOn = new Set<string>();

    for (const depTaskId of task.dependsOn) {
      if (activeDependsOn.has(depTaskId)) {
        continue;
      }
      activeDependsOn.add(depTaskId);

      const depTask = graph.getTask(depTaskId);
      if (!depTask || depTask.status === TASK_STATUS.DELETED) {
        if (basedOnFrontier[depTaskId] !== undefined) return true;
        continue;
      }

      const revision = this.latestRevisionForTaskCached(teamId, depTaskId, latestRevisionCache);
      if (revision <= 0) {
        if (basedOnFrontier[depTaskId] !== undefined) return true;
        continue;
      }

      if (basedOnFrontier[depTaskId] !== revision) return true;
    }

    for (const depTaskId of Object.keys(basedOnFrontier)) {
      if (!activeDependsOn.has(depTaskId)) return true;
    }

    return false;
  }

  private latestRevisionForTask(teamId: string, taskId: string): number {
    const registry = this.revisionRegistryFor(teamId);
    const latest = registry.latestByTaskId.get(taskId);
    if (latest) {
      this.setLatestRevisionCacheEntry(teamId, taskId, latest.revision);
      return latest.revision;
    }
    const task = this.graphFor(teamId).getTask(taskId);
    if (!task) {
      this.setLatestRevisionCacheEntry(teamId, taskId, 0);
      return 0;
    }
    const created = this.createTaskRevision(teamId, { task, cause: "create" });
    this.setLatestRevisionCacheEntry(teamId, taskId, created.revision);
    return created.revision;
  }

  private createTaskRevision(
    teamId: string,
    params: {
      task: SwarmTask;
      cause?: TaskRevisionCause;
      causeTaskId?: string;
      causeRevision?: number;
      previousRevisionId?: string;
      forceNewRevision?: boolean;
    },
  ): TaskRevisionRecord {
    const registry = this.revisionRegistryFor(teamId);
    const latest = registry.latestByTaskId.get(params.task.taskId);
    const dependsOnFrontier = this.buildRequiredFrontier(
      teamId,
      params.task.dependsOn,
      undefined,
      this.frontierMemoFor(teamId),
      params.task.taskId,
    );
    const frontierKey = this.taskFrontierKey(params.task.taskId, dependsOnFrontier);
    if (latest && !params.forceNewRevision) {
      if (
        params.task.revisionId !== latest.revisionId ||
        params.task.revision !== latest.revision ||
        !this.frontiersEqual(params.task.basedOnFrontier ?? {}, latest.basedOnFrontier)
      ) {
        this.applyTaskRevisionToGraph(teamId, params.task.taskId, latest);
      }
      registry.byTaskAndFrontierKey.set(
        this.taskFrontierKey(params.task.taskId, latest.basedOnFrontier),
        latest,
      );
      return latest;
    }

    // Idempotency guard: avoid duplicate revisions for same task+frontier under repeated triggers.
    const existingByFrontier = registry.byTaskAndFrontierKey.get(frontierKey);
    if (existingByFrontier && (!latest || existingByFrontier.revision >= latest.revision)) {
      if (
        params.task.revisionId !== existingByFrontier.revisionId ||
        params.task.revision !== existingByFrontier.revision ||
        !this.frontiersEqual(params.task.basedOnFrontier ?? {}, existingByFrontier.basedOnFrontier)
      ) {
        this.applyTaskRevisionToGraph(teamId, params.task.taskId, existingByFrontier);
      }
      return existingByFrontier;
    }

    const revision = latest ? latest.revision + 1 : 1;
    const revisionId = `${params.task.taskId}@r${revision}`;
    const previousRevisionId =
      params.previousRevisionId ?? latest?.revisionId ?? `${params.task.taskId}@r0`;
    const record: TaskRevisionRecord = {
      revisionId,
      taskId: params.task.taskId,
      revision,
      status: params.task.status,
      taskClass: params.task.taskClass,
      assignee: params.task.assignee,
      dependsOnTaskIds: [...params.task.dependsOn],
      dependsOnRevisionFrontier: this.copyFrontier(dependsOnFrontier),
      basedOnFrontier: this.copyFrontier(dependsOnFrontier),
      previousRevisionId,
      cause: params.cause ?? (latest ? "manual" : "create"),
      ...(params.causeTaskId ? { causeTaskId: params.causeTaskId } : {}),
      ...(params.causeRevision ? { causeRevision: params.causeRevision } : {}),
      submit: params.task.submit,
      commitId: params.task.commitId,
      createdAt: params.task.createdAt,
      claimedAt: params.task.claimedAt,
      completedAt: params.task.completedAt,
    };

    if (latest) {
      const supersededLatest: TaskRevisionRecord = {
        ...latest,
        status: "superseded",
        supersededByRevisionId: revisionId,
      };
      registry.byRevisionId.set(latest.revisionId, supersededLatest);
      const latestHistory = registry.byTaskId.get(params.task.taskId);
      const latestHistoryIndex = registry.historyIndexByRevisionId.get(latest.revisionId);
      if (
        latestHistory &&
        latestHistoryIndex !== undefined &&
        latestHistoryIndex >= 0 &&
        latestHistoryIndex < latestHistory.length
      ) {
        latestHistory[latestHistoryIndex] = supersededLatest;
      }
    }

    registry.byRevisionId.set(revisionId, record);
    const history = registry.byTaskId.get(params.task.taskId) ?? [];
    history.push(record);
    registry.byTaskId.set(params.task.taskId, history);
    registry.historyIndexByRevisionId.set(revisionId, history.length - 1);
    registry.byTaskAndFrontierKey.set(frontierKey, record);
    registry.latestByTaskId.set(params.task.taskId, record);
    this.setLatestRevisionCacheEntry(teamId, params.task.taskId, record.revision);

    this.applyTaskRevisionToGraph(teamId, params.task.taskId, record);

    return record;
  }

  private updateTaskRevisionRecord(
    teamId: string,
    taskId: string,
    patch: Partial<TaskRevisionRecord>,
  ): void {
    const task = this.graphFor(teamId).getTask(taskId);
    const revisionId = task?.revisionId?.trim();
    if (!revisionId) return;
    const registry = this.revisionRegistryFor(teamId);
    const current = registry.byRevisionId.get(revisionId);
    if (!current) return;
    const next: TaskRevisionRecord = { ...current, ...patch };
    registry.byRevisionId.set(revisionId, next);
    if (registry.latestByTaskId.get(taskId)?.revisionId === revisionId) {
      registry.latestByTaskId.set(taskId, next);
    }
    const history = registry.byTaskId.get(taskId);
    if (!history) return;
    const index = registry.historyIndexByRevisionId.get(revisionId);
    if (index !== undefined && index >= 0 && index < history.length) {
      history[index] = next;
    }
  }

  private enqueueDownstreamPropagation(teamId: string, sourceTaskId: string): void {
    let queue = AgentSwarm.propagationQueueByTeam.get(teamId);
    if (!queue) {
      queue = new Set<string>();
      AgentSwarm.propagationQueueByTeam.set(teamId, queue);
    }
    const sizeBefore = queue.size;
    queue.add(sourceTaskId);
    const metrics = this.propagationMetricsFor(teamId);
    if (queue.size > sizeBefore) {
      metrics.enqueuedSources += 1;
    }
    if (queue.size > metrics.maxQueueDepth) {
      metrics.maxQueueDepth = queue.size;
    }
    this.markPropagationMetricUpdate(teamId);
    this.schedulePropagationDrain(teamId);
  }

  private interruptAndPropagateRevisionFromSource(
    teamId: string,
    sourceTaskId: string,
    interruptedSessionKeys?: Iterable<string>,
  ): void {
    if (interruptedSessionKeys) this.enqueueTeamInterrupt(teamId, interruptedSessionKeys);
    this.enqueueDownstreamPropagation(teamId, sourceTaskId);
  }

  private schedulePropagationDrain(teamId: string): void {
    if (AgentSwarm.propagationInFlightByTeam.has(teamId)) return;
    AgentSwarm.propagationInFlightByTeam.add(teamId);
    queueMicrotask(() => this.drainPropagationQueue(teamId));
  }

  private drainPropagationQueue(teamId: string): void {
    const metrics = this.propagationMetricsFor(teamId);
    metrics.drainRuns += 1;
    const processedTaskFrontierKeys = new Set<string>();
    const latestRevisionCache = this.latestRevisionCacheFor(teamId);
    const frontierMemo = this.frontierMemoFor(teamId);
    try {
      while (true) {
        const queue = AgentSwarm.propagationQueueByTeam.get(teamId);
        if (!queue || queue.size === 0) break;
        const [sourceTaskId] = queue;
        queue.delete(sourceTaskId);
        metrics.drainedSources += 1;
        try {
          this.propagateDownstreamFromSource(
            teamId,
            sourceTaskId,
            processedTaskFrontierKeys,
            latestRevisionCache,
            frontierMemo,
            metrics,
          );
        } catch {
          // Propagation is best-effort; subsequent queue updates will retry.
        }
      }
    } finally {
      AgentSwarm.propagationInFlightByTeam.delete(teamId);
      const queue = AgentSwarm.propagationQueueByTeam.get(teamId);
      if (!queue || queue.size === 0) {
        AgentSwarm.propagationQueueByTeam.delete(teamId);
      } else {
        this.schedulePropagationDrain(teamId);
      }
      this.markPropagationMetricUpdate(teamId);
    }
  }

  private propagateDownstreamFromSource(
    teamId: string,
    sourceTaskId: string,
    processedTaskFrontierKeys: Set<string>,
    latestRevisionCache: Map<string, number>,
    frontierMemo: Map<string, TaskFrontierVector>,
    metrics: PropagationMetrics,
  ): void {
    const graph = this.graphFor(teamId);
    const sourceTask = graph.getTask(sourceTaskId);
    if (!sourceTask || sourceTask.status === TASK_STATUS.DELETED) return;

    const sourceRevision =
      latestRevisionCache.get(sourceTaskId) ??
      this.revisionRegistryFor(teamId).latestByTaskId.get(sourceTaskId)?.revision ??
      sourceTask.revision ??
      0;
    this.setLatestRevisionCacheEntry(teamId, sourceTaskId, sourceRevision, latestRevisionCache);
    const descendantTaskIds = graph.getAllChildrenTopologically(sourceTaskId);
    if (descendantTaskIds.length === 0) return;
    const endTaskId = this.resolveEndTask(teamId)?.taskId;

    const interruptedSessions = new Set<string>();
    this.withGraphMutation(graph, () => {
      for (const descendantTaskId of descendantTaskIds) {
        const task = graph.getTask(descendantTaskId);
        if (
          !task ||
          task.status === TASK_STATUS.DELETED ||
          (endTaskId && task.taskId === endTaskId)
        ) {
          continue;
        }
        metrics.descendantsVisited += 1;

        if (!this.hasFrontierMismatchFast(teamId, task, latestRevisionCache)) {
          metrics.skippedByShortCircuit += 1;
          continue;
        }

        const requiredFrontier = this.buildRequiredFrontier(
          teamId,
          task.dependsOn,
          latestRevisionCache,
          frontierMemo,
          task.taskId,
        );
        const taskFrontierKey = this.taskFrontierKey(task.taskId, requiredFrontier);
        if (processedTaskFrontierKeys.has(taskFrontierKey)) {
          metrics.skippedByFrontierDedupe += 1;
          continue;
        }
        processedTaskFrontierKeys.add(taskFrontierKey);
        if (this.frontiersEqual(task.basedOnFrontier ?? {}, requiredFrontier)) {
          continue;
        }

        if (
          (task.status === TASK_STATUS.CLAIMED ||
            task.status === TASK_STATUS.IN_PROGRESS ||
            task.status === TASK_STATUS.PAUSED) &&
          this.currentTaskForSession(teamId, this.taskSessionKey(task))?.taskId === task.taskId
        ) {
          interruptedSessions.add(this.taskSessionKey(task));
        }

        const nextStatus = this.resolvePropagationTaskStatus(teamId, task);
        const updatedTask = graph.updateTask(task.taskId, {
          status: nextStatus,
          claimedAt: 0,
          completedAt: 0,
          submit: "",
          commitId: undefined,
        });
        const nextRevision = this.createTaskRevision(teamId, {
          task: updatedTask,
          cause: "upstream_revision",
          causeTaskId: sourceTaskId,
          ...(sourceRevision ? { causeRevision: sourceRevision } : {}),
          forceNewRevision: true,
        });
        this.setLatestRevisionCacheEntry(
          teamId,
          task.taskId,
          nextRevision.revision,
          latestRevisionCache,
        );
        metrics.revisedDescendants += 1;
      }
    });

    this.enqueueTeamInterrupt(teamId, interruptedSessions);
    if (interruptedSessions.size > 0) metrics.interruptedSessions += interruptedSessions.size;
  }

  private resolvePropagationTaskStatus(teamId: string, task: SwarmTask): SwarmTask["status"] {
    const graph = this.graphFor(teamId);
    const isUnblocked = task.dependsOn.every((depId) => {
      const dep = graph.getTask(depId);
      return !dep || dep.status === TASK_STATUS.COMPLETED;
    });
    return isUnblocked ? TASK_STATUS.PENDING : TASK_STATUS.BLOCKED;
  }

  private isLatestTaskRevision(teamId: string, task: SwarmTask): boolean {
    const latest = this.revisionRegistryFor(teamId).latestByTaskId.get(task.taskId);
    if (!latest || !latest.revisionId) return true;
    return task.revisionId === latest.revisionId;
  }

  private taskNeedsRevisionUpdate(
    teamId: string,
    task: SwarmTask,
    latestRevisionCache: Map<string, number>,
  ): boolean {
    if (!this.isLatestTaskRevision(teamId, task)) return true;
    return this.hasFrontierMismatchFast(teamId, task, latestRevisionCache);
  }

  private rebaseTaskToLatestFrontier(
    teamId: string,
    task: SwarmTask,
    latestRevisionCache: Map<string, number>,
  ): SwarmTask {
    const graph = this.graphFor(teamId);
    const latest = this.revisionRegistryFor(teamId).latestByTaskId.get(task.taskId);
    if (latest && latest.revisionId !== task.revisionId) {
      this.applyTaskRevisionToGraph(teamId, task.taskId, latest);
      return graph.getTask(task.taskId) ?? task;
    }
    if (!this.hasFrontierMismatchFast(teamId, task, latestRevisionCache)) return task;
    const nextStatus = this.resolvePropagationTaskStatus(teamId, task);
    const updated = graph.updateTask(task.taskId, {
      status: nextStatus,
      claimedAt: 0,
      completedAt: 0,
      submit: "",
      commitId: undefined,
    });
    const nextRevision = this.createTaskRevision(teamId, {
      task: updated,
      cause: "upstream_revision",
      forceNewRevision: true,
    });
    this.setLatestRevisionCacheEntry(
      teamId,
      task.taskId,
      nextRevision.revision,
      latestRevisionCache,
    );
    return graph.getTask(task.taskId) ?? updated;
  }

  private isSystemAutoTask(task: SwarmTask): boolean {
    return task.assignee === SYSTEM_AUTO_ASSIGNEE;
  }

  private completeSystemAutoTaskIfPending(teamId: string, task: SwarmTask): boolean {
    if (!this.isSystemAutoTask(task) || task.status !== TASK_STATUS.PENDING) return false;
    const graph = this.graphFor(teamId);
    const submit = task.submit.trim() || "auto_completed";
    if (!task.submit.trim()) {
      graph.updateTask(task.taskId, { submit });
    }
    const completed = graph.completeTask({
      taskId: task.taskId,
      result: "success",
    });
    this.updateTaskRevisionRecord(teamId, task.taskId, {
      status: completed.status,
      submit,
      completedAt: Date.now(),
    });
    this.enqueueDownstreamPropagation(teamId, task.taskId);
    return true;
  }

  private taskSessionKey(task: SwarmTask): string {
    const sessionKey = task.contextSessionKey.trim();
    if (sessionKey) return sessionKey;
    return `task:${task.taskId}`;
  }

  private sessionRuntimeKey(teamId: string, sessionKey: string): string {
    return `${teamId}:${sessionKey}`;
  }

  private setSessionIdle(teamId: string, sessionKey: string): void {
    if (!sessionKey.trim()) return;
    const previousTask = this.currentTaskForSession(teamId, sessionKey);
    if (
      previousTask &&
      previousTask.status !== TASK_STATUS.COMPLETED &&
      previousTask.status !== TASK_STATUS.FAILED
    ) {
      this.emitInterrupt({
        teamId,
        sessionKey,
        reason: `Task "${previousTask.taskId}" was interrupted because session transitioned to idle.`,
      });
    }
    AgentSwarm.activeTaskBySession.delete(this.sessionRuntimeKey(teamId, sessionKey));
    this.scheduleSessionClaim(teamId, sessionKey);
  }

  private enqueueTeamInterrupt(teamId: string, sessionKeys: Iterable<string>): void {
    let queue = AgentSwarm.interruptQueueByTeam.get(teamId);
    if (!queue) {
      queue = new Set<string>();
      AgentSwarm.interruptQueueByTeam.set(teamId, queue);
    }

    let added = false;
    for (const sessionKey of sessionKeys) {
      if (!sessionKey.trim()) continue;
      const sizeBefore = queue.size;
      queue.add(sessionKey);
      if (queue.size > sizeBefore) added = true;
    }
    if (!added) return;
    this.scheduleTeamInterruptDispatch(teamId);
  }

  private scheduleTeamInterruptDispatch(teamId: string): void {
    if (AgentSwarm.interruptDispatchQueuedByTeam.has(teamId)) return;
    AgentSwarm.interruptDispatchQueuedByTeam.add(teamId);
    queueMicrotask(() => {
      AgentSwarm.interruptDispatchQueuedByTeam.delete(teamId);
      const queue = AgentSwarm.interruptQueueByTeam.get(teamId);
      AgentSwarm.interruptQueueByTeam.delete(teamId);
      if (!queue || queue.size === 0) return;
      for (const sessionKey of queue) {
        this.setSessionIdle(teamId, sessionKey);
      }
    });
  }

  private sendTaskToSession(teamId: string, sessionKey: string, taskId: string): void {
    const runtimeKey = this.sessionRuntimeKey(teamId, sessionKey);
    AgentSwarm.activeTaskBySession.set(runtimeKey, taskId);
    const task = this.graphFor(teamId).getTask(taskId);
    if (!task) return;
    const dependencyNotes = this.opts.platform?.sendBootstrap
      ? this.undeliveredDependencyNotes(teamId, sessionKey, task)
      : undefined;
    this.emitBootstrap({
      teamId,
      sessionLabel: task.assignee || sessionKey,
      taskId,
      sessionKey,
      title: task.title,
      instruction: task.instruction,
      dependencyNotes,
    });
  }

  private readyQueueFor(teamId: string, sessionKey: string): PendingTaskQueue {
    const key = this.sessionRuntimeKey(teamId, sessionKey);
    return this.getOrInitMapValue(
      AgentSwarm.readyQueuesBySession,
      key,
      () => new PendingTaskQueue(),
    );
  }

  private enqueueReadyTask(teamId: string, task: SwarmTask): void {
    if (task.status !== TASK_STATUS.PENDING) return;
    this.readyQueueFor(teamId, this.taskSessionKey(task)).enqueue(task);
  }

  private scheduleSessionClaimIfIdle(teamId: string, sessionKey: string): void {
    if (!sessionKey.trim()) return;
    if (!this.isSessionIdle(teamId, sessionKey)) return;
    this.scheduleSessionClaim(teamId, sessionKey);
  }

  private scheduleSessionClaim(teamId: string, sessionKey: string): void {
    const key = this.sessionRuntimeKey(teamId, sessionKey);
    if (AgentSwarm.sessionClaimsQueued.has(key) || AgentSwarm.sessionClaimsInFlight.has(key))
      return;
    AgentSwarm.sessionClaimsQueued.add(key);

    queueMicrotask(() => {
      AgentSwarm.sessionClaimsQueued.delete(key);
      if (AgentSwarm.sessionClaimsInFlight.has(key)) return;
      AgentSwarm.sessionClaimsInFlight.add(key);
      void this.claimPendingForSession(teamId, sessionKey)
        .catch(() => {
          // Claiming is best-effort; future state transitions can retry.
        })
        .finally(() => {
          AgentSwarm.sessionClaimsInFlight.delete(key);
        });
    });
  }

  private isSessionIdle(teamId: string, sessionKey: string): boolean {
    return !AgentSwarm.activeTaskBySession.has(this.sessionRuntimeKey(teamId, sessionKey));
  }

  private readAskMode(value: unknown): SwarmAskMode {
    return value === "edit" ? "edit" : "read";
  }

  private resolveTeamToolContext(
    params: Record<string, unknown>,
    options: { requireTaskId: true },
  ): { teamId: string; sessionKey?: string; taskId: string };

  private resolveTeamToolContext(
    params: Record<string, unknown>,
    options: { requireTaskId: false },
  ): { teamId: string; sessionKey: string };

  private resolveTeamToolContext(
    params: Record<string, unknown>,
    options: { requireTaskId: boolean },
  ):
    | { teamId: string; sessionKey?: string; taskId: string }
    | { teamId: string; sessionKey: string } {
    const explicitTeamId = readStringParam(params, "teamId");
    const explicitTaskId = readStringParam(params, "taskId");
    const sessionContext = this.parseSessionTeamContext(this.opts.agentSessionKey);
    const teamId = explicitTeamId ?? sessionContext?.teamId;
    if (!teamId) throw new Error("teamId required (or run from a team session).");
    const sessionKey = this.opts.agentSessionKey?.trim() || undefined;
    const inferredTaskId = sessionKey
      ? this.currentTaskForSession(teamId, sessionKey)?.taskId
      : undefined;
    const taskId = explicitTaskId ?? inferredTaskId;
    if (options.requireTaskId && !taskId) {
      throw new Error("taskId required (or you must have an active assigned task).");
    }
    if (!options.requireTaskId) {
      if (!sessionKey) throw new Error("sessionKey required (run from a team task session).");
      return { teamId, sessionKey };
    }
    const resolvedTaskId = taskId;
    if (!resolvedTaskId) throw new Error("taskId required.");
    const resolvedSessionKey =
      sessionKey ?? this.graphFor(teamId).getTask(resolvedTaskId)?.contextSessionKey?.trim();
    return { teamId, sessionKey: resolvedSessionKey, taskId: resolvedTaskId };
  }

  private parseSessionTeamContext(sessionKey?: string): { teamId: string } | undefined {
    const session = sessionKey?.trim();
    if (!session) return undefined;
    const parts = session
      .split(":")
      .map((part) => part.trim())
      .filter(Boolean);
    if (parts.length < 3 || parts[0] !== "agent") return undefined;
    const teamToken = parts[1];
    if (!teamToken || !teamToken.startsWith("team-")) return undefined;
    const teamId = teamToken.slice("team-".length).trim();
    return teamId ? { teamId } : undefined;
  }

  private taskSearchMode(value: unknown): "current" | "history" {
    return value === "history" ? "history" : "current";
  }

  private readTaskPlanItems(value: unknown): TaskPlanItem[] {
    const parseContainer = (input: unknown): unknown[] => {
      if (input === undefined) return [];
      if (Array.isArray(input)) return input;
      if (typeof input === "string") {
        const parsed = JSON.parse(input) as unknown;
        if (Array.isArray(parsed)) return parsed;
        if (
          parsed &&
          typeof parsed === "object" &&
          Array.isArray((parsed as { tasks?: unknown[] }).tasks)
        ) {
          return (parsed as { tasks: unknown[] }).tasks;
        }
      }
      if (
        input &&
        typeof input === "object" &&
        Array.isArray((input as { tasks?: unknown[] }).tasks)
      ) {
        return (input as { tasks: unknown[] }).tasks;
      }
      throw new Error("tasks must be an array or { tasks: [] }.");
    };

    const tasks = parseContainer(value);
    const rawItems = tasks.map((entry, index) => {
      if (!entry || typeof entry !== "object") {
        throw new Error(`tasks[${index}] must be an object.`);
      }
      const record = entry as Record<string, unknown>;
      const taskKey = readStringParam(record, "id") || String(index + 1);
      const title = readStringParam(record, "title", { required: true });
      const assignee = readStringParam(record, "assignee");
      const instruction = readStringParam(record, "instruction");
      const contextSessionKey = readStringParam(record, "contextSessionKey");
      const taskClassRaw = readStringParam(record, "taskClass");
      const taskClass =
        taskClassRaw === "primary" || taskClassRaw === "secondary" ? taskClassRaw : undefined;
      const priorityRaw = record.priority;
      const priority = typeof priorityRaw === "number" ? priorityRaw : undefined;
      const dependsOnRaw = Array.isArray(record.dependsOn) ? record.dependsOn : [];
      const dependsOnRefs = dependsOnRaw.map((dep, depIndex) => {
        if (typeof dep !== "string") {
          throw new Error(`tasks[${index}].dependsOn[${depIndex}] must be a string id or index.`);
        }
        const trimmed = dep.trim();
        if (!trimmed) {
          throw new Error(`tasks[${index}].dependsOn[${depIndex}] cannot be empty.`);
        }
        return trimmed;
      });
      return {
        taskKey,
        title,
        dependsOnRefs,
        ...(assignee ? { assignee } : {}),
        ...(instruction ? { instruction } : {}),
        ...(priority !== undefined ? { priority } : {}),
        ...(taskClass ? { taskClass } : {}),
        ...(contextSessionKey ? { contextSessionKey } : {}),
      } as TaskPlanItem & { dependsOnRefs: string[] };
    });

    const keySet = new Set<string>();
    for (const [index, item] of rawItems.entries()) {
      if (keySet.has(item.taskKey)) {
        throw new Error(`Duplicate task key "${item.taskKey}" at tasks[${index}].`);
      }
      keySet.add(item.taskKey);
    }
    const taskKeyByIndex = rawItems.map((item) => item.taskKey);
    const taskKeySet = new Set(taskKeyByIndex);
    const resolved = rawItems.map((item, index) => {
      const dependsOnKeys = item.dependsOnRefs.map((ref) => {
        if (taskKeySet.has(ref)) return ref;
        const asIndex = Number.parseInt(ref, 10);
        if (Number.isFinite(asIndex) && String(asIndex) === ref) {
          const depKey = taskKeyByIndex[asIndex - 1];
          if (!depKey) throw new Error(`tasks[${index}].dependsOn "${ref}" is out of range.`);
          return depKey;
        }
        throw new Error(`tasks[${index}].dependsOn "${ref}" does not match any task id.`);
      });
      if (dependsOnKeys.includes(item.taskKey)) {
        throw new Error(`tasks[${index}] cannot depend on itself.`);
      }
      return {
        taskKey: item.taskKey,
        title: item.title,
        ...(item.assignee ? { assignee: item.assignee } : {}),
        dependsOnKeys,
        ...(item.instruction ? { instruction: item.instruction } : {}),
        ...(item.priority !== undefined ? { priority: item.priority } : {}),
        ...(item.taskClass ? { taskClass: item.taskClass } : {}),
        ...(item.contextSessionKey ? { contextSessionKey: item.contextSessionKey } : {}),
      } as TaskPlanItem;
    });

    const indegreeByTaskKey = new Map<string, number>();
    const dependantsByTaskKey = new Map<string, string[]>();
    for (const item of resolved) {
      indegreeByTaskKey.set(item.taskKey, item.dependsOnKeys.length);
      for (const depKey of item.dependsOnKeys) {
        const dependants = dependantsByTaskKey.get(depKey) ?? [];
        dependants.push(item.taskKey);
        dependantsByTaskKey.set(depKey, dependants);
      }
    }
    const ready = resolved
      .filter((item) => item.dependsOnKeys.length === 0)
      .map((item) => item.taskKey);
    let visited = 0;
    while (ready.length > 0) {
      const taskKey = ready.pop();
      if (!taskKey) continue;
      visited += 1;
      for (const dependantKey of dependantsByTaskKey.get(taskKey) ?? []) {
        const nextIndegree = (indegreeByTaskKey.get(dependantKey) ?? 0) - 1;
        indegreeByTaskKey.set(dependantKey, nextIndegree);
        if (nextIndegree === 0) ready.push(dependantKey);
      }
    }
    if (visited !== resolved.length) {
      throw new Error("task_plan DAG contains a dependency cycle.");
    }

    return resolved;
  }

  private serializeDependencyChat(
    messages: unknown[],
    limit: number,
  ): Array<{ role?: string; text: string; createdAt?: number }> {
    const sliced = messages.slice(Math.max(0, messages.length - limit));
    const result: Array<{ role?: string; text: string; createdAt?: number }> = [];
    for (const message of sliced) {
      if (!message || typeof message !== "object") continue;
      const entry = message as Record<string, unknown>;
      const text = this.extractHistoryMessageText(entry);
      if (!text) continue;
      const createdAtRaw = entry.createdAt;
      const createdAt =
        typeof createdAtRaw === "number" && Number.isFinite(createdAtRaw)
          ? createdAtRaw
          : undefined;
      result.push({
        ...(typeof entry.role === "string" ? { role: entry.role } : {}),
        text: text.length <= 800 ? text : `${text.slice(0, 800)}...`,
        ...(createdAt ? { createdAt } : {}),
      });
    }
    return result;
  }

  private async captureTaskChatCheckpoint(
    teamId: string,
    task: SwarmTask,
    limit = 8,
  ): Promise<TaskChatCheckpoint | undefined> {
    const readHistory = this.opts.platform?.readSessionHistory;
    const sessionKey = task.contextSessionKey?.trim();
    if (!readHistory || !sessionKey) return undefined;

    try {
      const normalizedLimit = Math.max(1, Math.min(20, limit));
      const historyResult = await readHistory({ teamId, sessionKey, limit: normalizedLimit });
      const sample = this.serializeDependencyChat(historyResult.messages, normalizedLimit).map(
        (entry) => ({
          ...(entry.role ? { role: entry.role } : {}),
          text: entry.text.length <= 240 ? entry.text : `${entry.text.slice(0, 240)}...`,
          ...(entry.createdAt ? { createdAt: entry.createdAt } : {}),
        }),
      );
      const digestInput = sample
        .map((entry) => `${entry.createdAt ?? 0}|${entry.role ?? ""}|${entry.text}`)
        .join("\n");
      const digest = createHash("sha256").update(digestInput).digest("hex").slice(0, 16);
      return {
        capturedAt: Date.now(),
        limit: normalizedLimit,
        digest,
        ...(historyResult.sessionId ? { sessionId: historyResult.sessionId } : {}),
        sample,
      };
    } catch {
      return undefined;
    }
  }

  private buildStructuredEventsForSubmission(params: {
    task: SwarmTask;
    answer: string;
    errorText?: string;
    commitId?: string;
  }): TaskStructuredEvent[] {
    const answer = params.answer.trim();
    const events = this.extractStructuredEventsFromEnvelope(params.task, answer);
    if (events.length === 0) {
      const refs = params.commitId ? [`commit:${params.commitId}`] : [];
      events.push(
        this.createStructuredEvent({
          task: params.task,
          kind: "output",
          eventKey: `output:${params.task.taskId}`,
          title: `Submission for ${params.task.taskId}`,
          summary: answer || "(empty submission)",
          status: "active",
          refs,
          source: "tool",
        }),
      );
    }

    if (params.commitId) {
      events.push(
        this.createStructuredEvent({
          task: params.task,
          kind: "evidence",
          eventKey: `evidence:commit:${params.commitId}`,
          title: "Commit created",
          summary: `Primary task merged as commit ${params.commitId}.`,
          status: "active",
          refs: [`commit:${params.commitId}`],
          source: "tool",
        }),
      );
    }

    if (params.errorText?.trim()) {
      events.push(
        this.createStructuredEvent({
          task: params.task,
          kind: "risk",
          eventKey: `risk:${params.task.taskId}:submission`,
          title: "Task submission failure",
          summary: params.errorText.trim(),
          status: "open",
          refs: [],
          source: "tool",
        }),
      );
    }

    return this.currentStructuredEventsFromRevision(events);
  }

  private buildStructuredEventsForPlan(
    task: SwarmTask,
    params: { createdCount: number; rewiredCount: number },
  ): TaskStructuredEvent[] {
    return [
      this.createStructuredEvent({
        task,
        kind: "plan",
        eventKey: `plan:${task.taskId}:dag_insert`,
        title: "DAG inserted",
        summary: `Inserted DAG with ${params.createdCount} tasks and rewired ${params.rewiredCount} direct children.`,
        status: "active",
        refs: [],
        source: "tool",
      }),
    ];
  }

  private extractStructuredEventsFromEnvelope(
    task: SwarmTask,
    answer: string,
  ): TaskStructuredEvent[] {
    const candidateBlocks: string[] = [];
    const fenced = /```json\s*([\s\S]*?)```/gi;
    let match: RegExpExecArray | null;
    while ((match = fenced.exec(answer)) !== null) {
      const block = match[1]?.trim();
      if (block) candidateBlocks.push(block);
    }
    const trimmed = answer.trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) candidateBlocks.push(trimmed);

    const events: TaskStructuredEvent[] = [];
    for (const block of candidateBlocks) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(block);
      } catch {
        continue;
      }
      if (!parsed || typeof parsed !== "object") continue;
      const root = parsed as Record<string, unknown>;
      const payloadEvents = Array.isArray(root.events) ? root.events : [];
      for (let index = 0; index < payloadEvents.length; index += 1) {
        const payload = payloadEvents[index];
        if (!payload || typeof payload !== "object") continue;
        const record = payload as Record<string, unknown>;
        const kindRaw = typeof record.kind === "string" ? record.kind.trim() : "";
        if (!this.isStructuredEventKind(kindRaw)) continue;
        const titleRaw =
          typeof record.title === "string"
            ? record.title.trim()
            : typeof record.text === "string"
              ? record.text.trim()
              : "";
        const summaryRaw =
          typeof record.summary === "string"
            ? record.summary.trim()
            : typeof record.text === "string"
              ? record.text.trim()
              : titleRaw;
        const statusRaw =
          typeof record.status === "string" ? record.status.trim().toLowerCase() : "active";
        const status = this.isStructuredEventStatus(statusRaw) ? statusRaw : "active";
        const refs = Array.isArray(record.refs)
          ? record.refs.filter(
              (ref): ref is string => typeof ref === "string" && ref.trim().length > 0,
            )
          : [];
        const eventKey =
          typeof record.eventKey === "string" && record.eventKey.trim()
            ? record.eventKey.trim()
            : typeof record.id === "string" && record.id.trim()
              ? record.id.trim()
              : `${kindRaw}:${index + 1}`;
        const supersedesEventId =
          typeof record.supersedesEventId === "string"
            ? record.supersedesEventId.trim()
            : typeof record.supersedes === "string"
              ? record.supersedes.trim()
              : "";
        if (!titleRaw || !summaryRaw) continue;
        events.push(
          this.createStructuredEvent({
            task,
            kind: kindRaw,
            eventKey,
            title: titleRaw,
            summary: summaryRaw,
            status,
            refs,
            source: "envelope",
            ...(supersedesEventId ? { supersedesEventId } : {}),
          }),
        );
      }
      if (events.length > 0) break;
    }
    return events;
  }

  private createStructuredEvent(params: {
    task: SwarmTask;
    kind: TaskStructuredEvent["kind"];
    eventKey: string;
    title: string;
    summary: string;
    status: TaskStructuredEvent["status"];
    refs: string[];
    source: TaskStructuredEvent["source"];
    supersedesEventId?: string;
  }): TaskStructuredEvent {
    const revisionId =
      params.task.revisionId || `${params.task.taskId}@r${params.task.revision ?? 0}`;
    const createdAt = Date.now();
    const canonical = [
      params.task.taskId,
      revisionId,
      params.kind,
      params.eventKey,
      params.title.trim(),
      params.summary.trim(),
      params.status,
      params.refs.join("|"),
    ].join("|");
    const eventId = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
    const tokens = this.normalizeStructuredEventTokens(
      `${params.title} ${params.summary} ${params.refs.join(" ")}`,
    );
    return {
      eventId,
      eventKey: params.eventKey,
      kind: params.kind,
      title: params.title.trim(),
      summary: params.summary.trim(),
      status: params.status,
      tokens,
      refs: params.refs.map((ref) => ref.trim()).filter((ref) => ref.length > 0),
      source: params.source,
      createdAt,
      ...(params.supersedesEventId ? { supersedesEventId: params.supersedesEventId } : {}),
    };
  }

  private currentStructuredEventsFromRevision(
    events?: TaskStructuredEvent[],
  ): TaskStructuredEvent[] {
    if (!events || events.length === 0) return [];
    const latestByEventKey = new Map<string, TaskStructuredEvent>();
    for (const event of events) {
      const current = latestByEventKey.get(event.eventKey);
      if (!current || event.createdAt >= current.createdAt) {
        latestByEventKey.set(event.eventKey, event);
      }
    }
    return Array.from(latestByEventKey.values())
      .filter((event) => event.status !== "superseded")
      .toSorted((a, b) => a.createdAt - b.createdAt);
  }

  private normalizeStructuredEventTokens(text: string): string[] {
    const normalized = text
      .toLowerCase()
      .replaceAll(/[^a-z0-9_\-.\s]/g, " ")
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3 && !STRUCTURED_EVENT_TOKEN_STOPWORDS.has(token));
    return Array.from(new Set(normalized));
  }

  private isStructuredEventKind(value: string): value is TaskStructuredEvent["kind"] {
    return (
      value === "fact" ||
      value === "evidence" ||
      value === "decision" ||
      value === "assumption" ||
      value === "risk" ||
      value === "question" ||
      value === "answer" ||
      value === "plan" ||
      value === "output" ||
      value === "thinking_summary" ||
      value === "next"
    );
  }

  private isStructuredEventStatus(value: string): value is TaskStructuredEvent["status"] {
    return value === "active" || value === "open" || value === "resolved" || value === "superseded";
  }

  private serializeDependencyRevision(
    entry: TaskRevisionRecord,
    currentMode: boolean,
  ): Record<string, unknown> {
    const structuredEvents = currentMode
      ? this.currentStructuredEventsFromRevision(entry.structuredEvents)
      : (entry.structuredEvents ?? []).toSorted((a, b) => a.createdAt - b.createdAt);
    return {
      revisionId: entry.revisionId,
      revision: entry.revision,
      status: entry.status,
      cause: entry.cause,
      causeTaskId: entry.causeTaskId,
      causeRevision: entry.causeRevision,
      completedAt: entry.completedAt,
      submit: entry.submit,
      chatCheckpoint: entry.chatCheckpoint
        ? {
            capturedAt: entry.chatCheckpoint.capturedAt,
            digest: entry.chatCheckpoint.digest,
            limit: entry.chatCheckpoint.limit,
            sessionId: entry.chatCheckpoint.sessionId,
            sampleCount: entry.chatCheckpoint.sample.length,
            sample: entry.chatCheckpoint.sample,
          }
        : undefined,
      structuredEvents: structuredEvents.map((event) => ({
        eventId: event.eventId,
        eventKey: event.eventKey,
        kind: event.kind,
        title: event.title,
        summary: event.summary,
        status: event.status,
        tokens: event.tokens,
        refs: event.refs,
        source: event.source,
        createdAt: event.createdAt,
        ...(event.supersedesEventId ? { supersedesEventId: event.supersedesEventId } : {}),
      })),
    };
  }

  private revisionDeltaSince(
    history: TaskRevisionRecord[],
    sinceRevisionId?: string,
  ): {
    found: boolean;
    sinceCreatedAt?: number;
    revisions: TaskRevisionRecord[];
  } {
    if (!sinceRevisionId) return { found: false, revisions: history };
    const sinceIndex = history.findIndex((entry) => entry.revisionId === sinceRevisionId);
    if (sinceIndex < 0) return { found: false, revisions: history };
    return {
      found: true,
      sinceCreatedAt: history[sinceIndex]?.createdAt,
      revisions: history.slice(sinceIndex + 1),
    };
  }

  private dependencyNotesSince(
    notes: DependencyNote[],
    delta: { found: boolean; sinceCreatedAt?: number; revisions: TaskRevisionRecord[] },
    sinceRevisionId?: string,
  ): DependencyNote[] {
    if (!sinceRevisionId || !delta.found) return notes;
    const revisionIds = new Set(delta.revisions.map((entry) => entry.revisionId));
    return notes.filter((note) => {
      if (note.sourceRevisionId) return revisionIds.has(note.sourceRevisionId);
      return delta.sinceCreatedAt ? note.createdAt > delta.sinceCreatedAt : true;
    });
  }

  private extractHistoryMessageText(message: Record<string, unknown>): string | undefined {
    if (typeof message.text === "string" && message.text.trim()) return message.text.trim();
    const content = message.content;
    if (typeof content === "string") {
      const text = content.trim();
      return text || undefined;
    }
    if (!Array.isArray(content)) return undefined;
    const chunks: string[] = [];
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const asRecord = block as Record<string, unknown>;
      const type = typeof asRecord.type === "string" ? asRecord.type : "";
      if (type === "text" && typeof asRecord.text === "string") {
        const text = asRecord.text.trim();
        if (text) chunks.push(text);
        continue;
      }
      if (type === "thinking" && typeof asRecord.thinking === "string") {
        const thinking = asRecord.thinking.trim();
        if (thinking) chunks.push(`[thinking] ${thinking}`);
      }
    }
    if (chunks.length === 0) return undefined;
    return chunks.join("\n");
  }

  private readOptionalError(value: unknown): string | undefined {
    if (typeof value === "string") {
      const text = value.trim();
      return text || undefined;
    }
    if (value === true) return "Task failed due to execution error.";
    if (!value || typeof value !== "object") return undefined;

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

  private withGraphMutation<T>(graph: Graph, action: () => T): T {
    graph.beginGraphMutation();
    try {
      return action();
    } finally {
      graph.endGraphMutation();
    }
  }

  private message(err: unknown, fallback: string): string {
    return err instanceof Error ? err.message : typeof err === "string" ? err : fallback;
  }

  private errorResult(error: string): AgentToolResult<unknown> {
    return jsonResult({ status: "error", error });
  }

  private async withTeamsTool(
    failureMessage: string,
    action: () => Promise<AgentToolResult<unknown>>,
  ): Promise<AgentToolResult<unknown>> {
    if (!this.teamsEnabled()) return this.errorResult("Teams are not enabled.");
    try {
      return await action();
    } catch (err) {
      return this.errorResult(this.message(err, failureMessage));
    }
  }

  private staleTaskSubmitResult(
    task: SwarmTask,
    details: Record<string, unknown>,
  ): AgentToolResult<unknown> {
    return jsonResult({
      taskId: task.taskId,
      ...(task.revisionId ? { latestRevisionId: task.revisionId } : {}),
      ...(task.basedOnFrontier ? { latestBasedOnFrontier: task.basedOnFrontier } : {}),
      ...details,
    });
  }

  private failedTaskSubmitResult(
    teamId: string,
    taskId: string,
    failed: { status: SwarmTask["status"]; unblockedTasks: string[] },
    error: string,
  ): AgentToolResult<unknown> {
    return jsonResult({
      status: "failed",
      taskId,
      taskStatus: failed.status,
      unblockedTasks: failed.unblockedTasks,
      error,
      propagation: this.propagationDebugStatus(teamId),
    });
  }

  private teamsEnabled(): boolean {
    return Boolean(loadConfig().gateway?.teams?.enabled);
  }

  private readTeamAgentId(team: SwarmRunRecord): string {
    const explicit = (team as unknown as { teamAgentId?: string }).teamAgentId;
    if (explicit && explicit.trim()) return explicit;
    return `team-${team.teamId}`;
  }

  private insertDagWithAccumulator(
    teamId: string,
    parentTask: SwarmTask,
    items: TaskPlanItem[],
  ): {
    createdTaskIds: string[];
    accumulatorTaskId: string;
    rewiredChildTaskIds: string[];
    interruptedSessions: string[];
  } {
    const graph = this.graphFor(teamId);
    const created: SwarmTask[] = [];
    let accumulatorTaskId = "";
    const rewiredChildTaskIds = new Set<string>();
    const interruptedSessions = new Set<string>();

    this.withGraphMutation(graph, () => {
      const directChildren = graph
        .listTasks()
        .filter(
          (task) =>
            task.status !== TASK_STATUS.DELETED && task.dependsOn.includes(parentTask.taskId),
        );

      const createdTaskByKey = new Map<string, SwarmTask>();
      for (const item of items) {
        const createdTask = this.addTaskWithRevision(teamId, {
          title: item.title,
          instruction: item.instruction,
          assignTo: item.assignee,
          priority: item.priority,
          taskClass: item.taskClass,
          contextSessionKey: item.contextSessionKey,
          dependsOn: [parentTask.taskId],
          status: TASK_STATUS.BLOCKED,
        });
        created.push(createdTask);
        createdTaskByKey.set(item.taskKey, createdTask);
      }

      const dependencyUpdates: Array<{ taskId: string; dependsOn: string[] }> = [];
      for (const item of items) {
        const task = createdTaskByKey.get(item.taskKey);
        if (!task) continue;
        const internalDepTaskIds = item.dependsOnKeys.map((depKey) => {
          const depTask = createdTaskByKey.get(depKey);
          if (!depTask) throw new Error(`Missing DAG dependency "${depKey}".`);
          return depTask.taskId;
        });
        const dependsOn =
          item.dependsOnKeys.length === 0
            ? [parentTask.taskId]
            : this.normalizeTaskIds(internalDepTaskIds);
        dependencyUpdates.push({
          taskId: task.taskId,
          dependsOn,
        });
      }
      graph.applyDependencyBatch(dependencyUpdates);

      const dependantTaskKeys = new Set<string>();
      for (const item of items) {
        for (const depKey of item.dependsOnKeys) dependantTaskKeys.add(depKey);
      }
      const dagLeafTaskIds = items
        .filter((item) => !dependantTaskKeys.has(item.taskKey))
        .map((item) => createdTaskByKey.get(item.taskKey)?.taskId)
        .filter((taskId): taskId is string => !!taskId);
      const normalizedDagLeafTaskIds = this.normalizeTaskIds(dagLeafTaskIds);

      const accumulatorTask = this.addTaskWithRevision(teamId, {
        title: TASK_ACCUMULATOR,
        instruction: `Accumulator barrier for ${parentTask.taskId}`,
        assignTo: SYSTEM_AUTO_ASSIGNEE,
        priority: 1,
        taskClass: "secondary",
        dependsOn: normalizedDagLeafTaskIds,
        status: TASK_STATUS.BLOCKED,
      });
      accumulatorTaskId = accumulatorTask.taskId;

      for (const child of directChildren) {
        if (child.taskId === accumulatorTaskId) continue;
        const nextDependsOnSet = new Set<string>();
        for (const depId of child.dependsOn) {
          if (depId === parentTask.taskId) {
            continue;
          }
          nextDependsOnSet.add(depId);
        }
        nextDependsOnSet.add(accumulatorTaskId);

        const nextDependsOn = Array.from(nextDependsOnSet);
        if (this.sameTaskIdList(child.dependsOn, nextDependsOn)) continue;
        graph.updateTask(child.taskId, { dependsOn: nextDependsOn });
        rewiredChildTaskIds.add(child.taskId);
        if (
          this.currentTaskForSession(teamId, this.taskSessionKey(child))?.taskId === child.taskId
        ) {
          interruptedSessions.add(this.taskSessionKey(child));
        }
      }
    });

    return {
      createdTaskIds: created.map((task) => task.taskId),
      accumulatorTaskId,
      rewiredChildTaskIds: Array.from(rewiredChildTaskIds),
      interruptedSessions: Array.from(interruptedSessions),
    };
  }

  private scheduleTeamCompletionEvaluation(teamId: string): void {
    if (AgentSwarm.completionEvalQueuedByTeam.has(teamId)) return;
    AgentSwarm.completionEvalQueuedByTeam.add(teamId);
    queueMicrotask(() => {
      AgentSwarm.completionEvalQueuedByTeam.delete(teamId);
      this.evaluateTeamCompletion(teamId);
    });
  }

  private evaluateTeamCompletion(teamId: string): void {
    const graph = this.graphFor(teamId);
    const activeTasks = graph.listTasks().filter((task) => task.status !== TASK_STATUS.DELETED);
    const endTask = this.resolveEndTask(teamId);
    const endTaskId = endTask?.taskId;

    const hasOpenWork = activeTasks.some((task) => {
      if (endTaskId && task.taskId === endTaskId) return false;
      return task.status !== TASK_STATUS.COMPLETED && task.status !== TASK_STATUS.FAILED;
    });

    if (hasOpenWork) {
      if (
        endTask &&
        endTask.status !== TASK_STATUS.COMPLETED &&
        endTask.status !== TASK_STATUS.FAILED
      ) {
        graph.updateTask(endTask.taskId, {
          status: TASK_STATUS.DELETED,
          completedAt: Date.now(),
          deletedAt: Date.now(),
        });
        this.setRunEndTaskId(teamId, undefined);
        const endSessionKey = this.taskSessionKey(endTask);
        if (this.currentTaskForSession(teamId, endSessionKey)?.taskId === endTask.taskId) {
          this.setSessionIdle(teamId, endSessionKey);
        }
      }
      return;
    }

    const leafTaskIds = graph
      .listActiveLeafTasks(new Set(endTaskId ? [endTaskId] : []))
      .map((task) => task.taskId);
    const normalizedLeafTaskIds = this.normalizeTaskIds(leafTaskIds);

    if (endTask) {
      if (endTask.status === TASK_STATUS.COMPLETED || endTask.status === TASK_STATUS.FAILED) {
        this.refreshEndTaskInstruction(teamId, endTask.taskId);
        return;
      }
      const patch: Partial<SwarmTask> = {};
      if (!this.sameTaskIdList(endTask.dependsOn, normalizedLeafTaskIds)) {
        patch.dependsOn = normalizedLeafTaskIds;
      }
      if (endTask.status === TASK_STATUS.BLOCKED) {
        patch.status = TASK_STATUS.PENDING;
        patch.claimedAt = 0;
      }
      if (Object.keys(patch).length > 0) {
        graph.updateTask(endTask.taskId, patch);
      }
      this.refreshEndTaskInstruction(teamId, endTask.taskId);
      return;
    }

    const team = this.getRun(teamId);
    const created = this.addTaskWithRevision(teamId, {
      title: TASK_END,
      instruction:
        "Skill: report generation. Generate final report for caller. Submit with task_submit; system broadcasts to caller.",
      assignTo: RESERVED_MATE_ID.LEAD,
      priority: 1,
      taskClass: "secondary",
      contextSessionKey: team
        ? this.resolveLeadSessionKey(team)
        : `agent:team-${teamId}:${RESERVED_MATE_ID.LEAD}`,
      dependsOn: normalizedLeafTaskIds,
      status: TASK_STATUS.PENDING,
    });
    this.setRunEndTaskId(teamId, created.taskId);
    this.refreshEndTaskInstruction(teamId, created.taskId);
  }

  private normalizeTaskIds(taskIds: string[]): string[] {
    return Array.from(new Set(taskIds)).toSorted((a, b) => a.localeCompare(b));
  }

  private sameTaskIdList(a: string[], b: string[]): boolean {
    const left = this.normalizeTaskIds(a);
    const right = this.normalizeTaskIds(b);
    if (left.length !== right.length) return false;
    for (let i = 0; i < left.length; i += 1) {
      if (left[i] !== right[i]) return false;
    }
    return true;
  }

  private refreshEndTaskInstruction(teamId: string, endTaskId?: string): void {
    const graph = this.graphFor(teamId);
    const endTask = this.resolveEndTask(teamId, endTaskId);
    if (!endTask || endTask.status === TASK_STATUS.DELETED) return;

    const graphVersion = graph.getVersion();
    const cached = AgentSwarm.endTaskChronologyCacheByTeam.get(teamId);
    if (cached && cached.graphVersion === graphVersion) {
      this.applyEndTaskInstruction(graph, endTask, cached.instruction);
      return;
    }

    const chronologyText = graph
      .listTasks()
      .filter((task) => this.isChronologyPrimaryTask(task, endTask.taskId))
      .toSorted((a, b) => a.createdAt - b.createdAt)
      .map((task) => {
        const submit = task.submit?.trim() ? task.submit.trim() : "(no submission)";
        return `- ${task.taskId} | ${task.title} | ${task.status}\n  submit: ${submit}`;
      })
      .join("\n");
    const instruction = this.buildEndTaskInstruction(
      chronologyText || "- No primary task results yet.",
    );
    this.applyEndTaskInstruction(graph, endTask, instruction);
    AgentSwarm.endTaskChronologyCacheByTeam.set(teamId, {
      graphVersion: graph.getVersion(),
      instruction,
    });
  }

  private isChronologyPrimaryTask(task: SwarmTask, endTaskId?: string): boolean {
    return (
      task.status !== TASK_STATUS.DELETED &&
      task.taskClass === "primary" &&
      task.title !== TASK_INIT &&
      (!endTaskId || task.taskId !== endTaskId)
    );
  }

  private buildEndTaskInstruction(chronologyText: string): string {
    return [
      "Skill: report generation.",
      "Build final report for caller from completed primary tasks.",
      "Summarize timeline, key decisions, implementation details, and final outcomes.",
      "Submit final report using task_submit with this end_task id. System will broadcast to caller.",
      "",
      "Chronology:",
      chronologyText,
    ].join("\n");
  }

  private applyEndTaskInstruction(graph: Graph, endTask: SwarmTask, instruction: string): void {
    if (endTask.instruction === instruction) return;
    graph.updateTask(endTask.taskId, { instruction });
  }

  private readEndTaskId(teamId: string): string | undefined {
    return this.getRun(teamId)?.endTaskId?.trim() || undefined;
  }

  private isEndTask(teamId: string, taskId: string): boolean {
    const endTaskId = this.readEndTaskId(teamId);
    return !!endTaskId && endTaskId === taskId;
  }

  private resolveEndTask(teamId: string, endTaskId?: string): SwarmTask | undefined {
    const graph = this.graphFor(teamId);
    const resolvedEndTaskId = endTaskId?.trim() || this.readEndTaskId(teamId);
    if (!resolvedEndTaskId) return undefined;
    const task = graph.getTask(resolvedEndTaskId);
    if (task && task.status !== TASK_STATUS.DELETED) return task;
    this.setRunEndTaskId(teamId, undefined);
    return undefined;
  }

  private currentTaskForSession(teamId: string, sessionKey: string): SwarmTask | undefined {
    const taskId = AgentSwarm.activeTaskBySession.get(this.sessionRuntimeKey(teamId, sessionKey));
    if (!taskId) return undefined;
    return this.graphFor(teamId).getTask(taskId);
  }

  private emitBootstrap(params: {
    teamId: string;
    sessionLabel?: string;
    taskId: string;
    sessionKey: string;
    title: string;
    instruction: string;
    dependencyNotes?: DependencyNotesByTaskId;
  }): void {
    const send = this.opts.platform?.sendBootstrap;
    if (!send) return;
    this.runSessionHook(send(params));
  }

  private emitSessionNote(params: { teamId: string; sessionKey: string; note: string }): void {
    const append = this.opts.platform?.appendSessionNote;
    if (!append) return;
    this.runSessionHook(append(params));
  }

  private emitSessionAnnouncement(params: {
    teamId: string;
    sessionKey: string;
    message: string;
  }): boolean {
    const announce = this.opts.platform?.announceSession;
    if (!announce) return false;
    this.runSessionHook(announce(params));
    return true;
  }

  private emitInterrupt(params: { teamId: string; sessionKey: string; reason: string }): void {
    const interrupt = this.opts.platform?.interruptSession;
    if (!interrupt) return;
    this.runSessionHook(interrupt(params));
  }

  private runSessionHook(result: void | Promise<void>): void {
    if (!result) return;
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
    if (!question || !answer) return;

    const graph = this.graphFor(teamId);
    const descendantTaskIds = graph.getAllChildren(params.questionTaskId);
    if (descendantTaskIds.length === 0) return;

    const contextSessionKeys = new Set<string>();
    for (const taskId of descendantTaskIds) {
      const task = graph.getTask(taskId);
      if (!task || task.status === TASK_STATUS.DELETED) continue;
      const sessionKey = task.contextSessionKey.trim();
      if (sessionKey) contextSessionKeys.add(sessionKey);
    }
    const transcript = `Dependency Q&A:\nQ: ${question}\nA: ${answer}`;
    const appendHook = this.opts.platform?.appendSessionNote;
    if (!appendHook) return;
    for (const sessionKey of contextSessionKeys) {
      this.emitSessionNote({ teamId, sessionKey, note: transcript });
    }
  }

  private emitSubmitDependencyChange(teamId: string, sourceTaskId: string): void {
    const graph = this.graphFor(teamId);
    const sourceTask = graph.getTask(sourceTaskId);
    if (!sourceTask || sourceTask.status === TASK_STATUS.DELETED) return;

    const answer = sourceTask.submit.trim();
    const isQuestionNode = sourceTask.title === "qn_request";
    const summary = answer.length <= 800 ? answer : `${answer.slice(0, 800)}...`;
    const question = sourceTask.instruction.trim();
    const text = isQuestionNode
      ? [
          "Dependency Q&A",
          ...(question ? [`Q: ${question}`] : []),
          ...(summary ? [`A: ${summary}`] : []),
        ].join("\n")
      : [
          `Dependency ${sourceTask.taskId} (${sourceTask.title}) completed.`,
          ...(summary ? [`Summary: ${summary}`] : []),
        ].join("\n");
    const note: DependencyNote = {
      noteId: `${sourceTaskId}:${sourceTask.revisionId ?? "unknown"}:${isQuestionNode ? "qa" : "submit"}`,
      sourceTaskId,
      sourceRevisionId: sourceTask.revisionId,
      kind: isQuestionNode ? "question_answer" : "submit",
      text,
      createdAt: Date.now(),
    };
    this.emitDependencyChange(teamId, note);
  }

  private buildTeamFinalReportAnnouncement(answer: string): string {
    const report = answer.trim() || "(no report provided)";
    return [
      "A team run just completed.",
      "",
      "Team Final Report:",
      report,
      "",
      "Summarize this naturally for the user in 1-2 sentences.",
      "Do not mention internal team orchestration mechanics.",
    ].join("\n");
  }

  private emitDependencyChange(
    teamId: string,
    note: DependencyNote,
    targetTaskIds?: string[],
  ): void {
    const graph = this.graphFor(teamId);
    const taskIds = targetTaskIds ?? graph.getAllChildrenTopologically(note.sourceTaskId);
    if (taskIds.length === 0) return;
    this.withGraphMutation(graph, () => {
      for (const taskId of taskIds) {
        const task = graph.getTask(taskId);
        if (!task || task.status === TASK_STATUS.DELETED) continue;
        this.appendDependencyNoteToTask(graph, task.taskId, note);
      }
    });
  }

  private appendDependencyNoteToTask(graph: Graph, taskId: string, note: DependencyNote): void {
    const task = graph.getTask(taskId);
    if (!task || task.status === TASK_STATUS.DELETED) return;
    const dependencyNotes = task.dependencyNotes ?? {};
    const bySource = dependencyNotes[note.sourceTaskId] ?? [];
    if (bySource.some((existing) => existing.noteId === note.noteId)) return;
    graph.updateTask(taskId, {
      dependencyNotes: {
        ...dependencyNotes,
        [note.sourceTaskId]: [...bySource, note],
      },
    });
  }

  private dependencyNoteCursorFor(teamId: string): Map<string, Record<string, number>> {
    return this.getOrInitMapValue(
      AgentSwarm.deliveredDependencyNotesByTeam,
      teamId,
      () => new Map(),
    );
  }

  private undeliveredDependencyNotes(
    teamId: string,
    sessionKey: string,
    task: SwarmTask,
  ): DependencyNotesByTaskId | undefined {
    const dependencyNotes = task.dependencyNotes;
    if (!dependencyNotes) return undefined;
    const cursorByTask = this.dependencyNoteCursorFor(teamId);
    const cursorKey = `${task.taskId}:${sessionKey}`;
    const cursor = cursorByTask.get(cursorKey) ?? {};
    const nextCursor: Record<string, number> = { ...cursor };
    const pending: DependencyNotesByTaskId = {};
    let hasPending = false;

    for (const [sourceTaskId, notes] of Object.entries(dependencyNotes)) {
      if (notes.length === 0) continue;
      const start = Math.max(0, cursor[sourceTaskId] ?? 0);
      if (start >= notes.length) continue;
      pending[sourceTaskId] = notes.slice(start);
      nextCursor[sourceTaskId] = notes.length;
      hasPending = true;
    }

    if (!hasPending) return undefined;
    cursorByTask.set(cursorKey, nextCursor);
    return pending;
  }

  private async discardFailedTaskChanges(teamId: string, task: SwarmTask): Promise<void> {
    const sessionName = task.contextSessionKey.trim();
    if (!sessionName) return;

    const workspaceDir = this.worktree.sessionWorkspaceDir(teamId, sessionName);
    if (!(await this.worktree.pathExists(workspaceDir))) return;

    const restore = await runCommandWithTimeout(
      ["git", "-C", workspaceDir, "restore", "--worktree", "--staged", "."],
      { timeoutMs: GIT_TIMEOUT_MS },
    );
    if (restore.code === 0) return;

    await runCommandWithTimeout(["git", "-C", workspaceDir, "checkout", "--", "."], {
      timeoutMs: GIT_TIMEOUT_MS,
    });
  }

  private async claimPendingForSession(teamId: string, sessionKey: string): Promise<void> {
    if (!this.isSessionIdle(teamId, sessionKey)) return;

    const graph = this.graphFor(teamId);
    const queue = this.readyQueueFor(teamId, sessionKey);
    const latestRevisionCache = this.latestRevisionCacheFor(teamId);
    if (queue.size === 0) {
      for (const task of graph.listTasks()) {
        if (task.status !== TASK_STATUS.PENDING) continue;
        if (this.taskSessionKey(task) !== sessionKey) continue;
        queue.enqueue(task);
      }
    }

    let claimed: SwarmTask | undefined;
    while (this.isSessionIdle(teamId, sessionKey)) {
      const taskId = queue.dequeueTaskId();
      if (!taskId) {
        break;
      }
      const task = graph.getTask(taskId);
      if (
        !task ||
        task.status !== TASK_STATUS.PENDING ||
        this.taskSessionKey(task) !== sessionKey
      ) {
        continue;
      }
      if (this.completeSystemAutoTaskIfPending(teamId, task)) {
        continue;
      }
      if (this.taskNeedsRevisionUpdate(teamId, task, latestRevisionCache)) {
        const rebased = this.rebaseTaskToLatestFrontier(teamId, task, latestRevisionCache);
        if (rebased.status === TASK_STATUS.PENDING) queue.enqueue(rebased);
        continue;
      }
      const next = graph.claimIfPending(task.taskId);
      if (next.status === TASK_STATUS.CLAIMED) {
        claimed = next;
        break;
      }
    }

    if (!claimed) return;

    try {
      await this.worktree.switchTaskWorktreeAndBranch(teamId, claimed);
    } catch (err) {
      graph.updateTask(claimed.taskId, { status: TASK_STATUS.PENDING, claimedAt: 0 });
      throw err;
    }
    const refreshedClaim = graph.getTask(claimed.taskId);
    if (
      !refreshedClaim ||
      refreshedClaim.status !== TASK_STATUS.CLAIMED ||
      this.taskNeedsRevisionUpdate(teamId, refreshedClaim, latestRevisionCache)
    ) {
      if (refreshedClaim?.status === TASK_STATUS.CLAIMED) {
        const rebased = this.rebaseTaskToLatestFrontier(
          teamId,
          refreshedClaim,
          latestRevisionCache,
        );
        if (rebased.status === TASK_STATUS.PENDING) queue.enqueue(rebased);
      }
      return;
    }
    this.sendTaskToSession(teamId, sessionKey, claimed.taskId);
  }
}
