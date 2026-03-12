import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.js";
import { registerAgentRunContext, resetAgentRunContextForTest } from "../infra/agent-events.js";
import { resolveHeartbeatVisibility } from "../infra/heartbeat-visibility.js";
import {
  createAgentEventHandler,
  createChatRunState,
  createToolEventRecipientRegistry,
} from "./server-chat.js";
import { resolveMentionRouteInText } from "./server-methods/agent-mentions.js";
import {
  appendAssistantTranscriptMessage,
  forwardMentionRouteToAgent,
} from "./server-methods/chat.js";
import type { DedupeEntry } from "./server-shared.js";
import { loadSessionEntry } from "./session-utils.js";

vi.mock("../config/config.js", () => ({
  loadConfig: vi.fn(() => ({})),
}));

vi.mock("../infra/heartbeat-visibility.js", () => ({
  resolveHeartbeatVisibility: vi.fn(() => ({
    showOk: false,
    showAlerts: true,
    useIndicator: true,
  })),
}));

vi.mock("./server-methods/agent-mentions.js", () => ({
  resolveMentionRouteInText: vi.fn(),
}));

vi.mock("./server-methods/chat.js", () => ({
  appendAssistantTranscriptMessage: vi.fn(() => ({ ok: true })),
  forwardMentionRouteToAgent: vi.fn(),
  resolveUnseenTerminalAssistantText: vi.fn(
    ({ fullText, committedVisibleText }: { fullText?: string; committedVisibleText?: string }) => {
      const next = String(fullText ?? "");
      const committed = String(committedVisibleText ?? "");
      if (!next.trim()) {
        return "";
      }
      if (!committed.trim()) {
        return next;
      }
      if (next === committed) {
        return "";
      }
      if (next.startsWith(committed)) {
        return next.slice(committed.length);
      }
      return next;
    },
  ),
}));

vi.mock("./session-utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session-utils.js")>();
  return {
    ...actual,
    loadSessionEntry: vi.fn(() => ({
      cfg: {},
      storePath: "/tmp/test-store",
      entry: { sessionId: "session-1", sessionFile: "/tmp/session-1.jsonl" },
    })),
  };
});

describe("agent event handler", () => {
  beforeEach(() => {
    vi.mocked(loadConfig).mockReturnValue({});
    vi.mocked(resolveHeartbeatVisibility).mockReturnValue({
      showOk: false,
      showAlerts: true,
      useIndicator: true,
    });
    vi.mocked(resolveMentionRouteInText).mockReset();
    vi.mocked(forwardMentionRouteToAgent).mockReset();
    vi.mocked(appendAssistantTranscriptMessage).mockClear();
    vi.mocked(loadSessionEntry).mockImplementation(() => ({
      cfg: {} as OpenClawConfig,
      storePath: "/tmp/test-store",
      store: {},
      entry: {
        sessionId: "session-1",
        sessionFile: "/tmp/session-1.jsonl",
        updatedAt: Date.now(),
      } as SessionEntry,
      canonicalKey: "session-1",
      legacyKey: undefined,
    }));
    resetAgentRunContextForTest();
  });

  afterEach(() => {
    resetAgentRunContextForTest();
  });

  function createHarness(params?: {
    now?: number;
    resolveSessionKeyForRun?: (runId: string) => string | undefined;
    resolveVisibleRunIdForSession?: (params: {
      runId: string;
      sessionKey?: string;
    }) => string | undefined;
    gatewayContext?: {
      broadcast: (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;
      nodeSendToSession: (sessionKey: string, event: string, payload: unknown) => void;
      agentRunSeq: Map<string, number>;
      dedupe: Map<string, DedupeEntry>;
      logGateway: Pick<
        import("../logging/subsystem.js").SubsystemLogger,
        | "warn"
        | "subsystem"
        | "isEnabled"
        | "trace"
        | "debug"
        | "info"
        | "error"
        | "fatal"
        | "child"
        | "raw"
      >;
    };
  }) {
    const nowSpy =
      params?.now === undefined ? undefined : vi.spyOn(Date, "now").mockReturnValue(params.now);
    const broadcast = vi.fn();
    const broadcastToConnIds = vi.fn();
    const nodeSendToSession = vi.fn();
    const agentRunSeq = new Map<string, number>();
    const chatRunState = createChatRunState();
    const liveEventRecipients = createToolEventRecipientRegistry();
    const sessionLiveEventRecipients = createToolEventRecipientRegistry();

    const handler = createAgentEventHandler({
      broadcast,
      broadcastToConnIds,
      nodeSendToSession,
      agentRunSeq,
      chatRunState,
      resolveSessionKeyForRun: params?.resolveSessionKeyForRun ?? (() => undefined),
      resolveVisibleRunIdForSession: params?.resolveVisibleRunIdForSession,
      clearAgentRunContext: vi.fn(),
      liveEventRecipients,
      sessionLiveEventRecipients,
      gatewayContext: params?.gatewayContext,
    });

    return {
      nowSpy,
      broadcast,
      broadcastToConnIds,
      nodeSendToSession,
      agentRunSeq,
      chatRunState,
      toolEventRecipients: liveEventRecipients,
      sessionToolEventRecipients: sessionLiveEventRecipients,
      liveEventRecipients,
      sessionLiveEventRecipients,
      handler,
    };
  }

  function emitRun1AssistantText(
    harness: ReturnType<typeof createHarness>,
    text: string,
  ): ReturnType<typeof createHarness> {
    harness.chatRunState.registry.add("run-1", {
      sessionKey: "session-1",
      clientRunId: "client-1",
    });
    harness.handler({
      runId: "run-1",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
      data: { text },
    });
    return harness;
  }

  function chatBroadcastCalls(broadcast: ReturnType<typeof vi.fn>) {
    return broadcast.mock.calls.filter(([event]) => event === "chat");
  }

  function sessionChatCalls(nodeSendToSession: ReturnType<typeof vi.fn>) {
    return nodeSendToSession.mock.calls.filter(([, event]) => event === "chat");
  }

  const FALLBACK_LIFECYCLE_DATA = {
    phase: "fallback",
    selectedProvider: "fireworks",
    selectedModel: "fireworks/minimax-m2p5",
    activeProvider: "deepinfra",
    activeModel: "moonshotai/Kimi-K2.5",
  } as const;

  function emitLifecycleEnd(
    handler: ReturnType<typeof createHarness>["handler"],
    runId: string,
    seq = 2,
  ) {
    handler({
      runId,
      seq,
      stream: "lifecycle",
      ts: Date.now(),
      data: { phase: "end" },
    });
  }

  function emitFallbackLifecycle(params: {
    handler: ReturnType<typeof createHarness>["handler"];
    runId: string;
    seq?: number;
    sessionKey?: string;
  }) {
    params.handler({
      runId: params.runId,
      seq: params.seq ?? 1,
      stream: "lifecycle",
      ts: Date.now(),
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
      data: { ...FALLBACK_LIFECYCLE_DATA },
    });
  }

  function expectSingleAgentBroadcastPayload(broadcast: ReturnType<typeof vi.fn>) {
    const broadcastAgentCalls = broadcast.mock.calls.filter(([event]) => event === "agent");
    expect(broadcastAgentCalls).toHaveLength(1);
    return broadcastAgentCalls[0]?.[1] as {
      runId?: string;
      sessionKey?: string;
      stream?: string;
      data?: Record<string, unknown>;
    };
  }

  function expectSingleFinalChatPayload(broadcast: ReturnType<typeof vi.fn>) {
    const chatCalls = chatBroadcastCalls(broadcast);
    const finalCalls = chatCalls.filter(
      ([, payload]) => (payload as { state?: string }).state === "final",
    );
    expect(finalCalls).toHaveLength(1);
    const payload = finalCalls[0]?.[1] as {
      state?: string;
      message?: unknown;
    };
    expect(payload.state).toBe("final");
    return payload;
  }

  it("emits chat delta for assistant text-only events", () => {
    const { broadcast, nodeSendToSession, nowSpy } = emitRun1AssistantText(
      createHarness({ now: 1_000 }),
      "Hello world",
    );
    const chatCalls = chatBroadcastCalls(broadcast);
    expect(chatCalls).toHaveLength(1);
    const payload = chatCalls[0]?.[1] as {
      state?: string;
      message?: { content?: Array<{ text?: string }> };
    };
    expect(payload.state).toBe("delta");
    expect(payload.message?.content?.[0]?.text).toBe("Hello world");
    expect(sessionChatCalls(nodeSendToSession)).toHaveLength(1);
    nowSpy?.mockRestore();
  });

  it("emits chat delta for assistant delta-only events", () => {
    const { broadcast, nodeSendToSession, chatRunState, handler, nowSpy } = createHarness({
      now: 1_000,
    });
    chatRunState.registry.add("run-delta-only", {
      sessionKey: "session-delta-only",
      clientRunId: "client-delta-only",
    });

    handler({
      runId: "run-delta-only",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
      data: { delta: "Hello world" },
    });

    const chatCalls = chatBroadcastCalls(broadcast);
    expect(chatCalls).toHaveLength(1);
    const payload = chatCalls[0]?.[1] as {
      state?: string;
      message?: { content?: Array<{ text?: string }> };
    };
    expect(payload.state).toBe("delta");
    expect(payload.message?.content?.[0]?.text).toBe("Hello world");
    expect(sessionChatCalls(nodeSendToSession)).toHaveLength(1);
    nowSpy?.mockRestore();
  });

  it("does not append restarted assistant prefix deltas twice", () => {
    const text =
      "I'm ready to help! Let me check what files are available in the workspace and then respond.";
    const { broadcast, chatRunState, handler, nowSpy } = createHarness({ now: 1_000 });
    chatRunState.registry.add("run-1", {
      sessionKey: "session-1",
      clientRunId: "client-1",
    });

    handler({
      runId: "run-1",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
      data: { text, delta: text },
    });

    nowSpy?.mockReturnValue(1_100);
    handler({
      runId: "run-1",
      seq: 2,
      stream: "assistant",
      ts: Date.now(),
      data: {
        text,
        delta: "I'm ready to help! Let me check what files are available in the workspace and then",
      },
    });

    const chatCalls = chatBroadcastCalls(broadcast);
    expect(chatCalls).toHaveLength(1);
    nowSpy?.mockRestore();
  });

  it("strips inline directives from assistant chat events", () => {
    const { broadcast, nodeSendToSession, nowSpy } = emitRun1AssistantText(
      createHarness({ now: 1_000 }),
      "Hello [[reply_to_current]] world [[audio_as_voice]]",
    );
    const chatCalls = chatBroadcastCalls(broadcast);
    expect(chatCalls).toHaveLength(1);
    const payload = chatCalls[0]?.[1] as {
      message?: { content?: Array<{ text?: string }> };
    };
    expect(payload.message?.content?.[0]?.text).toBe("Hello  world ");
    expect(sessionChatCalls(nodeSendToSession)).toHaveLength(1);
    nowSpy?.mockRestore();
  });

  it("does not emit chat delta for NO_REPLY streaming text", () => {
    const { broadcast, nodeSendToSession, nowSpy } = emitRun1AssistantText(
      createHarness({ now: 1_000 }),
      " NO_REPLY  ",
    );
    expect(chatBroadcastCalls(broadcast)).toHaveLength(0);
    expect(sessionChatCalls(nodeSendToSession)).toHaveLength(0);
    nowSpy?.mockRestore();
  });

  it("does not include NO_REPLY text in chat final message", () => {
    const { broadcast, nodeSendToSession, chatRunState, handler, nowSpy } = createHarness({
      now: 2_000,
    });
    chatRunState.registry.add("run-2", { sessionKey: "session-2", clientRunId: "client-2" });

    handler({
      runId: "run-2",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "NO_REPLY" },
    });
    emitLifecycleEnd(handler, "run-2");

    const payload = expectSingleFinalChatPayload(broadcast) as { message?: unknown };
    expect(payload.message).toBeUndefined();
    expect(sessionChatCalls(nodeSendToSession)).toHaveLength(1);
    nowSpy?.mockRestore();
  });

  it("routes leading teammate mentions in streamed final chat replies", async () => {
    vi.mocked(resolveMentionRouteInText).mockResolvedValue({
      ok: true,
      mention: "@frontend_engineer",
      body: "@frontend_engineer please take this",
      bodyWithoutMention: "please take this",
      agentId: "frontend_engineer",
      sessionKey: "agent:frontend_engineer:main",
      token: { mention: "@frontend_engineer", start: 0, end: 18 },
    });
    vi.mocked(forwardMentionRouteToAgent).mockResolvedValue({
      ok: true,
      delivery: "queued",
      payload: undefined,
    });
    const gatewayContext = {
      broadcast: vi.fn(),
      nodeSendToSession: vi.fn(),
      agentRunSeq: new Map<string, number>(),
      dedupe: new Map<string, DedupeEntry>(),
      logGateway: {
        subsystem: "test",
        isEnabled: () => true,
        trace: vi.fn(),
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        fatal: vi.fn(),
        child: vi.fn(),
        raw: vi.fn(),
      },
    };
    const { broadcast, nodeSendToSession, chatRunState, handler } = createHarness({
      now: 2_050,
      gatewayContext,
    });
    chatRunState.registry.add("run-route", {
      sessionKey: "session-route",
      clientRunId: "client-route",
    });

    handler({
      runId: "run-route",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "@frontend_engineer please take this" },
    });
    handler({
      runId: "run-route",
      seq: 2,
      stream: "lifecycle",
      ts: Date.now(),
      data: { phase: "end" },
    });
    await vi.waitFor(
      () =>
        expect(
          chatBroadcastCalls(broadcast).some(
            ([, payload]) => (payload as { state?: string }).state === "final",
          ),
        ).toBe(true),
      {
        timeout: 250,
        interval: 2,
      },
    );

    const finalPayload = expectSingleFinalChatPayload(broadcast) as {
      state?: string;
      message?: { content?: Array<{ text?: string }> };
    };
    expect(finalPayload.message?.content?.[0]?.text).toBe("Delivered to @frontend_engineer.");
    expect(vi.mocked(forwardMentionRouteToAgent)).toHaveBeenCalledOnce();
    expect(vi.mocked(appendAssistantTranscriptMessage)).toHaveBeenCalledWith(
      expect.objectContaining({
        label: "Queued for teammate",
        message: "Delivered to @frontend_engineer.",
        idempotencyKey: "client-route:assistant-mention-route-notice",
      }),
    );
    expect(sessionChatCalls(nodeSendToSession).length).toBeGreaterThanOrEqual(2);
  });

  it("suppresses NO_REPLY lead fragments and does not leak NO in final chat message", () => {
    const { broadcast, nodeSendToSession, chatRunState, handler, nowSpy } = createHarness({
      now: 2_100,
    });
    chatRunState.registry.add("run-3", { sessionKey: "session-3", clientRunId: "client-3" });

    for (const text of ["NO", "NO_", "NO_RE", "NO_REPLY"]) {
      handler({
        runId: "run-3",
        seq: 1,
        stream: "assistant",
        ts: Date.now(),
        data: { text },
      });
    }
    emitLifecycleEnd(handler, "run-3");

    const payload = expectSingleFinalChatPayload(broadcast) as { message?: unknown };
    expect(payload.message).toBeUndefined();
    expect(sessionChatCalls(nodeSendToSession)).toHaveLength(1);
    nowSpy?.mockRestore();
  });

  it("omits final assistant message when the full reply was already broadcast as deltas", () => {
    const { broadcast, chatRunState, handler } = createHarness({
      now: 2_250,
      resolveSessionKeyForRun: () => "session-final-idem",
    });
    chatRunState.registry.add("run-final-idem", {
      sessionKey: "session-final-idem",
      clientRunId: "client-final-idem",
    });

    handler({
      runId: "run-final-idem",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "Hello there" },
    });
    emitLifecycleEnd(handler, "run-final-idem", 2);

    const payload = expectSingleFinalChatPayload(broadcast) as { message?: unknown };
    expect(payload.message).toBeUndefined();
  });

  it("keeps final short replies like 'No' even when lead-fragment deltas are suppressed", () => {
    const { broadcast, nodeSendToSession, chatRunState, handler, nowSpy } = createHarness({
      now: 2_200,
    });
    chatRunState.registry.add("run-4", { sessionKey: "session-4", clientRunId: "client-4" });

    handler({
      runId: "run-4",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "No" },
    });
    emitLifecycleEnd(handler, "run-4");

    const payload = expectSingleFinalChatPayload(broadcast) as {
      message?: { content?: Array<{ text?: string }> };
    };
    expect(payload.message?.content?.[0]?.text).toBe("No");
    expect(sessionChatCalls(nodeSendToSession)).toHaveLength(1);
    nowSpy?.mockRestore();
  });

  it("flushes buffered text as delta before final when throttle suppresses the latest chunk", () => {
    let now = 10_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const { broadcast, nodeSendToSession, chatRunState, handler } = createHarness();
    chatRunState.registry.add("run-flush", {
      sessionKey: "session-flush",
      clientRunId: "client-flush",
    });

    handler({
      runId: "run-flush",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "Hello" },
    });

    now = 10_100;
    handler({
      runId: "run-flush",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "Hello world" },
    });

    emitLifecycleEnd(handler, "run-flush");

    const chatCalls = chatBroadcastCalls(broadcast);
    expect(chatCalls).toHaveLength(3);
    const firstPayload = chatCalls[0]?.[1] as { state?: string };
    const secondPayload = chatCalls[1]?.[1] as {
      state?: string;
      message?: { content?: Array<{ text?: string }> };
    };
    const thirdPayload = chatCalls[2]?.[1] as { state?: string; phase?: string };
    expect(firstPayload.state).toBe("delta");
    expect(secondPayload.state).toBe("delta");
    expect(secondPayload.message?.content?.[0]?.text).toBe(" world");
    expect(thirdPayload.state).toBe("final");
    expect(sessionChatCalls(nodeSendToSession)).toHaveLength(3);
    nowSpy.mockRestore();
  });

  it("preserves pre-tool assistant text when later segments stream as non-prefix snapshots", () => {
    let now = 10_500;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const { broadcast, nodeSendToSession, chatRunState, handler } = createHarness();
    chatRunState.registry.add("run-segmented", {
      sessionKey: "session-segmented",
      clientRunId: "client-segmented",
    });

    handler({
      runId: "run-segmented",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "Before tool call", delta: "Before tool call" },
    });

    now = 10_700;
    handler({
      runId: "run-segmented",
      seq: 2,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "After tool call", delta: "\nAfter tool call" },
    });

    emitLifecycleEnd(handler, "run-segmented", 3);

    const chatCalls = chatBroadcastCalls(broadcast);
    expect(chatCalls).toHaveLength(3);
    const secondPayload = chatCalls[1]?.[1] as {
      state?: string;
      message?: { content?: Array<{ text?: string }> };
    };
    const phasePayload = chatCalls[2]?.[1] as { state?: string; phase?: string };
    const finalPayload = chatCalls[3]?.[1] as {
      state?: string;
      message?: { content?: Array<{ text?: string }> };
    };
    expect(secondPayload.state).toBe("delta");
    expect(secondPayload.message?.content?.[0]?.text).toBe("\nAfter tool call");
    expect(phasePayload.state).toBe("final");
    expect(finalPayload).toBeUndefined();
    expect(sessionChatCalls(nodeSendToSession)).toHaveLength(3);
    nowSpy.mockRestore();
  });

  it("omits final payload message after a prefix was already committed before tool work", () => {
    let now = 10_950;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const { broadcast, nodeSendToSession, chatRunState, handler } = createHarness();
    chatRunState.registry.add("run-tool-final", {
      sessionKey: "session-tool-final",
      clientRunId: "client-tool-final",
    });

    handler({
      runId: "run-tool-final",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
      data: {
        text: "Got it! I'm Developer Lead. Let me check my identity and the SOUL.md file to understand who I",
      },
    });

    handler({
      runId: "run-tool-final",
      seq: 2,
      stream: "tool",
      ts: Date.now(),
      data: { phase: "start", name: "read", toolCallId: "t1" },
    });

    now = 11_050;
    handler({
      runId: "run-tool-final",
      seq: 3,
      stream: "assistant",
      ts: Date.now(),
      data: {
        text: "Got it! I'm Developer Lead. Let me check my identity and the SOUL.md file to understand who I am better.",
      },
    });

    emitLifecycleEnd(handler, "run-tool-final", 4);

    const chatCalls = chatBroadcastCalls(broadcast);
    const finalPayload = chatCalls.at(-1)?.[1] as {
      state?: string;
      message?: { content?: Array<{ text?: string }> };
    };
    expect(chatCalls.map(([, payload]) => (payload as { state?: string }).state)).toEqual([
      "delta",
      "phase",
      "delta",
      "final",
    ]);
    const thirdPayload = chatCalls[2]?.[1] as
      | { message?: { content?: Array<{ text?: string }> } }
      | undefined;
    expect(thirdPayload?.message?.content?.[0]?.text).toBe(" am better.");
    expect(finalPayload.state).toBe("final");
    expect(finalPayload.message).toBeUndefined();
    expect(sessionChatCalls(nodeSendToSession)).toHaveLength(4);
    nowSpy.mockRestore();
  });

  it("flushes merged segmented text before final when latest segment is throttled", () => {
    let now = 10_800;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const { broadcast, nodeSendToSession, chatRunState, handler } = createHarness();
    chatRunState.registry.add("run-segmented-flush", {
      sessionKey: "session-segmented-flush",
      clientRunId: "client-segmented-flush",
    });

    handler({
      runId: "run-segmented-flush",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "Before tool call", delta: "Before tool call" },
    });

    now = 10_860;
    handler({
      runId: "run-segmented-flush",
      seq: 2,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "After tool call", delta: "\nAfter tool call" },
    });

    emitLifecycleEnd(handler, "run-segmented-flush", 3);

    const chatCalls = chatBroadcastCalls(broadcast);
    expect(chatCalls).toHaveLength(3);
    const flushPayload = chatCalls[1]?.[1] as {
      state?: string;
      message?: { content?: Array<{ text?: string }> };
    };
    const phasePayload = chatCalls[2]?.[1] as { state?: string; phase?: string };
    const finalPayload = chatCalls[3]?.[1] as {
      state?: string;
      message?: { content?: Array<{ text?: string }> };
    };
    expect(flushPayload.state).toBe("delta");
    expect(flushPayload.message?.content?.[0]?.text).toBe("\nAfter tool call");
    expect(phasePayload.state).toBe("final");
    expect(finalPayload).toBeUndefined();
    expect(sessionChatCalls(nodeSendToSession)).toHaveLength(3);
    nowSpy.mockRestore();
  });

  it("does not flush an extra delta when the latest text already broadcast", () => {
    let now = 11_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const { broadcast, nodeSendToSession, chatRunState, handler } = createHarness();
    chatRunState.registry.add("run-no-dup-flush", {
      sessionKey: "session-no-dup-flush",
      clientRunId: "client-no-dup-flush",
    });

    handler({
      runId: "run-no-dup-flush",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "Hello" },
    });

    now = 11_200;
    handler({
      runId: "run-no-dup-flush",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "Hello world" },
    });

    emitLifecycleEnd(handler, "run-no-dup-flush");

    const chatCalls = chatBroadcastCalls(broadcast);
    expect(chatCalls).toHaveLength(3);
    expect(chatCalls.map(([, payload]) => (payload as { state?: string }).state)).toEqual([
      "delta",
      "delta",
      "final",
    ]);
    expect(sessionChatCalls(nodeSendToSession)).toHaveLength(3);
    nowSpy.mockRestore();
  });

  it("cleans up agent run sequence tracking when lifecycle completes", () => {
    const { agentRunSeq, chatRunState, handler, nowSpy } = createHarness({ now: 2_500 });
    chatRunState.registry.add("run-cleanup", {
      sessionKey: "session-cleanup",
      clientRunId: "client-cleanup",
    });

    handler({
      runId: "run-cleanup",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "done" },
    });
    expect(agentRunSeq.get("run-cleanup")).toBe(1);

    handler({
      runId: "run-cleanup",
      seq: 2,
      stream: "lifecycle",
      ts: Date.now(),
      data: { phase: "end" },
    });

    expect(agentRunSeq.has("run-cleanup")).toBe(false);
    expect(agentRunSeq.has("client-cleanup")).toBe(false);
    nowSpy?.mockRestore();
  });

  it("routes tool events only to registered recipients when verbose is enabled", () => {
    const { broadcast, broadcastToConnIds, toolEventRecipients, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-1",
    });

    registerAgentRunContext("run-tool", { sessionKey: "session-1", verboseLevel: "on" });
    toolEventRecipients.add("run-tool", "conn-1");

    handler({
      runId: "run-tool",
      seq: 1,
      stream: "tool",
      ts: Date.now(),
      data: { phase: "start", name: "read", toolCallId: "t1" },
    });

    expect(broadcast).not.toHaveBeenCalled();
    expect(broadcastToConnIds).toHaveBeenCalledTimes(1);
    resetAgentRunContextForTest();
  });

  it("broadcasts tool events to WS recipients even when verbose is off, but skips node send", () => {
    const { broadcastToConnIds, nodeSendToSession, toolEventRecipients, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-1",
    });

    registerAgentRunContext("run-tool-off", { sessionKey: "session-1", verboseLevel: "off" });
    toolEventRecipients.add("run-tool-off", "conn-1");

    handler({
      runId: "run-tool-off",
      seq: 1,
      stream: "tool",
      ts: Date.now(),
      data: { phase: "start", name: "read", toolCallId: "t2" },
    });

    // Tool events always broadcast to registered WS recipients
    expect(broadcastToConnIds).toHaveBeenCalledTimes(1);
    // But node/channel subscribers should NOT receive when verbose is off
    const nodeToolCalls = nodeSendToSession.mock.calls.filter(([, event]) => event === "agent");
    expect(nodeToolCalls).toHaveLength(0);
    resetAgentRunContextForTest();
  });

  it("keeps tool output for WS recipients when verbose is on", () => {
    const { broadcastToConnIds, toolEventRecipients, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-1",
    });

    registerAgentRunContext("run-tool-on", { sessionKey: "session-1", verboseLevel: "on" });
    toolEventRecipients.add("run-tool-on", "conn-1");

    handler({
      runId: "run-tool-on",
      seq: 1,
      stream: "tool",
      ts: Date.now(),
      data: {
        phase: "result",
        name: "exec",
        toolCallId: "t3",
        result: { content: [{ type: "text", text: "secret" }] },
        partialResult: { content: [{ type: "text", text: "partial" }] },
      },
    });

    expect(broadcastToConnIds).toHaveBeenCalledTimes(1);
    const payload = broadcastToConnIds.mock.calls[0]?.[1] as { data?: Record<string, unknown> };
    expect(payload.data?.result).toEqual({ content: [{ type: "text", text: "secret" }] });
    expect(payload.data?.partialResult).toEqual({ content: [{ type: "text", text: "partial" }] });
    resetAgentRunContextForTest();
  });

  it("strips tool output for node session fanout when verbose is on", () => {
    const { nodeSendToSession, toolEventRecipients, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-1",
    });

    registerAgentRunContext("run-tool-on-node", { sessionKey: "session-1", verboseLevel: "on" });
    toolEventRecipients.add("run-tool-on-node", "conn-1");

    handler({
      runId: "run-tool-on-node",
      seq: 1,
      stream: "tool",
      ts: Date.now(),
      data: {
        phase: "result",
        name: "exec",
        toolCallId: "t3-node",
        result: { content: [{ type: "text", text: "secret" }] },
        partialResult: { content: [{ type: "text", text: "partial" }] },
      },
    });

    const nodeToolCalls = nodeSendToSession.mock.calls.filter(([, event]) => event === "agent");
    expect(nodeToolCalls).toHaveLength(1);
    const payload = nodeToolCalls[0]?.[2] as { data?: Record<string, unknown> };
    expect(payload.data?.result).toBeUndefined();
    expect(payload.data?.partialResult).toBeUndefined();
    resetAgentRunContextForTest();
  });

  it("keeps tool output when verbose is full", () => {
    const { broadcastToConnIds, toolEventRecipients, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-1",
    });

    registerAgentRunContext("run-tool-full", { sessionKey: "session-1", verboseLevel: "full" });
    toolEventRecipients.add("run-tool-full", "conn-1");

    const result = { content: [{ type: "text", text: "secret" }] };
    handler({
      runId: "run-tool-full",
      seq: 1,
      stream: "tool",
      ts: Date.now(),
      data: {
        phase: "result",
        name: "exec",
        toolCallId: "t4",
        result,
      },
    });

    expect(broadcastToConnIds).toHaveBeenCalledTimes(1);
    const payload = broadcastToConnIds.mock.calls[0]?.[1] as { data?: Record<string, unknown> };
    expect(payload.data?.result).toEqual(result);
    resetAgentRunContextForTest();
  });

  it("broadcasts fallback events to agent subscribers and node session", () => {
    const { broadcast, broadcastToConnIds, nodeSendToSession, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-fallback",
    });

    emitFallbackLifecycle({ handler, runId: "run-fallback" });

    expect(broadcastToConnIds).not.toHaveBeenCalled();
    const payload = expectSingleAgentBroadcastPayload(broadcast);
    expect(payload.stream).toBe("lifecycle");
    expect(payload.data?.phase).toBe("fallback");
    expect(payload.sessionKey).toBe("session-fallback");
    expect(payload.data?.activeProvider).toBe("deepinfra");

    const nodeCalls = nodeSendToSession.mock.calls.filter(([, event]) => event === "agent");
    expect(nodeCalls).toHaveLength(1);
  });

  it("remaps chat-linked lifecycle runId to client runId", () => {
    const { broadcast, nodeSendToSession, chatRunState, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-fallback",
    });
    chatRunState.registry.add("run-fallback-internal", {
      sessionKey: "session-fallback",
      clientRunId: "run-fallback-client",
    });

    emitFallbackLifecycle({ handler, runId: "run-fallback-internal" });

    const payload = expectSingleAgentBroadcastPayload(broadcast);
    expect(payload.runId).toBe("run-fallback-client");
    expect(payload.stream).toBe("lifecycle");
    expect(payload.data?.phase).toBe("fallback");

    const nodeCalls = nodeSendToSession.mock.calls.filter(([, event]) => event === "agent");
    expect(nodeCalls).toHaveLength(1);
    const nodePayload = nodeCalls[0]?.[2] as { runId?: string };
    expect(nodePayload.runId).toBe("run-fallback-client");
  });

  it("suppresses chat and node session events for non-control-UI-visible runs", () => {
    const { broadcast, nodeSendToSession, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-hidden",
    });
    registerAgentRunContext("run-hidden", {
      sessionKey: "session-hidden",
      isControlUiVisible: false,
      verboseLevel: "off",
    });

    handler({
      runId: "run-hidden",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "Reply from imessage" },
    });
    emitLifecycleEnd(handler, "run-hidden", 2);

    expect(chatBroadcastCalls(broadcast)).toHaveLength(0);
    expect(nodeSendToSession).not.toHaveBeenCalled();
  });

  it("broadcasts deterministic chat phases for reasoning, typing, and tool work", () => {
    const { broadcast, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-phase",
    });

    handler({
      runId: "run-phase",
      seq: 1,
      stream: "lifecycle",
      ts: Date.now(),
      data: { phase: "start", startedAt: 1 },
    });
    handler({
      runId: "run-phase",
      seq: 2,
      stream: "reasoning",
      ts: Date.now(),
      data: { phase: "delta", delta: "hmm" },
    });
    handler({
      runId: "run-phase",
      seq: 3,
      stream: "assistant",
      ts: Date.now(),
      data: { phase: "start" },
    });
    handler({
      runId: "run-phase",
      seq: 4,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "Hello", delta: "Hello" },
    });
    handler({
      runId: "run-phase",
      seq: 5,
      stream: "tool",
      ts: Date.now(),
      data: { phase: "start", name: "read", toolCallId: "t1" },
    });
    handler({
      runId: "run-phase",
      seq: 6,
      stream: "assistant",
      ts: Date.now(),
      data: { phase: "end" },
    });
    handler({
      runId: "run-phase",
      seq: 7,
      stream: "lifecycle",
      ts: Date.now(),
      data: { phase: "end", endedAt: 7 },
    });

    const chatPayloads = chatBroadcastCalls(broadcast).map(([, payload]) => payload);
    expect(chatPayloads[0]).toMatchObject({ state: "phase", phase: "processing" });
    expect(chatPayloads[1]).toMatchObject({ state: "started", phase: "processing" });
    expect(chatPayloads[2]).toMatchObject({ state: "phase", phase: "thinking" });
    expect(chatPayloads[3]).toMatchObject({ state: "delta", phase: "typing" });
    expect(chatPayloads[4]).toMatchObject({ state: "phase", phase: "tool_running" });
    expect(chatPayloads[5]).toMatchObject({ state: "phase", phase: "processing" });
    expect(chatPayloads[6]).toMatchObject({ state: "final" });
  });

  it("captures only the broadcast-visible assistant prefix when leaving typing for tool work", () => {
    const { handler, chatRunState } = createHarness({
      resolveSessionKeyForRun: () => "session-phase",
      gatewayContext: {
        broadcast: vi.fn(),
        nodeSendToSession: vi.fn(),
        agentRunSeq: new Map<string, number>(),
        dedupe: new Map<string, DedupeEntry>(),
        logGateway: {
          warn: vi.fn(),
          subsystem: "gateway",
          isEnabled: () => false,
          trace: vi.fn(),
          debug: vi.fn(),
          info: vi.fn(),
          error: vi.fn(),
          fatal: vi.fn(),
          child: vi.fn(),
          raw: vi.fn(),
        },
      },
    });

    chatRunState.registry.add("run-phase", {
      sessionKey: "session-phase",
      clientRunId: "run-phase",
    });
    chatRunState.buffers.set(
      "run-phase",
      "I'm ready to help! Let me check what files are available in the workspace and then respond.",
    );
    chatRunState.deltaLastBroadcastLen.set(
      "run-phase",
      "I'm ready to help! Let me check what files are available in the workspace and then".length,
    );
    chatRunState.phases.set("run-phase", "typing");

    handler({
      runId: "run-phase",
      seq: 5,
      stream: "tool",
      ts: Date.now(),
      data: { phase: "start", name: "read", toolCallId: "t1" },
    });

    expect(chatRunState.committedVisibleText.get("run-phase")).toBe(
      "I'm ready to help! Let me check what files are available in the workspace and then",
    );
    expect(appendAssistantTranscriptMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-phase",
        idempotencyKey: "run-phase:timeline:5",
        timeline: {
          canonical: true,
          seq: 5,
        },
      }),
    );
  });

  it("persists a canonical final suffix row when a run completes after tool work", () => {
    const { handler, chatRunState } = createHarness({
      resolveSessionKeyForRun: () => "session-phase",
      gatewayContext: {
        broadcast: vi.fn(),
        nodeSendToSession: vi.fn(),
        agentRunSeq: new Map<string, number>(),
        dedupe: new Map<string, DedupeEntry>(),
        logGateway: {
          warn: vi.fn(),
          subsystem: "gateway",
          isEnabled: () => false,
          trace: vi.fn(),
          debug: vi.fn(),
          info: vi.fn(),
          error: vi.fn(),
          fatal: vi.fn(),
          child: vi.fn(),
          raw: vi.fn(),
        },
      },
    });

    chatRunState.registry.add("run-phase", {
      sessionKey: "session-phase",
      clientRunId: "run-phase",
    });
    chatRunState.buffers.set(
      "run-phase",
      "I'm ready to help! Let me check what files are available in the workspace and then respond.",
    );
    chatRunState.deltaLastBroadcastLen.set(
      "run-phase",
      "I'm ready to help! Let me check what files are available in the workspace and then".length,
    );

    handler({
      runId: "run-phase",
      seq: 7,
      stream: "lifecycle",
      ts: Date.now(),
      data: { phase: "end", endedAt: 7 },
    });

    expect(appendAssistantTranscriptMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-phase",
        idempotencyKey: "run-phase:timeline:7",
        timeline: {
          canonical: true,
          seq: 7,
        },
      }),
    );
  });

  it("does not mark typing on assistant start before any token text arrives", () => {
    const { broadcast, handler, chatRunState } = createHarness({
      resolveSessionKeyForRun: () => "session-phase",
    });

    handler({
      runId: "run-phase",
      seq: 1,
      stream: "lifecycle",
      ts: Date.now(),
      data: { phase: "start", startedAt: 1 },
    });
    handler({
      runId: "run-phase",
      seq: 2,
      stream: "assistant",
      ts: Date.now(),
      data: { phase: "start" },
    });

    const chatPayloads = chatBroadcastCalls(broadcast).map(([, payload]) => payload);
    expect(chatPayloads).toEqual([
      expect.objectContaining({ state: "phase", phase: "processing" }),
      expect.objectContaining({ state: "started", phase: "processing" }),
    ]);
    expect(chatRunState.phases.get("run-phase")).toBe("processing");
  });

  it("uses agent event sessionKey when run-context lookup cannot resolve", () => {
    const { broadcast, handler } = createHarness({
      resolveSessionKeyForRun: () => undefined,
    });

    emitFallbackLifecycle({
      handler,
      runId: "run-fallback-session-key",
      sessionKey: "session-from-event",
    });

    const payload = expectSingleAgentBroadcastPayload(broadcast);
    expect(payload.sessionKey).toBe("session-from-event");
  });

  it("remaps chat-linked tool runId for non-full verbose payloads", () => {
    const { broadcastToConnIds, chatRunState, toolEventRecipients, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-tool-remap",
    });

    chatRunState.registry.add("run-tool-internal", {
      sessionKey: "session-tool-remap",
      clientRunId: "run-tool-client",
    });
    registerAgentRunContext("run-tool-internal", {
      sessionKey: "session-tool-remap",
      verboseLevel: "on",
    });
    toolEventRecipients.add("run-tool-internal", "conn-1");

    handler({
      runId: "run-tool-internal",
      seq: 1,
      stream: "tool",
      ts: Date.now(),
      data: {
        phase: "result",
        name: "exec",
        toolCallId: "tool-remap-1",
        result: { content: [{ type: "text", text: "secret" }] },
      },
    });

    expect(broadcastToConnIds).toHaveBeenCalledTimes(1);
    const payload = broadcastToConnIds.mock.calls[0]?.[1] as { runId?: string };
    expect(payload.runId).toBe("run-tool-client");
    resetAgentRunContextForTest();
  });

  it("routes tool events when recipients are registered on linked client run id", () => {
    const { broadcastToConnIds, chatRunState, toolEventRecipients, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-tool-link",
    });

    chatRunState.registry.add("run-tool-internal-link", {
      sessionKey: "session-tool-link",
      clientRunId: "run-tool-client-link",
    });
    registerAgentRunContext("run-tool-internal-link", {
      sessionKey: "session-tool-link",
      verboseLevel: "on",
    });
    toolEventRecipients.add("run-tool-client-link", "conn-refresh");

    handler({
      runId: "run-tool-internal-link",
      seq: 1,
      stream: "tool",
      ts: Date.now(),
      data: { phase: "start", name: "discover_teammates", toolCallId: "t-link-1" },
    });

    expect(broadcastToConnIds).toHaveBeenCalledTimes(1);
    const recipients = broadcastToConnIds.mock.calls[0]?.[2] as ReadonlySet<string> | undefined;
    expect(recipients?.has("conn-refresh")).toBe(true);
    expect(toolEventRecipients.get("run-tool-internal-link")?.has("conn-refresh")).toBe(true);
    resetAgentRunContextForTest();
  });

  it("routes same-session sub-run tool events via session recipients", () => {
    const { broadcastToConnIds, toolEventRecipients, sessionToolEventRecipients, handler } =
      createHarness({
        resolveSessionKeyForRun: () => "session-tool-session",
        resolveVisibleRunIdForSession: ({ sessionKey }) =>
          sessionKey === "session-tool-session" ? "run-tool-parent-visible" : undefined,
      });

    registerAgentRunContext("run-tool-sub-session", {
      sessionKey: "session-tool-session",
      verboseLevel: "on",
    });
    sessionToolEventRecipients.add("session-tool-session", "conn-session");

    handler({
      runId: "run-tool-sub-session",
      seq: 1,
      stream: "tool",
      ts: Date.now(),
      sessionKey: "session-tool-session",
      data: { phase: "start", name: "discover_teammates", toolCallId: "t-session-1" },
    });

    expect(broadcastToConnIds).toHaveBeenCalledTimes(1);
    const payload = broadcastToConnIds.mock.calls[0]?.[1] as { runId?: string };
    expect(payload.runId).toBe("run-tool-parent-visible");
    const recipients = broadcastToConnIds.mock.calls[0]?.[2] as ReadonlySet<string> | undefined;
    expect(recipients?.has("conn-session")).toBe(true);
    expect(toolEventRecipients.get("run-tool-sub-session")?.has("conn-session")).toBe(true);
    expect(toolEventRecipients.get("run-tool-parent-visible")?.has("conn-session")).toBe(true);
  });

  it("remaps same-session sub-run assistant, reasoning, and tool events to the visible run id", () => {
    const { broadcast, nodeSendToSession, handler, chatRunState } = createHarness({
      resolveSessionKeyForRun: () => "session-visible-parent",
      resolveVisibleRunIdForSession: ({ sessionKey }) =>
        sessionKey === "session-visible-parent" ? "run-visible-parent" : undefined,
    });
    chatRunState.phases.set("run-visible-parent", "processing");

    registerAgentRunContext("run-sub-visible", {
      sessionKey: "session-visible-parent",
      verboseLevel: "on",
    });

    handler({
      runId: "run-sub-visible",
      seq: 1,
      stream: "reasoning",
      ts: Date.now(),
      sessionKey: "session-visible-parent",
      data: { phase: "start" },
    });
    handler({
      runId: "run-sub-visible",
      seq: 2,
      stream: "assistant",
      ts: Date.now(),
      sessionKey: "session-visible-parent",
      data: { text: "Visible text" },
    });
    handler({
      runId: "run-sub-visible",
      seq: 3,
      stream: "tool",
      ts: Date.now(),
      sessionKey: "session-visible-parent",
      data: { phase: "start", name: "read", toolCallId: "tool-visible-1" },
    });

    const agentCalls = broadcast.mock.calls.filter(([event]) => event === "agent");
    expect(
      agentCalls.some(
        ([, payload]) =>
          (payload as { runId?: string; stream?: string }).runId === "run-visible-parent" &&
          (payload as { stream?: string }).stream === "reasoning",
      ),
    ).toBe(true);
    const nodeAgentCalls = nodeSendToSession.mock.calls.filter(([, event]) => event === "agent");
    expect(
      nodeAgentCalls.some(
        ([, , payload]) =>
          (payload as { runId?: string; stream?: string }).runId === "run-visible-parent" &&
          (payload as { stream?: string }).stream === "tool",
      ),
    ).toBe(true);
    const chatCalls = chatBroadcastCalls(broadcast);
    expect(
      chatCalls.some(
        ([, payload]) =>
          (payload as { runId?: string; state?: string; phase?: string }).runId ===
            "run-visible-parent" &&
          (payload as { state?: string }).state === "phase" &&
          (payload as { phase?: string }).phase === "thinking",
      ),
    ).toBe(true);
    expect(
      chatCalls.some(
        ([, payload]) =>
          (payload as { runId?: string; state?: string }).runId === "run-visible-parent" &&
          (payload as { state?: string }).state === "delta",
      ),
    ).toBe(true);
    expect(sessionChatCalls(nodeSendToSession).length).toBeGreaterThan(0);
  });

  it("uses input provenance sourceSessionKey as the visible webchat session for inter-session tool events", () => {
    const { broadcastToConnIds, nodeSendToSession, sessionToolEventRecipients, handler } =
      createHarness({
        resolveSessionKeyForRun: () => "agent:teammate:subagent:worker",
        resolveVisibleRunIdForSession: ({ sessionKey }) =>
          sessionKey === "main" ? "run-visible-main" : undefined,
      });

    registerAgentRunContext("run-inter-session-tool", {
      sessionKey: "agent:teammate:subagent:worker",
      verboseLevel: "on",
      inputProvenance: {
        kind: "inter_session",
        sourceSessionKey: "main",
        sourceTool: "discover_teammates",
      },
    });
    sessionToolEventRecipients.add("main", "conn-main");

    handler({
      runId: "run-inter-session-tool",
      seq: 1,
      stream: "tool",
      ts: Date.now(),
      sessionKey: "agent:teammate:subagent:worker",
      data: { phase: "start", name: "tts", toolCallId: "tool-tts-1" },
    });

    expect(broadcastToConnIds).toHaveBeenCalledTimes(1);
    const agentPayload = broadcastToConnIds.mock.calls[0]?.[1] as {
      runId?: string;
      sessionKey?: string;
      stream?: string;
    };
    expect(agentPayload.runId).toBe("run-visible-main");
    expect(agentPayload.sessionKey).toBe("main");
    expect(agentPayload.stream).toBe("tool");

    const nodeAgentCalls = nodeSendToSession.mock.calls.filter(([, event]) => event === "agent");
    expect(
      nodeAgentCalls.some(
        ([sessionKey, , payload]) =>
          sessionKey === "main" &&
          (payload as { runId?: string; sessionKey?: string }).runId === "run-visible-main" &&
          (payload as { sessionKey?: string }).sessionKey === "main",
      ),
    ).toBe(true);
  });

  it("does not route sub-run tool events to recipients from another session", () => {
    const { broadcastToConnIds, sessionToolEventRecipients, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-tool-actual",
    });

    registerAgentRunContext("run-tool-other-session", {
      sessionKey: "session-tool-actual",
      verboseLevel: "on",
    });
    sessionToolEventRecipients.add("session-tool-different", "conn-wrong");

    handler({
      runId: "run-tool-other-session",
      seq: 1,
      stream: "tool",
      ts: Date.now(),
      sessionKey: "session-tool-actual",
      data: { phase: "start", name: "discover_teammates", toolCallId: "t-session-2" },
    });

    expect(broadcastToConnIds).not.toHaveBeenCalled();
  });

  it("suppresses heartbeat ack-like chat output when showOk is false", () => {
    const { broadcast, nodeSendToSession, chatRunState, handler } = createHarness({
      now: 2_000,
    });
    chatRunState.registry.add("run-heartbeat", {
      sessionKey: "session-heartbeat",
      clientRunId: "client-heartbeat",
    });
    registerAgentRunContext("run-heartbeat", {
      sessionKey: "session-heartbeat",
      isHeartbeat: true,
      verboseLevel: "off",
    });

    handler({
      runId: "run-heartbeat",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
      data: {
        text: "HEARTBEAT_OK Read HEARTBEAT.md if it exists (workspace context). Follow it strictly.",
      },
    });

    expect(chatBroadcastCalls(broadcast)).toHaveLength(0);
    expect(sessionChatCalls(nodeSendToSession)).toHaveLength(0);

    emitLifecycleEnd(handler, "run-heartbeat");

    const finalPayload = expectSingleFinalChatPayload(broadcast) as { message?: unknown };
    expect(finalPayload.message).toBeUndefined();
    expect(sessionChatCalls(nodeSendToSession)).toHaveLength(1);
  });

  it("keeps heartbeat alert text in final chat output when remainder exceeds ackMaxChars", () => {
    vi.mocked(loadConfig).mockReturnValue({
      agents: { defaults: { heartbeat: { ackMaxChars: 10 } } },
    });

    const { broadcast, chatRunState, handler } = createHarness({ now: 3_000 });
    chatRunState.registry.add("run-heartbeat-alert", {
      sessionKey: "session-heartbeat-alert",
      clientRunId: "client-heartbeat-alert",
    });
    registerAgentRunContext("run-heartbeat-alert", {
      sessionKey: "session-heartbeat-alert",
      isHeartbeat: true,
      verboseLevel: "off",
    });

    handler({
      runId: "run-heartbeat-alert",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
      data: {
        text: "HEARTBEAT_OK Disk usage crossed 95 percent on /data and needs cleanup now.",
      },
    });

    emitLifecycleEnd(handler, "run-heartbeat-alert");

    const payload = expectSingleFinalChatPayload(broadcast) as {
      message?: { content?: Array<{ text?: string }> };
    };
    expect(payload.message?.content?.[0]?.text).toBe(
      "Disk usage crossed 95 percent on /data and needs cleanup now.",
    );
  });
});
