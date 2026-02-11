import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "../../../tools/common.js";
import { loadConfig } from "../../../../config/config.js";
import { jsonResult } from "../../../tools/common.js";
import { killTeamTmuxSession, resolveTeamTmuxSessionName } from "../../display-tmux.js";
import { cleanupTeam, getTeam, resolveCallerTeamContext } from "../../team-registry.js";

const TeamCleanupSchema = Type.Object({
  teamId: Type.Optional(
    Type.String({
      description: "Optional team ID to cleanup. If not provided, uses the current team context.",
    }),
  ),
  confirm: Type.Boolean({
    description:
      "Must be true to confirm cleanup. This removes all team resources and cannot be undone.",
  }),
  force: Type.Optional(
    Type.Boolean({
      description: "Force cleanup even when teammates are still init/working.",
    }),
  ),
});

export function createTeamCleanupTool(opts?: { agentSessionKey?: string }): AnyAgentTool {
  return {
    label: "Teams",
    name: "team_cleanup",
    description:
      "Remove all team resources when work is complete. Deletes team data, tasks, and tmux session. Only available to the team creator. This action cannot be undone.",
    parameters: TeamCleanupSchema,
    execute: async (_toolCallId, args) => {
      const cfg = loadConfig();
      if (!cfg.gateway?.teams?.enabled) {
        return jsonResult({ status: "error", error: "Teams are not enabled in gateway config" });
      }

      const confirm = args.confirm === true;
      const force = args.force === true;
      if (!confirm) {
        return jsonResult({
          status: "error",
          error: "Must set confirm: true to cleanup team. This action cannot be undone.",
        });
      }

      const callerSessionKey = opts?.agentSessionKey;
      if (!callerSessionKey) {
        return jsonResult({ status: "error", error: "No session key provided" });
      }

      let teamId = args.teamId;

      if (!teamId) {
        const context = resolveCallerTeamContext(callerSessionKey);
        if (context) {
          teamId = context.team.teamId;
        }
      }

      if (!teamId) {
        return jsonResult({
          status: "error",
          error: "No team context found. Provide a teamId if calling from outside a team.",
        });
      }

      const team = getTeam(teamId);
      if (!team) {
        return jsonResult({ status: "error", error: `Team ${teamId} not found` });
      }

      // Only the team creator can cleanup
      if (!team.creatorSessionKey || team.creatorSessionKey !== callerSessionKey) {
        return jsonResult({
          status: "error",
          error: "Only the team creator can cleanup the team",
        });
      }

      // Check if there are active teammates
      const activeTeammates = Object.values(team.teammates).filter(
        (tm) => tm.status === "working" || tm.status === "init",
      );
      if (activeTeammates.length > 0) {
        if (!force) {
          return jsonResult({
            status: "warning",
            error: `${activeTeammates.length} teammate(s) still active. Rerun with force: true to cleanup now.`,
            activeTeammates: activeTeammates.map((tm) => ({
              teammateId: tm.teammateId,
              role: tm.role,
              status: tm.status,
            })),
          });
        }
      }

      // Kill tmux session if it exists
      try {
        const sessionPrefix = cfg.gateway?.teams?.display?.tmux?.sessionPrefix ?? "openclaw-team";
        const sessionName = resolveTeamTmuxSessionName({
          teamName: team.teamName,
          prefix: sessionPrefix,
        });
        killTeamTmuxSession(sessionName);
      } catch {
        // Ignore tmux cleanup errors (session may not exist)
      }

      // Cleanup team
      const result = cleanupTeam(teamId);
      if (!result.success) {
        return jsonResult({
          status: "error",
          error: result.error || "Cleanup failed",
        });
      }

      return jsonResult({
        status: "cleaned",
        teamId,
        teamName: team.teamName,
        message:
          activeTeammates.length > 0 && force
            ? `Team "${team.teamName}" has been force-cleaned with active teammates.`
            : `Team "${team.teamName}" has been cleaned up. All resources removed.`,
        forced: activeTeammates.length > 0 && force,
      });
    },
  };
}
