import { Type } from "@sinclair/typebox";
import crypto from "node:crypto";
import type { AnyAgentTool } from "../../../tools/common.js";
import { loadConfig } from "../../../../config/config.js";
import { callGateway } from "../../../../gateway/call.js";
import { resolveAgentWorkspaceDir } from "../../../agent-scope.js";
import { AGENT_LANE_TEAM } from "../../../lanes.js";
import { jsonResult, readStringParam, readStringArrayParam } from "../../../tools/common.js";
import { ensureAgentWorkspace } from "../../../workspace.js";
import { createTeamTmuxView, resolveTeamDisplayMode } from "../../display-tmux.js";
import { buildTeamLeadSystemPrompt } from "../../system-prompt.js";
import { addTask } from "../../task-list.js";
import { TASK_INIT } from "../../task-taxonomy.js";
import {
  createTeam,
  listActiveTeams,
  registerLeadRun,
  getTeam,
  cleanupTeam,
  setLeadWorkspace,
  setTeammateWorkspace,
  updateLeadSessionKey,
  updateTeamTmuxPanes,
} from "../../team-registry.js";
import { ensureLeadWorktree, ensureTeammateWorktree } from "../../worktree.js";

const TeamCreateSchema = Type.Object({
  teamName: Type.String(),
  description: Type.Optional(Type.String()),
  persistent: Type.Optional(Type.Boolean()), // false for auto-cleanup (default), true for persistent
  tasks: Type.Optional(Type.Array(Type.String())),
  waitFor: Type.Optional(Type.String()), // "none" | "lead_start"
  timeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
  bootstrapMode: Type.Optional(Type.String()), // "none" | "minimal" | "full"
  heartbeatMode: Type.Optional(Type.String()), // "none" | "lead" | "all"
});

export function createTeamCreateTool(opts?: { agentSessionKey?: string }): AnyAgentTool {
  return {
    label: "Teams",
    name: "team_create",
    description:
      "Create a new agent team. Teams can be task-specific (auto-cleanup, default) or persistent. When initial tasks are provided, the system creates a single init_task for the lead to break down into subtasks with dependencies and assignees.",
    parameters: TeamCreateSchema,
    execute: async (_toolCallId, args) => {
      // 1. Check teams enabled
      const cfg = loadConfig();
      if (!cfg.gateway?.teams?.enabled) {
        return jsonResult({
          status: "error",
          error: "Teams are not enabled. Set gateway.teams.enabled: true.",
        });
      }
      if (cfg.tools?.agentToAgent?.enabled !== true) {
        return jsonResult({
          status: "error",
          error:
            "Teams require agent-to-agent messaging. Set tools.agentToAgent.enabled: true (and allowlist) to enable team coordination.",
        });
      }

      // 2. Check max active teams if provided
      const maxActiveTeams = cfg.gateway?.teams?.maxActiveTeams;
      const activeTeams = listActiveTeams();
      if (maxActiveTeams && activeTeams.length >= maxActiveTeams) {
        return jsonResult({
          status: "error",
          error: `Maximum active teams limit reached (${maxActiveTeams}). Clean up existing teams before creating new ones.`,
        });
      }

      // 3. Parse params
      const params = args as Record<string, unknown>;
      const teamName = readStringParam(params, "teamName", { required: true });
      const description = readStringParam(params, "description");
      const persistent = params.persistent === true; // default to false (auto-cleanup)

      const tasks = readStringArrayParam(params, "tasks");
      const waitForRaw = readStringParam(params, "waitFor");
      const bootstrapModeRaw = readStringParam(params, "bootstrapMode");
      const heartbeatModeRaw = readStringParam(params, "heartbeatMode");
      const timeoutSeconds =
        typeof params.timeoutSeconds === "number" && params.timeoutSeconds >= 0
          ? params.timeoutSeconds
          : undefined;

      // Enforce tasks for auto-cleanup teams
      if (!persistent && (!tasks || tasks.length === 0)) {
        return jsonResult({
          status: "error",
          error: "Task-specific teams require initial tasks in team_create.",
        });
      }

      // 4. Create team in registry
      try {
        const existing = listActiveTeams().find((t) => t.teamName === teamName);
        if (existing) {
          return jsonResult({
            status: "error",
            error: `Team "${teamName}" already exists (ID: ${existing.teamId}).`,
          });
        }

        const callerSessionKey = opts?.agentSessionKey ?? "";
        const team = createTeam({
          teamName,
          description,
          creatorSessionKey: callerSessionKey,
          config: { notifyOnUnblock: true },
          persistent,
          boundSessionKey: undefined,
        });

        const leadSessionKey = `agent:${team.teamAgentId}:lead`;
        updateLeadSessionKey(team.teamId, leadSessionKey, !persistent ? leadSessionKey : undefined);
        team.leadSessionKey = leadSessionKey;
        const leadWorktree = await ensureLeadWorktree(team);
        setLeadWorkspace(team.teamId, leadWorktree.workspaceDir);
        for (const teammate of Object.values(team.teammates)) {
          const ensured = await ensureTeammateWorktree({
            team,
            teammateId: teammate.teammateId,
          });
          setTeammateWorkspace(team.teamId, teammate.teammateId, ensured.workspaceDir);
        }

        const configuredBootstrapMode = cfg.gateway?.teams?.bootstrapMode ?? "minimal";
        const bootstrapMode =
          bootstrapModeRaw === "none" ||
          bootstrapModeRaw === "minimal" ||
          bootstrapModeRaw === "full"
            ? bootstrapModeRaw
            : configuredBootstrapMode;
        const configuredHeartbeatMode = cfg.gateway?.teams?.heartbeatMode ?? "none";
        const heartbeatMode =
          heartbeatModeRaw === "none" || heartbeatModeRaw === "lead" || heartbeatModeRaw === "all"
            ? heartbeatModeRaw
            : configuredHeartbeatMode;

        const teamWorkspaceDir = resolveAgentWorkspaceDir(cfg, team.teamAgentId, leadSessionKey);
        await ensureAgentWorkspace({
          dir: teamWorkspaceDir,
          bootstrapMode,
          heartbeatMode,
          skipGitInit: true,
        });

        // 5. Add tasks
        let taskMsg = "";
        let initTaskId: string | undefined;
        if (tasks && tasks.length > 0) {
          const initDescriptionLines = [
            "Create subtasks with clear dependencies and assignees based on the initial tasks below.",
            "Reply with JSON in this shape:",
            '{"tasks":[{"id":"spec","title":"...","description":"...","assignee":"<teammateId or role>","dependsOn":["spec"]}]}',
            "Use dependsOn ids or 1-based indices to reference tasks in your JSON list.",
            "",
            "Initial tasks from creator:",
            ...tasks.map((taskDesc, index) => `${index + 1}. ${taskDesc}`),
          ];
          const initTask = addTask(team.teamId, {
            title: TASK_INIT,
            description: initDescriptionLines.join("\n"),
            assignTo: "lead",
            priority: "critical",
            metadata: { initialTasks: tasks },
          });
          initTaskId = initTask.taskId;
          taskMsg = " Added init_task for the lead.";
        }

        // 6. Spawn lead agent session
        const leadPrompt = buildTeamLeadSystemPrompt({
          team,
          teammatesList: Object.values(team.teammates).map((teammate) => ({
            role: teammate.role,
            status: teammate.status,
            currentTask: teammate.currentTask,
          })),
        });
        const leadInitMessage =
          tasks && tasks.length > 0
            ? `An init_task was created for you${initTaskId ? ` (taskId: ${initTaskId})` : ""}. Use task_answer on init_task with the JSON plan described in the task to create subtasks.`
            : "Team lead initialized. Awaiting tasks.";
        const leadRunId = crypto.randomUUID();
        registerLeadRun(team.teamId, leadRunId);

        try {
          await callGateway({
            method: "agent",
            params: {
              message: leadInitMessage,
              sessionKey: leadSessionKey,
              lane: AGENT_LANE_TEAM,
              extraSystemPrompt: leadPrompt,
              workspaceDir: leadWorktree.workspaceDir,
              deliver: false,
              idempotencyKey: leadRunId,
              label: "team-lead",
              spawnedBy: callerSessionKey,
            },
            timeoutMs: 10_000,
          });
        } catch (err) {
          cleanupTeam(team.teamId);
          const msg = err instanceof Error ? err.message : String(err);
          return jsonResult({
            status: "error",
            error: `Failed to spawn team lead: ${msg}`,
          });
        }

        // 7. Optional wait for lead start (default for ephemeral)
        const waitFor =
          waitForRaw === "none" || waitForRaw === "lead_start" ? waitForRaw : undefined;
        const shouldWait = waitFor ? waitFor === "lead_start" : !persistent;

        if (shouldWait) {
          const deadline = Date.now() + (timeoutSeconds ?? 30) * 1000;
          while (Date.now() < deadline) {
            const latest = getTeam(team.teamId);
            if (latest?.leadStatus === "working") {
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 200));
          }
        }

        // 8. Create tmux session for lead if display mode is "tmux"
        const displayMode = await resolveTeamDisplayMode(cfg.gateway?.teams?.display?.mode);
        if (displayMode === "tmux") {
          try {
            const sessionPrefix =
              cfg.gateway?.teams?.display?.tmux?.sessionPrefix ?? "openclaw-team";
            const view = await createTeamTmuxView({
              teamName: team.teamName,
              leadSessionKey: team.leadSessionKey,
              teammates: [],
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

        // 8. Return result
        return jsonResult({
          status: "created",
          teamId: team.teamId,
          teamName: team.teamName,
          leadSessionKey: team.leadSessionKey,
          persistent: team.persistent,
          message: `Team created.${taskMsg}`,
          note: "Team members will be created automatically based on the tasks. As the creator, only provide tasks and wait for completion.",
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return jsonResult({
          status: "error",
          error: `Failed to create team: ${msg}`,
        });
      }
    },
  };
}
