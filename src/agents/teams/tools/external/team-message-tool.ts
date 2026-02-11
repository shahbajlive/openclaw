import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "../../../tools/common.js";
import { loadConfig } from "../../../../config/config.js";
import { callGateway } from "../../../../gateway/call.js";
import { jsonResult, readStringParam } from "../../../tools/common.js";
import { createSessionsSendTool } from "../../../tools/sessions-send-tool.js";
import { resolvePrimaryContextTaskId } from "../../task-context.js";
import { addTask, listTasks } from "../../task-list.js";
import { getTeam } from "../../team-registry.js";

const TeamMessageSchema = Type.Object({
  teamId: Type.String(),
  message: Type.String(),
  priority: Type.Optional(Type.String()), // "normal" | "urgent"
});

export function createTeamMessageTool(opts?: { agentSessionKey?: string }): AnyAgentTool {
  return {
    label: "Teams",
    name: "team_message",
    description:
      "Send a message from the team creator to the team. Creates a lead-assigned task containing the message.",
    parameters: TeamMessageSchema,
    execute: async (_toolCallId, args) => {
      const cfg = loadConfig();
      if (!cfg.gateway?.teams?.enabled) {
        return jsonResult({ status: "error", error: "Teams are not enabled." });
      }
      if (cfg.tools?.agentToAgent?.enabled !== true) {
        return jsonResult({
          status: "error",
          error:
            "Agent-to-agent messaging is disabled. Set tools.agentToAgent.enabled: true to message the team.",
        });
      }

      const params = args as Record<string, unknown>;
      const teamId = readStringParam(params, "teamId", { required: true });
      const message = readStringParam(params, "message", { required: true });
      const priorityRaw = readStringParam(params, "priority");
      const priority = priorityRaw === "urgent" ? "urgent" : "normal";

      const team = getTeam(teamId);
      if (!team) {
        return jsonResult({ status: "error", error: "Team not found." });
      }

      const callerSessionKey = opts?.agentSessionKey ?? "";
      if (!team.creatorSessionKey || team.creatorSessionKey !== callerSessionKey) {
        return jsonResult({
          status: "error",
          error: "Only the team creator can message the team with this tool.",
        });
      }

      try {
        const trimmed = message.trim();
        const firstLine = trimmed.split("\n")[0] ?? "";
        const title = firstLine ? firstLine.slice(0, 80) : "creator_message";
        let contextTaskId: string | undefined;
        try {
          const allTasks = listTasks(teamId, { includeCompleted: true }).tasks;
          const openLeadReview = allTasks.find(
            (task) =>
              task.assignee === "lead" &&
              task.title === "lead_review" &&
              task.status !== "completed" &&
              task.status !== "failed",
          );
          contextTaskId = openLeadReview?.taskId;
          if (!contextTaskId) {
            const primaryTasks = allTasks
              .filter((task) => task.taskClass === "primary")
              .toSorted((a, b) => b.createdAt - a.createdAt || b.taskId.localeCompare(a.taskId));
            contextTaskId = primaryTasks[0]?.taskId;
          }
          if (!contextTaskId) {
            return jsonResult({
              status: "error",
              error: "Cannot create creator message task before a primary task exists.",
            });
          }
          const primaryContextTaskId = resolvePrimaryContextTaskId(contextTaskId, allTasks);
          if (!primaryContextTaskId) {
            return jsonResult({
              status: "error",
              error: "Cannot resolve primary context for creator message task.",
            });
          }
        } catch (err) {
          return jsonResult({
            status: "error",
            error:
              err instanceof Error
                ? err.message
                : "Failed to resolve primary context for creator message task.",
          });
        }

        const leadTask = addTask(teamId, {
          title,
          description: `Message from creator:\n${message}`,
          assignTo: "lead",
          priority: priority === "urgent" ? "high" : "normal",
          metadata: {
            source: "creator",
            creatorSessionKey: callerSessionKey,
            context_task_id: contextTaskId,
          },
        });

        try {
          const sessionsSend = createSessionsSendTool({
            agentSessionKey: callerSessionKey,
            allowTeamSessionTarget: true,
          });
          await sessionsSend.execute("team-message", {
            sessionKey: team.leadSessionKey,
            message: `Creator message task queued: "${leadTask.title}" (taskId: ${leadTask.taskId}).`,
          });
        } catch {
          try {
            await callGateway({
              method: "agent",
              params: {
                message: `Creator message task queued: "${leadTask.title}" (taskId: ${leadTask.taskId}).`,
                sessionKey: team.leadSessionKey,
                deliver: false,
                label: "team-lead",
                spawnedBy: callerSessionKey,
              },
              timeoutMs: 10_000,
            });
          } catch {
            // Best-effort wakeup only.
          }
        }

        return jsonResult({
          taskId: leadTask.taskId,
          delivered: true,
          to: "team",
          message: "Message sent to team and queued as a lead task.",
        });
      } catch (err) {
        const messageText =
          err instanceof Error
            ? err.message
            : typeof err === "string"
              ? err
              : "failed to send message";
        return jsonResult({
          status: "error",
          error: messageText,
        });
      }
    },
  };
}
