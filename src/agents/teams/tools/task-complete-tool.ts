import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "../../tools/common.js";
import { loadConfig } from "../../../config/config.js";
import { jsonResult, readStringParam, readStringArrayParam } from "../../tools/common.js";
import { broadcastMessage } from "../mailbox.js";
import { completeTask, listTasks } from "../task-list.js";
import {
  getTeam,
  resolveCallerTeamContext,
  notifyLeadIfTeamIdle,
  transitionTeammateToIdle,
} from "../team-registry.js";
import { saveTeamToDisk } from "../team-registry.store.js";

const TaskCompleteSchema = Type.Object({
  teamId: Type.String(),
  taskId: Type.String(),
  result: Type.Optional(Type.String()), // "success" | "failure"
  summary: Type.Optional(Type.String()),
  artifacts: Type.Optional(Type.Array(Type.String())),
});

export function createTaskCompleteTool(opts?: { agentSessionKey?: string }): AnyAgentTool {
  return {
    label: "Teams",
    name: "task_complete",
    description:
      "Mark a claimed task as completed. Optionally provide a result, summary, and artifacts.",
    parameters: TaskCompleteSchema,
    execute: async (_toolCallId, args) => {
      // 1. Check teams enabled
      const cfg = loadConfig();
      if (!cfg.gateway?.teams?.enabled) {
        return jsonResult({
          status: "error",
          error: "Teams are not enabled.",
        });
      }

      // 2. Parse params
      const params = args as Record<string, unknown>;
      const teamId = readStringParam(params, "teamId", { required: true });
      const taskId = readStringParam(params, "taskId", { required: true });
      const resultRaw = readStringParam(params, "result");
      const summary = readStringParam(params, "summary");
      const artifacts = readStringArrayParam(params, "artifacts");

      // Normalize result
      let result: "success" | "failure" | undefined;
      if (resultRaw) {
        const normalized = resultRaw.toLowerCase();
        if (normalized === "success") {
          result = "success";
        } else if (normalized === "failure") {
          result = "failure";
        }
      }

      // 3. Get team from registry
      const team = getTeam(teamId);
      if (!team) {
        return jsonResult({
          status: "error",
          error: `Team "${teamId}" not found.`,
        });
      }

      // 4. Determine caller identity
      const callerContext = resolveCallerTeamContext(opts?.agentSessionKey ?? "");
      if (!callerContext) {
        return jsonResult({
          status: "error",
          error: "You are not a member of this team.",
        });
      }

      // 5. Complete the task
      try {
        const completionResult = completeTask(teamId, {
          taskId,
          result,
          summary,
          artifacts,
        });

        // 6. Update teammate's currentTask and completedTasks if caller is a teammate
        if (callerContext.teammate) {
          callerContext.teammate.currentTask = undefined;
          callerContext.teammate.completedTasks++;
          // Persist teammate state update to disk
          try {
            saveTeamToDisk(callerContext.team, cfg);
          } catch {
            // Non-fatal: in-memory state is already updated
          }
        }

        // 7. If unblockedTasks.length > 0, optionally broadcast notification
        if (completionResult.unblockedTasks.length > 0 && team.config.notifyOnUnblock) {
          const unblockedList = completionResult.unblockedTasks.join(", ");
          broadcastMessage({
            teamId,
            from: callerContext.isLead ? "lead" : (callerContext.teammate?.teammateId ?? "system"),
            message: `Task "${taskId}" completed. Unblocked tasks: ${unblockedList}`,
            priority: "normal",
          });
        }

        // 8. Check if there are more pending tasks; if not, transition teammate to idle
        if (callerContext.teammate) {
          const { summary } = listTasks(teamId);
          if (summary.pending === 0) {
            transitionTeammateToIdle(teamId, callerContext.teammate.teammateId);
          }
        }

        // 9. Notify the lead if the whole team is now idle
        notifyLeadIfTeamIdle(teamId);

        // 9. Return result
        return jsonResult({
          status: "completed",
          taskId: completionResult.taskId,
          taskStatus: completionResult.status,
          unblockedTasks: completionResult.unblockedTasks,
          unblockedCount: completionResult.unblockedTasks.length,
        });
      } catch (err) {
        const messageText =
          err instanceof Error
            ? err.message
            : typeof err === "string"
              ? err
              : "failed to complete task";
        return jsonResult({
          status: "error",
          error: messageText,
        });
      }
    },
  };
}
