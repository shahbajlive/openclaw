import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "../../tools/common.js";
import type { TaskPriority, TaskStatus } from "../types.js";
import { loadConfig } from "../../../config/config.js";
import { jsonResult, readStringParam } from "../../tools/common.js";
import { updateTask } from "../task-list.js";
import { getTeam, isTeamLead, resolveCallerTeamContext } from "../team-registry.js";

const TaskUpdateSchema = Type.Object({
  taskId: Type.String({ description: "ID of the task to update" }),
  status: Type.Optional(
    Type.Union(
      [
        Type.Literal("pending"),
        Type.Literal("blocked"),
        Type.Literal("claimed"),
        Type.Literal("in-progress"),
        Type.Literal("completed"),
        Type.Literal("failed"),
      ],
      { description: "New task status" },
    ),
  ),
  priority: Type.Optional(
    Type.Union(
      [Type.Literal("low"), Type.Literal("normal"), Type.Literal("high"), Type.Literal("critical")],
      { description: "New task priority" },
    ),
  ),
  assignee: Type.Optional(
    Type.String({ description: "New assignee (teammate ID or session key)" }),
  ),
  description: Type.Optional(Type.String({ description: "New task description" })),
  dependsOn: Type.Optional(
    Type.Array(Type.String(), { description: "Updated list of task IDs this task depends on" }),
  ),
});

export function createTaskUpdateTool(opts?: { agentSessionKey?: string }): AnyAgentTool {
  return {
    label: "Teams",
    name: "task_update",
    description:
      "Modify task properties like status, priority, dependencies, or description. Primarily for team leads to adjust task parameters. Teammates can update their own assigned tasks.",
    parameters: TaskUpdateSchema,
    execute: async (_toolCallId, args) => {
      const cfg = loadConfig();
      if (!cfg.gateway?.teams?.enabled) {
        return jsonResult({ status: "error", error: "Teams are not enabled in gateway config" });
      }

      const taskId = readStringParam(args, "taskId");
      const status = args.status as TaskStatus | undefined;
      const priority = args.priority as TaskPriority | undefined;
      const assignee = args.assignee ? String(args.assignee) : undefined;
      const description = args.description ? String(args.description) : undefined;
      const dependsOn = Array.isArray(args.dependsOn) ? (args.dependsOn as string[]) : undefined;

      const callerSessionKey = opts?.agentSessionKey;
      if (!callerSessionKey) {
        return jsonResult({ status: "error", error: "No session key provided" });
      }

      // Parse caller session to determine team
      const context = resolveCallerTeamContext(callerSessionKey);
      if (!context) {
        return jsonResult({ status: "error", error: "Caller is not in a team" });
      }

      const teamId = context.team.teamId;
      const team = getTeam(teamId);
      if (!team) {
        return jsonResult({ status: "error", error: `Team ${teamId} not found` });
      }

      // Check permissions: team lead can update any task, teammates can only update their own
      const isLead = isTeamLead(callerSessionKey, teamId);
      if (!isLead) {
        // For teammates, verify they're updating their own task
        const task = await import("../task-list.js").then((m) => m.getTask(teamId, taskId));
        const teammateId = context.teammate?.teammateId;
        if (!task || !teammateId || task.assignee !== teammateId) {
          return jsonResult({
            status: "error",
            error:
              "Teammates can only update tasks assigned to them. Ask the team lead to update this task.",
          });
        }
      }

      try {
        const updatedTask = updateTask(teamId, taskId, {
          status,
          priority,
          assignee,
          description,
          dependsOn,
        });

        return jsonResult({
          status: "updated",
          taskId: updatedTask.taskId,
          task: {
            title: updatedTask.title,
            description: updatedTask.description,
            status: updatedTask.status,
            assignee: updatedTask.assignee,
            priority: updatedTask.priority,
            dependsOn: updatedTask.dependsOn,
          },
        });
      } catch (err) {
        const messageText =
          err instanceof Error ? err.message : typeof err === "string" ? err : "update failed";
        return jsonResult({ status: "error", error: `Failed to update task: ${messageText}` });
      }
    },
  };
}
