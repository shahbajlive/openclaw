import { Type } from "@sinclair/typebox";
import crypto from "node:crypto";
import type { AnyAgentTool } from "../../../../tools/common.js";
import type { Teammate } from "../../../types.js";
import { loadConfig } from "../../../../../config/config.js";
import { callGateway } from "../../../../../gateway/call.js";
import { resolveAgentIdFromSessionKey } from "../../../../../routing/session-key.js";
import { AGENT_LANE_TEAM } from "../../../../lanes.js";
import { jsonResult, readStringParam } from "../../../../tools/common.js";
import { CHORE_ROLE, PR_REVIEWER_ROLE, PR_REVIEWER_TEAMMATE_ID } from "../../../chore-watch.js";
import { createTeamTmuxView, resolveTeamDisplayMode } from "../../../display-tmux.js";
import { buildTeammateSystemPrompt } from "../../../system-prompt.js";
import {
  getTeam,
  addTeammate,
  isTeamLead,
  registerTeammateRun,
  updateTeammateStatus,
  updateTeamTmuxPanes,
} from "../../../team-registry.js";

const TeammateSpawnSchema = Type.Object({
  teamId: Type.String(),
  role: Type.String(),
  task: Type.String(),
  model: Type.Optional(Type.String()),
  tools: Type.Optional(Type.Array(Type.String())),
  requirePlanApproval: Type.Optional(Type.Boolean()),
  timeout: Type.Optional(Type.Number({ minimum: 0 })),
});

function normalizeModelSelection(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function createTeammateSpawnTool(opts?: { agentSessionKey?: string }): AnyAgentTool {
  return {
    label: "Teams",
    name: "teammate_spawn",
    description:
      "Spawn a new teammate with a specific role and task. Only available to the Team Lead. Use this when users ask to 'add a teammate', 'spawn a reviewer', 'create an architect', etc. Each teammate gets their own session and can work independently. Teammates appear in split panes (tmux) by default.",
    parameters: TeammateSpawnSchema,
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
      const role = readStringParam(params, "role", { required: true });
      const task = readStringParam(params, "task", { required: true });
      const roleNormalized = role.trim().toLowerCase();
      if (roleNormalized === CHORE_ROLE) {
        return jsonResult({
          status: "error",
          error: "Chore teammate is system-managed and cannot be spawned manually.",
        });
      }
      if (roleNormalized === PR_REVIEWER_ROLE || roleNormalized === PR_REVIEWER_TEAMMATE_ID) {
        return jsonResult({
          status: "error",
          error: "PR reviewer teammate is system-managed and cannot be spawned manually.",
        });
      }
      const modelOverride = readStringParam(params, "model");
      const requirePlanApproval = params.requirePlanApproval === true;
      const timeout =
        typeof params.timeout === "number" && params.timeout >= 0 ? params.timeout : undefined;

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
          error: "Only the Team Lead can spawn teammates.",
        });
      }

      // 5. Resolve agentId from lead's session key
      const teamAgentId = team.teamAgentId;
      const ownerAgentId = resolveAgentIdFromSessionKey(team.creatorSessionKey ?? callerSessionKey);

      // 7. Validate model against allowedModels config (if provided)
      // Find the agent config from the list
      const agentConfigs = cfg.agents?.list ?? [];
      const agentConfig = agentConfigs.find((a) => a.id === ownerAgentId);
      const allowedModels = agentConfig?.teams?.allowedModels;
      const defaultTeamModel = agentConfig?.teams?.defaultModel ?? cfg.gateway?.teams?.defaultModel;

      let resolvedModel: string | undefined;
      if (modelOverride) {
        if (allowedModels && allowedModels.length > 0) {
          const normalized = normalizeModelSelection(modelOverride);
          if (normalized && !allowedModels.includes(normalized)) {
            return jsonResult({
              status: "error",
              error: `Model "${normalized}" is not allowed. Allowed models: ${allowedModels.join(", ")}`,
            });
          }
          resolvedModel = normalized;
        } else {
          resolvedModel = normalizeModelSelection(modelOverride);
        }
      } else {
        // Use team default model if configured
        resolvedModel = normalizeModelSelection(defaultTeamModel);
      }

      // 8. Build teammate session key
      const teammateId = crypto.randomUUID();
      const roleSlug = role
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .slice(0, 20);
      const sessionKey = `agent:${teamAgentId}:teammate:${roleSlug}-${teammateId.slice(0, 8)}`;

      // 9. Create Teammate record
      const teammate: Teammate = {
        teammateId,
        role,
        sessionKey,
        status: "init",
        model: resolvedModel,
        requirePlanApproval,
        planApproved: false,
        currentTask: task,
        currentTaskId: undefined,
        claimedTasks: 0,
        completedTasks: 0,
        createdAt: Date.now(),
        timeout,
      };

      // 10. Build teammate system prompt BEFORE adding to registry (for atomicity)
      const otherTeammates = Object.values(team.teammates)
        .filter((tm) => !tm.isChore)
        .map((tm) => ({
          role: tm.role,
          teammateId: tm.teammateId,
        }));

      const childSystemPrompt = buildTeammateSystemPrompt({
        team,
        teammate,
        otherTeammates,
      });

      // 11. Apply model if provided
      if (resolvedModel) {
        try {
          await callGateway({
            method: "sessions.patch",
            params: { key: sessionKey, model: resolvedModel },
            timeoutMs: 10_000,
          });
        } catch {
          // Non-fatal: continue spawning even if model patch fails
        }
      }

      // 12. Register run-to-teammate mapping BEFORE gateway call to avoid race conditions
      const childIdem = crypto.randomUUID();
      registerTeammateRun(childIdem, teamId, teammateId);

      // 13. Add teammate to registry BEFORE gateway call to avoid race conditions
      // This ensures that if the agent starts immediately, the registry is ready to receive events.
      addTeammate(teamId, teammate);

      // 14. Call gateway to spawn the run
      // Note: runId = idempotencyKey. Gateway uses idempotencyKey as runId (agent.ts:299).
      // Mapping registered at line 170 before this async call, so lifecycle events work.
      try {
        await callGateway({
          method: "agent",
          params: {
            message: task,
            sessionKey,
            lane: AGENT_LANE_TEAM,
            extraSystemPrompt: childSystemPrompt,
            deliver: false,
            timeout: timeout && timeout > 0 ? timeout : undefined,
            label: role,
            spawnedBy: callerSessionKey,
            idempotencyKey: childIdem,
          },
          timeoutMs: 10_000,
        });
        // so lifecycle events will find the mapping and transition status correctly.
      } catch (err) {
        // optimistically added, so remove if failed
        const { removeTeammate } = await import("../../../team-registry.js");
        removeTeammate(teamId, teammateId);

        const messageText =
          err instanceof Error ? err.message : typeof err === "string" ? err : "spawn failed";
        return jsonResult({
          status: "error",
          error: `Failed to spawn teammate: ${messageText}`,
          teammateId,
          sessionKey,
        });
      }

      // 16. Create tmux session/panes if display mode is "tmux"
      const displayMode = await resolveTeamDisplayMode(cfg.gateway?.teams?.display?.mode);
      if (displayMode === "tmux") {
        try {
          const sessionPrefix = cfg.gateway?.teams?.display?.tmux?.sessionPrefix ?? "openclaw-team";
          const view = await createTeamTmuxView({
            teamName: team.teamName,
            leadSessionKey: team.leadSessionKey,
            teammates: Object.values(team.teammates)
              .filter((t) => !t.isChore)
              .map((t) => ({
                teammateId: t.teammateId,
                role: t.role,
                sessionKey: t.sessionKey,
                currentTask: t.currentTask,
              })),
            sessionPrefix,
          });
          updateTeamTmuxPanes({
            teamId: team.teamId,
            sessionName: view.session,
            leadPaneId: view.leadPaneId,
            teammatePaneIds: view.teammatePaneIds,
          });
        } catch {
          // Non-fatal: continue even if tmux setup fails
        }
      }

      const latestTeam = getTeam(teamId);
      const spawned = latestTeam?.teammates[teammateId];
      if (spawned) {
        spawned.currentTask = undefined;
        spawned.currentTaskId = undefined;
        updateTeammateStatus(teamId, teammateId, "idle");
      }

      // 16. Return result
      return jsonResult({
        status: "spawned",
        teammateId,
        sessionKey,
        role,
        runId: childIdem,
        model: resolvedModel,
        requirePlanApproval,
      });
    },
  };
}
