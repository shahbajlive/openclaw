import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "../../tools/common.js";
import { loadConfig } from "../../../config/config.js";
import { callGateway } from "../../../gateway/call.js";
import { AGENT_LANE_TEAM } from "../../lanes.js";
import { jsonResult, readStringParam } from "../../tools/common.js";
import { getJoinRequest, removeJoinRequest } from "../join-requests.js";
import { getTeam, isTeamLead } from "../team-registry.js";

const TeammateJoinApproveSchema = Type.Object({
  requestId: Type.String({ description: "ID of the join request to approve" }),
  assignTask: Type.Optional(
    Type.String({ description: "Optional task to assign to the new teammate" }),
  ),
});

export function createTeammateJoinApproveTool(opts?: { agentSessionKey?: string }): AnyAgentTool {
  return {
    label: "Teams",
    name: "teammate_join_approve",
    description:
      "Approve a join request from another external agent. Only available to team leads. Once approved, the requester becomes a teammate with their requested role. Optionally assign them a task to start working on.",
    parameters: TeammateJoinApproveSchema,
    execute: async (_toolCallId, args) => {
      const cfg = loadConfig();
      if (!cfg.gateway?.teams?.enabled) {
        return jsonResult({ status: "error", error: "Teams are not enabled in gateway config" });
      }

      const requestId = readStringParam(args, "requestId");
      const assignTask = args.assignTask ? String(args.assignTask) : undefined;

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
          error: "Only the team lead can approve join requests",
        });
      }

      // Remove the request
      removeJoinRequest(requestId);

      // Spawn the teammate using teammate_spawn logic
      // For simplicity, we'll just send them a message via callGateway
      // In a full implementation, this would integrate with teammate_spawn
      try {
        const welcomeMessage = `Your request to join team "${team.teamName}" has been approved! You are now a teammate with role: ${requestedRole}.${assignTask ? ` Your first task: ${assignTask}` : ""}`;

        await callGateway({
          method: "agent",
          params: {
            message: welcomeMessage,
            sessionKey: requesterSessionKey,
            lane: AGENT_LANE_TEAM,
            deliver: true,
          },
          timeoutMs: 10_000,
        });

        return jsonResult({
          status: "approved",
          requestId,
          requesterSessionKey,
          role: requestedRole,
          message: `Join request approved. ${requesterSessionKey} is now a teammate with role "${requestedRole}"`,
        });
      } catch (err) {
        const messageText =
          err instanceof Error ? err.message : typeof err === "string" ? err : "approval failed";
        return jsonResult({
          status: "error",
          error: `Failed to notify requester: ${messageText}`,
        });
      }
    },
  };
}
