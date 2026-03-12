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

  it("ignores lifecycle start events for chat runtime ownership", () => {
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
        inputProvenance: {
          kind: "inter_session",
          sourceSessionKey: "agent:developer_lead:main",
        },
      },
    });

    expect(host.chatRunId).toBeNull();
    expect(host.chatStream).toBeNull();
    expect(host.chatStreamStartedAt).toBeNull();
    vi.useRealTimers();
  });

  it("does not hijack current chat runtime state for another active run", () => {
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
    expect(host.chatStream).toBe("");
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

  it("does not commit visible assistant stream when a live tool event arrives", () => {
    vi.useFakeTimers();
    const now = Date.now();
    const host = createHost({
      chatRunId: "run-live",
      chatStream: "Before tool call",
      chatStreamStartedAt: now - 100,
      chatStreamCommittedPrefixLength: 0,
      chatMessages: [],
    }) as MutableHost & {
      chatStream: string | null;
      chatStreamStartedAt: number | null;
      chatStreamCommittedPrefixLength: number;
      chatMessages: unknown[];
    };

    handleAgentEvent(host, {
      runId: "run-live",
      seq: 1,
      stream: "tool",
      ts: now,
      sessionKey: "main",
      data: {
        phase: "start",
        toolCallId: "tool-live-1",
        name: "read",
        args: { file: "SOUL.md" },
      },
    });

    expect(host.chatMessages).toEqual([]);
    expect(host.chatStream).toBe("Before tool call");
    expect(host.chatStreamCommittedPrefixLength).toBe(0);
    expect(host.chatStreamStartedAt).toBe(now - 100);
    vi.useRealTimers();
  });

  it("rejects same-session tool events from sub-runs while a run is active", () => {
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

    expect(host.chatToolMessages).toHaveLength(0);
    vi.useRealTimers();
  });

  it("rejects late same-session sub-run tool events shortly after final", () => {
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

    expect(host.chatToolMessages).toHaveLength(0);
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

  it("does not mutate live assistant stream when a tool starts", () => {
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

    expect(host.chatMessages).toEqual([]);
    expect(host.chatStream).toBe("First chunk");
    expect(host.chatStreamCommittedPrefixLength).toBe(0);
    expect(host.chatStreamStartedAt).toBe(now - 100);
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
