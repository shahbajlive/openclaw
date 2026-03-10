import { render } from "lit";
import { describe, expect, it } from "vitest";
import type { AppViewState } from "../ui/app-view-state.ts";
import { renderWorkspaceMessagesThread } from "./messages-page.ts";

function createState(): AppViewState {
  const sendCalls: Array<{ messageOverride?: string; opts?: { restoreDraft?: boolean } }> = [];
  const state = {
    sessionKey: "agent:test:clawport",
    chatThinkingLevel: null,
    chatLoading: false,
    chatSending: false,
    chatResetInFlight: false,
    chatRunId: null,
    compactionStatus: null,
    fallbackStatus: null,
    chatMessages: [],
    chatToolMessages: [],
    chatStream: null,
    chatStreamStartedAt: null,
    chatAvatarUrl: null,
    chatMessage: "",
    chatQueue: [],
    connected: true,
    lastError: null,
    sessionsResult: null,
    assistantName: "OpenClaw",
    assistantAvatar: null,
    settings: {
      chatShowThinking: true,
      workspaceMessagesSidebarCollapsed: false,
    },
    chatAttachments: [],
    chatNewMessagesBelow: false,
    chatManualRefreshInFlight: false,
    scrollToBottom: () => undefined,
    resetToolStream: () => undefined,
    handleSendChat: (messageOverride?: string, opts?: { restoreDraft?: boolean }) => {
      sendCalls.push({ messageOverride, opts });
      return Promise.resolve();
    },
    handleAbortChat: () => Promise.resolve(),
    removeQueuedMessage: () => undefined,
    editQueuedMessage: () => undefined,
    handleOpenSidebar: () => undefined,
    handleCloseSidebar: () => undefined,
    handleSplitRatioChange: () => undefined,
    handleChatScroll: () => undefined,
    sidebarOpen: false,
    sidebarContent: null,
    sidebarError: null,
    splitRatio: 0.6,
    chatLiveToolEventsEnabled: false,
    chatShouldEmitToolResult: true,
    chatShouldEmitToolOutput: true,
    handleToggleLiveToolEvents: () => {
      state.chatLiveToolEventsEnabled = !state.chatLiveToolEventsEnabled;
    },
    handleToggleShouldEmitToolResult: () => {
      state.chatShouldEmitToolResult = !state.chatShouldEmitToolResult;
      if (!state.chatShouldEmitToolResult) {
        state.chatShouldEmitToolOutput = false;
      }
    },
    handleToggleShouldEmitToolOutput: () => {
      state.chatShouldEmitToolOutput = !state.chatShouldEmitToolOutput;
      if (state.chatShouldEmitToolOutput) {
        state.chatShouldEmitToolResult = true;
      }
    },
    applySettings: (next: AppViewState["settings"]) => {
      state.settings = next;
    },
  };
  return Object.assign(state, { __sendCalls: sendCalls }) as unknown as AppViewState;
}

describe("workspace messages thread", () => {
  it("does not render the composer live events toggle button", () => {
    const container = document.createElement("div");
    const state = createState();
    const selectedAgent = { id: "test", name: "Test agent", title: "Test title" };

    render(renderWorkspaceMessagesThread(state, selectedAgent), container);
    const toggle = container.querySelector<HTMLButtonElement>(".chat-compose__stream-toggle");
    expect(toggle).toBeNull();
  });

  it("dispatches /reset and disables clear while reset is in flight", () => {
    const container = document.createElement("div");
    const state = createState() as AppViewState & {
      __sendCalls: Array<{ messageOverride?: string; opts?: { restoreDraft?: boolean } }>;
      chatResetInFlight: boolean;
    };
    const selectedAgent = { id: "test", name: "Test agent", title: "Test title" };

    render(renderWorkspaceMessagesThread(state, selectedAgent), container);
    const clearButton = container.querySelector<HTMLButtonElement>(
      '.workspace-msg-thread__icon-btn[title="Clear conversation"]',
    );
    expect(clearButton).not.toBeNull();

    clearButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(state.__sendCalls).toEqual([
      { messageOverride: "/reset", opts: { restoreDraft: true } },
    ]);

    state.chatResetInFlight = true;
    render(renderWorkspaceMessagesThread(state, selectedAgent), container);
    const disabledClearButton = container.querySelector<HTMLButtonElement>(
      '.workspace-msg-thread__icon-btn[title="Clearing conversation…"]',
    );
    expect(disabledClearButton?.disabled).toBe(true);
  });

  it("hides duplicate runtime toggles above the composer in workspace view", () => {
    const container = document.createElement("div");
    const state = createState();
    const selectedAgent = { id: "test", name: "Test agent", title: "Test title" };

    render(renderWorkspaceMessagesThread(state, selectedAgent), container);
    expect(container.querySelector(".chat-runtime-toggles")).toBeNull();
    expect(
      container.querySelector<HTMLButtonElement>(
        '.workspace-msg-thread__icon-btn[title="Hide thinking"]',
      ),
    ).not.toBeNull();
    expect(container.querySelector(".workspace-msg-thread__icon-btn.is-active")).not.toBeNull();
  });

  it("shows the selected agent name and keeps the agent id in hover text", () => {
    const container = document.createElement("div");
    const state = createState();
    state.chatMessages = [
      {
        role: "assistant",
        content: [{ type: "text", text: "I can help with that." }],
        timestamp: 1_000,
      },
    ];
    const selectedAgent = { id: "developer_lead", name: "Developer Lead", title: "Lead" };

    render(renderWorkspaceMessagesThread(state, selectedAgent), container);

    expect(container.querySelector(".workspace-msg-thread__name")?.textContent).toContain(
      "Developer Lead",
    );
    expect(container.querySelector(".workspace-msg-thread__title")?.textContent).toContain("Lead");
    expect(container.querySelector(".workspace-msg-thread__title")?.textContent).not.toContain("@");
    expect(container.querySelector(".chat-sender-name")?.textContent).toContain("Developer Lead");
    expect(container.querySelector(".chat-sender-name")?.textContent).not.toContain("@");
    expect(container.querySelector(".workspace-msg-thread__name")?.getAttribute("title")).toBe(
      "@developer_lead",
    );
    expect(container.querySelector(".chat-sender-name")?.getAttribute("title")).toBe(
      "@developer_lead",
    );
  });

  it("toggles the workspace conversations sidebar state", () => {
    const container = document.createElement("div");
    const state = createState();
    const selectedAgent = { id: "test", name: "Test agent", title: "Test title" };

    render(renderWorkspaceMessagesThread(state, selectedAgent), container);
    const collapseButton = container.querySelector<HTMLButtonElement>(
      '.workspace-msg-thread__icon-btn[title="Collapse conversations"]',
    );
    collapseButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(state.settings.workspaceMessagesSidebarCollapsed).toBe(true);
  });
});
