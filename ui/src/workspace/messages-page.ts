import { html, nothing } from "lit";
import { refreshChatAvatar } from "../ui/app-chat.ts";
import { setTab } from "../ui/app-settings.ts";
import type { AppViewState } from "../ui/app-view-state.ts";
import { buildMentionSuggestions, findDraftMentionAtSelection } from "../ui/chat/draft-mentions.ts";
import { loadChatHistory } from "../ui/controllers/chat.ts";
import { icons } from "../ui/icons.ts";
import type { WorkspaceAgentRow } from "../ui/types.ts";
import { renderChat, type ChatProps } from "../ui/views/chat.ts";

function getWorkspaceSearch(state: AppViewState & { workspaceMessagesSearch?: string }): string {
  return state.workspaceMessagesSearch ?? "";
}

function setWorkspaceSearch(
  state: AppViewState & { workspaceMessagesSearch?: string },
  value: string,
) {
  state.workspaceMessagesSearch = value;
}

function formatMessageTime(timestamp: number): string {
  if (!timestamp) {
    return "";
  }
  const diffMs = Date.now() - timestamp;
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) {
    return "Just now";
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  if (days === 1) {
    return "Yesterday";
  }
  if (days < 7) {
    return `${days}d ago`;
  }
  return new Date(timestamp).toLocaleDateString();
}

function formatExactMessageTime(timestamp: number): string {
  if (!timestamp) {
    return "";
  }
  return new Date(timestamp).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function normalizeAgentAccent(agent: WorkspaceAgentRow | null | undefined): string | undefined {
  const trimmed = agent?.color?.trim();
  if (!trimmed) {
    return undefined;
  }
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(trimmed) ? trimmed : undefined;
}

function agentEmoji(agent: WorkspaceAgentRow): string {
  return agent.emoji?.trim() || "🤖";
}

function agentTitle(agent: WorkspaceAgentRow): string {
  return agent.title?.trim() || agent.description?.trim() || "Agent";
}

function agentMention(agent: WorkspaceAgentRow | null | undefined): string | null {
  const agentId = agent?.id?.trim();
  return agentId ? `@${agentId}` : null;
}

export function selectWorkspaceMessagesAgent(state: AppViewState, agent: WorkspaceAgentRow) {
  state.workspaceSelectedAgentId = agent.id;
  const sessionKey = `agent:${agent.id}:clawport`;
  state.sessionKey = sessionKey;
  state.chatMessage = "";
  state.chatMentionQuery = null;
  state.chatMentionStart = null;
  state.chatMentionEnd = null;
  state.chatMentionSelectedIndex = 0;
  state.chatAttachments = [];
  state.chatStream = null;
  state.chatStreamStartedAt = null;
  state.chatRunId = null;
  state.chatQueue = [];
  state.resetToolStream();
  state.resetChatScroll();
  state.applySettings({
    ...state.settings,
    sessionKey,
    lastActiveSessionKey: sessionKey,
    workspaceSelectedAgentId: agent.id,
  });
  state.workspaceMessagesSeenAt = {
    ...state.workspaceMessagesSeenAt,
    [agent.id]: state.workspaceConversationSummaries[agent.id]?.lastActivity ?? Date.now(),
  };
  state.applySettings({
    ...state.settings,
    workspaceSelectedAgentId: agent.id,
    workspaceMessagesSeenAt: state.workspaceMessagesSeenAt,
  });
  const existing = state.workspaceConversationSummaries[agent.id];
  if (existing) {
    state.workspaceConversationSummaries = {
      ...state.workspaceConversationSummaries,
      [agent.id]: { ...existing, unread: 0 },
    };
    state.workspaceUnreadTotal = Object.values(state.workspaceConversationSummaries).reduce(
      (total, summary) => total + summary.unread,
      0,
    );
  }
  void state.loadAssistantIdentity();
  void loadChatHistory(state).then(() => {
    state.syncWorkspaceSelectedConversationSummary(
      agent.id,
      agent.description?.trim() || agentTitle(agent),
    );
  });
  void refreshChatAvatar(state);
}

function renderAgentList(
  state: AppViewState & { workspaceMessagesSearch?: string },
  agents: WorkspaceAgentRow[],
  selectedAgentId: string | null,
) {
  const search = getWorkspaceSearch(state).trim().toLowerCase();
  const filtered = search
    ? agents.filter((agent) => {
        const haystack =
          `${agent.name ?? agent.id} ${agent.title ?? ""} ${agent.description ?? ""}`.toLowerCase();
        return haystack.includes(search);
      })
    : agents;
  const sorted = [...filtered].toSorted((a, b) => {
    const sa = state.workspaceConversationSummaries[a.id];
    const sb = state.workspaceConversationSummaries[b.id];
    const ta = sa?.lastActivity ?? 0;
    const tb = sb?.lastActivity ?? 0;
    if (ta !== tb) {
      return tb - ta;
    }
    return (a.name ?? a.id).localeCompare(b.name ?? b.id);
  });
  return html`
    <section class="workspace-msg-list">
      <div class="workspace-msg-list__header card-title">Messages</div>
      <label class="workspace-msg-search field">
        <div class="workspace-msg-search__control">
          <span class="workspace-msg-search__icon">${icons.search}</span>
          <input
            .value=${getWorkspaceSearch(state)}
            @input=${(event: Event) =>
              setWorkspaceSearch(state, (event.target as HTMLInputElement).value)}
            placeholder="Search agents..."
            aria-label="Search agents"
          />
          ${
            getWorkspaceSearch(state).trim()
              ? html`
                <button
                  class="workspace-msg-search__clear"
                  type="button"
                  aria-label="Clear search"
                  title="Clear search"
                  @click=${() => setWorkspaceSearch(state, "")}
                >
                  ${icons.x}
                </button>
              `
              : nothing
          }
        </div>
      </label>

      <div class="workspace-msg-list__items">
        ${sorted.map((agent) => {
          const isSelected = agent.id === selectedAgentId;
          const summary = state.workspaceConversationSummaries[agent.id];
          const preview = summary?.preview || agent.description?.trim() || agentTitle(agent);
          const previewTime = formatMessageTime(summary?.lastActivity ?? 0);
          const previewTimeTitle = formatExactMessageTime(summary?.lastActivity ?? 0);
          const unread = summary?.unread ?? 0;
          const online = summary?.online ?? false;
          const accentStyle = normalizeAgentAccent(agent)
            ? `--workspace-agent-accent: ${normalizeAgentAccent(agent)};`
            : nothing;
          return html`
            <button
              class="workspace-msg-list__item nav-item ${isSelected ? "active is-selected" : ""}"
              @click=${() => selectWorkspaceMessagesAgent(state, agent)}
              type="button"
            >
              <div class="workspace-msg-list__avatar" style=${accentStyle}>
                <span>${agentEmoji(agent)}</span>
                ${
                  online
                    ? html`
                        <span class="workspace-msg-list__presence"></span>
                      `
                    : nothing
                }
              </div>
              <div class="workspace-msg-list__meta">
                <div class="workspace-msg-list__row">
                  <span class="workspace-msg-list__name nav-item__text">${agent.name || agent.id}</span>
                  <span class="workspace-msg-list__time muted" title=${previewTimeTitle}>${previewTime}</span>
                </div>
                <div class="workspace-msg-list__preview muted">${preview}</div>
              </div>
              ${
                unread > 0
                  ? html`<span class="workspace-msg-list__badge nav-item__badge">${unread > 9 ? "9+" : unread}</span>`
                  : nothing
              }
            </button>
          `;
        })}
      </div>
    </section>
  `;
}

export function renderWorkspaceMessagesThread(
  state: AppViewState,
  selectedAgent: WorkspaceAgentRow | null,
) {
  const clearBusy =
    !state.connected || state.chatResetInFlight || state.chatSending || state.chatRunId;
  const sidebarCollapsed = state.settings.workspaceMessagesSidebarCollapsed ?? false;
  const syncChatMentionDraft = (
    next: string,
    selectionStart = next.length,
    selectionEnd = selectionStart,
  ) => {
    state.chatMessage = next;
    const mention = findDraftMentionAtSelection(next, selectionStart, selectionEnd);
    state.chatMentionQuery = mention?.query ?? null;
    state.chatMentionStart = mention?.start ?? null;
    state.chatMentionEnd = mention?.end ?? null;
    state.chatMentionSelectedIndex = 0;
  };
  const mentionSuggestions = buildMentionSuggestions({
    sessionKey: state.sessionKey,
    query: state.chatMentionQuery,
    agents: state.workspaceAgentsList?.agents ?? [],
  });

  const openAgentOverview = () => {
    if (!selectedAgent) {
      return;
    }
    state.agentsSelectedId = selectedAgent.id;
    state.agentsPanel = "overview";
    setTab(state as unknown as Parameters<typeof setTab>[0], "agents");
  };

  const chatProps: ChatProps = {
    sessionKey: state.sessionKey,
    onSessionKeyChange: () => {},
    thinkingLevel: state.chatThinkingLevel,
    showThinking: state.settings.chatShowThinking,
    loading: state.chatLoading,
    sending: state.chatSending,
    canAbort: Boolean(state.chatRunId),
    hideNewSessionButton: true,
    compactionStatus: state.compactionStatus,
    fallbackStatus: state.fallbackStatus,
    messages: state.chatMessages,
    toolMessages: state.chatToolMessages,
    stream: state.chatStream,
    streamStartedAt: state.chatStreamStartedAt,
    assistantAvatarUrl: state.chatAvatarUrl,
    draft: state.chatMessage,
    queue: state.chatQueue,
    connected: state.connected,
    canSend: state.connected,
    disabledReason: state.connected ? null : "Connect to the gateway to start chatting.",
    error: state.lastError,
    sessions: state.sessionsResult,
    focusMode: false,
    assistantName: selectedAgent?.name?.trim() || state.assistantName || "Assistant",
    assistantLabelTooltip: agentMention(selectedAgent),
    assistantAvatar: selectedAgent?.emoji || state.assistantAvatar || null,
    assistantAccent: normalizeAgentAccent(selectedAgent) ?? null,
    agentDirectory: state.workspaceAgentsList?.agents ?? [],
    attachments: state.chatAttachments,
    onAttachmentsChange: (next) => (state.chatAttachments = next),
    showNewMessages: state.chatNewMessagesBelow && !state.chatManualRefreshInFlight,
    onScrollToBottom: () => state.scrollToBottom(),
    onRefresh: () => {
      state.resetToolStream();
      return Promise.all([loadChatHistory(state), refreshChatAvatar(state)]);
    },
    onToggleFocusMode: () => {},
    onDraftChange: syncChatMentionDraft,
    mentionSuggestions,
    mentionSelectedIndex: Math.min(
      state.chatMentionSelectedIndex,
      Math.max(mentionSuggestions.length - 1, 0),
    ),
    mentionRangeStart: state.chatMentionStart,
    mentionRangeEnd: state.chatMentionEnd,
    onMentionHighlight: (nextIndex) => (state.chatMentionSelectedIndex = nextIndex),
    onMentionDismiss: () => {
      state.chatMentionQuery = null;
      state.chatMentionStart = null;
      state.chatMentionEnd = null;
      state.chatMentionSelectedIndex = 0;
    },
    liveToolEventsEnabled: state.chatLiveToolEventsEnabled,
    onToggleLiveToolEvents: () => state.handleToggleLiveToolEvents(),
    shouldEmitToolResult: state.chatShouldEmitToolResult,
    onToggleShouldEmitToolResult: () => state.handleToggleShouldEmitToolResult(),
    shouldEmitToolOutput: state.chatShouldEmitToolOutput,
    onToggleShouldEmitToolOutput: () => state.handleToggleShouldEmitToolOutput(),
    onSend: () => state.handleSendChat(),
    onAbort: () => void state.handleAbortChat(),
    onQueueRemove: (id) => state.removeQueuedMessage(id),
    onQueueEdit: (id) => state.editQueuedMessage(id),
    onNewSession: () => state.handleSendChat("/new", { restoreDraft: true }),
    onOpenSidebar: (content: string) => state.handleOpenSidebar(content),
    onCloseSidebar: () => state.handleCloseSidebar(),
    onSplitRatioChange: (ratio: number) => state.handleSplitRatioChange(ratio),
    onChatScroll: (event) => state.handleChatScroll(event),
    sidebarOpen: state.sidebarOpen,
    sidebarContent: state.sidebarContent,
    sidebarError: state.sidebarError,
    splitRatio: state.splitRatio,
  };

  return html`
    <section class="workspace-msg-thread">
      <header class="workspace-msg-thread__header">
        <button
          class="workspace-msg-thread__agent"
          type="button"
          title="Open agent details"
          @click=${openAgentOverview}
        >
          <div
            class="workspace-msg-thread__avatar"
            style=${
              normalizeAgentAccent(selectedAgent)
                ? `--workspace-agent-accent: ${normalizeAgentAccent(selectedAgent)};`
                : nothing
            }
          >${selectedAgent ? agentEmoji(selectedAgent) : "🤖"}</div>
          <div>
            <div class="workspace-msg-thread__name" title=${agentMention(selectedAgent) || nothing}>
              ${selectedAgent?.name || "Select an agent"}
            </div>
            <div class="workspace-msg-thread__title">
              ${selectedAgent ? agentTitle(selectedAgent) : "Workspace agent"}
            </div>
          </div>
        </button>
        <div class="workspace-msg-thread__actions">
          <button
            class="workspace-msg-thread__icon-btn"
            type="button"
            title=${sidebarCollapsed ? "Expand conversations" : "Collapse conversations"}
            aria-label=${sidebarCollapsed ? "Expand conversations" : "Collapse conversations"}
            @click=${() =>
              state.applySettings({
                ...state.settings,
                workspaceMessagesSidebarCollapsed: !sidebarCollapsed,
              })}
          >
            ${sidebarCollapsed ? icons.chevronRight : icons.chevronLeft}
          </button>
          <button
            class="workspace-msg-thread__icon-btn ${state.settings.chatShowThinking ? "is-active" : ""}"
            type="button"
            title=${state.settings.chatShowThinking ? "Hide thinking" : "Show thinking"}
            aria-label="Toggle thinking visibility"
            aria-pressed=${String(state.settings.chatShowThinking)}
            @click=${() =>
              state.applySettings({
                ...state.settings,
                chatShowThinking: !state.settings.chatShowThinking,
              })}
          >
            ${state.settings.chatShowThinking ? icons.brain : icons.brainOff}
          </button>
          <button
            class="workspace-msg-thread__icon-btn ${state.chatShouldEmitToolOutput ? "is-active" : ""}"
            type="button"
            title=${state.chatShouldEmitToolOutput ? "Hide tools" : "Show tools"}
            aria-label="Toggle tools visibility"
            aria-pressed=${String(state.chatShouldEmitToolOutput)}
            @click=${() => state.handleToggleShouldEmitToolOutput()}
          >
            ${state.chatShouldEmitToolOutput ? icons.wrench : icons.wrenchOff}
          </button>
          <button
            class="workspace-msg-thread__icon-btn"
            type="button"
            title=${clearBusy ? "Clearing conversation…" : "Clear conversation"}
            aria-label=${clearBusy ? "Clearing conversation" : "Clear conversation"}
            ?disabled=${clearBusy}
            @click=${() => void state.handleSendChat("/reset", { restoreDraft: true })}
          >
            <svg viewBox="0 0 24 24"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
          </button>
        </div>
      </header>
      <div class="workspace-msg-thread__chat">${renderChat(chatProps)}</div>
    </section>
  `;
}

export function renderWorkspaceMessagesPage(
  state: AppViewState & {
    workspaceMessagesSearch?: string;
  },
) {
  const agents = state.workspaceAgentsList?.agents ?? [];
  const selectedAgent =
    agents.find((agent) => agent.id === state.workspaceSelectedAgentId) ?? agents[0] ?? null;
  const sidebarCollapsed = state.settings.workspaceMessagesSidebarCollapsed ?? false;

  return html`
    <div class="workspace-msg-page ${sidebarCollapsed ? "is-sidebar-collapsed" : ""}">
      <div class="workspace-msg-page__sidebar">
        ${renderAgentList(state, agents, selectedAgent?.id ?? null)}
      </div>
      ${renderWorkspaceMessagesThread(state, selectedAgent)}
    </div>
  `;
}
