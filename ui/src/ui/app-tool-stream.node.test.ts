import { beforeAll, describe, expect, it, vi } from "vitest";
import { handleAgentEvent, type FallbackStatus, type ToolStreamEntry } from "./app-tool-stream.ts";

type ToolStreamHost = Parameters<typeof handleAgentEvent>[0];
type MutableHost = ToolStreamHost & {
  compactionStatus?: unknown;
  compactionClearTimer?: number | null;
  fallbackStatus?: FallbackStatus | null;
  fallbackClearTimer?: number | null;
};

function createHost(overrides?: Partial<MutableHost>): MutableHost {
  return {
    sessionKey: "main",
    chatRunId: null,
    toolStreamById: new Map<string, ToolStreamEntry>(),
    toolStreamOrder: [],
    chatToolMessages: [],
    toolStreamSyncTimer: null,
    compactionStatus: null,
    compactionClearTimer: null,
    fallbackStatus: null,
    fallbackClearTimer: null,
    ...overrides,
  };
}

describe("app-tool-stream fallback lifecycle handling", () => {
  beforeAll(() => {
    const globalWithWindow = globalThis as typeof globalThis & {
      window?: Window & typeof globalThis;
    };
    if (!globalWithWindow.window) {
      globalWithWindow.window = globalThis as unknown as Window & typeof globalThis;
    }
  });

  it("accepts session-scoped fallback lifecycle events when no run is active", () => {
    vi.useFakeTimers();
    const host = createHost();

    handleAgentEvent(host, {
      runId: "run-1",
      seq: 1,
      stream: "lifecycle",
      ts: Date.now(),
      sessionKey: "main",
      data: {
        phase: "fallback",
        selectedProvider: "fireworks",
        selectedModel: "fireworks/minimax-m2p5",
        activeProvider: "deepinfra",
        activeModel: "moonshotai/Kimi-K2.5",
        reasonSummary: "rate limit",
      },
    });

    expect(host.fallbackStatus?.selected).toBe("fireworks/minimax-m2p5");
    expect(host.fallbackStatus?.active).toBe("deepinfra/moonshotai/Kimi-K2.5");
    expect(host.fallbackStatus?.reason).toBe("rate limit");
    vi.useRealTimers();
  });

  it("shows typing state for idle same-session inter-session lifecycle start", () => {
    vi.useFakeTimers();
    const now = Date.now();
    const host = createHost({
      chatRunId: null,
      chatStream: null,
      chatStreamStartedAt: null,
      chatStreamCommittedPrefixLength: 99,
    }) as MutableHost & {
      chatStream: string | null;
      chatStreamStartedAt: number | null;
      chatStreamCommittedPrefixLength: number;
    };

    handleAgentEvent(host, {
      runId: "run-inbound-a2a",
      seq: 1,
      stream: "lifecycle",
      ts: now,
      sessionKey: "main",
      data: {
        phase: "start",
        inputProvenance: {
          kind: "inter_session",
          sourceSessionKey: "agent:developer_lead:main",
        },
      },
    });

    expect(host.chatRunId).toBe("run-inbound-a2a");
    expect(host.chatStream).toBe("");
    expect(host.chatStreamStartedAt).toBe(now);
    expect(host.chatStreamCommittedPrefixLength).toBe(0);
    vi.useRealTimers();
  });

  it("ignores idle same-session lifecycle start without chat-visible provenance", () => {
    vi.useFakeTimers();
    const now = Date.now();
    const host = createHost({
      chatRunId: null,
      chatStream: null,
      chatStreamStartedAt: null,
      chatStreamCommittedPrefixLength: 0,
    }) as MutableHost & {
      chatStream: string | null;
      chatStreamStartedAt: number | null;
      chatStreamCommittedPrefixLength: number;
    };

    handleAgentEvent(host, {
      runId: "run-hidden",
      seq: 1,
      stream: "lifecycle",
      ts: now,
      sessionKey: "main",
      data: {
        phase: "start",
      },
    });

    expect(host.chatRunId).toBeNull();
    expect(host.chatStream).toBeNull();
    expect(host.chatStreamStartedAt).toBeNull();
    vi.useRealTimers();
  });

  it("does not hijack current typing state for another active run", () => {
    vi.useFakeTimers();
    const now = Date.now();
    const host = createHost({
      chatRunId: "run-user",
      chatStream: "",
      chatStreamStartedAt: now - 1000,
      chatStreamCommittedPrefixLength: 0,
    }) as MutableHost & {
      chatStream: string | null;
      chatStreamStartedAt: number | null;
      chatStreamCommittedPrefixLength: number;
    };

    handleAgentEvent(host, {
      runId: "run-other",
      seq: 1,
      stream: "lifecycle",
      ts: now,
      sessionKey: "main",
      data: {
        phase: "start",
      },
    });

    expect(host.chatRunId).toBe("run-user");
    expect(host.chatStreamStartedAt).toBe(now - 1000);
    vi.useRealTimers();
  });

  it("rejects idle fallback lifecycle events for other sessions", () => {
    vi.useFakeTimers();
    const host = createHost();

    handleAgentEvent(host, {
      runId: "run-1",
      seq: 1,
      stream: "lifecycle",
      ts: Date.now(),
      sessionKey: "agent:other:main",
      data: {
        phase: "fallback",
        selectedProvider: "fireworks",
        selectedModel: "fireworks/minimax-m2p5",
        activeProvider: "deepinfra",
        activeModel: "moonshotai/Kimi-K2.5",
      },
    });

    expect(host.fallbackStatus).toBeNull();
    vi.useRealTimers();
  });

  it("auto-clears fallback status after toast duration", () => {
    vi.useFakeTimers();
    const host = createHost();

    handleAgentEvent(host, {
      runId: "run-1",
      seq: 1,
      stream: "lifecycle",
      ts: Date.now(),
      sessionKey: "main",
      data: {
        phase: "fallback",
        selectedProvider: "fireworks",
        selectedModel: "fireworks/minimax-m2p5",
        activeProvider: "deepinfra",
        activeModel: "moonshotai/Kimi-K2.5",
      },
    });

    expect(host.fallbackStatus).not.toBeNull();
    vi.advanceTimersByTime(7_999);
    expect(host.fallbackStatus).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(host.fallbackStatus).toBeNull();
    vi.useRealTimers();
  });

  it("builds previous fallback label from provider + model on fallback_cleared", () => {
    vi.useFakeTimers();
    const host = createHost();

    handleAgentEvent(host, {
      runId: "run-1",
      seq: 1,
      stream: "lifecycle",
      ts: Date.now(),
      sessionKey: "main",
      data: {
        phase: "fallback_cleared",
        selectedProvider: "fireworks",
        selectedModel: "fireworks/minimax-m2p5",
        activeProvider: "fireworks",
        activeModel: "fireworks/minimax-m2p5",
        previousActiveProvider: "deepinfra",
        previousActiveModel: "moonshotai/Kimi-K2.5",
      },
    });

    expect(host.fallbackStatus?.phase).toBe("cleared");
    expect(host.fallbackStatus?.previous).toBe("deepinfra/moonshotai/Kimi-K2.5");
    vi.useRealTimers();
  });

  it("accepts late tool events for the most recent terminal run within grace window", () => {
    vi.useFakeTimers();
    const now = Date.now();
    const host = createHost({
      chatRunId: null,
      chatLastTerminalRunId: "run-terminal-1",
      chatLastTerminalAt: now,
    });

    handleAgentEvent(host, {
      runId: "run-terminal-1",
      seq: 1,
      stream: "tool",
      ts: now,
      sessionKey: "main",
      data: {
        phase: "start",
        toolCallId: "tool-1",
        name: "discover",
        args: { query: "teammates" },
      },
    });
    handleAgentEvent(host, {
      runId: "run-terminal-1",
      seq: 2,
      stream: "tool",
      ts: now + 50,
      sessionKey: "main",
      data: {
        phase: "result",
        toolCallId: "tool-1",
        name: "discover",
        result: { text: "ok" },
      },
    });
    vi.runOnlyPendingTimers();

    expect(host.chatToolMessages).toHaveLength(1);
    const first = host.chatToolMessages[0] as { content?: Array<{ type?: string; text?: string }> };
    expect(first.content?.some((entry) => entry.type === "toolresult" && entry.text === "ok")).toBe(
      true,
    );
    vi.useRealTimers();
  });

  it("rejects idle tool events for runs outside terminal grace window", () => {
    vi.useFakeTimers();
    const now = Date.now();
    const host = createHost({
      chatRunId: null,
      chatLastTerminalRunId: "run-terminal-old",
      chatLastTerminalAt: now - 10_000,
    });

    handleAgentEvent(host, {
      runId: "run-other",
      seq: 1,
      stream: "tool",
      ts: now,
      sessionKey: "main",
      data: {
        phase: "start",
        toolCallId: "tool-2",
        name: "discover",
      },
    });
    vi.runOnlyPendingTimers();

    expect(host.chatToolMessages).toHaveLength(0);
    vi.useRealTimers();
  });

  it("accepts same-session tool events from sub-runs while a run is active", () => {
    vi.useFakeTimers();
    const now = Date.now();
    const host = createHost({
      chatRunId: "run-parent",
    });

    handleAgentEvent(host, {
      runId: "run-sub",
      seq: 1,
      stream: "tool",
      ts: now,
      sessionKey: "main",
      data: {
        phase: "start",
        toolCallId: "tool-subrun",
        name: "discover_teammates",
      },
    });
    vi.runOnlyPendingTimers();

    expect(host.chatToolMessages).toHaveLength(1);
    const first = host.chatToolMessages[0] as { runId?: string };
    expect(first.runId).toBe("run-sub");
    vi.useRealTimers();
  });

  it("accepts late same-session sub-run tool events shortly after final", () => {
    vi.useFakeTimers();
    const now = Date.now();
    const host = createHost({
      chatRunId: null,
      chatLastTerminalRunId: "run-parent",
      chatLastTerminalAt: now,
    });

    handleAgentEvent(host, {
      runId: "run-sub",
      seq: 1,
      stream: "tool",
      ts: now + 50,
      sessionKey: "main",
      data: {
        phase: "result",
        toolCallId: "tool-late-subrun",
        name: "discover_teammates",
        result: { text: "done" },
      },
    });
    vi.runOnlyPendingTimers();

    expect(host.chatToolMessages).toHaveLength(1);
    const first = host.chatToolMessages[0] as { runId?: string };
    expect(first.runId).toBe("run-sub");
    vi.useRealTimers();
  });

  it("does not backdate first-seen tool result events before already-rendered text", () => {
    vi.useFakeTimers();
    const now = Date.now();
    const host = createHost({
      chatRunId: "run-chronology",
    });

    handleAgentEvent(host, {
      runId: "run-chronology",
      seq: 1,
      stream: "tool",
      ts: now - 30_000,
      sessionKey: "main",
      data: {
        phase: "result",
        toolCallId: "tool-late-result",
        name: "read",
        result: { text: "done" },
      },
    });
    vi.runOnlyPendingTimers();

    const tool = host.chatToolMessages[0] as { timestamp?: number };
    expect(typeof tool.timestamp).toBe("number");
    expect((tool.timestamp ?? 0) >= now).toBe(true);
    vi.useRealTimers();
  });

  it("does not backdate late tool start events after a run already completed", () => {
    vi.useFakeTimers();
    const now = Date.now();
    const host = createHost({
      chatRunId: null,
      chatLastTerminalRunId: "run-late-start",
      chatLastTerminalAt: now,
    });

    handleAgentEvent(host, {
      runId: "run-late-start",
      seq: 1,
      stream: "tool",
      ts: now - 30_000,
      sessionKey: "main",
      data: {
        phase: "start",
        toolCallId: "tool-late-start",
        name: "discover_teammates",
      },
    });
    vi.runOnlyPendingTimers();

    const tool = host.chatToolMessages[0] as { timestamp?: number };
    expect(typeof tool.timestamp).toBe("number");
    expect((tool.timestamp ?? 0) >= now).toBe(true);
    vi.useRealTimers();
  });

  it("splits live assistant stream into a finalized chunk when a tool starts", () => {
    vi.useFakeTimers();
    const now = Date.now();
    const host = createHost({
      chatRunId: "run-split",
      chatMessages: [],
      chatStream: "First chunk",
      chatStreamStartedAt: now - 100,
      chatStreamCommittedPrefixLength: 0,
    }) as MutableHost & {
      chatMessages: unknown[];
      chatStream: string | null;
      chatStreamStartedAt: number | null;
      chatStreamCommittedPrefixLength: number;
    };

    handleAgentEvent(host, {
      runId: "run-split",
      seq: 1,
      stream: "tool",
      ts: now,
      sessionKey: "main",
      data: {
        phase: "start",
        toolCallId: "tool-split",
        name: "read",
      },
    });

    expect(host.chatMessages).toHaveLength(1);
    expect(host.chatMessages[0]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "First chunk" }],
    });
    expect(host.chatStream).toBe("");
    expect(host.chatStreamCommittedPrefixLength).toBe("First chunk".length);
    expect(host.chatStreamStartedAt).toBe(now);
    vi.useRealTimers();
  });

  it("merges result into pending start entry when provider switches tool id", () => {
    vi.useFakeTimers();
    const now = Date.now();
    const host = createHost({
      chatRunId: "run-switch-id",
    });

    handleAgentEvent(host, {
      runId: "run-switch-id",
      seq: 1,
      stream: "tool",
      ts: now,
      sessionKey: "main",
      data: {
        phase: "start",
        toolCallId: "tool-start-id",
        name: "discover_teammates",
      },
    });

    handleAgentEvent(host, {
      runId: "run-switch-id",
      seq: 2,
      stream: "tool",
      ts: now + 100,
      sessionKey: "main",
      data: {
        phase: "result",
        toolCallId: "tool-result-id",
        name: "discover_teammates",
        result: { text: "done" },
      },
    });
    vi.runOnlyPendingTimers();

    expect(host.chatToolMessages).toHaveLength(1);
    const first = host.chatToolMessages[0] as {
      toolCallId?: string;
      content?: Array<{ type?: string }>;
    };
    expect(first.toolCallId).toBe("tool-result-id");
    expect(first.content?.some((entry) => entry.type === "toolresult")).toBe(true);
    vi.useRealTimers();
  });

  it("merges result into pending start entry when result run id differs but session/name match", () => {
    vi.useFakeTimers();
    const now = Date.now();
    const host = createHost({
      chatRunId: "run-parent",
    });

    handleAgentEvent(host, {
      runId: "run-parent",
      seq: 1,
      stream: "tool",
      ts: now,
      sessionKey: "main",
      data: {
        phase: "start",
        toolCallId: "tool-start-id-2",
        name: "discover_teammates",
      },
    });

    vi.advanceTimersByTime(60_000);

    handleAgentEvent(host, {
      runId: "run-sub",
      seq: 2,
      stream: "tool",
      ts: now + 60_000,
      sessionKey: "main",
      data: {
        phase: "result",
        toolCallId: "tool-result-id-2",
        name: "discover_teammates",
        result: { text: "done" },
      },
    });
    vi.runOnlyPendingTimers();

    expect(host.chatToolMessages).toHaveLength(1);
    const first = host.chatToolMessages[0] as { toolCallId?: string };
    expect(first.toolCallId).toBe("tool-result-id-2");
    vi.useRealTimers();
  });
});
