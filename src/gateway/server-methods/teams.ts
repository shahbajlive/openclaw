import type { Team } from "../../agents/teams/types.js";
import type { GatewayRequestHandlers } from "./types.js";
import {
  killTeamTmuxSession,
  resolveTeamTmuxSessionName,
} from "../../agents/teams/display-tmux.js";
import { listTasks } from "../../agents/teams/task-list.js";
import {
  cleanupTeam,
  findAllTeamsBySessionAny,
  findTeamBySessionAny,
  getTeam,
  isTeamLead,
  listActiveTeams,
  listCreatorTeams,
  listAllTeams,
  updateTeammateStatus,
} from "../../agents/teams/team-registry.js";
import { loadConfig } from "../../config/config.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";

function summarizeTeam(team: Team) {
  const teammates = Object.values(team.teammates).map((t) => ({
    teammateId: t.teammateId,
    role: t.role,
    status: t.status,
    sessionKey: t.sessionKey,
    currentTask: t.currentTask ?? null,
    model: t.model ?? null,
  }));

  let taskSummary = null;
  try {
    const result = listTasks(team.teamId, { includeCompleted: true });
    taskSummary = result.summary;
  } catch {
    // Ignore task list errors
  }

  return {
    teamId: team.teamId,
    teamName: team.teamName,
    description: team.description ?? null,
    status: team.status,
    persistent: team.persistent,
    leadSessionKey: team.leadSessionKey,
    teammateCount: teammates.length,
    teammates,
    taskSummary,
    createdAt: team.createdAt,
    updatedAt: team.updatedAt,
  };
}

export const teamsHandlers: GatewayRequestHandlers = {
  /**
   * Get the status of teams. If `sessionKey` is provided, returns the team
   * associated with that session. Otherwise returns all active teams.
   */
  "teams.status": ({ params, respond }) => {
    const p = params as Record<string, unknown>;
    const sessionKey = typeof p.sessionKey === "string" ? p.sessionKey.trim() : undefined;

    if (sessionKey) {
      // Return all teams matching this session (lead/teammate) plus creator teams.
      const bySession = findAllTeamsBySessionAny(sessionKey);
      const byCreator = listCreatorTeams(sessionKey);
      const merged = new Map<string, Team>();
      for (const team of [...bySession, ...byCreator]) {
        merged.set(team.teamId, team);
      }
      const teams = Array.from(merged.values()).map(summarizeTeam);
      respond(true, { teams }, undefined);
      return;
    }

    // Return all active teams
    const teams = listActiveTeams().map(summarizeTeam);
    respond(true, { teams }, undefined);
  },

  /**
   * List tasks for a team. Returns full task list with summary.
   */
  "teams.tasks": ({ params, respond }) => {
    const p = params as Record<string, unknown>;
    const sessionKey = typeof p.sessionKey === "string" ? p.sessionKey.trim() : undefined;

    if (!sessionKey) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "sessionKey is required"));
      return;
    }

    const team = findTeamBySessionAny(sessionKey);
    if (!team) {
      respond(true, { tasks: [], summary: null }, undefined);
      return;
    }

    try {
      const result = listTasks(team.teamId, { includeCompleted: true });
      const tasks = result.tasks.map((t) => ({
        taskId: t.taskId,
        title: t.title,
        status: t.status,
        assignee: t.assignee ?? null,
        priority: t.priority,
        dependsOn: t.dependsOn,
        completedAt: t.completedAt ?? null,
      }));
      respond(true, { teamId: team.teamId, tasks, summary: result.summary }, undefined);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, msg));
    }
  },

  /**
   * Cleanup a team and remove its resources. Caller must be the lead.
   */
  "teams.cleanup": ({ params, respond }) => {
    const p = params as Record<string, unknown>;
    const sessionKey = typeof p.sessionKey === "string" ? p.sessionKey.trim() : undefined;
    const force = p.force === true;
    const teamIdOrName = typeof p.teamId === "string" ? p.teamId.trim() : undefined;

    if (!sessionKey) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "sessionKey is required"));
      return;
    }

    if (!teamIdOrName) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "teamId is required"));
      return;
    }

    let team = getTeam(teamIdOrName);
    if (!team && teamIdOrName) {
      team = listAllTeams().find((candidate) => candidate.teamName === teamIdOrName) ?? null;
    }
    if (!team) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Team not found."));
      return;
    }

    if (!isTeamLead(team.teamId, sessionKey)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "Only the team lead can remove the team."),
      );
      return;
    }

    const activeTeammates = Object.values(team.teammates).filter(
      (tm) => tm.status === "active" || tm.status === "spawning",
    );
    if (activeTeammates.length > 0 && !force) {
      respond(true, {
        status: "warning",
        error: `${activeTeammates.length} teammate(s) still active. Shut them down first using teammate_shutdown.`,
        activeTeammates: activeTeammates.map((tm) => ({
          teammateId: tm.teammateId,
          role: tm.role,
          status: tm.status,
          sessionKey: tm.sessionKey,
        })),
      });
      return;
    }
    if (activeTeammates.length > 0 && force) {
      for (const teammate of activeTeammates) {
        updateTeammateStatus(team.teamId, teammate.teammateId, "completed");
      }
    }

    try {
      const cfg = loadConfig();
      const sessionPrefix = cfg.gateway?.teams?.display?.tmux?.sessionPrefix ?? "openclaw-team";
      const sessionName = resolveTeamTmuxSessionName({
        teamName: team.teamName,
        prefix: sessionPrefix,
      });
      killTeamTmuxSession(sessionName);
    } catch {
      // Ignore tmux cleanup errors
    }

    const result = cleanupTeam(team.teamId);
    if (!result.success) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, result.error || "Cleanup failed"),
      );
      return;
    }

    respond(true, {
      status: "cleaned",
      teamId: team.teamId,
      teamName: team.teamName,
      message: `Team "${team.teamName}" has been cleaned up.`,
    });
  },
};
