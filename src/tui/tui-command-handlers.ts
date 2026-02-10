import type { Component, TUI } from "@mariozechner/pi-tui";
import { randomUUID } from "node:crypto";
import type { SessionsPatchResult } from "../gateway/protocol/index.js";
import type { ChatLog } from "./components/chat-log.js";
import type { SplitView } from "./components/split-view.js";
import type { GatewayChatClient, GatewayTeamStatus } from "./gateway-chat.js";
import type {
  AgentSummary,
  GatewayStatusSummary,
  TuiOptions,
  TuiStateAccess,
} from "./tui-types.js";
import type { PaneContext } from "./tui-types.js";
import {
  formatThinkingLevels,
  normalizeUsageDisplay,
  resolveResponseUsageMode,
} from "../auto-reply/thinking.js";
import { loadConfig } from "../config/config.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { formatRelativeTime } from "../utils/time-format.js";
import { getAllowedCommands, helpText, parseCommand } from "./commands.js";
import {
  createFilterableSelectList,
  createSearchableSelectList,
  createSettingsList,
} from "./components/selectors.js";
import { formatStatusSummary } from "./tui-status-summary.js";

type CommandHandlerContext = {
  client: GatewayChatClient;
  chatLog: ChatLog;
  tui: TUI;
  opts: TuiOptions;
  state: TuiStateAccess;
  deliverDefault: boolean;
  openOverlay: (component: Component) => void;
  closeOverlay: () => void;
  refreshSessionInfo: () => Promise<void>;
  loadHistory: () => Promise<void>;
  setSession: (key: string) => Promise<void>;
  refreshAgents: () => Promise<void>;
  abortActive: () => Promise<void>;
  setActivityStatus: (text: string) => void;
  formatSessionKey: (key: string) => string;
  applySessionInfoFromPatch: (result: SessionsPatchResult) => void;
  noteLocalRunId: (runId: string) => void;
  forgetLocalRunId?: (runId: string) => void;
  splitView: SplitView;
  updateRootLayout: () => void;
  getPaneContext: () => import("./tui-types.js").PaneContext;
};

export function createCommandHandlers(context: CommandHandlerContext) {
  const {
    client,
    chatLog,
    tui,
    opts,
    state,
    deliverDefault,
    openOverlay,
    closeOverlay,
    refreshSessionInfo,
    loadHistory,
    setSession,
    refreshAgents,
    abortActive,
    setActivityStatus,
    formatSessionKey,
    applySessionInfoFromPatch,
    noteLocalRunId,
    forgetLocalRunId,
    splitView,
    updateRootLayout,
    getPaneContext,
  } = context;

  /**
   * Get the appropriate chat log for displaying messages.
   * If in split view mode, returns the active pane's chat log.
   * Otherwise, returns the main chat log.
   */
  const getActiveChatLog = (): ChatLog => {
    if (state.splitViewMode) {
      const activePane = splitView.getPane(state.activePaneIndex);
      if (activePane) {
        return activePane;
      }
    }
    return chatLog;
  };

  const setAgent = async (id: string) => {
    state.currentAgentId = normalizeAgentId(id);
    await setSession("");
  };

  const openModelSelector = async () => {
    try {
      const models = await client.listModels();
      if (models.length === 0) {
        chatLog.addSystem("no models available");
        tui.requestRender();
        return;
      }
      const items = models.map((model) => ({
        value: `${model.provider}/${model.id}`,
        label: `${model.provider}/${model.id}`,
        description: model.name && model.name !== model.id ? model.name : "",
      }));
      const selector = createSearchableSelectList(items, 9);
      selector.onSelect = (item) => {
        void (async () => {
          try {
            const result = await client.patchSession({
              key: state.currentSessionKey,
              model: item.value,
            });
            chatLog.addSystem(`model set to ${item.value}`);
            applySessionInfoFromPatch(result);
            await refreshSessionInfo();
          } catch (err) {
            chatLog.addSystem(`model set failed: ${String(err)}`);
          }
          closeOverlay();
          tui.requestRender();
        })();
      };
      selector.onCancel = () => {
        closeOverlay();
        tui.requestRender();
      };
      openOverlay(selector);
      tui.requestRender();
    } catch (err) {
      chatLog.addSystem(`model list failed: ${String(err)}`);
      tui.requestRender();
    }
  };

  const openAgentSelector = async () => {
    await refreshAgents();
    if (state.agents.length === 0) {
      chatLog.addSystem("no agents found");
      tui.requestRender();
      return;
    }
    const items = state.agents.map((agent: AgentSummary) => ({
      value: agent.id,
      label: agent.name ? `${agent.id} (${agent.name})` : agent.id,
      description: agent.id === state.agentDefaultId ? "default" : "",
    }));
    const selector = createSearchableSelectList(items, 9);
    selector.onSelect = (item) => {
      void (async () => {
        closeOverlay();
        await setAgent(item.value);
        tui.requestRender();
      })();
    };
    selector.onCancel = () => {
      closeOverlay();
      tui.requestRender();
    };
    openOverlay(selector);
    tui.requestRender();
  };

  const openSessionSelector = async () => {
    try {
      const result = await client.listSessions({
        includeGlobal: false,
        includeUnknown: false,
        includeDerivedTitles: true,
        includeLastMessage: true,
        agentId: state.currentAgentId,
      });
      const items = result.sessions.map((session) => {
        const title = session.derivedTitle ?? session.displayName;
        const formattedKey = formatSessionKey(session.key);
        // Avoid redundant "title (key)" when title matches key
        const label = title && title !== formattedKey ? `${title} (${formattedKey})` : formattedKey;
        // Build description: time + message preview
        const timePart = session.updatedAt ? formatRelativeTime(session.updatedAt) : "";
        const preview = session.lastMessagePreview?.replace(/\s+/g, " ").trim();
        const description =
          timePart && preview ? `${timePart} · ${preview}` : (preview ?? timePart);
        return {
          value: session.key,
          label,
          description,
          searchText: [
            session.displayName,
            session.label,
            session.subject,
            session.sessionId,
            session.key,
            session.lastMessagePreview,
          ]
            .filter(Boolean)
            .join(" "),
        };
      });
      const selector = createFilterableSelectList(items, 9);
      selector.onSelect = (item) => {
        void (async () => {
          closeOverlay();
          await setSession(item.value);
          tui.requestRender();
        })();
      };
      selector.onCancel = () => {
        closeOverlay();
        tui.requestRender();
      };
      openOverlay(selector);
      tui.requestRender();
    } catch (err) {
      chatLog.addSystem(`sessions list failed: ${String(err)}`);
      tui.requestRender();
    }
  };

  const openSettings = () => {
    const items = [
      {
        id: "tools",
        label: "Tool output",
        currentValue: state.toolsExpanded ? "expanded" : "collapsed",
        values: ["collapsed", "expanded"],
      },
      {
        id: "thinking",
        label: "Show thinking",
        currentValue: state.showThinking ? "on" : "off",
        values: ["off", "on"],
      },
    ];
    const settings = createSettingsList(
      items,
      (id, value) => {
        if (id === "tools") {
          state.toolsExpanded = value === "expanded";
          chatLog.setToolsExpanded(state.toolsExpanded);
        }
        if (id === "thinking") {
          state.showThinking = value === "on";
          void loadHistory();
        }
        tui.requestRender();
      },
      () => {
        closeOverlay();
        tui.requestRender();
      },
    );
    openOverlay(settings);
    tui.requestRender();
  };

  const handleTeamCommand = async (subcommand: string) => {
    const tokens = subcommand.trim().split(/\s+/).filter(Boolean);
    const sub = tokens[0]?.toLowerCase() || "status";
    const args = tokens.slice(1);

    if (sub === "status") {
      try {
        const teams = await client.getTeamStatuses(state.currentSessionKey);
        if (teams.length === 0) {
          chatLog.addSystem("No active teams for this session.");
          return;
        }
        const sections: string[] = [];
        for (const team of teams) {
          const lines: string[] = [];
          lines.push(`Team: ${team.teamName} (${team.teamId})`);
          lines.push(`Status: ${team.status} | ${team.teammateCount} teammate(s)`);
          for (const tm of team.teammates) {
            const statusIcon =
              tm.status === "active"
                ? "●"
                : tm.status === "completed"
                  ? "✓"
                  : tm.status === "failed"
                    ? "✗"
                    : "○";
            const model = tm.model ? ` [${tm.model}]` : "";
            const taskLabel = tm.currentTask ? ` · ${tm.currentTask}` : "";
            lines.push(`  ${statusIcon} @${tm.role}${model} — ${tm.status}${taskLabel}`);
          }
          if (team.taskSummary) {
            const ts = team.taskSummary;
            lines.push(
              `Tasks: ${ts.completed}/${ts.total} done, ${ts.inProgress} active, ${ts.pending} pending`,
            );
          }
          sections.push(lines.join("\n"));
        }
        chatLog.addSystem(sections.join("\n\n"));
      } catch (err) {
        chatLog.addSystem(`team status failed: ${String(err)}`);
      }
      return;
    }

    if (sub === "view" || sub === "close") {
      chatLog.addSystem("Team views are automatic now. Use Shift+Up/Down to cycle team leads.");
      return;
    }

    if (sub === "tasks") {
      try {
        const result = await client.getTeamTasks(state.currentSessionKey);
        if (!result || result.tasks.length === 0) {
          chatLog.addSystem("No tasks found.");
          return;
        }
        const lines: string[] = [];
        lines.push(`Tasks (${result.summary?.completed ?? 0}/${result.summary?.total ?? 0} done):`);
        for (const task of result.tasks) {
          const icon =
            task.status === "completed"
              ? "✓"
              : task.status === "failed"
                ? "✗"
                : task.status === "claimed" || task.status === "in-progress"
                  ? "●"
                  : task.status === "blocked"
                    ? "⊘"
                    : "○";
          const assigneeLabel = task.assignee ? ` → ${task.assignee}` : "";
          const priorityLabel = task.priority !== "normal" ? ` [${task.priority}]` : "";
          lines.push(`  ${icon} ${task.title}${assigneeLabel}${priorityLabel} (${task.status})`);
        }
        chatLog.addSystem(lines.join("\n"));
      } catch (err) {
        chatLog.addSystem(`team tasks failed: ${String(err)}`);
      }
      return;
    }

    if (sub === "remove") {
      const teamIdArg = args.find((arg) => arg.toLowerCase() !== "force");
      const force = args.some((arg) => arg.toLowerCase() === "force");
      if (!teamIdArg) {
        chatLog.addSystem("Usage: /team remove <teamId|teamName> [force]");
        chatLog.addSystem("This removes the team, tasks, mailbox, and tmux session.");
        return;
      }
      try {
        const result = await client.cleanupTeam(state.currentSessionKey, teamIdArg, force);
        if (!result) {
          chatLog.addSystem("team remove failed: no response");
          return;
        }
        if (result.status === "warning" && result.error) {
          chatLog.addSystem(result.error);
          return;
        }
        if (result.status !== "cleaned") {
          chatLog.addSystem(result.error || "team remove failed");
          return;
        }
        chatLog.addSystem(result.message ?? "Team removed.");
      } catch (err) {
        chatLog.addSystem(`team remove failed: ${String(err)}`);
      }
      return;
    }

    chatLog.addSystem("Usage: /team [status|tasks|remove]");
  };

  const openTeamSelector = async () => {
    try {
      // Step 1: Get all teams
      const teams = await client.getTeamStatuses(state.currentSessionKey);

      if (teams.length === 0) {
        chatLog.addSystem("No active teams found.");
        tui.requestRender();
        return;
      }

      // Step 2: Show team selector
      const teamItems = teams.map((team) => {
        const teammateCount = team.teammateCount;
        const taskInfo = team.taskSummary
          ? `${team.taskSummary.completed}/${team.taskSummary.total} tasks`
          : "no tasks";
        const description = `${teammateCount} teammate(s) · ${taskInfo}`;

        return {
          value: team.teamId,
          label: team.teamName,
          description,
          searchText: [team.teamName, team.teamId, team.description || ""]
            .filter(Boolean)
            .join(" "),
          team, // Store full team object for next step
        };
      });

      const teamSelector = createFilterableSelectList(teamItems, 9);

      teamSelector.onSelect = (teamItem) => {
        const selectedTeam = (teamItem as (typeof teamItems)[0] & { team: GatewayTeamStatus }).team;

        // Step 3: Show teammate selector for selected team
        const teammateItems = [
          // Lead option
          {
            value: selectedTeam.leadSessionKey,
            label: "Lead",
            description: "Team lead session",
            searchText: "lead team lead",
          },
          // Teammate options
          ...selectedTeam.teammates.map((tm) => {
            const taskLabel = tm.currentTask ? ` · ${tm.currentTask}` : "";
            const statusIcon =
              tm.status === "active"
                ? "●"
                : tm.status === "completed"
                  ? "✓"
                  : tm.status === "failed"
                    ? "✗"
                    : "○";

            return {
              value: tm.sessionKey,
              label: `@${tm.role}`,
              description: `${statusIcon} ${tm.status}${taskLabel}`,
              searchText: [tm.role, tm.status, tm.currentTask || ""].filter(Boolean).join(" "),
            };
          }),
        ];

        const teammateSelector = createFilterableSelectList(teammateItems, 9);

        teammateSelector.onSelect = (teammateItem) => {
          void (async () => {
            closeOverlay();
            // Switch to the selected session
            await setSession(teammateItem.value);
            tui.requestRender();
          })();
        };

        teammateSelector.onCancel = () => {
          closeOverlay();
          tui.requestRender();
        };

        openOverlay(teammateSelector);
        tui.requestRender();
      };

      teamSelector.onCancel = () => {
        closeOverlay();
        tui.requestRender();
      };

      openOverlay(teamSelector);
      tui.requestRender();
    } catch (err) {
      chatLog.addSystem(`teams list failed: ${String(err)}`);
      tui.requestRender();
    }
  };

  const handleCommand = async (raw: string) => {
    const { name, args } = parseCommand(raw);
    if (!name) {
      return;
    }

    // Check command permissions based on pane context
    const context = getPaneContext();
    const allowedCommands = getAllowedCommands(context);

    // Block restricted commands
    if (!allowedCommands.includes(name)) {
      if (context.type === "teammate") {
        chatLog.addSystem(
          `Command /${name} is not available in teammate panes. ` +
            `Use /help to see available commands.`,
        );
      } else {
        chatLog.addSystem(`Command /${name} is not available in this context.`);
      }
      tui.requestRender();
      return;
    }

    switch (name) {
      case "help":
        chatLog.addSystem(
          helpText(
            {
              provider: state.sessionInfo.modelProvider,
              model: state.sessionInfo.model,
            },
            getPaneContext(),
          ),
        );
        break;
      case "status":
        try {
          const status = await client.getStatus();
          if (typeof status === "string") {
            chatLog.addSystem(status);
            break;
          }
          if (status && typeof status === "object") {
            const lines = formatStatusSummary(status as GatewayStatusSummary);
            for (const line of lines) {
              chatLog.addSystem(line);
            }
            break;
          }
          chatLog.addSystem("status: unknown response");
        } catch (err) {
          chatLog.addSystem(`status failed: ${String(err)}`);
        }
        break;
      case "agent":
        if (!args) {
          await openAgentSelector();
        } else {
          await setAgent(args);
        }
        break;
      case "agents":
        await openAgentSelector();
        break;
      case "session":
        if (!args) {
          await openSessionSelector();
        } else {
          await setSession(args);
        }
        break;
      case "sessions":
        await openSessionSelector();
        break;
      case "model":
        if (!args) {
          await openModelSelector();
        } else {
          try {
            const result = await client.patchSession({
              key: state.currentSessionKey,
              model: args,
            });
            chatLog.addSystem(`model set to ${args}`);
            applySessionInfoFromPatch(result);
            await refreshSessionInfo();
          } catch (err) {
            chatLog.addSystem(`model set failed: ${String(err)}`);
          }
        }
        break;
      case "models":
        await openModelSelector();
        break;
      case "think":
        if (!args) {
          const levels = formatThinkingLevels(
            state.sessionInfo.modelProvider,
            state.sessionInfo.model,
            "|",
          );
          chatLog.addSystem(`usage: /think <${levels}>`);
          break;
        }
        try {
          const result = await client.patchSession({
            key: state.currentSessionKey,
            thinkingLevel: args,
          });
          chatLog.addSystem(`thinking set to ${args}`);
          applySessionInfoFromPatch(result);
          await refreshSessionInfo();
        } catch (err) {
          chatLog.addSystem(`think failed: ${String(err)}`);
        }
        break;
      case "verbose":
        if (!args) {
          chatLog.addSystem("usage: /verbose <on|off>");
          break;
        }
        try {
          const result = await client.patchSession({
            key: state.currentSessionKey,
            verboseLevel: args,
          });
          chatLog.addSystem(`verbose set to ${args}`);
          applySessionInfoFromPatch(result);
          await loadHistory();
        } catch (err) {
          chatLog.addSystem(`verbose failed: ${String(err)}`);
        }
        break;
      case "reasoning":
        if (!args) {
          chatLog.addSystem("usage: /reasoning <on|off>");
          break;
        }
        try {
          const result = await client.patchSession({
            key: state.currentSessionKey,
            reasoningLevel: args,
          });
          chatLog.addSystem(`reasoning set to ${args}`);
          applySessionInfoFromPatch(result);
          await refreshSessionInfo();
        } catch (err) {
          chatLog.addSystem(`reasoning failed: ${String(err)}`);
        }
        break;
      case "usage": {
        const trimmed = args?.trim() ?? "";
        if (trimmed.startsWith("logs")) {
          const parts = trimmed.split(/\s+/).filter(Boolean);
          const limitRaw = parts[1];
          const limit =
            limitRaw && Number.isFinite(Number.parseInt(limitRaw, 10))
              ? Number.parseInt(limitRaw, 10)
              : 20;
          try {
            const logs = await client.getSessionUsageLogs({
              sessionKey: state.currentSessionKey,
              limit,
            });
            if (logs.length === 0) {
              chatLog.addSystem("No usage logs found.");
              break;
            }
            const lines = logs
              .filter(
                (entry) =>
                  entry.role === "assistant" &&
                  (typeof entry.tokens === "number" || entry.usageBreakdown),
              )
              .map((entry) => {
                const ts = new Date(entry.timestamp).toLocaleString();
                const breakdown = entry.usageBreakdown;
                const tokens = Math.round(breakdown?.total ?? entry.tokens ?? 0);
                const cost = typeof entry.cost === "number" ? entry.cost.toFixed(4) : undefined;
                const breakdownLabel = breakdown
                  ? ` (in ${Math.round(breakdown.input)}, out ${Math.round(
                      breakdown.output,
                    )}, cr ${Math.round(breakdown.cacheRead)}, cw ${Math.round(
                      breakdown.cacheWrite,
                    )})`
                  : "";
                const preview = entry.content.replace(/\s+/g, " ").slice(0, 120);
                return cost
                  ? `${ts} · ${tokens} tokens${breakdownLabel} · $${cost} · ${preview}`
                  : `${ts} · ${tokens} tokens${breakdownLabel} · ${preview}`;
              });
            chatLog.addSystem(lines.join("\n"));
          } catch (err) {
            chatLog.addSystem(`usage logs failed: ${String(err)}`);
          }
          break;
        }

        const normalized = args ? normalizeUsageDisplay(args) : undefined;
        if (args && !normalized) {
          chatLog.addSystem("usage: /usage <off|tokens|full> or /usage logs [limit]");
          break;
        }
        const currentRaw = state.sessionInfo.responseUsage;
        const current = resolveResponseUsageMode(currentRaw);
        const next =
          normalized ?? (current === "off" ? "tokens" : current === "tokens" ? "full" : "off");
        try {
          const result = await client.patchSession({
            key: state.currentSessionKey,
            responseUsage: next === "off" ? null : next,
          });
          chatLog.addSystem(`usage footer: ${next}`);
          applySessionInfoFromPatch(result);
          await refreshSessionInfo();
        } catch (err) {
          chatLog.addSystem(`usage failed: ${String(err)}`);
        }
        break;
      }
      case "elevated":
        if (!args) {
          chatLog.addSystem("usage: /elevated <on|off|ask|full>");
          break;
        }
        if (!["on", "off", "ask", "full"].includes(args)) {
          chatLog.addSystem("usage: /elevated <on|off|ask|full>");
          break;
        }
        try {
          const result = await client.patchSession({
            key: state.currentSessionKey,
            elevatedLevel: args,
          });
          chatLog.addSystem(`elevated set to ${args}`);
          applySessionInfoFromPatch(result);
          await refreshSessionInfo();
        } catch (err) {
          chatLog.addSystem(`elevated failed: ${String(err)}`);
        }
        break;
      case "activation":
        if (!args) {
          chatLog.addSystem("usage: /activation <mention|always>");
          break;
        }
        try {
          const result = await client.patchSession({
            key: state.currentSessionKey,
            groupActivation: args === "always" ? "always" : "mention",
          });
          chatLog.addSystem(`activation set to ${args}`);
          applySessionInfoFromPatch(result);
          await refreshSessionInfo();
        } catch (err) {
          chatLog.addSystem(`activation failed: ${String(err)}`);
        }
        break;
      case "new":
      case "reset":
        try {
          // Clear token counts immediately to avoid stale display (#1523)
          state.sessionInfo.inputTokens = null;
          state.sessionInfo.outputTokens = null;
          state.sessionInfo.totalTokens = null;
          tui.requestRender();

          await client.resetSession(state.currentSessionKey);
          chatLog.addSystem(`session ${state.currentSessionKey} reset`);
          await loadHistory();
        } catch (err) {
          chatLog.addSystem(`reset failed: ${String(err)}`);
        }
        break;
      case "abort":
        await abortActive();
        break;
      case "settings":
        openSettings();
        break;
      case "team":
        await handleTeamCommand(args);
        break;
      case "teams":
        await openTeamSelector();
        break;
      case "split":
        if (!args || args.trim() === "") {
          chatLog.addSystem("Usage: /split [exit|close]");
          break;
        }
        const splitSub = args.trim().toLowerCase();
        if (splitSub === "exit" || splitSub === "close") {
          if (state.splitViewMode) {
            state.splitViewMode = false;
            state.splitViewPanes = [];
            state.activePaneIndex = 0;
            updateRootLayout();
            chatLog.addSystem("Exited split view.");
            tui.requestRender();
          } else {
            chatLog.addSystem("Not in split view mode.");
          }
        } else {
          chatLog.addSystem("Usage: /split [exit|close]");
        }
        break;
      case "exit":
      case "quit":
        client.stop();
        tui.stop();
        process.exit(0);
        break;
      default:
        await sendMessage(raw);
        break;
    }
    tui.requestRender();
  };

  const sendMessage = async (text: string) => {
    try {
      chatLog.addUser(text);
      tui.requestRender();
      const runId = randomUUID();
      noteLocalRunId(runId);
      state.activeChatRunId = runId;
      setActivityStatus("sending");
      await client.sendChat({
        sessionKey: state.currentSessionKey,
        message: text,
        thinking: opts.thinking,
        deliver: deliverDefault,
        timeoutMs: opts.timeoutMs,
        runId,
      });
      setActivityStatus("waiting");
    } catch (err) {
      if (state.activeChatRunId) {
        forgetLocalRunId?.(state.activeChatRunId);
      }
      state.activeChatRunId = null;
      chatLog.addSystem(`send failed: ${String(err)}`);
      setActivityStatus("error");
    }
    tui.requestRender();
  };

  return {
    handleCommand,
    sendMessage,
    openModelSelector,
    openAgentSelector,
    openSessionSelector,
    openSettings,
    setAgent,
  };
}
