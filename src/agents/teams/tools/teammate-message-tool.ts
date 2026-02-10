import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "../../tools/common.js";
import { loadConfig } from "../../../config/config.js";
import { jsonResult, readStringParam } from "../../tools/common.js";
import { sendMessage } from "../mailbox.js";
import { getTeam, resolveCallerTeamContext } from "../team-registry.js";

const TeammateMessageSchema = Type.Object({
  teamId: Type.String(),
  to: Type.String(), // teammateId or "lead"
  message: Type.String(),
  priority: Type.Optional(Type.String()), // "normal" | "urgent"
  waitForReply: Type.Optional(Type.Boolean()),
  timeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
});

export function createTeammateMessageTool(opts?: { agentSessionKey?: string }): AnyAgentTool {
  return {
    label: "Teams",
    name: "teammate_message",
    description: "Send a direct message to a specific teammate or the Team Lead.",
    parameters: TeammateMessageSchema,
    execute: async (_toolCallId, args) => {
      // 1. Check teams enabled
      const cfg = loadConfig();
      if (!cfg.gateway?.teams?.enabled) {
        return jsonResult({ status: "error", error: "Teams are not enabled." });
      }

      // 2. Parse params
      const params = args as Record<string, unknown>;
      const teamId = readStringParam(params, "teamId", { required: true });
      const to = readStringParam(params, "to", { required: true });
      const message = readStringParam(params, "message", { required: true });
      const priorityRaw = readStringParam(params, "priority");
      const priority = priorityRaw === "urgent" ? "urgent" : "normal";

      // 3. Get team from registry
      const team = getTeam(teamId);
      if (!team) {
        return jsonResult({ status: "error", error: "Team not found." });
      }

      // 4. Determine sender identity (lead or teammateId)
      const callerContext = resolveCallerTeamContext(opts?.agentSessionKey ?? "");
      if (!callerContext) {
        return jsonResult({ status: "error", error: "You are not a member of this team." });
      }
      const fromId = callerContext.isLead
        ? "lead"
        : (callerContext.teammate?.teammateId ?? "unknown");

      // 5. Find recipient
      let recipientSessionKey: string | undefined;
      if (to === "lead") {
        recipientSessionKey = team.leadSessionKey;
      } else {
        const recipient = team.teammates[to];
        if (!recipient) {
          return jsonResult({ status: "error", error: `Teammate "${to}" not found.` });
        }
        recipientSessionKey = recipient.sessionKey;
      }

      if (!recipientSessionKey) {
        return jsonResult({ status: "error", error: "Recipient session key not found." });
      }

      // 6. Send message via mailbox
      try {
        const msg = sendMessage({
          teamId,
          from: fromId,
          to,
          message,
          priority,
        });

        // 7. Return result
        return jsonResult({
          messageId: msg.messageId,
          delivered: true,
          to,
          message: "Message sent. Recipient will see it on their next turn.",
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
