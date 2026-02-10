import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "../../tools/common.js";
import { loadConfig } from "../../../config/config.js";
import { callGateway } from "../../../gateway/call.js";
import { AGENT_LANE_TEAM } from "../../lanes.js";
import { jsonResult, readStringParam } from "../../tools/common.js";
import { getJoinRequest, removeJoinRequest } from "../join-requests.js";
import { getTeam, isTeamLead } from "../team-registry.js";

const TeammateJoinRejectSchema = Type.Object({
  requestId: Type.String({ description: "ID of the join request to reject" }),
  reason: Type.Optional(Type.String({ description: "Reason for rejection (sent to requester)" })),
});

export function createTeammateJoinRejectTool(opts?: { agentSessionKey?: string }): AnyAgentTool {
  return {
    label: "Teams",
    name: "teammate_join_reject",
    description:
      "Reject a join request from another external agent. Only available to team leads. Optionally provide a reason that will be sent to the requester.",
    parameters: TeammateJoinRejectSchema,
    execute: async (_toolCallId, args) => {
      const cfg = loadConfig();
      if (!cfg.gateway?.teams?.enabled) {
        return jsonResult({ status: "error", error: "Teams are not enabled in gateway config" });
      }

      const requestId = readStringParam(args, "requestId");
      const reason = args.reason ? String(args.reason) : undefined;

      const callerSessionKey = opts?.agentSessionKey;
      if (!callerSessionKey) {
        return jsonResult({ status: "error", error: "No session key provided" });
      }

      // Get join request
      const request = getJoinRequest(requestId);
      if (!request) {
        return jsonResult({ status: "error", error: `Join request ${requestId} not found` });
      }

      const { teamId, requesterSessionKey, requestedRole } = request;

      // Verify caller is team lead
      const team = getTeam(teamId);
      if (!team) {
        return jsonResult({ status: "error", error: `Team ${teamId} not found` });
      }

      if (!isTeamLead(callerSessionKey, teamId)) {
        return jsonResult({
          status: "error",
          error: "Only the team lead can reject join requests",
        });
      }

      // Remove the request
      removeJoinRequest(requestId);

      // Notify requester
      try {
        const rejectionMessage = `Your request to join team "${team.teamName}" (role: ${requestedRole}) has been rejected.${reason ? ` Reason: ${reason}` : ""}`;

        await callGateway({
          method: "agent",
          params: {
            message: rejectionMessage,
            sessionKey: requesterSessionKey,
            lane: AGENT_LANE_TEAM,
            deliver: true,
          },
          timeoutMs: 10_000,
        });

        return jsonResult({
          status: "rejected",
          requestId,
          requesterSessionKey,
          role: requestedRole,
          reason,
          message: `Join request rejected${reason ? `: ${reason}` : ""}`,
        });
      } catch (err) {
        const messageText =
          err instanceof Error ? err.message : typeof err === "string" ? err : "rejection failed";
        return jsonResult({
          status: "error",
          error: `Failed to notify requester: ${messageText}`,
        });
      }
    },
  };
}
