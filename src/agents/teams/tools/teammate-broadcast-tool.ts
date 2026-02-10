import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "../../tools/common.js";
import { loadConfig } from "../../../config/config.js";
import { jsonResult, readStringParam } from "../../tools/common.js";
import { broadcastMessage } from "../mailbox.js";
import { getTeam, resolveCallerTeamContext } from "../team-registry.js";

const TeammateBroadcastSchema = Type.Object({
  teamId: Type.String(),
  message: Type.String(),
  priority: Type.Optional(Type.String()), // "normal" | "urgent"
  excludeSelf: Type.Optional(Type.Boolean()),
});

export function createTeammateBroadcastTool(opts?: { agentSessionKey?: string }): AnyAgentTool {
  return {
    label: "Teams",
    name: "teammate_broadcast",
    description: "Send a message to all active teammates in your team.",
    parameters: TeammateBroadcastSchema,
    execute: async (_toolCallId, args) => {
      // 1. Check teams enabled
      const cfg = loadConfig();
      if (!cfg.gateway?.teams?.enabled) {
        return jsonResult({ status: "error", error: "Teams are not enabled." });
      }

      // 2. Parse params
      const params = args as Record<string, unknown>;
      const teamId = readStringParam(params, "teamId", { required: true });
      const message = readStringParam(params, "message", { required: true });
      const priorityRaw = readStringParam(params, "priority");
      const priority = priorityRaw === "urgent" ? "urgent" : "normal";
      const excludeSelf = params.excludeSelf === true;

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

      // 5. Send broadcast message via mailbox (handles recipient resolution + delivery)
      try {
        const result = broadcastMessage({
          teamId,
          from: fromId,
          message,
          priority,
          excludeSelf,
        });

        if (result.deliveredTo.length === 0) {
          return jsonResult({
            status: "warning",
            message: "Broadcast sent but no active recipients to deliver to.",
            messageId: result.messageId,
          });
        }

        // 6. Return result
        return jsonResult({
          messageId: result.messageId,
          delivered: true,
          deliveredTo: result.deliveredTo,
          recipientCount: result.deliveredTo.length,
          message: "Broadcast sent. Recipients will see it on their next turn.",
        });
      } catch (err) {
        const messageText =
          err instanceof Error
            ? err.message
            : typeof err === "string"
              ? err
              : "failed to broadcast message";
        return jsonResult({
          status: "error",
          error: messageText,
        });
      }
    },
  };
}
