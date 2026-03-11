import { resolveAgentWorkspaceDir, resolveSessionAgentId } from "../agents/agent-scope.js";
import { createAgentToAgentPolicy } from "../agents/tools/sessions-access.js";
import { DEFAULT_HEARTBEAT_ACK_MAX_CHARS, stripHeartbeatToken } from "../auto-reply/heartbeat.js";
import { normalizeVerboseLevel } from "../auto-reply/thinking.js";
import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import { loadConfig } from "../config/config.js";
import { type AgentEventPayload, getAgentRunContext } from "../infra/agent-events.js";
import { resolveHeartbeatVisibility } from "../infra/heartbeat-visibility.js";
import { stripInlineDirectiveTagsForDisplay } from "../utils/directive-tags.js";
import { resolveMentionRouteInText } from "./server-methods/agent-mentions.js";
import {
  appendAssistantTranscriptMessage,
  forwardMentionRouteToAgent,
} from "./server-methods/chat.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { loadSessionEntry } from "./session-utils.js";
import { formatForLog } from "./ws-log.js";

function resolveHeartbeatAckMaxChars(): number {
  try {
    const cfg = loadConfig();
    return Math.max(
      0,
      cfg.agents?.defaults?.heartbeat?.ackMaxChars ?? DEFAULT_HEARTBEAT_ACK_MAX_CHARS,
    );
  } catch {
    return DEFAULT_HEARTBEAT_ACK_MAX_CHARS;
  }
}

function resolveHeartbeatContext(runId: string, sourceRunId?: string) {
  const primary = getAgentRunContext(runId);
  if (primary?.isHeartbeat) {
    return primary;
  }
  if (sourceRunId && sourceRunId !== runId) {
    const source = getAgentRunContext(sourceRunId);
    if (source?.isHeartbeat) {
      return source;
    }
  }
  return primary;
}

function resolveVisibleSessionKey(params: {
  chatLinkSessionKey?: string;
  eventSessionKey?: string;
  resolvedRunSessionKey?: string;
  inputProvenance?: unknown;
}) {
  if (params.chatLinkSessionKey) {
    return params.chatLinkSessionKey;
  }
  if (params.inputProvenance && typeof params.inputProvenance === "object") {
    const provenance = params.inputProvenance as Record<string, unknown>;
    const sourceSessionKey =
      typeof provenance.sourceSessionKey === "string" ? provenance.sourceSessionKey.trim() : "";
    const kind = typeof provenance.kind === "string" ? provenance.kind.trim() : "";
    if (kind === "inter_session" && sourceSessionKey) {
      return sourceSessionKey;
    }
  }
  return params.eventSessionKey ?? params.resolvedRunSessionKey;
}

/**
 * Check if heartbeat ACK/noise should be hidden from interactive chat surfaces.
 */
function shouldHideHeartbeatChatOutput(runId: string, sourceRunId?: string): boolean {
  const runContext = resolveHeartbeatContext(runId, sourceRunId);
  if (!runContext?.isHeartbeat) {
    return false;
  }

  try {
    const cfg = loadConfig();
    const visibility = resolveHeartbeatVisibility({ cfg, channel: "webchat" });
    return !visibility.showOk;
  } catch {
    // Default to suppressing if we can't load config
    return true;
  }
}

function normalizeHeartbeatChatFinalText(params: {
  runId: string;
  sourceRunId?: string;
  text: string;
}): { suppress: boolean; text: string } {
  if (!shouldHideHeartbeatChatOutput(params.runId, params.sourceRunId)) {
    return { suppress: false, text: params.text };
  }

  const stripped = stripHeartbeatToken(params.text, {
    mode: "heartbeat",
    maxAckChars: resolveHeartbeatAckMaxChars(),
  });
  if (!stripped.didStrip) {
    return { suppress: false, text: params.text };
  }
  if (stripped.shouldSkip) {
    return { suppress: true, text: "" };
  }
  return { suppress: false, text: stripped.text };
}

function isSilentReplyLeadFragment(text: string): boolean {
  const normalized = text.trim().toUpperCase();
  if (!normalized) {
    return false;
  }
  if (!/^[A-Z_]+$/.test(normalized)) {
    return false;
  }
  if (normalized === SILENT_REPLY_TOKEN) {
    return false;
  }
  return SILENT_REPLY_TOKEN.startsWith(normalized);
}

function appendUniqueSuffix(base: string, suffix: string): string {
  if (!suffix) {
    return base;
  }
  if (!base) {
    return suffix;
  }
  if (base.endsWith(suffix)) {
    return base;
  }
  const maxOverlap = Math.min(base.length, suffix.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    if (base.slice(-overlap) === suffix.slice(0, overlap)) {
      return base + suffix.slice(overlap);
    }
  }
  return base + suffix;
}

function resolveMergedAssistantText(params: {
  previousText: string;
  nextText: string;
  nextDelta: string;
}) {
  const { previousText, nextText, nextDelta } = params;
  if (nextText && previousText) {
    if (nextText === previousText) {
      return previousText;
    }
    if (nextText.startsWith(previousText)) {
      return nextText;
    }
    if (
      (previousText.startsWith(nextText) || previousText.includes(nextText)) &&
      (!nextDelta || previousText.includes(nextDelta))
    ) {
      return previousText;
    }
  }
  if (nextDelta) {
    // Some providers can restart a delta stream from the beginning of the same
    // assistant message. If the delta is already present in the buffered text,
    // treat it as a duplicate instead of appending the prefix again.
    if (previousText && previousText.includes(nextDelta)) {
      return nextText || previousText;
    }
    if (nextText && nextText.includes(nextDelta) && nextText.length >= previousText.length) {
      return nextText;
    }
    return appendUniqueSuffix(previousText, nextDelta);
  }
  if (nextText) {
    return nextText;
  }
  return previousText;
}

export type ChatRunEntry = {
  sessionKey: string;
  clientRunId: string;
};

export type ChatRunRegistry = {
  add: (sessionId: string, entry: ChatRunEntry) => void;
  peek: (sessionId: string) => ChatRunEntry | undefined;
  shift: (sessionId: string) => ChatRunEntry | undefined;
  remove: (sessionId: string, clientRunId: string, sessionKey?: string) => ChatRunEntry | undefined;
  clear: () => void;
};

export function createChatRunRegistry(): ChatRunRegistry {
  const chatRunSessions = new Map<string, ChatRunEntry[]>();

  const add = (sessionId: string, entry: ChatRunEntry) => {
    const queue = chatRunSessions.get(sessionId);
    if (queue) {
      queue.push(entry);
    } else {
      chatRunSessions.set(sessionId, [entry]);
    }
  };

  const peek = (sessionId: string) => chatRunSessions.get(sessionId)?.[0];

  const shift = (sessionId: string) => {
    const queue = chatRunSessions.get(sessionId);
    if (!queue || queue.length === 0) {
      return undefined;
    }
    const entry = queue.shift();
    if (!queue.length) {
      chatRunSessions.delete(sessionId);
    }
    return entry;
  };

  const remove = (sessionId: string, clientRunId: string, sessionKey?: string) => {
    const queue = chatRunSessions.get(sessionId);
    if (!queue || queue.length === 0) {
      return undefined;
    }
    const idx = queue.findIndex(
      (entry) =>
        entry.clientRunId === clientRunId && (sessionKey ? entry.sessionKey === sessionKey : true),
    );
    if (idx < 0) {
      return undefined;
    }
    const [entry] = queue.splice(idx, 1);
    if (!queue.length) {
      chatRunSessions.delete(sessionId);
    }
    return entry;
  };

  const clear = () => {
    chatRunSessions.clear();
  };

  return { add, peek, shift, remove, clear };
}

export type ChatRunState = {
  registry: ChatRunRegistry;
  buffers: Map<string, string>;
  phases: Map<string, "processing" | "thinking" | "typing" | "tool_running" | "finalizing">;
  deltaSentAt: Map<string, number>;
  /** Length of text at the time of the last broadcast, used to avoid duplicate flushes. */
  deltaLastBroadcastLen: Map<string, number>;
  pendingDeltaCount: Map<string, number>;
  oldestPendingDeltaAt: Map<string, number>;
  commitMode: "smooth" | "catchUp";
  catchUpExitEligibleAt?: number;
  abortedRuns: Map<string, number>;
  clear: () => void;
};

export function createChatRunState(): ChatRunState {
  const registry = createChatRunRegistry();
  const buffers = new Map<string, string>();
  const phases = new Map<
    string,
    "processing" | "thinking" | "typing" | "tool_running" | "finalizing"
  >();
  const deltaSentAt = new Map<string, number>();
  const deltaLastBroadcastLen = new Map<string, number>();
  const pendingDeltaCount = new Map<string, number>();
  const oldestPendingDeltaAt = new Map<string, number>();
  const abortedRuns = new Map<string, number>();

  const clear = () => {
    registry.clear();
    buffers.clear();
    phases.clear();
    deltaSentAt.clear();
    deltaLastBroadcastLen.clear();
    pendingDeltaCount.clear();
    oldestPendingDeltaAt.clear();
    abortedRuns.clear();
  };

  return {
    registry,
    buffers,
    phases,
    deltaSentAt,
    deltaLastBroadcastLen,
    pendingDeltaCount,
    oldestPendingDeltaAt,
    commitMode: "smooth",
    catchUpExitEligibleAt: undefined,
    abortedRuns,
    clear,
  };
}

export type ToolEventRecipientRegistry = {
  add: (key: string, connId: string) => void;
  get: (key: string) => ReadonlySet<string> | undefined;
  markFinal: (key: string) => void;
};

type ToolRecipientEntry = {
  connIds: Set<string>;
  updatedAt: number;
  finalizedAt?: number;
};

const TOOL_EVENT_RECIPIENT_TTL_MS = 10 * 60 * 1000;
const TOOL_EVENT_RECIPIENT_FINAL_GRACE_MS = 30 * 1000;

export function createToolEventRecipientRegistry(): ToolEventRecipientRegistry {
  const recipients = new Map<string, ToolRecipientEntry>();

  const prune = () => {
    if (recipients.size === 0) {
      return;
    }
    const now = Date.now();
    for (const [key, entry] of recipients) {
      const cutoff = entry.finalizedAt
        ? entry.finalizedAt + TOOL_EVENT_RECIPIENT_FINAL_GRACE_MS
        : entry.updatedAt + TOOL_EVENT_RECIPIENT_TTL_MS;
      if (now >= cutoff) {
        recipients.delete(key);
      }
    }
  };

  const add = (key: string, connId: string) => {
    if (!key || !connId) {
      return;
    }
    const now = Date.now();
    const existing = recipients.get(key);
    if (existing) {
      existing.connIds.add(connId);
      existing.updatedAt = now;
    } else {
      recipients.set(key, {
        connIds: new Set([connId]),
        updatedAt: now,
      });
    }
    prune();
  };

  const get = (key: string) => {
    const entry = recipients.get(key);
    if (!entry) {
      return undefined;
    }
    entry.updatedAt = Date.now();
    prune();
    return entry.connIds;
  };

  const markFinal = (key: string) => {
    const entry = recipients.get(key);
    if (!entry) {
      return;
    }
    entry.finalizedAt = Date.now();
    prune();
  };

  return { add, get, markFinal };
}

export type ChatEventBroadcast = (
  event: string,
  payload: unknown,
  opts?: { dropIfSlow?: boolean },
) => void;

export type NodeSendToSession = (sessionKey: string, event: string, payload: unknown) => void;

export type AgentEventHandlerOptions = {
  broadcast: ChatEventBroadcast;
  broadcastToConnIds: (
    event: string,
    payload: unknown,
    connIds: ReadonlySet<string>,
    opts?: { dropIfSlow?: boolean },
  ) => void;
  nodeSendToSession: NodeSendToSession;
  agentRunSeq: Map<string, number>;
  chatRunState: ChatRunState;
  resolveSessionKeyForRun: (runId: string) => string | undefined;
  resolveVisibleRunIdForSession?: (params: {
    runId: string;
    sessionKey?: string;
  }) => string | undefined;
  clearAgentRunContext: (runId: string) => void;
  toolEventRecipients: ToolEventRecipientRegistry;
  sessionToolEventRecipients: ToolEventRecipientRegistry;
  gatewayContext?: Pick<
    GatewayRequestContext,
    "broadcast" | "nodeSendToSession" | "agentRunSeq" | "dedupe" | "logGateway"
  >;
};

export function createAgentEventHandler({
  broadcast,
  broadcastToConnIds,
  nodeSendToSession,
  agentRunSeq,
  chatRunState,
  resolveSessionKeyForRun,
  resolveVisibleRunIdForSession,
  clearAgentRunContext,
  toolEventRecipients,
  sessionToolEventRecipients,
  gatewayContext,
}: AgentEventHandlerOptions) {
  const emitChatDelta = (
    sessionKey: string,
    clientRunId: string,
    sourceRunId: string,
    seq: number,
    text: string,
    delta?: unknown,
  ) => {
    const cleanedText = stripInlineDirectiveTagsForDisplay(text).text;
    const cleanedDelta =
      typeof delta === "string" ? stripInlineDirectiveTagsForDisplay(delta).text : "";
    const previousText = chatRunState.buffers.get(clientRunId) ?? "";
    const mergedText = resolveMergedAssistantText({
      previousText,
      nextText: cleanedText,
      nextDelta: cleanedDelta,
    });
    if (!mergedText) {
      return;
    }
    chatRunState.buffers.set(clientRunId, mergedText);
    if (isSilentReplyText(mergedText, SILENT_REPLY_TOKEN)) {
      return;
    }
    if (isSilentReplyLeadFragment(mergedText)) {
      return;
    }
    if (shouldHideHeartbeatChatOutput(clientRunId, sourceRunId)) {
      return;
    }
    const now = Date.now();
    const pendingForRun = (chatRunState.pendingDeltaCount.get(clientRunId) ?? 0) + 1;
    chatRunState.pendingDeltaCount.set(clientRunId, pendingForRun);
    if (!chatRunState.oldestPendingDeltaAt.has(clientRunId)) {
      chatRunState.oldestPendingDeltaAt.set(clientRunId, now);
    }

    const pendingDepth = Array.from(chatRunState.pendingDeltaCount.values()).reduce(
      (sum, count) => sum + count,
      0,
    );
    const oldestPending = Math.min(...chatRunState.oldestPendingDeltaAt.values(), now);
    const oldestAge = now - oldestPending;

    if (chatRunState.commitMode === "smooth") {
      if (pendingDepth >= 8 || oldestAge >= 120) {
        chatRunState.commitMode = "catchUp";
        chatRunState.catchUpExitEligibleAt = undefined;
      }
    } else if (pendingDepth <= 2 && oldestAge <= 40) {
      if (!chatRunState.catchUpExitEligibleAt) {
        chatRunState.catchUpExitEligibleAt = now;
      } else if (now - chatRunState.catchUpExitEligibleAt >= 250) {
        chatRunState.commitMode = "smooth";
        chatRunState.catchUpExitEligibleAt = undefined;
      }
    } else {
      chatRunState.catchUpExitEligibleAt = undefined;
    }

    const throttleMs = chatRunState.commitMode === "catchUp" ? 20 : 40;
    const last = chatRunState.deltaSentAt.get(clientRunId) ?? 0;
    if (now - last < throttleMs) {
      return;
    }
    chatRunState.deltaSentAt.set(clientRunId, now);
    chatRunState.phases.set(clientRunId, "typing");
    if (clientRunId !== sourceRunId) {
      chatRunState.phases.set(sourceRunId, "typing");
    }
    chatRunState.deltaLastBroadcastLen.set(clientRunId, mergedText.length);
    chatRunState.pendingDeltaCount.delete(clientRunId);
    chatRunState.oldestPendingDeltaAt.delete(clientRunId);
    const payload = {
      runId: clientRunId,
      sessionKey,
      seq,
      state: "delta" as const,
      phase: "typing" as const,
      message: {
        role: "assistant",
        content: [{ type: "text", text: mergedText }],
        timestamp: now,
      },
    };
    broadcast("chat", payload, { dropIfSlow: true });
    nodeSendToSession(sessionKey, "chat", payload);
  };

  const maybeRouteAssistantMentionFinal = async (params: {
    sessionKey: string;
    clientRunId: string;
    text: string;
  }): Promise<{ handled: boolean; text?: string }> => {
    if (!gatewayContext) {
      return { handled: false };
    }
    const trimmed = params.text.trim();
    if (!trimmed.startsWith("@")) {
      return { handled: false };
    }
    const { cfg, entry, storePath } = loadSessionEntry(params.sessionKey);
    const requesterAgentId = resolveSessionAgentId({
      sessionKey: params.sessionKey,
      config: cfg,
    });
    const mentionRoute = await resolveMentionRouteInText({
      text: trimmed,
      cfg,
      requesterSessionKey: params.sessionKey,
      workspaceDir: resolveAgentWorkspaceDir(cfg, requesterAgentId),
      action: "send",
      policy: createAgentToAgentPolicy(cfg),
    });
    const sessionId = entry?.sessionId ?? params.clientRunId;
    if (!mentionRoute) {
      return { handled: false };
    }
    if (!mentionRoute.ok || !mentionRoute.bodyWithoutMention.trim()) {
      const failureText = mentionRoute.ok
        ? "Teammate route failed: message body required after leading mention."
        : `Could not deliver to teammate: ${mentionRoute.error}`;
      appendAssistantTranscriptMessage({
        message: failureText,
        label: "Teammate route failed",
        runId: params.clientRunId,
        sessionId,
        storePath,
        sessionFile: entry?.sessionFile,
        agentId: requesterAgentId,
        createIfMissing: true,
        idempotencyKey: `${params.clientRunId}:assistant-mention-route-error`,
      });
      return { handled: true, text: failureText };
    }
    const routed = await forwardMentionRouteToAgent({
      message: mentionRoute.bodyWithoutMention.trim(),
      targetSessionKey: mentionRoute.sessionKey,
      requesterSessionKey: params.sessionKey,
      idempotencyKey: `${params.clientRunId}:assistant-mention-route`,
      context: gatewayContext as GatewayRequestContext,
      client: null,
    });
    if (!routed.ok) {
      const failureText = `Could not deliver to ${mentionRoute.mention}: ${routed.error.message}`;
      appendAssistantTranscriptMessage({
        message: failureText,
        label: "Teammate route failed",
        runId: params.clientRunId,
        sessionId,
        storePath,
        sessionFile: entry?.sessionFile,
        agentId: requesterAgentId,
        createIfMissing: true,
        idempotencyKey: `${params.clientRunId}:assistant-mention-route-error`,
      });
      gatewayContext.logGateway.warn(`assistant mention route failed: ${routed.error.message}`);
      return { handled: true, text: failureText };
    }
    const routedLabel = routed.delivery === "queued" ? "Queued for teammate" : "Sent to teammate";
    const routedNotice = `Delivered to ${mentionRoute.mention}.`;
    appendAssistantTranscriptMessage({
      message: routedNotice,
      label: routedLabel,
      runId: params.clientRunId,
      sessionId,
      storePath,
      sessionFile: entry?.sessionFile,
      agentId: requesterAgentId,
      createIfMissing: true,
      idempotencyKey: `${params.clientRunId}:assistant-mention-route-notice`,
    });
    return { handled: true, text: routedNotice };
  };

  const emitChatFinal = (
    sessionKey: string,
    clientRunId: string,
    sourceRunId: string,
    seq: number,
    jobState: "done" | "error",
    error?: unknown,
    stopReason?: string,
  ) => {
    const bufferedText = stripInlineDirectiveTagsForDisplay(
      chatRunState.buffers.get(clientRunId) ?? "",
    ).text.trim();
    const normalizedHeartbeatText = normalizeHeartbeatChatFinalText({
      runId: clientRunId,
      sourceRunId,
      text: bufferedText,
    });
    const finishWithText = (text: string, routedMentionFinal: boolean) => {
      const shouldSuppressSilent =
        normalizedHeartbeatText.suppress || isSilentReplyText(text, SILENT_REPLY_TOKEN);
      const shouldSuppressSilentLeadFragment = isSilentReplyLeadFragment(text);
      const shouldSuppressHeartbeatStreaming = shouldHideHeartbeatChatOutput(
        clientRunId,
        sourceRunId,
      );
      if (
        text &&
        !routedMentionFinal &&
        !shouldSuppressSilent &&
        !shouldSuppressSilentLeadFragment &&
        !shouldSuppressHeartbeatStreaming
      ) {
        const lastBroadcastLen = chatRunState.deltaLastBroadcastLen.get(clientRunId) ?? 0;
        if (text.length > lastBroadcastLen) {
          const flushPayload = {
            runId: clientRunId,
            sessionKey,
            seq,
            state: "delta" as const,
            message: {
              role: "assistant",
              content: [{ type: "text", text }],
              timestamp: Date.now(),
            },
          };
          broadcast("chat", flushPayload, { dropIfSlow: true });
          nodeSendToSession(sessionKey, "chat", flushPayload);
        }
      }
      chatRunState.deltaLastBroadcastLen.delete(clientRunId);
      chatRunState.buffers.delete(clientRunId);
      chatRunState.phases.delete(clientRunId);
      if (clientRunId !== sourceRunId) {
        chatRunState.phases.delete(sourceRunId);
      }
      chatRunState.deltaSentAt.delete(clientRunId);
      chatRunState.pendingDeltaCount.delete(clientRunId);
      chatRunState.oldestPendingDeltaAt.delete(clientRunId);
      if (jobState === "done") {
        const payload = {
          runId: clientRunId,
          sessionKey,
          seq,
          state: "final" as const,
          ...(stopReason && { stopReason }),
          message:
            text && !shouldSuppressSilent
              ? {
                  role: "assistant",
                  idempotencyKey: `${clientRunId}:assistant`,
                  content: [{ type: "text", text }],
                  timestamp: Date.now(),
                }
              : undefined,
        };
        broadcast("chat", payload);
        nodeSendToSession(sessionKey, "chat", payload);
        return;
      }
      const payload = {
        runId: clientRunId,
        sessionKey,
        seq,
        state: "error" as const,
        errorMessage: error ? formatForLog(error) : undefined,
      };
      broadcast("chat", payload);
      nodeSendToSession(sessionKey, "chat", payload);
    };

    const text = normalizedHeartbeatText.text.trim();
    const shouldAttemptMentionRoute =
      jobState === "done" && Boolean(gatewayContext) && text.startsWith("@");
    if (!shouldAttemptMentionRoute) {
      finishWithText(text, false);
      return;
    }
    void maybeRouteAssistantMentionFinal({
      sessionKey,
      clientRunId,
      text,
    }).then((mentionRoute) => {
      if (!mentionRoute.handled) {
        finishWithText(text, false);
        return;
      }
      finishWithText(mentionRoute.text?.trim() ?? "", true);
    });
  };

  const resolveToolVerboseLevel = (runId: string, sessionKey?: string) => {
    const runContext = getAgentRunContext(runId);
    const runVerbose = normalizeVerboseLevel(runContext?.verboseLevel);
    if (runVerbose) {
      return runVerbose;
    }
    if (!sessionKey) {
      return "off";
    }
    try {
      const { cfg, entry } = loadSessionEntry(sessionKey);
      const sessionVerbose = normalizeVerboseLevel(entry?.verboseLevel);
      if (sessionVerbose) {
        return sessionVerbose;
      }
      const defaultVerbose = normalizeVerboseLevel(cfg.agents?.defaults?.verboseDefault);
      return defaultVerbose ?? "off";
    } catch {
      return "off";
    }
  };

  return (evt: AgentEventPayload) => {
    const chatLink = chatRunState.registry.peek(evt.runId);
    const runContext = getAgentRunContext(evt.runId);
    const eventSessionKey =
      typeof evt.sessionKey === "string" && evt.sessionKey.trim() ? evt.sessionKey : undefined;
    const isControlUiVisible = runContext?.isControlUiVisible ?? true;
    const inputProvenance =
      (evt.data?.inputProvenance as Record<string, unknown> | undefined) ??
      runContext?.inputProvenance;
    const sessionKey = resolveVisibleSessionKey({
      chatLinkSessionKey: chatLink?.sessionKey,
      eventSessionKey,
      resolvedRunSessionKey: resolveSessionKeyForRun(evt.runId),
      inputProvenance,
    });
    const visibleRunId =
      chatLink?.clientRunId ??
      resolveVisibleRunIdForSession?.({ runId: evt.runId, sessionKey }) ??
      evt.runId;
    const clientRunId = visibleRunId;
    const eventRunId = visibleRunId;
    const eventForClients = eventRunId === evt.runId ? evt : { ...evt, runId: eventRunId };
    const hasDirectChatLink = Boolean(chatLink);
    const isAborted =
      chatRunState.abortedRuns.has(clientRunId) || chatRunState.abortedRuns.has(evt.runId);
    // Include sessionKey so Control UI can filter tool streams per session.
    const agentPayload = sessionKey ? { ...eventForClients, sessionKey } : eventForClients;
    const last = agentRunSeq.get(evt.runId) ?? 0;
    const isToolEvent = evt.stream === "tool";
    const toolVerbose = isToolEvent ? resolveToolVerboseLevel(evt.runId, sessionKey) : "off";
    // Build node/session tool payload: strip result/partialResult unless verbose=full.
    // WS/control-ui recipients should always receive full tool payload for live cards.
    const toolPayloadForSession =
      isToolEvent && toolVerbose !== "full"
        ? (() => {
            const data = evt.data ? { ...evt.data } : {};
            delete data.result;
            delete data.partialResult;
            return sessionKey
              ? { ...eventForClients, sessionKey, data }
              : { ...eventForClients, data };
          })()
        : agentPayload;
    if (evt.seq !== last + 1) {
      broadcast("agent", {
        runId: eventRunId,
        stream: "error",
        ts: Date.now(),
        sessionKey,
        data: {
          reason: "seq gap",
          expected: last + 1,
          received: evt.seq,
        },
      });
    }
    agentRunSeq.set(evt.runId, evt.seq);
    if (isToolEvent) {
      // Always broadcast tool events to registered WS recipients with
      // tool-events capability, regardless of verboseLevel. The verbose
      // setting only controls whether tool details are sent as channel
      // messages to messaging surfaces (Telegram, Discord, etc.).
      let recipients = toolEventRecipients.get(evt.runId);
      // Tool events may be emitted with an internal run id while the UI
      // recipient was registered on the linked client run id.
      if ((!recipients || recipients.size === 0) && visibleRunId !== evt.runId) {
        const linkedRecipients = toolEventRecipients.get(clientRunId);
        if (linkedRecipients && linkedRecipients.size > 0) {
          recipients = linkedRecipients;
          for (const connId of linkedRecipients) {
            toolEventRecipients.add(evt.runId, connId);
          }
        }
      }
      if ((!recipients || recipients.size === 0) && sessionKey) {
        const sessionRecipients = sessionToolEventRecipients.get(sessionKey);
        if (sessionRecipients && sessionRecipients.size > 0) {
          recipients = sessionRecipients;
          for (const connId of sessionRecipients) {
            toolEventRecipients.add(evt.runId, connId);
            if (visibleRunId !== evt.runId) {
              toolEventRecipients.add(clientRunId, connId);
            }
          }
        }
      }
      if (recipients && recipients.size > 0) {
        broadcastToConnIds("agent", agentPayload, recipients);
      }
    } else {
      broadcast("agent", agentPayload);
    }

    const lifecyclePhase =
      evt.stream === "lifecycle" && typeof evt.data?.phase === "string" ? evt.data.phase : null;
    const toolPhase =
      evt.stream === "tool" && typeof evt.data?.phase === "string" ? evt.data.phase : null;
    const assistantPhase =
      evt.stream === "assistant" && typeof evt.data?.phase === "string" ? evt.data.phase : null;
    const reasoningPhase =
      evt.stream === "reasoning" && typeof evt.data?.phase === "string" ? evt.data.phase : null;

    const setChatPhase = (
      phase: "processing" | "thinking" | "typing" | "tool_running" | "finalizing",
      opts?: { allowNew?: boolean; silent?: boolean },
    ) => {
      const previous = chatRunState.phases.get(clientRunId);
      if (!previous && opts?.allowNew !== true) {
        return;
      }
      chatRunState.phases.set(clientRunId, phase);
      if (clientRunId !== evt.runId) {
        chatRunState.phases.set(evt.runId, phase);
      }
      if (!sessionKey || previous === phase || opts?.silent) {
        return;
      }
      const payload = {
        runId: clientRunId,
        sessionKey,
        seq: evt.seq,
        state: "phase" as const,
        phase,
      };
      broadcast("chat", payload, { dropIfSlow: true });
      nodeSendToSession(sessionKey, "chat", payload);
    };

    if (isControlUiVisible && sessionKey) {
      if (!isAborted && lifecyclePhase === "start" && !chatLink) {
        setChatPhase("processing", { allowNew: true });
        const payload = {
          runId: eventRunId,
          sessionKey,
          seq: evt.seq,
          state: "started" as const,
          phase: "processing" as const,
          source: runContext?.queuedChatItemId ? "queue" : "agent",
          queueItemId: runContext?.queuedChatItemId,
        };
        broadcast("chat", payload, { dropIfSlow: true });
        nodeSendToSession(sessionKey, "chat", payload);
      }
      // Send tool events to node/channel subscribers only when verbose is enabled;
      // WS clients already received the event above via broadcastToConnIds.
      if (!isToolEvent || toolVerbose !== "off") {
        nodeSendToSession(sessionKey, "agent", isToolEvent ? toolPayloadForSession : agentPayload);
      }
      if (!isAborted && (evt.stream === "compaction" || evt.stream === "fallback")) {
        setChatPhase("processing");
      }
      if (!isAborted && evt.stream === "tool") {
        setChatPhase("tool_running");
      }
      if (
        !isAborted &&
        (toolPhase === "start" || toolPhase === "update" || toolPhase === "result")
      ) {
        setChatPhase("tool_running");
      }
      if (!isAborted && (reasoningPhase === "delta" || reasoningPhase === "start")) {
        setChatPhase("thinking");
      }
      if (!isAborted && reasoningPhase === "end") {
        setChatPhase("processing");
      }
      if (!isAborted && assistantPhase === "end") {
        setChatPhase("processing");
      }
      if (!isAborted && evt.stream === "assistant" && typeof evt.data?.text === "string") {
        setChatPhase("typing", { allowNew: true, silent: true });
        emitChatDelta(sessionKey, clientRunId, evt.runId, evt.seq, evt.data.text, evt.data.delta);
      } else if (!isAborted && (lifecyclePhase === "end" || lifecyclePhase === "error")) {
        if (lifecyclePhase === "end") {
          setChatPhase("finalizing");
        }
        const evtStopReason =
          typeof evt.data?.stopReason === "string" ? evt.data.stopReason : undefined;
        if (hasDirectChatLink) {
          const finished = chatRunState.registry.shift(evt.runId);
          if (!finished) {
            clearAgentRunContext(evt.runId);
            return;
          }
          emitChatFinal(
            finished.sessionKey,
            finished.clientRunId,
            evt.runId,
            evt.seq,
            lifecyclePhase === "error" ? "error" : "done",
            evt.data?.error,
            evtStopReason,
          );
        } else if (evt.runId === visibleRunId) {
          emitChatFinal(
            sessionKey,
            eventRunId,
            evt.runId,
            evt.seq,
            lifecyclePhase === "error" ? "error" : "done",
            evt.data?.error,
            evtStopReason,
          );
        }
      } else if (isAborted && (lifecyclePhase === "end" || lifecyclePhase === "error")) {
        chatRunState.abortedRuns.delete(clientRunId);
        chatRunState.abortedRuns.delete(evt.runId);
        chatRunState.buffers.delete(clientRunId);
        chatRunState.phases.delete(clientRunId);
        if (clientRunId !== evt.runId) {
          chatRunState.phases.delete(evt.runId);
        }
        chatRunState.deltaSentAt.delete(clientRunId);
        chatRunState.pendingDeltaCount.delete(clientRunId);
        chatRunState.oldestPendingDeltaAt.delete(clientRunId);
        if (chatLink) {
          chatRunState.registry.remove(evt.runId, clientRunId, sessionKey);
        }
      }
    }

    if (lifecyclePhase === "end" || lifecyclePhase === "error") {
      toolEventRecipients.markFinal(evt.runId);
      clearAgentRunContext(evt.runId);
      agentRunSeq.delete(evt.runId);
      agentRunSeq.delete(clientRunId);
    }
  };
}
