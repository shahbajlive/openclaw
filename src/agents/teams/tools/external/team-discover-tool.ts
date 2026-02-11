import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "../../../tools/common.js";
import { loadConfig } from "../../../../config/config.js";
import { jsonResult } from "../../../tools/common.js";
import { listActiveTeams, resolveCallerTeamContext } from "../../team-registry.js";

const TeamDiscoverSchema = Type.Object({
  filter: Type.Optional(
    Type.Object(
      {
        name: Type.Optional(Type.String({ description: "Filter by team name (partial match)" })),
        status: Type.Optional(Type.String({ description: "Filter by team status" })),
      },
      { description: "Optional filters" },
    ),
  ),
});

export function createTeamDiscoverTool(opts?: { agentSessionKey?: string }): AnyAgentTool {
  return {
    label: "Teams",
    name: "team_discover",
    description:
      "List active teams for diagnostics. Shows team name, ID, status, and description. Only sessions not yet in a team can use this.",
    parameters: TeamDiscoverSchema,
    execute: async (_toolCallId, args) => {
      const cfg = loadConfig();
      if (!cfg.gateway?.teams?.enabled) {
        return jsonResult({ status: "error", error: "Teams are not enabled in gateway config" });
      }

      const callerSessionKey = opts?.agentSessionKey;
      if (!callerSessionKey) {
        return jsonResult({ status: "error", error: "No session key provided" });
      }

      const context = resolveCallerTeamContext(callerSessionKey);
      if (context) {
        return jsonResult({
          status: "error",
          error: "team_discover is only available before joining a team.",
        });
      }
      const currentTeamId = context?.team.teamId;

      // Get all active teams
      const teams = listActiveTeams();

      // Apply filters if provided
      const nameFilter = args.filter?.name ? String(args.filter.name).toLowerCase() : undefined;
      const statusFilter = args.filter?.status ? String(args.filter.status) : undefined;

      const filtered = teams
        .filter((team) => {
          // Optionally exclude caller's own team
          if (currentTeamId && team.teamId === currentTeamId) {
            return false;
          }

          if (nameFilter && !team.teamName.toLowerCase().includes(nameFilter)) {
            return false;
          }

          if (statusFilter && team.status !== statusFilter) {
            return false;
          }

          return true;
        })
        .map((team) => {
          return {
            teamId: team.teamId,
            teamName: team.teamName,
            description: team.description,
            status: team.status,
          };
        });

      return jsonResult({
        status: "ok",
        teams: filtered,
        total: filtered.length,
      });
    },
  };
}
