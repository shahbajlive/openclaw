import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "../../../../tools/common.js";
import { loadConfig } from "../../../../../config/config.js";
import { jsonResult, readStringParam } from "../../../../tools/common.js";
import { createSessionsSendTool } from "../../../../tools/sessions-send-tool.js";
import { killTeamTmuxSession, resolveTeamTmuxSessionName } from "../../../display-tmux.js";
import { addTask, forceCompleteTask, listTasks } from "../../../task-list.js";
import { TASK_BROADCAST_ANSWER } from "../../../task-taxonomy.js";
import {
  cleanupTeam,
  getTeam,
  isTeamLead,
  markAnswerBroadcasted,
  updateLeadStatus,
  updateTeamStatus,
} from "../../../team-registry.js";
import { LEAD_STATUS_IDLE } from "../../../types.js";

const TeamBroadcastAnswerSchema = Type.Object({
  teamId: Type.String(),
  message: Type.Optional(Type.String()),
});

export function createTeamBroadcastAnswerTool(opts?: { agentSessionKey?: string }): AnyAgentTool {
  return {
    label: "Teams",
    name: "team_broadcast_answer",
    description:
      "Mark that you have broadcasted your answer/response to the user. Call this after you have sent your final response to the user. This will mark the team completed and clean up ephemeral teams when safe.",
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

      // 6. Complete terminal broadcast task and force lead back to idle.
      try {
        const { tasks } = listTasks(teamId, { includeCompleted: true });
        let terminalTask = tasks.find(
          (task) =>
            task.title === TASK_BROADCAST_ANSWER &&
            task.assignee === "lead" &&
            task.status !== "completed" &&
            task.status !== "failed",
        );
        if (!terminalTask) {
          terminalTask = addTask(teamId, {
            title: TASK_BROADCAST_ANSWER,
            description:
              "All work is complete. Broadcast the final answer to the caller using team_broadcast_answer.",
            assignTo: "lead",
            priority: "critical",
            metadata: { source: "system_terminal" },
          });
        }
        forceCompleteTask(teamId, {
          taskId: terminalTask.taskId,
          summary: message ?? "Final answer broadcasted to caller.",
        });
      } catch {
        // Best-effort terminal completion; broadcast already sent to caller.
      }
      updateLeadStatus(teamId, LEAD_STATUS_IDLE);

      // 7. Mark answer as broadcasted.
      markAnswerBroadcasted(teamId);

      // 8. Mark team idle when work is done, and auto-cleanup when safe.
      let cleanupStatus: "cleaned" | "deferred" | "skipped" | "error" = "skipped";
      let cleanupReason: string | undefined;
      try {
        const { summary } = listTasks(teamId, { includeCompleted: true });
        const hasIncomplete = summary.pending > 0 || summary.blocked > 0 || summary.inProgress > 0;
        if (!hasIncomplete) {
          updateTeamStatus(teamId, "idle");
        }

        if (!team.persistent) {
          if (!hasIncomplete) {
            try {
              const sessionPrefix =
                cfg.gateway?.teams?.display?.tmux?.sessionPrefix ?? "openclaw-team";
              const sessionName = resolveTeamTmuxSessionName({
                teamName: team.teamName,
                prefix: sessionPrefix,
              });
              killTeamTmuxSession(sessionName);
            } catch {
              // best-effort tmux cleanup
            }
            const result = cleanupTeam(teamId);
            if (result.success) {
              cleanupStatus = "cleaned";
            } else {
              cleanupStatus = "error";
              cleanupReason = result.error || "Cleanup failed";
            }
          } else {
            cleanupStatus = "deferred";
            cleanupReason = "Incomplete tasks remain";
          }
        }
      } catch (err) {
        cleanupStatus = "error";
        cleanupReason = err instanceof Error ? err.message : String(err);
      }

      // 9. Return result
      return jsonResult({
        status: "broadcasted",
        teamId,
        message: message || "Answer broadcasted to user",
        cleanup: cleanupStatus,
        cleanupReason,
      });
    },
  };
}
