import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "../../tools/common.js";
import { loadConfig } from "../../../config/config.js";
import { jsonResult, readStringParam } from "../../tools/common.js";
import { createSessionsSendTool } from "../../tools/sessions-send-tool.js";
import {
  getTeam,
  isTeamLead,
  markAnswerBroadcasted,
  notifyLeadIfTeamIdle,
} from "../team-registry.js";

const TeamBroadcastAnswerSchema = Type.Object({
  teamId: Type.String(),
  message: Type.Optional(Type.String()),
});

export function createTeamBroadcastAnswerTool(opts?: { agentSessionKey?: string }): AnyAgentTool {
  return {
    label: "Teams",
    name: "team_broadcast_answer",
    description:
      "Mark that you have broadcasted your answer/response to the user. This is required for auto-cleanup teams to complete cleanup. Call this after you have sent your final response to the user.",
    parameters: TeamBroadcastAnswerSchema,
    execute: async (_toolCallId, args) => {
      // 1. Check teams enabled
      const cfg = loadConfig();
      if (!cfg.gateway?.teams?.enabled) {
        return jsonResult({
          status: "error",
          error: "Teams are not enabled.",
        });
      }
      if (cfg.tools?.agentToAgent?.enabled !== true) {
        return jsonResult({
          status: "error",
          error:
            "Agent-to-agent messaging is disabled. Set tools.agentToAgent.enabled: true to broadcast answers.",
        });
      }

      // 2. Parse params
      const params = args as Record<string, unknown>;
      const teamId = readStringParam(params, "teamId", { required: true });
      const message = readStringParam(params, "message");

      // 3. Get team from registry
      const team = getTeam(teamId);
      if (!team) {
        return jsonResult({
          status: "error",
          error: `Team "${teamId}" not found.`,
        });
      }

      // 4. Verify caller is the lead
      const callerSessionKey = opts?.agentSessionKey ?? "";
      if (!isTeamLead(teamId, callerSessionKey)) {
        return jsonResult({
          status: "error",
          error: "Only the Team Lead can broadcast the answer.",
        });
      }

      // 5. Send to creator via sessions_send (A2A policy enforced)
      const creatorSessionKey = team.creatorSessionKey;
      if (!creatorSessionKey) {
        return jsonResult({
          status: "error",
          error: "Team creator session is unknown; cannot broadcast answer.",
        });
      }

      const sessionsSendTool = createSessionsSendTool({ agentSessionKey: callerSessionKey });
      const sendResult = await sessionsSendTool.execute("team-broadcast-answer", {
        sessionKey: creatorSessionKey,
        message: message ?? "Final answer ready.",
        timeoutSeconds: 0,
      });

      const sendDetails = (sendResult as { details?: Record<string, unknown> }).details ?? {};
      const sendStatus = typeof sendDetails.status === "string" ? sendDetails.status : "unknown";
      if (sendStatus !== "accepted") {
        return jsonResult({
          status: "error",
          error:
            typeof sendDetails.error === "string"
              ? sendDetails.error
              : "Failed to broadcast answer to creator.",
        });
      }

      // 6. Mark answer as broadcasted
      markAnswerBroadcasted(teamId);

      // 7. For auto-cleanup teams, trigger cleanup check
      if (!team.persistent) {
        notifyLeadIfTeamIdle(teamId);
      }

      // 8. Return result
      return jsonResult({
        status: "broadcasted",
        teamId,
        message: message || "Answer broadcasted to user",
      });
    },
  };
}
