/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import type { AppViewState } from "../ui/app-view-state.ts";
import { extractText } from "../ui/chat/message-extract.ts";

vi.hoisted(() => {
  const data = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      clear() {
        data.clear();
      },
      getItem(key: string) {
        return data.has(key) ? data.get(key)! : null;
      },
      key(index: number) {
        return Array.from(data.keys())[index] ?? null;
      },
      removeItem(key: string) {
        data.delete(key);
      },
      setItem(key: string, value: string) {
        data.set(key, value);
      },
      get length() {
        return data.size;
      },
    } as Storage,
  });
});

const traceUiWsMock = vi.hoisted(() => vi.fn());

vi.mock("../ui/ws-trace.ts", () => ({
  traceUiWs: traceUiWsMock,
}));

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
    toolStreamById: new Map(),
    toolStreamOrder: [],
    chatStream: null,
    chatStreamStartedAt: null,
    chatAvatarUrl: null,
    chatMessage: "",
    chatQueue: [],
    connected: true,
    clientInstanceId: "instance-test",
    tab: "workspace",
    updateComplete: Promise.resolve(),
    chatScrollFrame: null,
    refreshSessionsAfterChat: new Set<string>(),
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
    workspaceConversationSummaries: {},
    workspaceMessagesSeenAt: {},
    scrollToBottom: () => undefined,
    resetChatScroll: () => undefined,
    resetToolStream: () => undefined,
    handleSendChat: (messageOverride?: string, opts?: { restoreDraft?: boolean }) => {
      sendCalls.push({ messageOverride, opts });
      return Promise.resolve();
    },
    handleAbortChat: () => Promise.resolve(),
    sendQueuedMessageNow: () => undefined,
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
    loadAssistantIdentity: () => Promise.resolve(),
    syncWorkspaceSelectedConversationSummary: () => undefined,
    connect: vi.fn(),
    client: { stop: vi.fn() },
  };
  return Object.assign(state, { __sendCalls: sendCalls }) as unknown as AppViewState;
}

function summarizeTranscript(state: AppViewState): string[] {
  return state.chatMessages.map((message) => {
    const role =
      message &&
      typeof message === "object" &&
      typeof (message as { role?: unknown }).role === "string"
        ? String((message as { role: string }).role)
        : "unknown";
    return `${role}:${extractText(message) ?? ""}`;
  });
}

async function loadWorkspaceMessagesModule() {
  return import("./messages-page.ts");
}

async function loadChatControllerModule() {
  return import("../ui/controllers/chat.ts");
}

async function loadAppChatModule() {
  return import("../ui/app-chat.ts");
}

async function loadLitModule() {
  return import("lit");
}

describe("workspace messages thread", () => {
  it("does not render the composer live events toggle button", () => {
    const container = document.createElement("div");
    const state = createState();
    const selectedAgent = { id: "test", name: "Test agent", title: "Test title" };

    return Promise.all([loadLitModule(), loadWorkspaceMessagesModule()]).then(
      ([{ render }, { renderWorkspaceMessagesThread }]) => {
        render(renderWorkspaceMessagesThread(state, selectedAgent), container);
        const toggle = container.querySelector<HTMLButtonElement>(".chat-compose__stream-toggle");
        expect(toggle).toBeNull();
      },
    );
  });

  it("dispatches /reset and disables clear while reset is in flight", async () => {
    const container = document.createElement("div");
    const state = createState() as AppViewState & {
      __sendCalls: Array<{ messageOverride?: string; opts?: { restoreDraft?: boolean } }>;
      chatResetInFlight: boolean;
    };
    const selectedAgent = { id: "test", name: "Test agent", title: "Test title" };

    const [{ render }, { renderWorkspaceMessagesThread }] = await Promise.all([
      loadLitModule(),
      loadWorkspaceMessagesModule(),
    ]);
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

    return Promise.all([loadLitModule(), loadWorkspaceMessagesModule()]).then(
      ([{ render }, { renderWorkspaceMessagesThread }]) => {
        render(renderWorkspaceMessagesThread(state, selectedAgent), container);
        expect(container.querySelector(".chat-runtime-toggles")).toBeNull();
        expect(
          container.querySelector<HTMLButtonElement>(
            '.workspace-msg-thread__icon-btn[title="Hide thinking"]',
          ),
        ).not.toBeNull();
        expect(container.querySelector(".workspace-msg-thread__icon-btn.is-active")).not.toBeNull();
      },
    );
  });

  it("shows the selected agent name and keeps the agent id in hover text", async () => {
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

    const [{ render }, { renderWorkspaceMessagesThread }] = await Promise.all([
      loadLitModule(),
      loadWorkspaceMessagesModule(),
    ]);
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

  it("toggles the workspace conversations sidebar state", async () => {
    const container = document.createElement("div");
    const state = createState();
    const selectedAgent = { id: "test", name: "Test agent", title: "Test title" };

    const [{ render }, { renderWorkspaceMessagesThread }] = await Promise.all([
      loadLitModule(),
      loadWorkspaceMessagesModule(),
    ]);
    render(renderWorkspaceMessagesThread(state, selectedAgent), container);
    const collapseButton = container.querySelector<HTMLButtonElement>(
      '.workspace-msg-thread__icon-btn[title="Collapse conversations"]',
    );
    collapseButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(state.settings.workspaceMessagesSidebarCollapsed).toBe(true);
  });

  it("switches workspace agents without reconnecting the gateway client", async () => {
    const state = createState() as AppViewState & {
      client: { stop: ReturnType<typeof vi.fn> };
      connect: ReturnType<typeof vi.fn>;
    };
    const { selectWorkspaceMessagesAgent } = await loadWorkspaceMessagesModule();

    selectWorkspaceMessagesAgent(state, { id: "backend_engineer", name: "Backend Engineer" });

    expect(state.sessionKey).toBe("agent:backend_engineer:clawport");
    expect(state.client.stop).not.toHaveBeenCalled();
    expect(state.connect).not.toHaveBeenCalled();
    expect(traceUiWsMock).toHaveBeenCalledWith(
      expect.objectContaining({ event: "workspace-messages.selectAgent" }),
    );
  });

  it("runs the workspace /reset -> stop -> refresh loop as plain text rows", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("1970-01-01T00:00:00.015Z"));

    const container = document.createElement("div");
    const effectiveUserMessage =
      "A new session was started via /new or /reset. Execute your Session Startup sequence now.";
    let historyResponse: unknown = {
      messages: [],
      queuedMessages: [],
      toolInvocations: [],
      activeRun: null,
    };
    const request = vi.fn().mockImplementation(async (method: string) => {
      if (method === "chat.send") {
        return {
          runId: "run-reset",
          status: "started",
          effectiveUserMessage,
        };
      }
      if (method === "chat.abort") {
        return { aborted: true, runIds: ["run-reset"] };
      }
      if (method === "chat.history") {
        return historyResponse;
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const state = createState() as AppViewState & {
      client: { request: typeof request; stop: ReturnType<typeof vi.fn> };
      handleSendChat: (
        messageOverride?: string,
        opts?: { restoreDraft?: boolean },
      ) => Promise<void>;
      handleAbortChat: () => Promise<void>;
    };
    state.client = { request, stop: vi.fn() } as unknown as AppViewState["client"];
    const { handleAbortChat, handleSendChat } = await loadAppChatModule();
    state.handleSendChat = async (messageOverride?: string, opts?: { restoreDraft?: boolean }) => {
      await handleSendChat(state as Parameters<typeof handleSendChat>[0], messageOverride, opts);
    };
    state.handleAbortChat = async () => {
      await handleAbortChat(state as Parameters<typeof handleAbortChat>[0]);
    };
    const selectedAgent = {
      id: "developer_lead",
      name: "Developer Lead",
      title: "Lead",
    };

    const [{ render }, { renderWorkspaceMessagesThread }] = await Promise.all([
      loadLitModule(),
      loadWorkspaceMessagesModule(),
    ]);
    const { handleChatEvent, loadChatHistory } = await loadChatControllerModule();
    render(renderWorkspaceMessagesThread(state, selectedAgent), container);
    const clearButton = container.querySelector<HTMLButtonElement>(
      '.workspace-msg-thread__icon-btn[title="Clear conversation"]',
    );
    clearButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();

    expect(summarizeTranscript(state)).toEqual(["user:/reset", `system:${effectiveUserMessage}`]);

    handleChatEvent(state, {
      runId: "run-reset",
      sessionKey: state.sessionKey,
      state: "delta",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "I'm ready to help!" }],
        timestamp: 30,
      },
    });
    handleChatEvent(state, {
      runId: "run-reset",
      sessionKey: state.sessionKey,
      state: "phase",
      phase: "tool_running",
    });

    expect(summarizeTranscript(state)).toEqual([
      "user:/reset",
      `system:${effectiveUserMessage}`,
      "assistant:I'm ready to help!",
    ]);

    await state.handleAbortChat();
    handleChatEvent(state, {
      runId: "run-reset",
      sessionKey: state.sessionKey,
      state: "aborted",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "I'm ready to help! persona." }],
        timestamp: 40,
        idempotencyKey: "run-reset:assistant",
      },
    });

    const liveSummary = summarizeTranscript(state);
    expect(liveSummary).toEqual([
      "user:/reset",
      `system:${effectiveUserMessage}`,
      "assistant:I'm ready to help!",
      "assistant:persona.",
    ]);

    historyResponse = {
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "/reset" }],
          timestamp: 10,
        },
        {
          role: "system",
          content: [{ type: "text", text: effectiveUserMessage }],
          timestamp: 20,
          idempotencyKey: "run-reset:effective-user-message",
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "I'm ready to help!" }],
          timestamp: 30,
          runId: "run-reset",
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "persona." }],
          timestamp: 40,
          runId: "run-reset",
          idempotencyKey: "run-reset:assistant",
        },
      ],
      queuedMessages: [],
      toolInvocations: [],
      activeRun: null,
    };

    await loadChatHistory(state);

    expect(summarizeTranscript(state)).toEqual(liveSummary);
    vi.useRealTimers();
  });
});
