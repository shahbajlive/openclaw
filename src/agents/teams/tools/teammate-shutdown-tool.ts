import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "../../tools/common.js";
import { loadConfig } from "../../../config/config.js";
import { enqueueSystemEvent } from "../../../infra/system-events.js";
import { jsonResult, readStringParam } from "../../tools/common.js";
import { getTeam, isTeamLead, updateTeammateStatus } from "../team-registry.js";

const TeammateShutdownSchema = Type.Object({
  teamId: Type.String(),
  teammateId: Type.String(),
  reason: Type.Optional(Type.String()),
  force: Type.Optional(Type.Boolean()),
});

export function createTeammateShutdownTool(opts?: { agentSessionKey?: string }): AnyAgentTool {
  return {
    label: "Teams",
    name: "teammate_shutdown",
    description:
      "Request a teammate to shut down gracefully, or force termination. Only available to the Team Lead.",
    parameters: TeammateShutdownSchema,
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
      const teammateId = readStringParam(params, "teammateId", { required: true });
      const reason = readStringParam(params, "reason") ?? "Work completed";
      const force = params.force === true;

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
          error: "Only the Team Lead can shut down teammates.",
        });
      }

      // 5. Find teammate by teammateId
      const teammate = team.teammates[teammateId];
      if (!teammate) {
        return jsonResult({
          status: "error",
          error: `Teammate "${teammateId}" not found in team "${teamId}".`,
        });
      }

      // 6. Handle shutdown
      if (force) {
        // Force shutdown: immediately mark as completed
        // Note: In a full implementation, we would also kill the run via callGateway
        // or send an agent event. For now, we rely on the status update + lifecycle listener.
        updateTeammateStatus(teamId, teammateId, "completed");

        return jsonResult({
          status: "terminated",
          teammateId,
          reason,
          acknowledged: true,
        });
      } else {
        // Graceful shutdown: send a system event to the teammate
        const shutdownMessage = `SYSTEM: The Team Lead has requested that you shut down.\nReason: ${reason}\n\nPlease complete your current task and finish your work. When done, your session will be terminated.`;

        enqueueSystemEvent(shutdownMessage, {
          sessionKey: teammate.sessionKey,
        });

        return jsonResult({
          status: "shutting-down",
          teammateId,
          reason,
          acknowledged: true,
          message: "Shutdown request sent to teammate.",
        });
      }
    },
  };
}
