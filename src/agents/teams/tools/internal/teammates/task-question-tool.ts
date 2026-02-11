import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "../../../../tools/common.js";
import { loadConfig } from "../../../../../config/config.js";
import { callGateway } from "../../../../../gateway/call.js";
import { jsonResult, readStringParam } from "../../../../tools/common.js";
import { addTask, getTask, updateTask } from "../../../task-list.js";
import { TASK_QUESTION_REQUEST } from "../../../task-taxonomy.js";
import {
  getTeam,
  resolveCallerTeamContext,
  resetIdleNotification,
  transitionTeammateToIdle,
} from "../../../team-registry.js";

const TaskQuestionSchema = Type.Object({
  teamId: Type.String(),
  dependencyTaskId: Type.String({
    description: "Task id for the dependency you need context from.",
  }),
  questionText: Type.String({ description: "The question to route to the dependency owner." }),
  taskId: Type.Optional(
    Type.String({
      description: "The current task id. Defaults to your claimed task when omitted.",
    }),
  ),
});

export function createTaskQuestionTool(opts?: { agentSessionKey?: string }): AnyAgentTool {
  return {
    label: "Teams",
    name: "task_question",
    description:
      "Ask a question about a dependency task. The system creates a high-priority qn_request for the dependency owner, blocks your current task, and returns you to idle.",
    parameters: TaskQuestionSchema,
    execute: async (_toolCallId, args) => {
      const cfg = loadConfig();
      if (!cfg.gateway?.teams?.enabled) {
        return jsonResult({ status: "error", error: "Teams are not enabled." });
      }

      const params = args as Record<string, unknown>;
      const teamId = readStringParam(params, "teamId", { required: true });
      const dependencyTaskId = readStringParam(params, "dependencyTaskId", { required: true });
      const questionText = readStringParam(params, "questionText", { required: true });
      const taskIdParam = readStringParam(params, "taskId");

      const callerContext = resolveCallerTeamContext(opts?.agentSessionKey ?? "");
      if (!callerContext) {
        return jsonResult({ status: "error", error: "You are not a member of this team." });
      }
      if (callerContext.isLead) {
        return jsonResult({
          status: "error",
          error: "Lead should not ask questions. Route qn_request tasks instead.",
        });
      }
      if (callerContext.teammate?.isChore) {
        return jsonResult({
          status: "error",
          error: "Chore teammate cannot ask questions.",
        });
      }

      const team = getTeam(teamId);
      if (!team) {
        return jsonResult({ status: "error", error: `Team "${teamId}" not found.` });
      }

      const teammate = callerContext.teammate;
      if (!teammate) {
        return jsonResult({ status: "error", error: "Caller is not a teammate." });
      }

      const currentTaskId = taskIdParam ?? teammate.currentTaskId;
      if (!currentTaskId) {
        return jsonResult({
          status: "error",
          error: "No active task found. Provide taskId or claim a task first.",
        });
      }

      const currentTask = getTask(teamId, currentTaskId);
      if (!currentTask) {
        return jsonResult({
          status: "error",
          error: `Current task "${currentTaskId}" not found.`,
        });
      }
      if (currentTask.assignee !== teammate.teammateId) {
        return jsonResult({
          status: "error",
          error: "You can only ask questions for your own assigned task.",
        });
      }
      if (currentTask.status !== "claimed" && currentTask.status !== "in-progress") {
        return jsonResult({
          status: "error",
          error: `Current task is not active (status: ${currentTask.status}).`,
        });
      }

      if (dependencyTaskId === currentTaskId) {
        return jsonResult({
          status: "error",
          error: "dependencyTaskId cannot be the same as the current task.",
        });
      }

      const dependencyTask = getTask(teamId, dependencyTaskId);
      if (!dependencyTask) {
        return jsonResult({
          status: "error",
          error: `Dependency task "${dependencyTaskId}" not found.`,
        });
      }
      if (!currentTask.dependsOn.includes(dependencyTaskId)) {
        return jsonResult({
          status: "error",
          error: "dependencyTaskId must be listed in current task dependencies.",
        });
      }

      const dependencyAssignee = dependencyTask.assignee;
      if (!dependencyAssignee) {
        return jsonResult({
          status: "error",
          error: "dependencyTaskId has no assignee to answer this question.",
        });
      }
      if (dependencyAssignee === "lead") {
        return jsonResult({
          status: "error",
          error:
            "dependencyTaskId is lead-owned. Use lead_review workflow for lead clarifications.",
        });
      }
      const dependencyOwner = team.teammates[dependencyAssignee];
      if (!dependencyOwner || dependencyOwner.isChore) {
        return jsonResult({
          status: "error",
          error: `dependencyTaskId assignee \"${dependencyAssignee}\" is unavailable.`,
        });
      }

      try {
        const questionDependsOn = Array.from(
          new Set([dependencyTaskId, ...dependencyTask.dependsOn]),
        );
        const qnRequest = addTask(teamId, {
          title: TASK_QUESTION_REQUEST,
          description: questionText,
          assignTo: dependencyAssignee,
          priority: "high",
          dependsOn: questionDependsOn,
          metadata: {
            curr_task_id: currentTaskId,
            prev_task_id: dependencyTaskId,
            // Question context is the task being asked about.
            context_task_id: dependencyTaskId,
            questionText,
            asker: teammate.teammateId,
          },
        });

        const nextDependsOn = Array.from(new Set([...currentTask.dependsOn, qnRequest.taskId]));

        const updatedTask = updateTask(teamId, currentTaskId, { dependsOn: nextDependsOn });

        transitionTeammateToIdle(teamId, teammate.teammateId);
        resetIdleNotification(teamId);
        setTimeout(() => {
          callGateway({
            config: cfg,
            method: "chat.abort",
            params: { sessionKey: teammate.sessionKey },
            timeoutMs: 5_000,
          }).catch(() => {});
        }, 0);

        return jsonResult({
          status: "queued",
          questionTaskId: qnRequest.taskId,
          blockedTaskId: updatedTask.taskId,
          blockedTaskStatus: updatedTask.status,
          dependsOn: updatedTask.dependsOn,
        });
      } catch (err) {
        const messageText =
          err instanceof Error ? err.message : typeof err === "string" ? err : "question failed";
        return jsonResult({ status: "error", error: messageText });
      }
    },
  };
}
