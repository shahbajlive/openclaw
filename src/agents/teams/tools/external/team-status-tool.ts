import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "../../../tools/common.js";
import { loadConfig } from "../../../../config/config.js";
import { jsonResult, readStringParam } from "../../../tools/common.js";
import { listTasks } from "../../task-list.js";
import { getTeam, listActiveTeams, resolveCallerTeamContext } from "../../team-registry.js";

const TeamStatusSchema = Type.Object({
  teamId: Type.String(),
  includeTaskList: Type.Optional(Type.Boolean()),
});

export function createTeamStatusTool(opts?: { agentSessionKey?: string }): AnyAgentTool {
  return {
    label: "Teams",
    name: "team_status",
    description: "Get current status of a team including teammates, tasks, and messages.",
    parameters: TeamStatusSchema,
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
      const includeTaskList = params.includeTaskList === true;
      const callerSessionKey = opts?.agentSessionKey ?? "";
      if (!callerSessionKey) {
        return jsonResult({
          status: "error",
          error: "No session key provided.",
        });
      }

      const callerContext = resolveCallerTeamContext(callerSessionKey);
      if (!callerContext?.isLead) {
        return jsonResult({
          status: "error",
          error: "team_status is only available to team leads.",
        });
      }

      const buildStatus = (team: ReturnType<typeof getTeam>): Record<string, unknown> => {
        if (!team) {
          return {};
        }

        const teammatesList = Object.values(team.teammates).map((tm) => ({
          teammateId: tm.teammateId,
          role: tm.role,
          status: tm.status,
          currentTask: tm.currentTask,
          claimedTasks: tm.claimedTasks,
          completedTasks: tm.completedTasks,
          requirePlanApproval: tm.requirePlanApproval,
          planApproved: tm.planApproved,
          model: tm.model,
          isChore: tm.isChore ?? false,
        }));

        const taskResult = listTasks(team.teamId, { includeCompleted: true });
        const allTasks = taskResult.tasks;
        const taskSummary = taskResult.summary;
        const planTasks = allTasks.filter((task) => task.metadata?.excludedTaskClass !== true);
        const taskClassSummary = {
          primary: planTasks.filter((task) => task.taskClass === "primary").length,
          secondary: planTasks.filter((task) => task.taskClass === "secondary").length,
        };

        const isCreatorOnly =
          !!team.creatorSessionKey &&
          team.creatorSessionKey === callerSessionKey &&
          team.leadSessionKey !== callerSessionKey;

        const response: Record<string, unknown> = {
          teamId: team.teamId,
          teamName: team.teamName,
          description: team.description,
          status: team.status,
          persistent: team.persistent,
          createdAt: team.createdAt,
          updatedAt: team.updatedAt,
          taskSummary,
          taskClassSummary,
        };

        response.leadStatus = team.leadStatus;

        if (!isCreatorOnly) {
          response.leadSessionKey = team.leadSessionKey;
          response.answerBroadcasted = team.answerBroadcasted;
          response.teammates = teammatesList;
        }

        if (!isCreatorOnly && includeTaskList) {
          response.tasks = allTasks;
        }

        return response;
      };

      // 3. Get team from registry (id or name search)
      const team = getTeam(teamId);
      if (!team) {
        const needle = teamId.trim().toLowerCase();
        const matches = listActiveTeams().filter((t) => t.teamName.toLowerCase().includes(needle));
        if (matches.length === 0) {
          return jsonResult({
            status: "error",
            error: `Team "${teamId}" not found.`,
          });
        }
        if (matches.length === 1) {
          return jsonResult(buildStatus(matches[0]));
        }
        return jsonResult({
          status: "ok",
          matches: matches.map((t) => buildStatus(t)),
          total: matches.length,
        });
      }

      return jsonResult(buildStatus(team));
    },
  };
}
