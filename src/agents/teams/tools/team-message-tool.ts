import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "../../tools/common.js";
import { loadConfig } from "../../../config/config.js";
import { callGateway } from "../../../gateway/call.js";
import { jsonResult, readStringParam } from "../../tools/common.js";
import { createSessionsSendTool } from "../../tools/sessions-send-tool.js";
import { sendMessage } from "../mailbox.js";
import { getTeam } from "../team-registry.js";

const TeamMessageSchema = Type.Object({
  teamId: Type.String(),
  message: Type.String(),
  priority: Type.Optional(Type.String()), // "normal" | "urgent"
});

export function createTeamMessageTool(opts?: { agentSessionKey?: string }): AnyAgentTool {
  return {
    label: "Teams",
    name: "team_message",
    description: "Send a message from the team creator to the team.",
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
        const msg = sendMessage({
          teamId,
          from: "creator",
          to: "lead",
          message,
          priority,
        });

        try {
          const sessionsSend = createSessionsSendTool({
            agentSessionKey: callerSessionKey,
            allowTeamSessionTarget: true,
          });
          await sessionsSend.execute("team-message", {
            sessionKey: team.leadSessionKey,
            message,
          });
        } catch {
          try {
            await callGateway({
              method: "agent",
              params: {
                message,
                sessionKey: team.leadSessionKey,
                deliver: false,
                label: "team-lead",
                spawnedBy: callerSessionKey,
              },
              timeoutMs: 10_000,
            });
          } catch {
            // Best-effort wakeup; mailbox already persisted.
          }
        }

        return jsonResult({
          messageId: msg.messageId,
          delivered: true,
          to: "team",
          message: "Message sent to team.",
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
