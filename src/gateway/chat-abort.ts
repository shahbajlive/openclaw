import { isAbortRequestText } from "../auto-reply/reply/abort.js";
import { resolveUnseenTerminalAssistantText } from "./server-methods/chat.js";

export type ChatAbortControllerEntry = {
  controller: AbortController;
  sessionId: string;
  sessionKey: string;
  startedAtMs: number;
  expiresAtMs: number;
  /**
   * User-facing text for the in-flight run. Used by chat.history recovery so
   * refresh can keep the optimistic user row (for example bare /reset rewrite).
   */
  effectiveUserMessage?: string;
};

export function isChatStopCommandText(text: string): boolean {
  return isAbortRequestText(text);
}

export function resolveChatRunExpiresAtMs(params: {
  now: number;
  timeoutMs: number;
  graceMs?: number;
  minMs?: number;
  maxMs?: number;
}): number {
  const { now, timeoutMs, graceMs = 60_000, minMs = 2 * 60_000, maxMs = 24 * 60 * 60_000 } = params;
  const boundedTimeoutMs = Math.max(0, timeoutMs);
  const target = now + boundedTimeoutMs + graceMs;
  const min = now + minMs;
  const max = now + maxMs;
  return Math.min(max, Math.max(min, target));
}

export type ChatAbortOps = {
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
  chatRunBuffers: Map<string, string>;
  chatCommittedVisibleText?: Map<string, string>;
  chatDeltaLastBroadcastLen?: Map<string, number>;
  chatRunPhases: Map<string, "processing" | "thinking" | "typing" | "tool_running">;
  chatDeltaSentAt: Map<string, number>;
  chatAbortedRuns: Map<string, number>;
  removeChatRun: (
    sessionId: string,
    clientRunId: string,
    sessionKey?: string,
  ) => { sessionKey: string; clientRunId: string } | undefined;
  agentRunSeq: Map<string, number>;
  broadcast: (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;
  nodeSendToSession: (sessionKey: string, event: string, payload: unknown) => void;
};

function broadcastChatAborted(
  ops: ChatAbortOps,
  params: {
    runId: string;
    sessionKey: string;
    stopReason?: string;
    partialText?: string;
  },
) {
  const { runId, sessionKey, stopReason, partialText } = params;
  const lastBroadcastLen = Math.max(0, ops.chatDeltaLastBroadcastLen?.get(runId) ?? 0);
  const committedVisibleText =
    ops.chatCommittedVisibleText?.get(runId) ??
    (partialText && lastBroadcastLen > 0 ? partialText.slice(0, lastBroadcastLen) : undefined);
  const visiblePartialText = resolveUnseenTerminalAssistantText({
    fullText: partialText,
    committedVisibleText,
  });
  const baseSeq = ops.agentRunSeq.get(runId) ?? 0;
  if (visiblePartialText.trim()) {
    const deltaPayload = {
      runId,
      sessionKey,
      seq: baseSeq + 1,
      state: "delta" as const,
      phase: "typing" as const,
      message: {
        role: "assistant",
        content: [{ type: "text", text: visiblePartialText }],
        timestamp: Date.now(),
      },
    };
    ops.broadcast("chat", deltaPayload);
    ops.nodeSendToSession(sessionKey, "chat", deltaPayload);
  }
  const payload = {
    runId,
    sessionKey,
    seq: baseSeq + (visiblePartialText.trim() ? 2 : 1),
    state: "aborted" as const,
    stopReason,
  };
  ops.broadcast("chat", payload);
  ops.nodeSendToSession(sessionKey, "chat", payload);
}

export function abortChatRunById(
  ops: ChatAbortOps,
  params: {
    runId: string;
    sessionKey: string;
    stopReason?: string;
  },
): { aborted: boolean } {
  const { runId, sessionKey, stopReason } = params;
  const active = ops.chatAbortControllers.get(runId);
  if (!active) {
    return { aborted: false };
  }
  if (active.sessionKey !== sessionKey) {
    return { aborted: false };
  }

  const bufferedText = ops.chatRunBuffers.get(runId);
  const partialText = bufferedText && bufferedText.trim() ? bufferedText : undefined;
  ops.chatAbortedRuns.set(runId, Date.now());
  active.controller.abort();
  ops.chatAbortControllers.delete(runId);
  ops.chatRunBuffers.delete(runId);
  ops.chatRunPhases.delete(runId);
  ops.chatDeltaSentAt.delete(runId);
  const removed = ops.removeChatRun(runId, runId, sessionKey);
  broadcastChatAborted(ops, { runId, sessionKey, stopReason, partialText });
  ops.chatCommittedVisibleText?.delete(runId);
  ops.chatDeltaLastBroadcastLen?.delete(runId);
  ops.agentRunSeq.delete(runId);
  if (removed?.clientRunId) {
    ops.agentRunSeq.delete(removed.clientRunId);
  }
  return { aborted: true };
}

export function abortChatRunsForSessionKey(
  ops: ChatAbortOps,
  params: {
    sessionKey: string;
    stopReason?: string;
  },
): { aborted: boolean; runIds: string[] } {
  const { sessionKey, stopReason } = params;
  const runIds: string[] = [];
  for (const [runId, active] of ops.chatAbortControllers) {
    if (active.sessionKey !== sessionKey) {
      continue;
    }
    const res = abortChatRunById(ops, { runId, sessionKey, stopReason });
    if (res.aborted) {
      runIds.push(runId);
    }
  }
  return { aborted: runIds.length > 0, runIds };
}
