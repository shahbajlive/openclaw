import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "../../tools/common.js";
import { loadConfig } from "../../../config/config.js";
import { jsonResult } from "../../tools/common.js";
import { createSessionsSendTool } from "../../tools/sessions-send-tool.js";
import { getTask, listTasks, updateTask } from "../task-list.js";
import {
  getTeam,
  isTeamLead,
  resolveCallerTeamContext,
  updateTeamStatus,
} from "../team-registry.js";
import { cleanupTeam } from "../team-registry.js";

const TeamCompleteSchema = Type.Object({
  teamId: Type.Optional(
    Type.String({
      description: "Optional team ID to complete. If not provided, uses the current team context.",
    }),
  ),
  confirm: Type.Boolean({
    description: "Must be true to confirm completion.",
  }),
  result: Type.Optional(Type.String()),
  reason: Type.Optional(Type.String()),
  taskId: Type.Optional(Type.String()),
});

export function createTeamCompleteTool(opts?: { agentSessionKey?: string }): AnyAgentTool {
  return {
    label: "Teams",
    name: "team_complete",
    description:
      'Finish the team. Use result: "success" (default) or result: "failed" with optional reason/taskId. On failure, the caller is notified with task context and the team is cleaned up.',
    parameters: TeamCompleteSchema,
    execute: async (_toolCallId, args) => {
      const cfg = loadConfig();
      if (!cfg.gateway?.teams?.enabled) {
        return jsonResult({ status: "error", error: "Teams are not enabled in gateway config" });
      }

      const confirm = args.confirm === true;
      if (!confirm) {
        return jsonResult({
          status: "error",
          error: "Must set confirm: true to complete team.",
        });
      }

      const callerSessionKey = opts?.agentSessionKey;
      if (!callerSessionKey) {
        return jsonResult({ status: "error", error: "No session key provided" });
      }

      let teamId = args.teamId;

      if (!teamId) {
        const context = resolveCallerTeamContext(callerSessionKey);
        if (context) {
          teamId = context.team.teamId;
        }
      }

      if (!teamId) {
        return jsonResult({
          status: "error",
          error: "No team context found. Provide a teamId if calling from outside a team.",
        });
      }

      const team = getTeam(teamId);
      if (!team) {
        return jsonResult({ status: "error", error: `Team ${teamId} not found` });
      }

      // Only team lead can complete
      if (!isTeamLead(teamId, callerSessionKey)) {
        return jsonResult({
          status: "error",
          error: "Only the team lead can complete the team",
        });
      }

      // Check if there are active teammates
      const activeTeammates = Object.values(team.teammates).filter(
        (tm) => tm.status === "active" || tm.status === "spawning",
      );
      if (activeTeammates.length > 0) {
        return jsonResult({
          status: "warning",
          error: `${activeTeammates.length} teammate(s) still active. Shut them down first using teammate_shutdown.`,
          activeTeammates: activeTeammates.map((tm) => ({
            teammateId: tm.teammateId,
            role: tm.role,
            status: tm.status,
          })),
        });
      }

      const result = args.result === "failed" ? "failed" : "success";
      const reason = args.reason as string | undefined;
      const failedTaskId = args.taskId as string | undefined;

      if (result === "failed") {
        let failedTask:
          | {
              taskId: string;
              title: string;
              description?: string;
              dependsOn?: string[];
              status?: string;
            }
          | undefined;
        try {
          if (failedTaskId) {
            const task = getTask(teamId, failedTaskId);
            if (task) {
              failedTask = {
                taskId: task.taskId,
                title: task.title,
                description: task.description,
                dependsOn: task.dependsOn,
                status: task.status,
              };
              if (task.status !== "failed") {
                try {
                  updateTask(teamId, task.taskId, { status: "failed" });
                  failedTask.status = "failed";
                } catch {
                  // ignore update failure
                }
              }
            }
          }
        } catch {
          // ignore task lookup errors
        }

        updateTeamStatus(teamId, "failed");

        const creatorSessionKey = team.creatorSessionKey;
        if (creatorSessionKey) {
          const lines: string[] = [];
          lines.push(`Team "${team.teamName}" failed and was cleaned up.`);
          if (reason) {
            lines.push("");
            lines.push(`Reason: ${reason}`);
          }
          if (failedTask) {
            lines.push("");
            lines.push("Failed subtask:");
            lines.push(`- title: ${failedTask.title}`);
            lines.push(`- taskId: ${failedTask.taskId}`);
            if (failedTask.status) {
              lines.push(`- status: ${failedTask.status}`);
            }
            if (failedTask.description) {
              lines.push(`- description: ${failedTask.description}`);
            }
            if (failedTask.dependsOn && failedTask.dependsOn.length > 0) {
              lines.push(`- dependsOn: ${failedTask.dependsOn.join(", ")}`);
            }
          } else {
            lines.push("");
            lines.push("A subtask failed, but no task record was available.");
          }
          lines.push("");
          lines.push("You can retry by creating a new team with adjusted tasks.");
          try {
            const sessionsSend = createSessionsSendTool({ agentSessionKey: callerSessionKey });
            await sessionsSend.execute("team-failed", {
              sessionKey: creatorSessionKey,
              message: lines.join("\\n"),
              timeoutSeconds: 0,
            });
          } catch {
            // best-effort notify
          }
        }

        cleanupTeam(teamId);

        return jsonResult({
          status: "failed",
          teamId,
          teamName: team.teamName,
          message: `Team "${team.teamName}" failed and was cleaned up.`,
        });
      }

      // Get task summary
      let taskSummary: string | undefined;
      try {
        const { summary } = listTasks(teamId, { includeCompleted: true });
        taskSummary = `${summary.completed}/${summary.total} tasks completed, ${summary.failed} failed`;
      } catch {
        // Ignore task summary errors
      }

      // Mark team as completed
      updateTeamStatus(teamId, "completed");

      return jsonResult({
        status: "completed",
        teamId,
        teamName: team.teamName,
        message: `Team "${team.teamName}" has been marked as completed. Team data is preserved for review.`,
        taskSummary,
        note: "Use team_cleanup to delete team data when no longer needed.",
      });
    },
  };
}
