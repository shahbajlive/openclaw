import { describe, expect, it, vi } from "vitest";
import {
  enqueueChatMessage,
  handleChatEvent,
  handleChatQueueChangedEvent,
  loadChatHistory,
  sendChatMessage,
  type ChatEventPayload,
  type ChatState,
} from "./chat.ts";

function createState(overrides: Partial<ChatState> = {}): ChatState {
  return {
    chatAttachments: [],
    chatLoading: false,
    chatMessage: "",
    chatMessages: [],
    chatQueue: [],
    chatQueueRequestInFlight: false,
    chatToolMessages: [],
    chatRunId: null,
    chatRunPhase: null,
    chatResetInFlight: false,
    chatSending: false,
    chatStream: null,
    chatStreamStartedAt: null,
    chatStreamCommittedPrefixLength: 0,
    chatThinkingLevel: null,
    client: null,
    connected: true,
    lastError: null,
    sessionKey: "main",
    ...overrides,
  };
}

describe("handleChatEvent", () => {
  it("returns null when payload is missing", () => {
    const state = createState();
    expect(handleChatEvent(state, undefined)).toBe(null);
  });

  it("returns null when sessionKey does not match", () => {
    const state = createState({ sessionKey: "main" });
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "other",
      state: "final",
    };
    expect(handleChatEvent(state, payload)).toBe(null);
  });

  it("accepts a queued started event when queue item matches even if sessionKey differs", () => {
    const state = createState({
      sessionKey: "main",
      chatQueue: [{ id: "queued-1", text: "follow up", createdAt: 1, source: "backend" }],
    });

    expect(
      handleChatEvent(state, {
        runId: "run-queued",
        sessionKey: "agent:main:main",
        state: "started",
        source: "queue",
        queueItemId: "queued-1",
      }),
    ).toBe("started");

    expect(state.chatRunId).toBe("run-queued");
    expect(state.chatRunPhase).toBe("processing");
    expect(state.chatQueue).toEqual([]);
    expect(state.chatMessages).toEqual([expect.objectContaining({ idempotencyKey: "queued-1" })]);
  });

  it("returns null for delta from another run", () => {
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-user",
      chatStream: "Hello",
    });
    const payload: ChatEventPayload = {
      runId: "run-announce",
      sessionKey: "main",
      state: "delta",
      message: { role: "assistant", content: [{ type: "text", text: "Done" }] },
    };
    expect(handleChatEvent(state, payload)).toBe(null);
    expect(state.chatRunId).toBe("run-user");
    expect(state.chatStream).toBe("Hello");
  });

  it("ignores NO_REPLY delta updates", () => {
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatStream: "Hello",
    });
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "main",
      state: "delta",
      message: { role: "assistant", content: [{ type: "text", text: "NO_REPLY" }] },
    };

    expect(handleChatEvent(state, payload)).toBe("delta");
    expect(state.chatRunPhase).toBe("typing");
    expect(state.chatStream).toBe("Hello");
  });

  it("updates the active run phase from explicit phase events", () => {
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatRunPhase: "typing",
      chatStream: "Hello",
    });

    expect(
      handleChatEvent(state, {
        runId: "run-1",
        sessionKey: "main",
        state: "phase",
        phase: "processing",
      }),
    ).toBe("phase");

    expect(state.chatRunPhase).toBe("processing");
    expect(state.chatStream).toBeNull();
    expect(state.chatMessages).toContainEqual(
      expect.objectContaining({
        role: "assistant",
        content: [{ type: "text", text: "Hello" }],
      }),
    );
  });

  it("coalesces duplicate assistant finals without idempotency keys", () => {
    const state = createState({
      chatMessages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "Hey! I'm Developer Lead." }],
          timestamp: 1_000,
        },
      ],
    });

    expect(
      handleChatEvent(state, {
        runId: "run-1",
        sessionKey: "main",
        state: "final",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Hey! I'm Developer Lead." }],
          timestamp: 1_005,
        },
      }),
    ).toBe("final");

    expect(state.chatMessages).toHaveLength(1);
    expect((state.chatMessages[0] as { timestamp?: number }).timestamp).toBe(1_005);
  });

  it("supports thinking and finalizing phases from backend events", () => {
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatRunPhase: "processing",
    });

    expect(
      handleChatEvent(state, {
        runId: "run-1",
        sessionKey: "main",
        state: "phase",
        phase: "thinking",
      }),
    ).toBe("phase");
    expect(state.chatRunPhase).toBe("thinking");

    expect(
      handleChatEvent(state, {
        runId: "run-1",
        sessionKey: "main",
        state: "phase",
        phase: "finalizing",
      }),
    ).toBe("phase");
    expect(state.chatRunPhase).toBe("finalizing");
  });

  it("rehydrates non-typing active-run text as a committed assistant bubble", async () => {
    const request = vi.fn().mockResolvedValue({
      messages: [],
      toolInvocations: [],
      queuedMessages: [],
      activeRun: {
        runId: "run-1",
        streamText: "I'm ready to help!",
        startedAtMs: 100,
        phase: "tool_running",
      },
    });
    const state = createState({
      client: { request } as unknown as ChatState["client"],
    });

    await loadChatHistory(state);

    expect(state.chatRunId).toBe("run-1");
    expect(state.chatRunPhase).toBe("tool_running");
    expect(state.chatStream).toBeNull();
    expect(state.chatMessages).toContainEqual(
      expect.objectContaining({
        role: "assistant",
        content: [{ type: "text", text: "I'm ready to help!" }],
        timestamp: 100,
        runId: "run-1",
      }),
    );
  });

  it("appends streamed suffix deltas to the visible assistant text", () => {
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatStream: "Hello",
      chatStreamCommittedPrefixLength: 5,
    });
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "main",
      state: "delta",
      message: { role: "assistant", content: [{ type: "text", text: " world" }] },
    };

    expect(handleChatEvent(state, payload)).toBe("delta");
    expect(state.chatStream).toBe("Hello world");
  });

  it("ignores duplicate streamed suffix deltas", () => {
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatStream: "Hello world",
    });

    expect(
      handleChatEvent(state, {
        runId: "run-1",
        sessionKey: "main",
        state: "delta",
        message: { role: "assistant", content: [{ type: "text", text: " world" }] },
      }),
    ).toBe("delta");

    expect(state.chatStream).toBe("Hello world");
  });

  it("appends final payload from another run without clearing active stream", () => {
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-user",
      chatStream: "Working...",
      chatStreamStartedAt: 123,
    });
    const payload: ChatEventPayload = {
      runId: "run-announce",
      sessionKey: "main",
      state: "final",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Sub-agent findings" }],
      },
    };
    expect(handleChatEvent(state, payload)).toBe(null);
    expect(state.chatRunId).toBe("run-user");
    expect(state.chatStream).toBe("Working...");
    expect(state.chatStreamStartedAt).toBe(123);
    expect(state.chatMessages).toHaveLength(1);
    expect(state.chatMessages[0]).toEqual(payload.message);
  });

  it("drops NO_REPLY final payload from another run without clearing active stream", () => {
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-user",
      chatStream: "Working...",
      chatStreamStartedAt: 123,
    });
    const payload: ChatEventPayload = {
      runId: "run-announce",
      sessionKey: "main",
      state: "final",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "NO_REPLY" }],
      },
    };

    expect(handleChatEvent(state, payload)).toBe("final");
    expect(state.chatRunId).toBe("run-user");
    expect(state.chatStream).toBe("Working...");
    expect(state.chatStreamStartedAt).toBe(123);
    expect(state.chatMessages).toEqual([]);
  });

  it("returns final for another run when payload has no message", () => {
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-user",
      chatStream: "Working...",
      chatStreamStartedAt: 123,
    });
    const payload: ChatEventPayload = {
      runId: "run-announce",
      sessionKey: "main",
      state: "final",
    };
    expect(handleChatEvent(state, payload)).toBe("final");
    expect(state.chatRunId).toBe("run-user");
    expect(state.chatMessages).toEqual([]);
  });

  it("persists streamed text when final event carries no message", () => {
    const existingMessage = {
      role: "user",
      content: [{ type: "text", text: "Hi" }],
      timestamp: 1,
    };
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatStream: "Here is my reply",
      chatStreamStartedAt: 100,
      chatMessages: [existingMessage],
    });
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "main",
      state: "final",
    };
    expect(handleChatEvent(state, payload)).toBe("final");
    expect(state.chatRunId).toBe(null);
    expect(state.chatStream).toBe(null);
    expect(state.chatStreamStartedAt).toBe(null);
    expect(state.chatMessages).toHaveLength(2);
    expect(state.chatMessages[0]).toEqual(existingMessage);
    expect(state.chatMessages[1]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "Here is my reply" }],
    });
  });

  it("persists only the uncommitted final suffix after a tool split", () => {
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatStream: "",
      chatStreamStartedAt: 200,
      chatStreamCommittedPrefixLength: "Before tool call".length,
      chatMessages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "Before tool call" }],
          timestamp: 100,
        },
      ],
    });
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "main",
      state: "final",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Before tool call\nAfter tool call" }],
        timestamp: 300,
      },
    };

    expect(handleChatEvent(state, payload)).toBe("final");
    expect(state.chatMessages).toHaveLength(2);
    expect(state.chatMessages[1]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "\nAfter tool call" }],
      timestamp: 300,
      runId: "run-1",
    });
  });

  it("does not persist empty or whitespace-only stream on final", () => {
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatStream: "   ",
      chatStreamStartedAt: 100,
    });
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "main",
      state: "final",
    };
    expect(handleChatEvent(state, payload)).toBe("final");
    expect(state.chatRunId).toBe(null);
    expect(state.chatStream).toBe(null);
    expect(state.chatMessages).toEqual([]);
  });

  it("does not persist null stream on final with no message", () => {
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatStream: null,
      chatStreamStartedAt: 100,
    });
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "main",
      state: "final",
    };
    expect(handleChatEvent(state, payload)).toBe("final");
    expect(state.chatMessages).toEqual([]);
  });

  it("prefers final payload message over streamed text", () => {
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatStream: "Streamed partial",
      chatStreamStartedAt: 100,
    });
    const finalMsg = {
      role: "assistant",
      content: [{ type: "text", text: "Complete reply" }],
      timestamp: 101,
    };
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "main",
      state: "final",
      message: finalMsg,
    };
    expect(handleChatEvent(state, payload)).toBe("final");
    expect(state.chatMessages).toEqual([finalMsg]);
    expect(state.chatStream).toBe(null);
  });

  it("appends final payload message from own run before clearing stream state", () => {
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatStream: "Reply",
      chatStreamStartedAt: 100,
    });
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "main",
      state: "final",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Reply" }],
        timestamp: 101,
      },
    };
    expect(handleChatEvent(state, payload)).toBe("final");
    expect(state.chatMessages).toEqual([payload.message]);
    expect(state.chatRunId).toBe(null);
    expect(state.chatStream).toBe(null);
    expect(state.chatStreamStartedAt).toBe(null);
  });

  it("processes aborted from own run and keeps partial assistant message", () => {
    const existingMessage = {
      role: "user",
      content: [{ type: "text", text: "Hi" }],
      timestamp: 1,
    };
    const partialMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Partial reply" }],
      timestamp: 2,
    };
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatStream: "Partial reply",
      chatStreamStartedAt: 100,
      chatMessages: [existingMessage],
    });
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "main",
      state: "aborted",
      message: partialMessage,
    };

    expect(handleChatEvent(state, payload)).toBe("aborted");
    expect(state.chatRunId).toBe(null);
    expect(state.chatStream).toBe(null);
    expect(state.chatStreamStartedAt).toBe(null);
    expect(state.chatMessages).toEqual([existingMessage, partialMessage]);
  });

  it("falls back to streamed partial when aborted payload message is invalid", () => {
    const existingMessage = {
      role: "user",
      content: [{ type: "text", text: "Hi" }],
      timestamp: 1,
    };
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatStream: "Partial reply",
      chatStreamStartedAt: 100,
      chatMessages: [existingMessage],
    });
    const payload = {
      runId: "run-1",
      sessionKey: "main",
      state: "aborted",
      message: "not-an-assistant-message",
    } as unknown as ChatEventPayload;

    expect(handleChatEvent(state, payload)).toBe("aborted");
    expect(state.chatRunId).toBe(null);
    expect(state.chatStream).toBe(null);
    expect(state.chatStreamStartedAt).toBe(null);
    expect(state.chatMessages).toHaveLength(2);
    expect(state.chatMessages[0]).toEqual(existingMessage);
    expect(state.chatMessages[1]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "Partial reply" }],
    });
  });

  it("falls back to streamed partial when aborted payload has non-assistant role", () => {
    const existingMessage = {
      role: "user",
      content: [{ type: "text", text: "Hi" }],
      timestamp: 1,
    };
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatStream: "Partial reply",
      chatStreamStartedAt: 100,
      chatMessages: [existingMessage],
    });
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "main",
      state: "aborted",
      message: {
        role: "user",
        content: [{ type: "text", text: "unexpected" }],
      },
    };

    expect(handleChatEvent(state, payload)).toBe("aborted");
    expect(state.chatMessages).toHaveLength(2);
    expect(state.chatMessages[1]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "Partial reply" }],
    });
  });

  it("processes aborted from own run without message and empty stream", () => {
    const existingMessage = {
      role: "user",
      content: [{ type: "text", text: "Hi" }],
      timestamp: 1,
    };
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatStream: "",
      chatStreamStartedAt: 100,
      chatMessages: [existingMessage],
    });
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "main",
      state: "aborted",
    };

    expect(handleChatEvent(state, payload)).toBe("aborted");
    expect(state.chatRunId).toBe(null);
    expect(state.chatStream).toBe(null);
    expect(state.chatStreamStartedAt).toBe(null);
    expect(state.chatMessages).toEqual([existingMessage]);
  });

  it("drops NO_REPLY final payload from another run", () => {
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-user",
      chatStream: "Working...",
      chatStreamStartedAt: 123,
    });
    const payload: ChatEventPayload = {
      runId: "run-announce",
      sessionKey: "main",
      state: "final",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "NO_REPLY" }],
      },
    };

    expect(handleChatEvent(state, payload)).toBe("final");
    expect(state.chatMessages).toEqual([]);
    expect(state.chatRunId).toBe("run-user");
    expect(state.chatStream).toBe("Working...");
  });

  it("drops NO_REPLY final payload from own run", () => {
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatStream: "NO_REPLY",
      chatStreamStartedAt: 100,
    });
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "main",
      state: "final",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "NO_REPLY" }],
      },
    };

    expect(handleChatEvent(state, payload)).toBe("final");
    expect(state.chatMessages).toEqual([]);
    expect(state.chatRunId).toBe(null);
    expect(state.chatStream).toBe(null);
  });

  it("does not persist NO_REPLY stream text on final without message", () => {
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatStream: "NO_REPLY",
      chatStreamStartedAt: 100,
    });
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "main",
      state: "final",
    };

    expect(handleChatEvent(state, payload)).toBe("final");
    expect(state.chatMessages).toEqual([]);
  });

  it("does not persist NO_REPLY stream text on abort", () => {
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatStream: "NO_REPLY",
      chatStreamStartedAt: 100,
    });
    const payload = {
      runId: "run-1",
      sessionKey: "main",
      state: "aborted",
      message: "not-an-assistant-message",
    } as unknown as ChatEventPayload;

    expect(handleChatEvent(state, payload)).toBe("aborted");
    expect(state.chatMessages).toEqual([]);
  });

  it("keeps user messages containing NO_REPLY text", () => {
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-user",
      chatStream: "Working...",
      chatStreamStartedAt: 123,
    });
    const payload: ChatEventPayload = {
      runId: "run-announce",
      sessionKey: "main",
      state: "final",
      message: {
        role: "user",
        content: [{ type: "text", text: "NO_REPLY" }],
      },
    };

    // User messages with NO_REPLY text should NOT be filtered — only assistant messages.
    // normalizeFinalAssistantMessage returns null for user role, so this falls through.
    expect(handleChatEvent(state, payload)).toBe("final");
  });

  it("keeps assistant message when text field has real reply but content is NO_REPLY", () => {
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatStream: "",
      chatStreamStartedAt: 100,
    });
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "main",
      state: "final",
      message: {
        role: "assistant",
        text: "real reply",
        content: "NO_REPLY",
      },
    };

    // entry.text takes precedence — "real reply" is NOT silent, so the message is kept.
    expect(handleChatEvent(state, payload)).toBe("final");
    expect(state.chatMessages).toHaveLength(1);
  });
});

describe("loadChatHistory", () => {
  it("filters NO_REPLY assistant messages from history", async () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "Hello" }] },
      { role: "assistant", content: [{ type: "text", text: "NO_REPLY" }] },
      { role: "assistant", content: [{ type: "text", text: "Real answer" }] },
      { role: "assistant", text: "  NO_REPLY  " },
    ];
    const mockClient = {
      request: vi.fn().mockResolvedValue({ messages, thinkingLevel: "low" }),
    };
    const state = createState({
      client: mockClient as unknown as ChatState["client"],
      connected: true,
    });

    await loadChatHistory(state);

    expect(state.chatMessages).toHaveLength(2);
    expect(state.chatMessages[0]).toEqual(messages[0]);
    expect(state.chatMessages[1]).toEqual(messages[2]);
    expect(state.chatThinkingLevel).toBe("low");
    expect(state.chatLoading).toBe(false);
  });

  it("keeps assistant message when text field has real content but content is NO_REPLY", async () => {
    const messages = [{ role: "assistant", text: "real reply", content: "NO_REPLY" }];
    const mockClient = {
      request: vi.fn().mockResolvedValue({ messages }),
    };
    const state = createState({
      client: mockClient as unknown as ChatState["client"],
      connected: true,
    });

    await loadChatHistory(state);

    // text takes precedence — "real reply" is NOT silent, so message is kept.
    expect(state.chatMessages).toHaveLength(1);
  });
});

describe("event-first history hydration", () => {
  it("hydrates canonical tool invocations and active run stream from chat.history", async () => {
    const request = vi.fn().mockResolvedValue({
      messages: [{ role: "assistant", content: [{ type: "text", text: "Working..." }] }],
      toolInvocations: [
        {
          message: {
            role: "assistant",
            toolCallId: "call-1",
            content: [
              { type: "toolcall", name: "discover_teammates", arguments: {} },
              { type: "toolresult", name: "discover_teammates", text: "Found 3 teammates." },
            ],
            __openclaw: { canonicalToolInvocation: true },
            timestamp: 100,
          },
        },
      ],
      activeRun: { runId: "run-1", streamText: "", startedAtMs: 1234, phase: "thinking" },
      thinkingLevel: "low",
    });
    const state = createState({
      connected: true,
      client: { request } as unknown as ChatState["client"],
    });

    await loadChatHistory(state);

    expect(state.chatMessages).toHaveLength(1);
    expect(state.chatToolMessages).toHaveLength(1);
    expect(state.chatRunId).toBe("run-1");
    expect(state.chatRunPhase).toBe("thinking");
    expect(state.chatStream).toBeNull();
    expect(state.chatStreamStartedAt).toBeNull();
  });

  it("preserves queued live tool rows when chat.history hydrates stale tool invocations", async () => {
    const request = vi.fn().mockResolvedValue({
      messages: [],
      toolInvocations: [],
      activeRun: { runId: "run-1", streamText: "", startedAtMs: 1234, phase: "tool_running" },
    });
    const liveToolMessage = {
      role: "assistant",
      toolCallId: "call-live-1",
      runId: "run-1",
      sessionKey: "main",
      content: [
        { type: "toolcall", name: "read", arguments: { path: "README.md" } },
        { type: "toolresult", name: "read", text: "content" },
      ],
      timestamp: 100,
    };
    const state = createState({
      connected: true,
      client: { request } as unknown as ChatState["client"],
      chatToolMessages: [liveToolMessage],
    });

    await loadChatHistory(state);

    expect(state.chatToolMessages).toEqual([liveToolMessage]);
  });

  it("hydrates queued items into queue state without adding transcript rows", async () => {
    const request = vi.fn().mockResolvedValue({
      messages: [],
      queuedMessages: [{ id: "queued-1", text: "follow up later", createdAt: 10 }],
      toolInvocations: [],
      activeRun: null,
    });
    const state = createState({
      connected: true,
      client: { request } as unknown as ChatState["client"],
    });

    await loadChatHistory(state);

    expect(state.chatMessages).toEqual([]);
    expect(state.chatQueue).toEqual([
      expect.objectContaining({ id: "queued-1", text: "follow up later", source: "backend" }),
    ]);
  });

  it("preserves pre-start processing state across refresh when history has no active run yet", async () => {
    const request = vi.fn().mockResolvedValue({
      messages: [],
      queuedMessages: [],
      toolInvocations: [],
      activeRun: null,
    });
    const state = createState({
      connected: true,
      client: { request } as unknown as ChatState["client"],
      chatSending: true,
      chatStreamStartedAt: 1234,
    });

    await loadChatHistory(state);

    expect(state.chatSending).toBe(true);
    expect(state.chatRunId).toBeNull();
    expect(state.chatStream).toBeNull();
    expect(state.chatStreamStartedAt).toBe(1234);
  });

  it("clears stale reset-in-flight state when history shows the known run is gone", async () => {
    const request = vi.fn().mockResolvedValue({
      messages: [],
      queuedMessages: [],
      toolInvocations: [],
      activeRun: null,
    });
    const state = createState({
      connected: true,
      client: { request } as unknown as ChatState["client"],
      chatRunId: "run-reset-stale",
      chatResetInFlight: true,
      chatSending: false,
    });

    await loadChatHistory(state);

    expect(state.chatRunId).toBeNull();
    expect(state.chatResetInFlight).toBe(false);
  });

  it("filters queued user rows out of transcript hydration when the same item is still queued", async () => {
    const request = vi.fn().mockResolvedValue({
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "I'm Developer Lead..." }],
          timestamp: 5,
        },
        {
          role: "user",
          content: [{ type: "text", text: "retry" }],
          timestamp: 10,
          idempotencyKey: "queued-1",
          queued: true,
        },
      ],
      queuedMessages: [{ id: "queued-1", text: "retry", createdAt: 10 }],
      toolInvocations: [],
      activeRun: null,
    });
    const state = createState({
      connected: true,
      client: { request } as unknown as ChatState["client"],
    });

    await loadChatHistory(state);

    expect(state.chatMessages).toEqual([
      expect.objectContaining({
        role: "assistant",
        content: [{ type: "text", text: "I'm Developer Lead..." }],
      }),
    ]);
    expect(state.chatQueue).toEqual([
      expect.objectContaining({ id: "queued-1", text: "retry", source: "backend" }),
    ]);
  });

  it("keeps bare /reset row visible while hydrating an in-flight active run", async () => {
    const request = vi.fn().mockResolvedValue({
      messages: [{ role: "user", content: [{ type: "text", text: "/reset" }], timestamp: 10 }],
      toolInvocations: [],
      activeRun: {
        runId: "run-reset",
        streamText: "",
        startedAtMs: 20,
      },
    });
    const state = createState({
      connected: true,
      client: { request } as unknown as ChatState["client"],
    });

    await loadChatHistory(state);

    expect(state.chatMessages).toHaveLength(1);
    const only = state.chatMessages[0] as { content?: Array<{ text?: string }> };
    expect(only.content?.[0]?.text).toBe("/reset");
    expect(state.chatRunId).toBe("run-reset");
  });

  it("shows bare /reset bootstrap prompt from activeRun metadata on refresh", async () => {
    const effectiveUserMessage =
      "A new session was started via /new or /reset. Execute your Session Startup sequence now.";
    const request = vi.fn().mockResolvedValue({
      messages: [{ role: "user", content: [{ type: "text", text: "/reset" }], timestamp: 10 }],
      toolInvocations: [],
      activeRun: {
        runId: "run-reset",
        streamText: "",
        effectiveUserMessage,
        startedAtMs: 20,
      },
    });
    const state = createState({
      connected: true,
      client: { request } as unknown as ChatState["client"],
    });

    await loadChatHistory(state);

    expect(state.chatMessages).toHaveLength(2);
    const bootstrap = state.chatMessages[1] as {
      role?: string;
      content?: Array<{ text?: string }>;
    };
    expect(bootstrap.role).toBe("system");
    expect(bootstrap.content?.[0]?.text).toBe(effectiveUserMessage);
  });
});

describe("sendChatMessage", () => {
  it("keeps optimistic /reset row visible even if backend returns effectiveUserMessage metadata", async () => {
    const effectiveUserMessage =
      "A new session was started via /new or /reset. Execute your Session Startup sequence now.";
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-11T18:04:00.000Z"));
    const request = vi.fn().mockResolvedValue({
      runId: "run-1",
      status: "started",
      effectiveUserMessage,
    });
    const state = createState({
      connected: true,
      client: { request } as unknown as ChatState["client"],
    });

    const runId = await sendChatMessage(state, "/reset");

    expect(runId).toBeTruthy();
    const userMessage = state.chatMessages[0] as {
      role?: string;
      content?: Array<{ type?: string; text?: string }>;
    };
    expect(userMessage.role).toBe("user");
    expect(userMessage.content?.[0]?.type).toBe("text");
    expect(userMessage.content?.[0]?.text).toBe("/reset");
    expect((userMessage as { idempotencyKey?: string }).idempotencyKey).toBe(runId);
    expect(state.chatRunId).toBe("run-1");
    expect(state.chatMessages).toHaveLength(2);
    const bootstrap = state.chatMessages[1] as {
      role?: string;
      content?: Array<{ text?: string }>;
    };
    expect(bootstrap.role).toBe("system");
    expect(bootstrap.content?.[0]?.text).toBe(effectiveUserMessage);
    expect((bootstrap as { timestamp?: number }).timestamp).toBe(
      (state.chatMessages[0] as { timestamp?: number }).timestamp,
    );
    vi.useRealTimers();
  });

  it("clears local in-flight state after a routed teammate send starts elsewhere", async () => {
    const request = vi.fn().mockResolvedValue({
      runId: "run-mention",
      status: "started",
      routedTo: "@frontend_engineer",
    });
    const state = createState({
      connected: true,
      client: { request } as unknown as ChatState["client"],
    });

    const runId = await sendChatMessage(state, "@frontend_engineer can you review this?");

    expect(runId).toBeTruthy();
    expect(state.chatRunId).toBe(null);
    expect(state.chatStream).toBe(null);
    expect(state.chatStreamStartedAt).toBe(null);
    expect(state.chatStreamCommittedPrefixLength).toBe(0);
  });

  it("keeps chatSending true until a started event arrives for normal sends", async () => {
    const request = vi.fn().mockResolvedValue({
      runId: "run-1",
      status: "started",
    });
    const state = createState({
      connected: true,
      client: { request } as unknown as ChatState["client"],
    });

    const runId = await sendChatMessage(state, "find your mates");

    expect(runId).toBeTruthy();
    expect(state.chatSending).toBe(true);

    handleChatEvent(state, {
      runId: "run-1",
      sessionKey: "main",
      state: "started",
    });

    expect(state.chatSending).toBe(false);
  });
});

describe("enqueueChatMessage", () => {
  it("suppresses duplicate queue requests while the first enqueue is still in flight", async () => {
    let resolveFirst: ((value: unknown) => void) | null = null;
    const request = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
    );
    const state = createState({
      connected: true,
      client: { request } as unknown as ChatState["client"],
    });

    const first = enqueueChatMessage(state, "retry");
    const second = enqueueChatMessage(state, "retry");

    await Promise.resolve();

    expect(request).toHaveBeenCalledTimes(1);
    expect(state.chatQueueRequestInFlight).toBe(true);

    expect(request).toHaveBeenCalledWith("chat.queue.enqueue", {
      sessionKey: "main",
      message: "retry",
      idempotencyKey: expect.any(String),
    });

    if (resolveFirst) {
      resolveFirst({
        ok: true,
        item: { id: "queued-1", text: "retry", createdAt: Date.now() },
        queue: [{ id: "queued-1", text: "retry", createdAt: 123 }],
      });
    }
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(false);
    expect(state.chatQueueRequestInFlight).toBe(false);
    expect(state.chatQueue).toEqual([
      expect.objectContaining({ id: "queued-1", text: "retry", source: "backend" }),
    ]);
  });
});

describe("queue-driven runtime ownership", () => {
  it("keeps queued chat events out of the transcript until accepted", () => {
    const state = createState({ sessionKey: "main" });

    expect(
      handleChatEvent(state, {
        runId: "queued-1",
        sessionKey: "main",
        state: "queued",
        queueItemId: "queued-1",
        source: "queue",
        message: {
          role: "user",
          content: [{ type: "text", text: "retry" }],
          timestamp: 10,
          idempotencyKey: "queued-1",
          queued: true,
        },
      }),
    ).toBe("queued");

    expect(state.chatMessages).toEqual([]);
  });

  it("updates queue directly from queue.changed events", () => {
    const state = createState({
      sessionKey: "main",
      chatQueue: [{ id: "stale", text: "old", createdAt: 1, source: "backend" }],
    });

    expect(
      handleChatQueueChangedEvent(state, {
        sessionKey: "main",
        queue: [{ id: "queued-1", text: "fresh", createdAt: 2 }],
      }),
    ).toBe(true);

    expect(state.chatQueue).toEqual([
      expect.objectContaining({ id: "queued-1", text: "fresh", source: "backend" }),
    ]);
  });

  it("accepts a queue item while another run is active", async () => {
    const request = vi.fn().mockResolvedValue({
      ok: true,
      queue: [{ id: "queued-1", text: "follow up", createdAt: 10 }],
    });
    const state = createState({
      connected: true,
      chatRunId: "run-active",
      chatStream: "working",
      client: { request } as unknown as ChatState["client"],
    });

    await expect(enqueueChatMessage(state, "follow up")).resolves.toBe(true);

    expect(state.chatRunId).toBe("run-active");
    expect(state.chatStream).toBe("working");
    expect(state.chatQueue).toEqual([
      expect.objectContaining({ id: "queued-1", text: "follow up", source: "backend" }),
    ]);
  });

  it("keeps the accepted queued item in transcript while removing it from the queue", () => {
    const state = createState({
      sessionKey: "main",
      chatQueue: [
        { id: "queued-1", text: "follow up", createdAt: 1, source: "backend" },
        { id: "queued-2", text: "later", createdAt: 2, source: "backend" },
      ],
    });

    expect(
      handleChatEvent(state, {
        runId: "run-queued",
        sessionKey: "main",
        state: "started",
        source: "queue",
        queueItemId: "queued-1",
      }),
    ).toBe("started");

    expect(state.chatQueue.map((item) => item.id)).toEqual(["queued-2"]);
    expect(state.chatMessages).toEqual([
      expect.objectContaining({
        idempotencyKey: "queued-1",
        content: [{ type: "text", text: "follow up" }],
        queued: false,
      }),
    ]);
    expect(state.chatRunId).toBe("run-queued");
    expect(state.chatStream).toBe("");
    expect(state.chatStreamStartedAt).not.toBeNull();
  });

  it("switches active run id when a queued item starts while another run was active", () => {
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-old",
      chatStream: "working",
      chatStreamStartedAt: 1,
      chatQueue: [{ id: "queued-1", text: "follow up", createdAt: 1, source: "backend" }],
    });

    expect(
      handleChatEvent(state, {
        runId: "run-queued",
        sessionKey: "main",
        state: "started",
        source: "queue",
        queueItemId: "queued-1",
      }),
    ).toBe("started");

    expect(state.chatRunId).toBe("run-queued");
    expect(state.chatQueue).toEqual([]);
    expect(state.chatMessages).toEqual([
      expect.objectContaining({
        idempotencyKey: "queued-1",
        content: [{ type: "text", text: "follow up" }],
      }),
    ]);
  });

  it("retimestamps an accepted queued item so chronology follows execution order", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-10T12:00:10.000Z"));

    const state = createState({
      sessionKey: "main",
      chatMessages: [
        {
          role: "user",
          content: [{ type: "text", text: "find your mates" }],
          timestamp: 1_000,
          idempotencyKey: "first",
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "I'm Developer Lead..." }],
          timestamp: 5_000,
        },
      ],
      chatQueue: [{ id: "queued-1", text: "retry", createdAt: 2_000, source: "backend" }],
    });

    handleChatEvent(state, {
      runId: "run-queued",
      sessionKey: "main",
      state: "started",
      source: "queue",
      queueItemId: "queued-1",
    });

    expect(state.chatMessages).toEqual([
      expect.objectContaining({ idempotencyKey: "first", timestamp: 1_000 }),
      expect.objectContaining({ timestamp: 5_000 }),
      expect.objectContaining({
        idempotencyKey: "queued-1",
        queued: false,
        timestamp: Date.now(),
      }),
    ]);

    vi.useRealTimers();
  });

  it("clears dots and lands the message when a queued run ends", () => {
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-queued",
      chatStream: "partial",
      chatStreamStartedAt: 100,
    });

    expect(
      handleChatEvent(state, {
        runId: "run-queued",
        sessionKey: "main",
        state: "final",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "queued reply" }],
          timestamp: 101,
        },
      }),
    ).toBe("final");

    expect(state.chatRunId).toBeNull();
    expect(state.chatStream).toBeNull();
    expect(state.chatStreamStartedAt).toBeNull();
    expect(state.chatMessages).toEqual([
      {
        role: "assistant",
        content: [{ type: "text", text: "queued reply" }],
        timestamp: 101,
      },
    ]);
  });

  it("does not leave stuck typing after a queued final", () => {
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-queued",
      chatStream: "",
      chatStreamStartedAt: 100,
    });

    handleChatEvent(state, {
      runId: "run-queued",
      sessionKey: "main",
      state: "final",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
      },
    });

    expect(state.chatRunId).toBeNull();
    expect(state.chatStream).toBeNull();
    expect(state.chatStreamStartedAt).toBeNull();
  });
});

describe("loadChatHistory", () => {
  it("filters assistant NO_REPLY messages and keeps user NO_REPLY messages", async () => {
    const request = vi.fn().mockResolvedValue({
      messages: [
        { role: "assistant", content: [{ type: "text", text: "NO_REPLY" }] },
        { role: "assistant", content: [{ type: "text", text: "visible answer" }] },
        { role: "user", content: [{ type: "text", text: "NO_REPLY" }] },
      ],
      thinkingLevel: "low",
    });
    const state = createState({
      connected: true,
      client: { request } as unknown as ChatState["client"],
    });

    await loadChatHistory(state);

    expect(request).toHaveBeenCalledWith("chat.history", {
      sessionKey: "main",
      limit: 200,
    });
    expect(state.chatMessages).toEqual([
      { role: "assistant", content: [{ type: "text", text: "visible answer" }] },
      { role: "user", content: [{ type: "text", text: "NO_REPLY" }] },
    ]);
    expect(state.chatThinkingLevel).toBe("low");
    expect(state.chatLoading).toBe(false);
    expect(state.lastError).toBeNull();
  });
});
