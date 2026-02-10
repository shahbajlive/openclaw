import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "../../tools/common.js";
import type { TaskStatus, TaskPriority } from "../types.js";
import { loadConfig } from "../../../config/config.js";
import { jsonResult, readStringParam, readStringArrayParam } from "../../tools/common.js";
import { listTasks } from "../task-list.js";

const TaskListSchema = Type.Object({
  teamId: Type.String(),
  filter: Type.Optional(
    Type.Object({
      status: Type.Optional(Type.Array(Type.String())),
      assignee: Type.Optional(Type.String()),
      priority: Type.Optional(Type.String()),
    }),
  ),
  includeCompleted: Type.Optional(Type.Boolean()),
});

export function createTaskListTool(_opts?: { agentSessionKey?: string }): AnyAgentTool {
  return {
    label: "Teams",
    name: "task_list",
    description:
      "List all tasks in the team's shared task list. Supports filtering by status, assignee, and priority.",
    parameters: TaskListSchema,
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
      const filterObj = (params.filter as Record<string, unknown>) ?? {};
      const includeCompleted = params.includeCompleted === true;

      const statusFilter = readStringArrayParam(filterObj, "status");
      const assigneeFilter = readStringParam(filterObj, "assignee");
      const priorityFilter = readStringParam(filterObj, "priority");

      // 3. Normalize filters
      let statusValues: TaskStatus[] | undefined;
      if (statusFilter && statusFilter.length > 0) {
        statusValues = statusFilter
          .map((s) => s.toLowerCase())
          .filter(
            (s) =>
              s === "pending" ||
              s === "blocked" ||
              s === "claimed" ||
              s === "in-progress" ||
              s === "completed" ||
              s === "failed",
          ) as TaskStatus[];
      }

      let priorityValue: TaskPriority | undefined;
      if (priorityFilter) {
        const normalized = priorityFilter.toLowerCase();
        if (
          normalized === "low" ||
          normalized === "normal" ||
          normalized === "high" ||
          normalized === "critical"
        ) {
          priorityValue = normalized as TaskPriority;
        }
      }

      // 4. Call listTasks
      try {
        const result = listTasks(teamId, {
          status: statusValues,
          assignee: assigneeFilter,
          priority: priorityValue,
          includeCompleted,
        });

        const filteredTasks = result.tasks;

        // 6. Use summary from listTasks result
        const summary = result.summary;

        // 7. Return result
        return jsonResult({
          tasks: filteredTasks.map((t) => ({
            taskId: t.taskId,
            title: t.title,
            description: t.description,
            status: t.status,
            assignee: t.assignee,
            priority: t.priority,
            dependsOn: t.dependsOn,
            result: t.result,
            summary: t.summary,
            createdAt: t.createdAt,
            claimedAt: t.claimedAt,
            completedAt: t.completedAt,
          })),
          summary,
        });
      } catch (err) {
        const messageText =
          err instanceof Error
            ? err.message
            : typeof err === "string"
              ? err
              : "failed to list tasks";
        return jsonResult({
          status: "error",
          error: messageText,
        });
      }
    },
  };
}
