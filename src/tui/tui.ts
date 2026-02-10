import {
  CombinedAutocompleteProvider,
  Container,
  Loader,
  ProcessTerminal,
  Text,
  TUI,
} from "@mariozechner/pi-tui";
import chalk from "chalk";
import type { GatewayTeamStatus } from "./gateway-chat.js";
import type {
  AgentSummary,
  PaneContext,
  SessionInfo,
  SessionScope,
  TuiOptions,
  TuiStateAccess,
} from "./tui-types.js";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { resolveTeamDisplayMode } from "../agents/teams/display-tmux.js";
import { loadConfig } from "../config/config.js";
import {
  buildAgentMainSessionKey,
  normalizeAgentId,
  normalizeMainKey,
  parseAgentSessionKey,
} from "../routing/session-key.js";
import { getSlashCommands } from "./commands.js";
import { ChatLog } from "./components/chat-log.js";
import { CustomEditor } from "./components/custom-editor.js";
import { SplitView } from "./components/split-view.js";
import { GatewayChatClient } from "./gateway-chat.js";
import { getTeamColor, getTeammateColor } from "./team-colors.js";
import { editorTheme, theme } from "./theme/theme.js";
import { createCommandHandlers } from "./tui-command-handlers.js";
import { createEventHandlers } from "./tui-event-handlers.js";
import { formatTokens } from "./tui-formatters.js";
import { createLocalShellRunner } from "./tui-local-shell.js";
import { createOverlayHandlers } from "./tui-overlays.js";
import { createSessionActions } from "./tui-session-actions.js";
import { buildWaitingStatusMessage, defaultWaitingPhrases } from "./tui-waiting.js";

export { resolveFinalAssistantText } from "./tui-formatters.js";
export type { TuiOptions } from "./tui-types.js";

export function createEditorSubmitHandler(params: {
  editor: {
    setText: (value: string) => void;
    addToHistory: (value: string) => void;
  };
  handleCommand: (value: string) => Promise<void> | void;
  sendMessage: (value: string) => Promise<void> | void;
  handleBangLine: (value: string) => Promise<void> | void;
  updatePlaceholder?: () => void;
}) {
  return (text: string) => {
    const raw = text;
    const value = raw.trim();
    params.editor.setText("");
    params.updatePlaceholder?.();

    // Keep previous behavior: ignore empty/whitespace-only submissions.
    if (!value) {
      return;
    }

    // Bash mode: only if the very first character is '!' and it's not just '!'.
    // IMPORTANT: use the raw (untrimmed) text so leading spaces do NOT trigger.
    // Per requirement: a lone '!' should be treated as a normal message.
    if (raw.startsWith("!") && raw !== "!") {
      params.editor.addToHistory(raw);
      void params.handleBangLine(raw);
      return;
    }

    // Enable built-in editor prompt history navigation (up/down).
    params.editor.addToHistory(value);

    if (value.startsWith("/")) {
      void params.handleCommand(value);
      return;
    }

    void params.sendMessage(value);
  };
}

export async function runTui(opts: TuiOptions) {
  const config = loadConfig();
  const initialSessionInput = (opts.session ?? "").trim();
  let sessionScope: SessionScope = (config.session?.scope ?? "per-sender") as SessionScope;
  let sessionMainKey = normalizeMainKey(config.session?.mainKey);
  let agentDefaultId = resolveDefaultAgentId(config);
  let currentAgentId = agentDefaultId;
  let agents: AgentSummary[] = [];
  const agentNames = new Map<string, string>();
  let currentSessionKey = "";
  let initialSessionApplied = false;
  let currentSessionId: string | null = null;
  let activeChatRunId: string | null = null;
  let historyLoaded = false;
  let isConnected = false;
  let wasDisconnected = false;
  let toolsExpanded = false;
  let showThinking = true;
  const localRunIds = new Set<string>();

  const deliverDefault = opts.deliver ?? false;
  const autoMessage = opts.message?.trim();
  let autoMessageSent = false;
  let sessionInfo: SessionInfo = {};
  let lastCtrlCAt = 0;
  let activityStatus = "idle";
  let connectionStatus = "connecting";
  let statusTimeout: NodeJS.Timeout | null = null;
  let statusTimer: NodeJS.Timeout | null = null;
  let statusStartedAt: number | null = null;
  let lastActivityStatus = activityStatus;

  // --- Team state ---
  let teamStatus: GatewayTeamStatus | null = null;
  let callerTeams: GatewayTeamStatus[] = [];
  let teamDisplayMode: "tmux" | "inline" = "inline";

  const resolveTeamContext = () => {
    if (!teamStatus) {
      return null;
    }
    if (teamStatus.leadSessionKey === currentSessionKey) {
      return { isLead: true, teamId: teamStatus.teamId };
    }
    const teammate = teamStatus.teammates.find((tm) => tm.sessionKey === currentSessionKey);
    if (!teammate) {
      return null;
    }
    return {
      isLead: false,
      teamId: teamStatus.teamId,
      teammateId: teammate.teammateId,
      role: teammate.role,
    };
  };
  let teamPollTimer: NodeJS.Timeout | null = null;

  // --- Split view state ---
  let splitViewMode = false;
  let splitViewPanes: string[] = [];
  let activePaneIndex = 0;

  // --- Team view mode ---
  let teamViewMode = false;

  const state: TuiStateAccess = {
    get agentDefaultId() {
      return agentDefaultId;
    },
    set agentDefaultId(value) {
      agentDefaultId = value;
    },
    get sessionMainKey() {
      return sessionMainKey;
    },
    set sessionMainKey(value) {
      sessionMainKey = value;
    },
    get sessionScope() {
      return sessionScope;
    },
    set sessionScope(value) {
      sessionScope = value;
    },
    get agents() {
      return agents;
    },
    set agents(value) {
      agents = value;
    },
    get currentAgentId() {
      return currentAgentId;
    },
    set currentAgentId(value) {
      currentAgentId = value;
    },
    get currentSessionKey() {
      return currentSessionKey;
    },
    set currentSessionKey(value) {
      currentSessionKey = value;
    },
    get currentSessionId() {
      return currentSessionId;
    },
    set currentSessionId(value) {
      currentSessionId = value;
    },
    get activeChatRunId() {
      return activeChatRunId;
    },
    set activeChatRunId(value) {
      activeChatRunId = value;
    },
    get historyLoaded() {
      return historyLoaded;
    },
    set historyLoaded(value) {
      historyLoaded = value;
    },
    get sessionInfo() {
      return sessionInfo;
    },
    set sessionInfo(value) {
      sessionInfo = value;
    },
    get initialSessionApplied() {
      return initialSessionApplied;
    },
    set initialSessionApplied(value) {
      initialSessionApplied = value;
    },
    get isConnected() {
      return isConnected;
    },
    set isConnected(value) {
      isConnected = value;
    },
    get autoMessageSent() {
      return autoMessageSent;
    },
    set autoMessageSent(value) {
      autoMessageSent = value;
    },
    get toolsExpanded() {
      return toolsExpanded;
    },
    set toolsExpanded(value) {
      toolsExpanded = value;
    },
    get showThinking() {
      return showThinking;
    },
    set showThinking(value) {
      showThinking = value;
    },
    get connectionStatus() {
      return connectionStatus;
    },
    set connectionStatus(value) {
      connectionStatus = value;
    },
    get activityStatus() {
      return activityStatus;
    },
    set activityStatus(value) {
      activityStatus = value;
    },
    get statusTimeout() {
      return statusTimeout;
    },
    set statusTimeout(value) {
      statusTimeout = value;
    },
    get lastCtrlCAt() {
      return lastCtrlCAt;
    },
    set lastCtrlCAt(value) {
      lastCtrlCAt = value;
    },
    get splitViewMode() {
      return splitViewMode;
    },
    set splitViewMode(value) {
      splitViewMode = value;
    },
    get splitViewPanes() {
      return splitViewPanes;
    },
    set splitViewPanes(value) {
      splitViewPanes = value;
    },
    get activePaneIndex() {
      return activePaneIndex;
    },
    set activePaneIndex(value) {
      activePaneIndex = value;
    },
    get teamViewMode() {
      return teamViewMode;
    },
    set teamViewMode(value) {
      teamViewMode = value;
    },
  };

  const noteLocalRunId = (runId: string) => {
    if (!runId) {
      return;
    }
    localRunIds.add(runId);
    if (localRunIds.size > 200) {
      const [first] = localRunIds;
      if (first) {
        localRunIds.delete(first);
      }
    }
  };

  const forgetLocalRunId = (runId: string) => {
    localRunIds.delete(runId);
  };

  const isLocalRunId = (runId: string) => localRunIds.has(runId);

  const clearLocalRunIds = () => {
    localRunIds.clear();
  };

  const client = new GatewayChatClient({
    url: opts.url,
    token: opts.token,
    password: opts.password,
  });

  const tui = new TUI(new ProcessTerminal());
  const header = new Text("", 1, 0);
  const statusContainer = new Container();
  const footer = new Text("", 1, 0);
  const chatLog = new ChatLog();
  const splitView = new SplitView();
  const editor = new CustomEditor(tui, editorTheme, { paddingX: 2 });
  const root = new Container();

  // Helper to rebuild root children based on split view mode
  const updateRootLayout = () => {
    root.clear();
    root.addChild(header);
    if (splitViewMode) {
      root.addChild(splitView);
    } else {
      root.addChild(chatLog);
    }
    root.addChild(statusContainer);
    root.addChild(footer);
    root.addChild(editor);
  };

  updateRootLayout();

  const updateAutocompleteProvider = () => {
    const context = getPaneContext();
    editor.setAutocompleteProvider(
      new CombinedAutocompleteProvider(
        getSlashCommands(
          {
            cfg: config,
            provider: sessionInfo.modelProvider,
            model: sessionInfo.model,
          },
          context,
        ),
        process.cwd(),
      ),
    );
  };

  tui.addChild(root);
  tui.setFocus(editor);

  const formatSessionKey = (key: string) => {
    if (key === "global" || key === "unknown") {
      return key;
    }
    const parsed = parseAgentSessionKey(key);
    return parsed?.rest ?? key;
  };

  const formatAgentLabel = (id: string) => {
    const name = agentNames.get(id);
    return name ? `${id} (${name})` : id;
  };

  const resolveSessionKey = (raw?: string) => {
    const trimmed = (raw ?? "").trim();
    if (sessionScope === "global") {
      return "global";
    }
    if (!trimmed) {
      return buildAgentMainSessionKey({
        agentId: currentAgentId,
        mainKey: sessionMainKey,
      });
    }
    if (trimmed === "global" || trimmed === "unknown") {
      return trimmed;
    }
    if (trimmed.startsWith("agent:")) {
      return trimmed;
    }
    return `agent:${currentAgentId}:${trimmed}`;
  };

  currentSessionKey = resolveSessionKey(initialSessionInput);
  const homeSessionKey = currentSessionKey;

  const updateHeader = () => {
    const sessionLabel = formatSessionKey(currentSessionKey);
    const agentLabel = formatAgentLabel(currentAgentId);

    // Check if we're in a team context
    const teamContext = resolveTeamContext();
    let headerText = `openclaw tui - ${client.connection.url} - agent ${agentLabel} - session ${sessionLabel}`;

    if (teamContext && teamStatus) {
      // Build role badge
      let roleBadge = "";
      if (teamContext.isLead) {
        roleBadge = " @lead";
      } else if (teamContext.teammateId) {
        // Find teammate role from team status
        const teammate = teamStatus.teammates.find(
          (tm) => tm.teammateId === teamContext.teammateId,
        );
        if (teammate?.role) {
          roleBadge = ` @${teammate.role}`;
        } else {
          roleBadge = ` @${teamContext.teammateId}`;
        }
      }

      // Apply team color to role badge (colored text, no background)
      const teamColor = getTeamColor(teamContext.teamId);
      const coloredBadge = `${teamColor.fg}${roleBadge}\x1b[0m`;

      headerText = `openclaw tui - ${client.connection.url} - agent ${agentLabel} - ${teamColor.fg}team ${teamStatus.teamName}\x1b[0m${coloredBadge}`;
    }

    header.setText(theme.header(headerText));
  };

  const busyStates = new Set(["sending", "waiting", "streaming", "running"]);
  let statusText: Text | null = null;
  let statusLoader: Loader | null = null;

  const formatElapsed = (startMs: number) => {
    const totalSeconds = Math.max(0, Math.floor((Date.now() - startMs) / 1000));
    if (totalSeconds < 60) {
      return `${totalSeconds}s`;
    }
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}m ${seconds}s`;
  };

  const ensureStatusText = () => {
    if (statusText) {
      return;
    }
    statusContainer.clear();
    statusLoader?.stop();
    statusLoader = null;
    statusText = new Text("", 1, 0);
    statusContainer.addChild(statusText);
  };

  const ensureStatusLoader = () => {
    if (statusLoader) {
      return;
    }
    statusContainer.clear();
    statusText = null;
    statusLoader = new Loader(
      tui,
      (spinner) => theme.accent(spinner),
      (text) => theme.bold(theme.accentSoft(text)),
      "",
    );
    statusContainer.addChild(statusLoader);
  };

  let waitingTick = 0;
  let waitingTimer: NodeJS.Timeout | null = null;
  let waitingPhrase: string | null = null;

  const updateBusyStatusMessage = () => {
    if (!statusLoader || !statusStartedAt) {
      return;
    }
    const elapsed = formatElapsed(statusStartedAt);

    if (activityStatus === "waiting") {
      waitingTick++;
      statusLoader.setMessage(
        buildWaitingStatusMessage({
          theme,
          tick: waitingTick,
          elapsed,
          connectionStatus,
          phrases: waitingPhrase ? [waitingPhrase] : undefined,
        }),
      );
      return;
    }

    statusLoader.setMessage(`${activityStatus} • ${elapsed} | ${connectionStatus}`);
  };

  const startStatusTimer = () => {
    if (statusTimer) {
      return;
    }
    statusTimer = setInterval(() => {
      if (!busyStates.has(activityStatus)) {
        return;
      }
      updateBusyStatusMessage();
    }, 1000);
  };

  const stopStatusTimer = () => {
    if (!statusTimer) {
      return;
    }
    clearInterval(statusTimer);
    statusTimer = null;
  };

  const startWaitingTimer = () => {
    if (waitingTimer) {
      return;
    }

    // Pick a phrase once per waiting session.
    if (!waitingPhrase) {
      const idx = Math.floor(Math.random() * defaultWaitingPhrases.length);
      waitingPhrase = defaultWaitingPhrases[idx] ?? defaultWaitingPhrases[0] ?? "waiting";
    }

    waitingTick = 0;

    waitingTimer = setInterval(() => {
      if (activityStatus !== "waiting") {
        return;
      }
      updateBusyStatusMessage();
    }, 120);
  };

  const stopWaitingTimer = () => {
    if (!waitingTimer) {
      return;
    }
    clearInterval(waitingTimer);
    waitingTimer = null;
    waitingPhrase = null;
  };

  const renderStatus = () => {
    const isBusy = busyStates.has(activityStatus);
    if (isBusy) {
      if (!statusStartedAt || lastActivityStatus !== activityStatus) {
        statusStartedAt = Date.now();
      }
      ensureStatusLoader();
      if (activityStatus === "waiting") {
        stopStatusTimer();
        startWaitingTimer();
      } else {
        stopWaitingTimer();
        startStatusTimer();
      }
      updateBusyStatusMessage();
    } else {
      statusStartedAt = null;
      stopStatusTimer();
      stopWaitingTimer();
      statusLoader?.stop();
      statusLoader = null;
      // When idle, clear the status container entirely — status info goes in the footer
      statusContainer.clear();
      statusText = null;
      updateFooter();
    }
    lastActivityStatus = activityStatus;
  };

  const setConnectionStatus = (text: string, ttlMs?: number) => {
    connectionStatus = text;
    renderStatus();
    updateEditorPlaceholder();
    if (statusTimeout) {
      clearTimeout(statusTimeout);
    }
    if (ttlMs && ttlMs > 0) {
      statusTimeout = setTimeout(() => {
        connectionStatus = isConnected ? "connected" : "disconnected";
        renderStatus();
        updateEditorPlaceholder();
      }, ttlMs);
    }
  };

  const setActivityStatus = (text: string) => {
    activityStatus = text;
    updateEditorBorderColor();
    renderStatus();
  };

  const updateEditorBorderColor = () => {
    // Update editor border based on activity state
    if (activityStatus === "error" || activityStatus.includes("failed")) {
      editor.borderColor = theme.borderError;
    } else if (busyStates.has(activityStatus)) {
      editor.borderColor = theme.borderActive;
    } else {
      editor.borderColor = theme.borderIdle;
    }
  };

  // Helper function to format thinking level as volume-style bars
  // Active levels are bold/bright, inactive levels are dimmed
  const formatThinkingBars = (level: string): string => {
    const maxBars = 5; // off=0, minimal=1, low=2, medium=3, high=4, xhigh=5
    let activeCount = 0;
    switch (level) {
      case "off":
        activeCount = 0;
        break;
      case "minimal":
        activeCount = 1;
        break;
      case "low":
        activeCount = 2;
        break;
      case "medium":
        activeCount = 3;
        break;
      case "high":
        activeCount = 4;
        break;
      case "xhigh":
        activeCount = 5;
        break;
      default:
        activeCount = 0;
    }

    if (activeCount === 0) {
      return theme.dim("•••••"); // All dimmed when off
    }

    // color it with the theme.accent
    const activeBars = theme.bold(theme.accent("•".repeat(activeCount)));
    const inactiveBars = theme.dim("•".repeat(maxBars - activeCount));
    return activeBars + inactiveBars;
  };

  // Helper function to format tokens simply as "0/1m"
  const formatTokensSimple = (total?: number | null, context?: number | null): string => {
    const formatTokenCount = (count: number): string => {
      if (count >= 1000000) {
        return `${(count / 1000000).toFixed(count % 1000000 === 0 ? 0 : 1)}m`;
      }
      if (count >= 1000) {
        return `${(count / 1000).toFixed(count % 1000 === 0 ? 0 : 1)}k`;
      }
      return String(count);
    };

    if (total == null && context == null) {
      return "?";
    }
    const totalLabel = total == null ? "?" : formatTokenCount(total);
    if (context == null) {
      return totalLabel;
    }
    return `${totalLabel}/${formatTokenCount(context)}`;
  };

  const updateEditorTopBorder = () => {
    const tokens = formatTokensSimple(
      sessionInfo.totalTokens ?? null,
      sessionInfo.contextTokens ?? null,
    );

    // Format: ------ @role - 20.6k/200k ----
    // Combine role and tokens into right label
    const teamContext = resolveTeamContext();
    let roleLabel = "";

    if (teamContext) {
      if (teamContext.isLead) {
        roleLabel = "@lead";
      } else if (teamStatus) {
        // Teammate - need teamStatus to get colors
        const teammateIndex = teamStatus.teammates.findIndex(
          (t) =>
            t.teammateId === teamContext.teammateId ||
            t.role === teamContext.role ||
            t.sessionKey === currentSessionKey,
        );
        if (teammateIndex >= 0) {
          const paneColor = getTeammateColor(teammateIndex + 1);
          const roleName = teamStatus.teammates[teammateIndex]?.role ?? teamContext.role;
          roleLabel = chalk.hex(paneColor.fg)(`@${roleName}`);
        } else {
          roleLabel = `@${teamContext.role}`;
        }
      } else {
        // Teammate but teamStatus not loaded yet - show basic role
        roleLabel = `@${teamContext.role}`;
      }
    }

    // Format: ------ @role - 20.6k/200k ----
    if (roleLabel && tokens) {
      editor.topBorderLabel = `${roleLabel} - ${theme.dim(tokens)}`;
    } else if (roleLabel) {
      editor.topBorderLabel = roleLabel;
    } else {
      editor.topBorderLabel = theme.dim(tokens);
    }

    editor.topBorderLeftLabel = ""; // Not used, task goes in pane title
  };

  const updateEditorBottomBorder = () => {
    const modelLabel = sessionInfo.model
      ? sessionInfo.modelProvider
        ? `${sessionInfo.modelProvider}/${sessionInfo.model}`
        : sessionInfo.model
      : "";
    const think = sessionInfo.thinkingLevel ?? "off";
    const bars = formatThinkingBars(think);
    const barsText = bars ? ` ${bars}` : "";
    editor.bottomBorderLabel = modelLabel ? theme.dim(modelLabel) + barsText : "";
  };

  const updateEditorPlaceholder = () => {
    if (!isConnected) {
      editor.placeholderText = "gateway not connected";
    } else {
      editor.placeholderText = "";
    }
  };

  const updateFooter = () => {
    const verbose = sessionInfo.verboseLevel ?? "off";
    const reasoning = sessionInfo.reasoningLevel ?? "off";
    const reasoningLabel =
      reasoning === "on" ? "reasoning" : reasoning === "stream" ? "reasoning:stream" : null;

    // Build team footer segment only for team lead sessions
    const teamContext = resolveTeamContext();
    let teamLabel: string | null = null;
    if (teamStatus && teamContext?.isLead) {
      const names = teamStatus.teammates.map((t) => `@${t.role}`).join(" ");
      teamLabel = `${names} · ${teamStatus.teammateCount} teammate${teamStatus.teammateCount === 1 ? "" : "s"}`;
    }

    // Check if we're in a teammate session and add colored role badge
    let coloredRoleBadge = "";
    if (teamContext && !teamContext.isLead && teamStatus) {
      const teammateIndex = teamStatus.teammates.findIndex(
        (t) => t.teammateId === teamContext.teammateId,
      );
      if (teammateIndex >= 0) {
        const paneColor = getTeammateColor(teammateIndex + 1);
        const roleName = teamStatus.teammates[teammateIndex]?.role ?? teamContext.role;
        coloredRoleBadge = ` ${chalk.hex(paneColor.fg)(`@${roleName}`)}`;
        // Apply role badge to chat log so every assistant message shows @Role
        chatLog.setRoleContext(roleName, paneColor.fg);
      } else {
        chatLog.setRoleContext(null, null);
      }
    } else {
      chatLog.setRoleContext(null, null);
    }

    const footerParts = [
      verbose !== "off" ? `verbose ${verbose}` : null,
      reasoningLabel,
      teamLabel,
    ].filter(Boolean);
    footer.setText(
      footerParts.length > 0 ? theme.dim(footerParts.join(" | ")) + coloredRoleBadge : "",
    );
    // Update editor borders with model/thinking and tokens
    updateEditorTopBorder();
    updateEditorBottomBorder();
  };

  const { openOverlay, closeOverlay } = createOverlayHandlers(tui, editor);

  const initialSessionAgentId = (() => {
    if (!initialSessionInput) {
      return null;
    }
    const parsed = parseAgentSessionKey(initialSessionInput);
    return parsed ? normalizeAgentId(parsed.agentId) : null;
  })();

  const sessionActions = createSessionActions({
    client,
    chatLog,
    tui,
    opts,
    state,
    agentNames,
    initialSessionInput,
    initialSessionAgentId,
    resolveSessionKey,
    updateHeader,
    updateFooter,
    updateAutocompleteProvider,
    setActivityStatus,
    clearLocalRunIds,
  });
  const {
    refreshAgents,
    refreshSessionInfo,
    applySessionInfoFromPatch,
    loadHistory,
    setSession,
    abortActive,
  } = sessionActions;

  const { handleChatEvent, handleAgentEvent } = createEventHandlers({
    chatLog,
    tui,
    state,
    setActivityStatus,
    refreshSessionInfo,
    loadHistory,
    isLocalRunId,
    forgetLocalRunId,
    clearLocalRunIds,
  });

  /**
   * Get the pane context (lead, teammate, or standalone) for the current session.
   */
  const getPaneContext = (): PaneContext => {
    if (!teamStatus) {
      return { type: "standalone" };
    }
    const teamContext = resolveTeamContext();
    if (!teamContext) {
      return { type: "standalone" };
    }
    if (teamContext.isLead) {
      return { type: "lead", teamStatus };
    }
    // Find teammate index
    const teammateIndex = teamStatus.teammates.findIndex(
      (tm) => tm.teammateId === teamContext.teammateId || tm.role === teamContext.role,
    );
    if (teammateIndex >= 0) {
      return { type: "teammate", teamStatus, teammateIndex };
    }
    return { type: "standalone" };
  };

  const { handleCommand, sendMessage, openModelSelector, openAgentSelector, openSessionSelector } =
    createCommandHandlers({
      client,
      chatLog,
      tui,
      opts,
      state,
      deliverDefault,
      openOverlay,
      closeOverlay,
      refreshSessionInfo,
      applySessionInfoFromPatch,
      loadHistory,
      setSession,
      refreshAgents,
      abortActive,
      setActivityStatus,
      formatSessionKey,
      noteLocalRunId,
      forgetLocalRunId,
      splitView,
      updateRootLayout,
      getPaneContext,
    });

  const { runLocalShellLine } = createLocalShellRunner({
    chatLog,
    tui,
    openOverlay,
    closeOverlay,
  });
  // --- Team awareness helpers ---

  const refreshTeamStatus = async () => {
    try {
      callerTeams = await client.getTeamStatuses(homeSessionKey);
    } catch {
      callerTeams = [];
    }
    try {
      const teams = await client.getTeamStatuses(currentSessionKey);
      teamStatus = teams[0] ?? null;
    } catch {
      teamStatus = null;
    }
    const cfg = loadConfig();
    teamDisplayMode = await resolveTeamDisplayMode(cfg.gateway?.teams?.display?.mode);
    state.teamViewMode =
      teamDisplayMode === "inline" &&
      currentSessionKey === homeSessionKey &&
      callerTeams.length > 0;
    updateFooter();
    updateEditorTopBorder(); // Update role display
    updateAutocompleteProvider(); // Update command filtering
    tui.requestRender();
  };

  const startTeamPolling = () => {
    if (teamPollTimer) {
      return;
    }
    // Poll team status every 5 seconds for footer updates
    teamPollTimer = setInterval(() => {
      void refreshTeamStatus();
    }, 5000);
  };

  const stopTeamPolling = () => {
    if (teamPollTimer) {
      clearInterval(teamPollTimer);
      teamPollTimer = null;
    }
  };

  const openTeamTaskOverlay = async () => {
    try {
      const result = await client.getTeamTasks(currentSessionKey);
      if (!result || result.tasks.length === 0) {
        chatLog.addSystem("No tasks found.");
        tui.requestRender();
        return;
      }
      // Render tasks as inline system messages (simple first pass)
      const lines: string[] = [];
      lines.push(
        `Team tasks (${result.summary?.completed ?? 0}/${result.summary?.total ?? 0} done):`,
      );
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
      chatLog.addSystem(`tasks failed: ${String(err)}`);
    }
    tui.requestRender();
  };

  updateAutocompleteProvider();
  editor.onSubmit = createEditorSubmitHandler({
    editor,
    handleCommand,
    sendMessage,
    updatePlaceholder: updateEditorPlaceholder,
    handleBangLine: runLocalShellLine,
  });

  editor.onEscape = () => {
    // Escape key: Cancel current input/abort (doesn't exit split view)
    // Use /split exit to exit split view
    void abortActive();
  };
  editor.onCtrlC = () => {
    const now = Date.now();
    if (editor.getText().trim().length > 0) {
      editor.setText("");
      updateEditorPlaceholder();
      setActivityStatus("cleared input");
      tui.requestRender();
      return;
    }
    if (now - lastCtrlCAt < 1000) {
      client.stop();
      tui.stop();
      process.exit(0);
    }
    lastCtrlCAt = now;
    setActivityStatus("press ctrl+c again to exit");
    tui.requestRender();
  };
  editor.onCtrlD = () => {
    client.stop();
    tui.stop();
    process.exit(0);
  };
  editor.onCtrlO = () => {
    toolsExpanded = !toolsExpanded;
    chatLog.setToolsExpanded(toolsExpanded);
    setActivityStatus(toolsExpanded ? "tools expanded" : "tools collapsed");
    tui.requestRender();
  };
  editor.onCtrlL = () => {
    void openModelSelector();
  };
  editor.onCtrlG = () => {
    void openAgentSelector();
  };
  editor.onCtrlP = () => {
    void openSessionSelector();
  };
  editor.onCtrlT = () => {
    // When a team is active, Ctrl+T shows the task list overlay
    if (teamStatus) {
      void openTeamTaskOverlay();
      return;
    }
    // Otherwise toggle thinking visibility
    showThinking = !showThinking;
    void loadHistory();
  };
  const cycleTeamLead = async (direction: "up" | "down") => {
    if (callerTeams.length === 0) {
      return;
    }

    const leadItems = callerTeams.map((team) => ({
      key: team.leadSessionKey,
      label: team.teamName,
    }));
    const items = [{ key: homeSessionKey, label: "caller" }, ...leadItems].filter(
      (item) => item.key,
    );

    if (items.length <= 1) {
      return;
    }

    const currentIndex = items.findIndex((item) => item.key === currentSessionKey);
    let nextIndex = 0;
    if (direction === "up") {
      nextIndex = (currentIndex - 1 + items.length) % items.length;
    } else {
      nextIndex = (currentIndex + 1) % items.length;
    }

    const nextItem = items[nextIndex];
    if (nextItem && nextItem.key !== currentSessionKey) {
      setActivityStatus(`switching to ${nextItem.label}...`);
      await setSession(nextItem.key);
      tui.requestRender();
    }
  };

  editor.onShiftUp = () => {
    const context = getPaneContext();

    if (context.type === "teammate") {
      return;
    }
    void cycleTeamLead("up");
  };

  editor.onShiftDown = () => {
    const context = getPaneContext();

    if (context.type === "teammate") {
      return;
    }
    void cycleTeamLead("down");
  };

  editor.onShiftTab = () => {
    // If in split view mode, use Tab to cycle between panes
    if (splitViewMode && splitViewPanes.length > 1) {
      activePaneIndex = (activePaneIndex + 1) % splitViewPanes.length;
      state.activePaneIndex = activePaneIndex;
      splitView.setActivePane(activePaneIndex);

      // Switch to the session in the active pane
      const targetSessionKey = splitViewPanes[activePaneIndex];
      if (targetSessionKey && targetSessionKey !== currentSessionKey) {
        setActivityStatus(`switching to pane ${activePaneIndex + 1}...`);
        void setSession(targetSessionKey);
      }
      tui.requestRender();
      return;
    }
    return;
  };

  client.onEvent = (evt) => {
    if (evt.event === "chat") {
      handleChatEvent(evt.payload);
    }
    if (evt.event === "agent") {
      handleAgentEvent(evt.payload);
    }
  };

  client.onConnected = () => {
    isConnected = true;
    const reconnected = wasDisconnected;
    wasDisconnected = false;
    setConnectionStatus("connected");
    updateEditorPlaceholder();
    void (async () => {
      await refreshAgents();
      updateHeader();
      await loadHistory();
      // Check for active team (footer + team polling)
      await refreshTeamStatus();
      if (teamStatus) {
        startTeamPolling();
      }
      setConnectionStatus(reconnected ? "gateway reconnected" : "gateway connected", 4000);
      tui.requestRender();
      if (!autoMessageSent && autoMessage) {
        autoMessageSent = true;
        await sendMessage(autoMessage);
      }
      updateFooter();
      tui.requestRender();
    })();
  };

  client.onDisconnected = (reason) => {
    isConnected = false;
    wasDisconnected = true;
    historyLoaded = false;
    stopTeamPolling();
    teamStatus = null;
    const reasonLabel = reason?.trim() ? reason.trim() : "closed";
    setConnectionStatus(`gateway disconnected: ${reasonLabel}`, 5000);
    setActivityStatus("idle");
    updateEditorPlaceholder();
    updateFooter();
    tui.requestRender();
  };

  client.onGap = (info) => {
    setConnectionStatus(`event gap: expected ${info.expected}, got ${info.received}`, 5000);
    tui.requestRender();
  };

  // Check if pane is active (for wezterm) and update editor accordingly
  const checkPaneActive = async () => {
    if (process.env.WEZTERM_PANE) {
      try {
        const { execFile } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const execFileAsync = promisify(execFile);
        const { stdout } = await execFileAsync("wezterm", ["cli", "list", "--format", "json"], {
          encoding: "utf-8",
        });
        const panes = JSON.parse(stdout);
        const currentPaneId = process.env.WEZTERM_PANE.trim();
        const currentPane = panes.find((p: any) => p.pane_id === currentPaneId);
        editor.isPaneActive = currentPane?.is_active ?? true;
        tui.requestRender();
      } catch {
        editor.isPaneActive = true; // Default to active if we can't check
      }
    } else {
      editor.isPaneActive = true; // Not in wezterm, assume active
    }
  };

  // Poll pane active status periodically in wezterm
  let paneActiveCheckInterval: NodeJS.Timeout | null = null;
  if (process.env.WEZTERM_PANE) {
    paneActiveCheckInterval = setInterval(() => {
      void checkPaneActive();
    }, 500); // Check every 500ms
  }

  updateHeader();
  setConnectionStatus("connecting");
  updateFooter();
  updateEditorBorderColor(); // Apply initial border color based on idle state
  updateEditorTopBorder();
  updateEditorBottomBorder();
  updateEditorPlaceholder();
  void checkPaneActive(); // Check pane active status
  tui.start();
  client.start();
  await new Promise<void>((resolve) => {
    const finish = () => resolve();
    process.once("exit", finish);
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
  });
}
