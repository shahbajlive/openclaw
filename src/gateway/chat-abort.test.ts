import { describe, expect, it, vi } from "vitest";
import {
  abortChatRunById,
  isChatStopCommandText,
  type ChatAbortOps,
  type ChatAbortControllerEntry,
} from "./chat-abort.js";

function createActiveEntry(sessionKey: string): ChatAbortControllerEntry {
  const now = Date.now();
  return {
    controller: new AbortController(),
    sessionId: "sess-1",
    sessionKey,
    startedAtMs: now,
    expiresAtMs: now + 10_000,
  };
}

function createOps(params: {
  runId: string;
  entry: ChatAbortControllerEntry;
  buffer?: string;
  committedVisibleText?: string;
  deltaLastBroadcastLen?: number;
}): ChatAbortOps & {
  broadcast: ReturnType<typeof vi.fn>;
  nodeSendToSession: ReturnType<typeof vi.fn>;
  removeChatRun: ReturnType<typeof vi.fn>;
} {
  const { runId, entry, buffer, committedVisibleText, deltaLastBroadcastLen } = params;
  const broadcast = vi.fn();
  const nodeSendToSession = vi.fn();
  const removeChatRun = vi.fn();

  return {
    chatAbortControllers: new Map([[runId, entry]]),
    chatRunBuffers: new Map(buffer !== undefined ? [[runId, buffer]] : []),
    chatCommittedVisibleText: new Map(
      committedVisibleText !== undefined ? [[runId, committedVisibleText]] : [],
    ),
    chatDeltaLastBroadcastLen: new Map(
      deltaLastBroadcastLen !== undefined ? [[runId, deltaLastBroadcastLen]] : [],
    ),
    chatRunPhases: new Map([[runId, "processing"]]),
    chatDeltaSentAt: new Map([[runId, Date.now()]]),
    chatAbortedRuns: new Map(),
    removeChatRun,
    agentRunSeq: new Map(),
    broadcast,
    nodeSendToSession,
  };
}

describe("isChatStopCommandText", () => {
  it("matches slash and standalone multilingual stop forms", () => {
    expect(isChatStopCommandText(" /STOP!!! ")).toBe(true);
    expect(isChatStopCommandText("stop please")).toBe(true);
    expect(isChatStopCommandText("do not do that")).toBe(true);
    expect(isChatStopCommandText("停止")).toBe(true);
    expect(isChatStopCommandText("やめて")).toBe(true);
    expect(isChatStopCommandText("توقف")).toBe(true);
    expect(isChatStopCommandText("остановись")).toBe(true);
    expect(isChatStopCommandText("halt")).toBe(true);
    expect(isChatStopCommandText("stopp")).toBe(true);
    expect(isChatStopCommandText("pare")).toBe(true);
    expect(isChatStopCommandText("/status")).toBe(false);
    expect(isChatStopCommandText("please do not do that")).toBe(false);
    expect(isChatStopCommandText("keep going")).toBe(false);
  });
});

describe("abortChatRunById", () => {
  it("broadcasts aborted payload with partial message when buffered text exists", () => {
    const runId = "run-1";
    const sessionKey = "main";
    const entry = createActiveEntry(sessionKey);
    const ops = createOps({ runId, entry, buffer: "  Partial reply  " });
    ops.agentRunSeq.set(runId, 2);
    ops.agentRunSeq.set("client-run-1", 4);
    ops.removeChatRun.mockReturnValue({ sessionKey, clientRunId: "client-run-1" });

    const result = abortChatRunById(ops, { runId, sessionKey, stopReason: "user" });

    expect(result).toEqual({ aborted: true });
    expect(entry.controller.signal.aborted).toBe(true);
    expect(ops.chatAbortControllers.has(runId)).toBe(false);
    expect(ops.chatRunBuffers.has(runId)).toBe(false);
    expect(ops.chatDeltaSentAt.has(runId)).toBe(false);
    expect(ops.removeChatRun).toHaveBeenCalledWith(runId, runId, sessionKey);
    expect(ops.agentRunSeq.has(runId)).toBe(false);
    expect(ops.agentRunSeq.has("client-run-1")).toBe(false);

    expect(ops.broadcast).toHaveBeenCalledTimes(2);
    const deltaPayload = ops.broadcast.mock.calls[0]?.[1] as Record<string, unknown>;
    const payload = ops.broadcast.mock.calls[1]?.[1] as Record<string, unknown>;
    expect(deltaPayload).toEqual(
      expect.objectContaining({
        runId,
        sessionKey,
        seq: 3,
        state: "delta",
        phase: "typing",
      }),
    );
    expect(deltaPayload.message).toEqual(
      expect.objectContaining({
        role: "assistant",
        content: [{ type: "text", text: "  Partial reply  " }],
      }),
    );
    expect((deltaPayload.message as { timestamp?: unknown }).timestamp).toEqual(expect.any(Number));
    expect(payload).toEqual(
      expect.objectContaining({
        runId,
        sessionKey,
        seq: 4,
        state: "aborted",
        stopReason: "user",
      }),
    );
    expect(payload.message).toBeUndefined();
    expect(ops.nodeSendToSession).toHaveBeenNthCalledWith(1, sessionKey, "chat", deltaPayload);
    expect(ops.nodeSendToSession).toHaveBeenNthCalledWith(2, sessionKey, "chat", payload);
  });

  it("omits aborted message when buffered text is empty", () => {
    const runId = "run-1";
    const sessionKey = "main";
    const entry = createActiveEntry(sessionKey);
    const ops = createOps({ runId, entry, buffer: "   " });

    const result = abortChatRunById(ops, { runId, sessionKey });

    expect(result).toEqual({ aborted: true });
    expect(ops.broadcast).toHaveBeenCalledTimes(1);
    const payload = ops.broadcast.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(payload.message).toBeUndefined();
  });

  it("preserves partial message even when abort listeners clear buffers synchronously", () => {
    const runId = "run-1";
    const sessionKey = "main";
    const entry = createActiveEntry(sessionKey);
    const ops = createOps({ runId, entry, buffer: "streamed text" });

    // Simulate synchronous cleanup triggered by AbortController listeners.
    entry.controller.signal.addEventListener("abort", () => {
      ops.chatRunBuffers.delete(runId);
    });

    const result = abortChatRunById(ops, { runId, sessionKey });

    expect(result).toEqual({ aborted: true });
    const deltaPayload = ops.broadcast.mock.calls[0]?.[1] as Record<string, unknown>;
    const abortedPayload = ops.broadcast.mock.calls[1]?.[1] as Record<string, unknown>;
    expect(deltaPayload.message).toEqual(
      expect.objectContaining({
        role: "assistant",
        content: [{ type: "text", text: "streamed text" }],
      }),
    );
    expect(abortedPayload.message).toBeUndefined();
  });

  it("emits only the unseen suffix when aborting after a committed visible prefix", () => {
    const runId = "run-1";
    const sessionKey = "main";
    const entry = createActiveEntry(sessionKey);
    const ops = createOps({
      runId,
      entry,
      buffer: "I'm ready to help! Let me check the relevant files and then respond in my persona.",
      committedVisibleText:
        "I'm ready to help! Let me check the relevant files and then respond in my",
    });

    const result = abortChatRunById(ops, { runId, sessionKey, stopReason: "user" });

    expect(result).toEqual({ aborted: true });
    const deltaPayload = ops.broadcast.mock.calls[0]?.[1] as Record<string, unknown>;
    const payload = ops.broadcast.mock.calls[1]?.[1] as Record<string, unknown>;
    expect(deltaPayload).toEqual(
      expect.objectContaining({
        runId,
        sessionKey,
        state: "delta",
        phase: "typing",
      }),
    );
    expect(deltaPayload.message).toEqual(
      expect.objectContaining({
        role: "assistant",
        content: [{ type: "text", text: " persona." }],
      }),
    );
    expect(payload).toEqual(
      expect.objectContaining({
        runId,
        sessionKey,
        state: "aborted",
        stopReason: "user",
      }),
    );
    expect(payload.message).toBeUndefined();
  });

  it("emits only the unseen suffix when aborting after a tool split", () => {
    const runId = "run-1";
    const sessionKey = "main";
    const entry = createActiveEntry(sessionKey);
    const ops = createOps({
      runId,
      entry,
      buffer: "I'm ready to help! Let me check the relevant files and then greet you.",
      committedVisibleText: "I'm ready to help! Let me check the relevant files and then",
    });

    const result = abortChatRunById(ops, { runId, sessionKey, stopReason: "rpc" });

    expect(result).toEqual({ aborted: true });
    const deltaPayload = ops.broadcast.mock.calls[0]?.[1] as Record<string, unknown>;
    const payload = ops.broadcast.mock.calls[1]?.[1] as Record<string, unknown>;
    expect(deltaPayload).toEqual(
      expect.objectContaining({
        runId,
        sessionKey,
        state: "delta",
        phase: "typing",
      }),
    );
    expect(deltaPayload.message).toEqual(
      expect.objectContaining({
        role: "assistant",
        content: [{ type: "text", text: " greet you." }],
      }),
    );
    expect(payload).toEqual(
      expect.objectContaining({
        runId,
        sessionKey,
        state: "aborted",
        stopReason: "rpc",
      }),
    );
    expect(payload.message).toBeUndefined();
  });

  it("falls back to last broadcast length when committed visible text is unavailable", () => {
    const runId = "run-1";
    const sessionKey = "main";
    const entry = createActiveEntry(sessionKey);
    const fullText =
      "I'm ready to help! Let me check the current session context and memory files.";
    const prefix = "I'm ready to help! Let me check the current session context and";
    const ops = createOps({
      runId,
      entry,
      buffer: fullText,
      deltaLastBroadcastLen: prefix.length,
    });

    const result = abortChatRunById(ops, { runId, sessionKey, stopReason: "rpc" });

    expect(result).toEqual({ aborted: true });
    expect(ops.chatDeltaLastBroadcastLen?.has(runId)).toBe(false);
    const deltaPayload = ops.broadcast.mock.calls[0]?.[1] as Record<string, unknown>;
    const payload = ops.broadcast.mock.calls[1]?.[1] as Record<string, unknown>;
    expect(deltaPayload.message).toEqual(
      expect.objectContaining({
        role: "assistant",
        content: [{ type: "text", text: " memory files." }],
      }),
    );
    expect(payload.message).toBeUndefined();
  });
});
