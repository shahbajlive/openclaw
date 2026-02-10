import { Type } from "@sinclair/typebox";
import crypto from "node:crypto";
import type { AnyAgentTool } from "../../tools/common.js";
import { loadConfig } from "../../../config/config.js";
import { jsonResult, readStringParam } from "../../tools/common.js";
import { addJoinRequest, hasPendingRequest } from "../join-requests.js";
import { getTeam, resolveCallerTeamContext } from "../team-registry.js";

const TeammateJoinRequestSchema = Type.Object({
  teamId: Type.String({ description: "ID of the team to join" }),
  role: Type.String({ description: "Proposed role you would take in the team" }),
  message: Type.Optional(
    Type.String({ description: "Message to the team lead explaining why you want to join" }),
  ),
});

export function createTeammateJoinRequestTool(opts?: { agentSessionKey?: string }): AnyAgentTool {
  return {
    label: "Teams",
    name: "teammate_join_request",
    description:
      "Request to join an existing team as an external agent. The team lead will receive your request and can approve or reject it. Use team_discover to find teams first. Provide a role you want to fill and optionally a message explaining why you want to join. Not for the team creator.",
    parameters: TeammateJoinRequestSchema,
    execute: async (_toolCallId, args) => {
      const cfg = loadConfig();
      if (!cfg.gateway?.teams?.enabled) {
        return jsonResult({ status: "error", error: "Teams are not enabled in gateway config" });
      }

      const teamId = readStringParam(args, "teamId");
      const role = readStringParam(args, "role");
      const message = args.message ? String(args.message) : undefined;

      const requesterSessionKey = opts?.agentSessionKey;
      if (!requesterSessionKey) {
        return jsonResult({ status: "error", error: "No session key provided" });
      }

      // Check if requester is already in a team
      const context = resolveCallerTeamContext(requesterSessionKey);
      if (context) {
        return jsonResult({
          status: "error",
          error: "You are already in a team. Leave your current team before joining another.",
        });
      }

      // Verify target team exists
      const team = getTeam(teamId);
      if (!team) {
        return jsonResult({ status: "error", error: `Team ${teamId} not found` });
      }

      // Check if already has pending request
      if (hasPendingRequest(teamId, requesterSessionKey)) {
        return jsonResult({
          status: "error",
          error: `You already have a pending join request for team "${team.teamName}"`,
        });
      }

      // Create join request
      const requestId = crypto.randomUUID();
      const requestData: Parameters<typeof addJoinRequest>[0] = {
        requestId,
        teamId,
        requesterSessionKey,
        requestedRole: role,
        requestedAt: Date.now(),
      };
      if (message) {
        requestData.message = message;
      }
      addJoinRequest(requestData);

      return jsonResult({
        status: "requested",
        requestId,
        teamId,
        teamName: team.teamName,
        role,
        message: `Join request sent to team "${team.teamName}". The team lead will review your request.`,
      });
    },
  };
}
