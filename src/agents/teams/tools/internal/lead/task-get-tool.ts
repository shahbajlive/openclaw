import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "../../../../tools/common.js";
import { loadConfig } from "../../../../../config/config.js";
import { jsonResult, readStringParam } from "../../../../tools/common.js";
import { getTask } from "../../../task-list.js";
import { getTeam, resolveCallerTeamContext } from "../../../team-registry.js";

const TaskGetSchema = Type.Object({
  taskId: Type.String({ description: "ID of the task to get details for" }),
});

export function createTaskGetTool(opts?: { agentSessionKey?: string }): AnyAgentTool {
  return {
    label: "Teams",
    name: "task_get",
    description: "Get details of a specific task by ID. Lead-only tool.",
    parameters: TaskGetSchema,
    execute: async (_toolCallId, args) => {
      const cfg = loadConfig();
      if (!cfg.gateway?.teams?.enabled) {
        return jsonResult({ status: "error", error: "Teams are not enabled in gateway config" });
      }

      const taskId = readStringParam(args, "taskId");
      const callerSessionKey = opts?.agentSessionKey;
      if (!callerSessionKey) {
        return jsonResult({ status: "error", error: "No session key provided" });
      }

      // Parse caller session to determine team
      const context = resolveCallerTeamContext(callerSessionKey);
      if (!context) {
        return jsonResult({ status: "error", error: "Caller is not in a team" });
      }
      if (!context.isLead) {
        return jsonResult({ status: "error", error: "task_get is only available to team leads." });
      }

      const teamId = context.team.teamId;
      const team = getTeam(teamId);
      if (!team) {
        return jsonResult({ status: "error", error: `Team ${teamId} not found` });
      }

      // Get task
      const task = getTask(teamId, taskId);
      if (!task) {
        return jsonResult({ status: "error", error: `Task ${taskId} not found in team ${teamId}` });
      }

      return jsonResult({
        status: "ok",
        task: {
          taskId: task.taskId,
          title: task.title,
          description: task.description,
          status: task.status,
          assignee: task.assignee,
          priority: task.priority,
          dependsOn: task.dependsOn,
          createdAt: task.createdAt,
          claimedAt: task.claimedAt,
          completedAt: task.completedAt,
          result: task.result,
          summary: task.summary,
          artifacts: task.artifacts,
          metadata: task.metadata,
        },
      });
    },
  };
}
