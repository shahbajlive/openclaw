import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "../../tools/common.js";
import type { TaskPriority } from "../types.js";
import { loadConfig } from "../../../config/config.js";
import { jsonResult, readStringParam } from "../../tools/common.js";
import { claimTask } from "../task-list.js";
import { getTeam, resolveCallerTeamContext, updateTeammateStatus } from "../team-registry.js";
import { saveTeamToDisk } from "../team-registry.store.js";
import {
  TEAMMATE_STATUS_ACTIVE,
  TEAMMATE_STATUS_IDLE,
  TEAMMATE_STATUS_COMPLETED,
  TEAMMATE_STATUS_FAILED,
} from "../types.js";

const TaskClaimSchema = Type.Object({
  teamId: Type.String(),
  taskId: Type.Optional(Type.String()),
  filter: Type.Optional(
    Type.Object({
      priority: Type.Optional(Type.String()),
    }),
  ),
});

export function createTaskClaimTool(opts?: { agentSessionKey?: string }): AnyAgentTool {
  return {
    label: "Teams",
    name: "task_claim",
    description:
      "Claim a task from the team's shared task list. You can claim a specific task by ID, or let the system auto-select the highest priority pending task.",
    parameters: TaskClaimSchema,
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
      const taskId = readStringParam(params, "taskId");
      const filter = (params.filter as Record<string, unknown>) ?? {};
      const priorityFilter = readStringParam(filter, "priority");

      // 3. Get team from registry
      const team = getTeam(teamId);
      if (!team) {
        return jsonResult({
          status: "error",
          error: `Team "${teamId}" not found.`,
        });
      }

      // 4. Determine caller identity (lead or teammateId)
      const callerContext = resolveCallerTeamContext(opts?.agentSessionKey ?? "");
      if (!callerContext) {
        return jsonResult({
          status: "error",
          error: "You are not a member of this team.",
        });
      }

      // 5. Lead cannot claim tasks. Lead is coordinator-only.
      if (callerContext.isLead) {
        return jsonResult({
          status: "error",
          error:
            "Lead cannot claim tasks. You can only coordinate. Spawn teammates to do the work.",
        });
      }

      const claimerId = callerContext.isLead
        ? "lead"
        : (callerContext.teammate?.teammateId ?? "unknown");

      // 6. Normalize priority filter
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

      // 7. Call claimTask
      try {
        const result = claimTask(teamId, {
          taskId,
          claimerId,
          filter: priorityValue ? { priority: priorityValue } : undefined,
        });

        if (!result.success) {
          return jsonResult({
            status: "error",
            error: result.reason ?? "Failed to claim task",
          });
        }

        // 8. Update teammate's currentTask in registry if caller is a teammate
        if (callerContext.teammate && result.task) {
          callerContext.teammate.currentTask = result.task.title;
          callerContext.teammate.claimedTasks++;
          // Transition to active if teammate is idle or in terminal state
          if (
            callerContext.teammate.status === TEAMMATE_STATUS_IDLE ||
            callerContext.teammate.status === TEAMMATE_STATUS_COMPLETED ||
            callerContext.teammate.status === TEAMMATE_STATUS_FAILED
          ) {
            updateTeammateStatus(teamId, callerContext.teammate.teammateId, TEAMMATE_STATUS_ACTIVE);
          }
          // Persist teammate state update to disk
          try {
            saveTeamToDisk(callerContext.team, cfg);
          } catch {
            // Non-fatal: in-memory state is already updated
          }
        }

        // 9. Return result
        return jsonResult({
          success: true,
          taskId: result.task?.taskId,
          title: result.task?.title,
          description: result.task?.description,
          priority: result.task?.priority,
          dependsOn: result.task?.dependsOn,
          claimedBy: claimerId,
        });
      } catch (err) {
        const messageText =
          err instanceof Error
            ? err.message
            : typeof err === "string"
              ? err
              : "failed to claim task";
        return jsonResult({
          status: "error",
          error: messageText,
        });
      }
    },
  };
}
