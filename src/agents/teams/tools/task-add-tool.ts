import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "../../tools/common.js";
import type { TaskPriority } from "../types.js";
import { loadConfig } from "../../../config/config.js";
import { jsonResult, readStringParam, readStringArrayParam } from "../../tools/common.js";
import { addTask } from "../task-list.js";
import { resetIdleNotification } from "../team-registry.js";

const TaskAddSchema = Type.Object({
  teamId: Type.String(),
  title: Type.String(),
  description: Type.Optional(Type.String()),
  dependsOn: Type.Optional(Type.Array(Type.String())),
  assignTo: Type.Optional(Type.String()),
  priority: Type.Optional(Type.String()), // "low" | "normal" | "high" | "critical"
  metadata: Type.Optional(Type.Unknown()),
});

export function createTaskAddTool(_opts?: { agentSessionKey?: string }): AnyAgentTool {
  return {
    label: "Teams",
    name: "task_add",
    description:
      "Add a new task to the team's shared task list. Tasks can have dependencies on other tasks.",
    parameters: TaskAddSchema,
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
      const title = readStringParam(params, "title", { required: true });
      const description = readStringParam(params, "description");
      const dependsOn = readStringArrayParam(params, "dependsOn");
      const assignTo = readStringParam(params, "assignTo");
      const priorityRaw = readStringParam(params, "priority");
      const metadata = params.metadata as Record<string, unknown> | undefined;

      // Normalize priority
      let priority: TaskPriority = "normal";
      if (priorityRaw) {
        const normalized = priorityRaw.toLowerCase();
        if (normalized === "low" || normalized === "high" || normalized === "critical") {
          priority = normalized as TaskPriority;
        }
      }

      // 3. Add task to team's task list
      try {
        const task = addTask(teamId, {
          title,
          description,
          dependsOn,
          assignTo,
          priority,
          metadata,
        });

        // 4. Reset idle-notification so the lead can be re-notified
        //    after this new work completes.
        resetIdleNotification(teamId);

        // 5. Return result
        return jsonResult({
          status: "added",
          taskId: task.taskId,
          title: task.title,
          taskStatus: task.status,
          priority: task.priority,
          dependsOn: task.dependsOn,
        });
      } catch (err) {
        const messageText =
          err instanceof Error ? err.message : typeof err === "string" ? err : "failed to add task";
        return jsonResult({
          status: "error",
          error: messageText,
        });
      }
    },
  };
}
