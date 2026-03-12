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
  resolveUnseenTerminalAssistantText,
} from "./server-methods/chat.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { loadSessionEntry, readSessionMessages } from "./session-utils.js";
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
  if (params.eventSessionKey) {
    return params.eventSessionKey;
  }
  if (params.resolvedRunSessionKey) {
    return params.resolvedRunSessionKey;
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
  return undefined;
}

function resolveInterSessionSourceSessionKey(inputProvenance?: unknown): string | undefined {
  if (!inputProvenance || typeof inputProvenance !== "object") {
    return undefined;
  }
  const provenance = inputProvenance as Record<string, unknown>;
  const sourceSessionKey =
    typeof provenance.sourceSessionKey === "string" ? provenance.sourceSessionKey.trim() : "";
  const kind = typeof provenance.kind === "string" ? provenance.kind.trim() : "";
  if (kind === "inter_session" && sourceSessionKey) {
    return sourceSessionKey;
  }
  return undefined;
}

function deriveLegacyActivityKind(evt: AgentEventPayload): string | undefined {
  if (typeof evt.kind === "string" && evt.kind.trim()) {
    return evt.kind;
  }
  if (evt.stream === "assistant") {
    return "assistant_message";
  }
  if (evt.stream === "tool") {
    return "tool_call";
  }
  if (evt.stream === "reasoning") {
    return "reasoning";
  }
  return undefined;
}

function deriveLegacyEventType(evt: AgentEventPayload, kind?: string): string {
  if (typeof evt.eventType === "string" && evt.eventType.trim()) {
    return evt.eventType;
  }
  if (evt.stream === "assistant" || evt.stream === "reasoning") {
    const phase = typeof evt.data?.phase === "string" ? evt.data.phase.trim() : "";
    if (phase === "start" || phase === "started") {
      return "activity.started";
    }
    if (phase === "end" || phase === "completed" || phase === "failed" || phase === "aborted") {
      return "activity.completed";
    }
    return "activity.output";
  }
  if (evt.stream === "tool") {
    const phase = typeof evt.data?.phase === "string" ? evt.data.phase.trim() : "";
    if (phase === "start" || phase === "started") {
      return "activity.started";
    }
    if (
      phase === "end" ||
      phase === "completed" ||
      phase === "failed" ||
      phase === "cancelled" ||
      phase === "canceled"
    ) {
      return "activity.completed";
    }
    return "activity.updated";
  }
  if (evt.stream === "lifecycle") {
    const phase = typeof evt.data?.phase === "string" ? evt.data.phase.trim() : "";
    if (phase === "start" || phase === "started") {
      return "run.started";
    }
    if (phase === "end" || phase === "completed" || phase === "failed" || phase === "aborted") {
      return "run.completed";
    }
    return "run.updated";
  }
  return kind ? "activity.updated" : "run.updated";
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

function resolveCommittedVisibleText(params: {
  fullText: string;
  lastBroadcastLen: number;
}): string {
  const { fullText } = params;
  const lastBroadcastLen = Math.max(0, params.lastBroadcastLen);
  if (!fullText || lastBroadcastLen <= 0) {
    return "";
  }
  if (fullText.length <= lastBroadcastLen) {
    return fullText.trim();
  }
  return fullText.slice(0, lastBroadcastLen).trim();
}

function resolvePersistedCanonicalAssistantPrefix(params: {
  sessionKey: string;
  clientRunId: string;
}): string {
  try {
    const { storePath, entry } = loadSessionEntry(params.sessionKey);
    const sessionId = entry?.sessionId?.trim();
    if (!sessionId) {
      return "";
    }
    const history = readSessionMessages(sessionId, storePath, entry?.sessionFile);
    for (let i = history.length - 1; i >= 0; i -= 1) {
      const candidate = history[i] as Record<string, unknown>;
      if (!candidate || typeof candidate !== "object") {
        continue;
      }
      const runId = typeof candidate.runId === "string" ? candidate.runId.trim() : "";
      const role = typeof candidate.role === "string" ? candidate.role.trim().toLowerCase() : "";
      const timeline = candidate.__openclaw as { timeline?: { canonical?: boolean } } | undefined;
      if (
        runId !== params.clientRunId ||
        role !== "assistant" ||
        timeline?.timeline?.canonical !== true
      ) {
        continue;
      }
      const content = candidate.content;
      if (!Array.isArray(content)) {
        continue;
      }
      const text = content
        .map((block) =>
          block &&
          typeof block === "object" &&
          (block as { type?: unknown }).type === "text" &&
          typeof (block as { text?: unknown }).text === "string"
            ? (block as { text: string }).text
            : "",
        )
        .join("\n");
      if (text.trim()) {
        return text;
      }
    }
  } catch {
    // Fallback to in-memory state only when transcript lookup is unavailable.
  }
  return "";
}

function resolveUnbroadcastSuffix(params: { fullText: string; lastBroadcastLen: number }): string {
  return resolveUnseenTerminalAssistantText({
    fullText: params.fullText,
    committedVisibleText: resolveCommittedVisibleText(params),
  });
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
  phases: Map<string, "processing" | "thinking" | "typing" | "tool_running">;
  committedVisibleText: Map<string, string>;
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
  const phases = new Map<string, "processing" | "thinking" | "typing" | "tool_running">();
  const committedVisibleText = new Map<string, string>();
  const deltaSentAt = new Map<string, number>();
  const deltaLastBroadcastLen = new Map<string, number>();
  const pendingDeltaCount = new Map<string, number>();
  const oldestPendingDeltaAt = new Map<string, number>();
  const abortedRuns = new Map<string, number>();

  const clear = () => {
    registry.clear();
    buffers.clear();
    phases.clear();
    committedVisibleText.clear();
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
    committedVisibleText,
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

export type LiveEventRecipientRegistry = {
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

export function createLiveEventRecipientRegistry(): LiveEventRecipientRegistry {
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

export const createToolEventRecipientRegistry = createLiveEventRecipientRegistry;

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
  liveEventRecipients: LiveEventRecipientRegistry;
  sessionLiveEventRecipients: LiveEventRecipientRegistry;
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
  liveEventRecipients,
  sessionLiveEventRecipients,
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
    const lastBroadcastLen = chatRunState.deltaLastBroadcastLen.get(clientRunId) ?? 0;
    const unbroadcastSuffix = resolveUnbroadcastSuffix({
      fullText: mergedText,
      lastBroadcastLen,
    });
    chatRunState.pendingDeltaCount.delete(clientRunId);
    chatRunState.oldestPendingDeltaAt.delete(clientRunId);
    if (!unbroadcastSuffix) {
      return;
    }
    chatRunState.deltaSentAt.set(clientRunId, now);
    chatRunState.phases.set(clientRunId, "typing");
    if (clientRunId !== sourceRunId) {
      chatRunState.phases.set(sourceRunId, "typing");
    }
    chatRunState.deltaLastBroadcastLen.set(clientRunId, mergedText.length);
    chatRunState.committedVisibleText.set(clientRunId, mergedText);
    if (clientRunId !== sourceRunId) {
      chatRunState.committedVisibleText.set(sourceRunId, mergedText);
    }
    const payload = {
      runId: clientRunId,
      sessionKey,
      seq,
      state: "delta" as const,
      phase: "typing" as const,
      message: {
        role: "assistant",
        content: [{ type: "text", text: unbroadcastSuffix }],
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

  const persistCanonicalAssistantTimelineRow = (params: {
    sessionKey: string;
    clientRunId: string;
    text: string;
    seq: number;
  }) => {
    if (!gatewayContext) {
      return;
    }
    const text = params.text.trim();
    if (!text) {
      return;
    }
    const { cfg, entry, storePath } = loadSessionEntry(params.sessionKey);
    const sessionId = entry?.sessionId ?? params.clientRunId;
    appendAssistantTranscriptMessage({
      message: text,
      runId: params.clientRunId,
      sessionId,
      storePath,
      sessionFile: entry?.sessionFile,
      agentId: resolveSessionAgentId({
        sessionKey: params.sessionKey,
        config: cfg,
      }),
      createIfMissing: true,
      idempotencyKey: `${params.clientRunId}:timeline:${params.seq}`,
      timeline: {
        canonical: true,
        seq: params.seq,
      },
    });
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
      const lastBroadcastLen = chatRunState.deltaLastBroadcastLen.get(clientRunId) ?? 0;
      const committedVisibleText =
        chatRunState.committedVisibleText.get(clientRunId) ||
        resolvePersistedCanonicalAssistantPrefix({
          sessionKey,
          clientRunId,
        }) ||
        resolveCommittedVisibleText({
          fullText: text,
          lastBroadcastLen,
        });
      const unbroadcastSuffix = resolveUnseenTerminalAssistantText({
        fullText: text,
        committedVisibleText,
      });
      let flushedVisibleSuffix = false;
      if (
        text &&
        !routedMentionFinal &&
        !shouldSuppressSilent &&
        !shouldSuppressSilentLeadFragment &&
        !shouldSuppressHeartbeatStreaming
      ) {
        if (unbroadcastSuffix) {
          persistCanonicalAssistantTimelineRow({
            sessionKey,
            clientRunId,
            text: unbroadcastSuffix,
            seq,
          });
          const flushPayload = {
            runId: clientRunId,
            sessionKey,
            seq,
            state: "delta" as const,
            message: {
              role: "assistant",
              content: [{ type: "text", text: unbroadcastSuffix }],
              timestamp: Date.now(),
            },
          };
          broadcast("chat", flushPayload, { dropIfSlow: true });
          nodeSendToSession(sessionKey, "chat", flushPayload);
          flushedVisibleSuffix = true;
        }
      }
      chatRunState.deltaLastBroadcastLen.delete(clientRunId);
      chatRunState.buffers.delete(clientRunId);
      chatRunState.committedVisibleText.delete(clientRunId);
      chatRunState.committedVisibleText.delete(sourceRunId);
      chatRunState.phases.delete(clientRunId);
      if (clientRunId !== sourceRunId) {
        chatRunState.phases.delete(sourceRunId);
      }
      chatRunState.deltaSentAt.delete(clientRunId);
      chatRunState.pendingDeltaCount.delete(clientRunId);
      chatRunState.oldestPendingDeltaAt.delete(clientRunId);
      if (jobState === "done") {
        const hadVisibleAssistantOutput =
          Boolean(committedVisibleText) || lastBroadcastLen > 0 || flushedVisibleSuffix;
        const finalVisibleText =
          routedMentionFinal || !hadVisibleAssistantOutput ? text : undefined;
        const payload = {
          runId: clientRunId,
          sessionKey,
          seq,
          state: "final" as const,
          ...(stopReason && { stopReason }),
          message:
            finalVisibleText && !shouldSuppressSilent
              ? {
                  role: "assistant",
                  idempotencyKey: `${clientRunId}:assistant`,
                  content: [{ type: "text", text: finalVisibleText }],
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
    const eventKind = deriveLegacyActivityKind(evt);
    const eventType = deriveLegacyEventType(evt, eventKind);
    const eventData =
      eventType === "activity.output"
        ? (evt.output ?? evt.data)
        : eventType === "activity.started"
          ? (evt.input ?? evt.data)
          : eventType === "activity.updated"
            ? (evt.patch ?? evt.data)
            : eventType === "activity.completed"
              ? (evt.result ?? evt.data)
              : eventType === "run.updated"
                ? (evt.patch ?? evt.data)
                : eventType === "run.completed"
                  ? (evt.result ?? evt.data)
                  : undefined;
    const inputProvenance =
      (evt.inputProvenance as Record<string, unknown> | undefined) ?? runContext?.inputProvenance;
    const sessionKey = resolveVisibleSessionKey({
      chatLinkSessionKey: chatLink?.sessionKey,
      eventSessionKey,
      resolvedRunSessionKey: resolveSessionKeyForRun(evt.runId),
      inputProvenance,
    });
    const isToolEvent =
      eventType.startsWith("activity.") &&
      (eventKind === "tool_call" ||
        eventKind === "subagent_call" ||
        eventKind === "peer_agent_call");
    const toolVisibleSessionKey = isToolEvent
      ? (resolveInterSessionSourceSessionKey(inputProvenance) ?? sessionKey)
      : sessionKey;
    const visibleRunId =
      chatLink?.clientRunId ??
      resolveVisibleRunIdForSession?.({ runId: evt.runId, sessionKey: toolVisibleSessionKey }) ??
      evt.runId;
    const clientRunId = visibleRunId;
    const eventRunId = visibleRunId;
    const eventForClients = eventRunId === evt.runId ? evt : { ...evt, runId: eventRunId };
    const hasDirectChatLink = Boolean(chatLink);
    const isAborted =
      chatRunState.abortedRuns.has(clientRunId) || chatRunState.abortedRuns.has(evt.runId);
    // Include sessionKey so Control UI can filter tool streams per session.
    const payloadSessionKey = isToolEvent ? toolVisibleSessionKey : sessionKey;
    const agentPayload = payloadSessionKey
      ? { ...eventForClients, sessionKey: payloadSessionKey }
      : eventForClients;
    const last = agentRunSeq.get(evt.runId) ?? 0;
    const toolVerbose = isToolEvent ? resolveToolVerboseLevel(evt.runId, sessionKey) : "off";
    // Build node/session tool payload: strip result/partialResult unless verbose=full.
    // WS/control-ui recipients should always receive full tool payload for live cards.
    const toolPayloadForSession =
      isToolEvent && toolVerbose !== "full"
        ? {
            ...agentPayload,
            ...(agentPayload.data && typeof agentPayload.data === "object"
              ? {
                  data: {
                    ...agentPayload.data,
                    result: undefined,
                    partialResult: undefined,
                  },
                }
              : {}),
            result: undefined,
            partialResult: undefined,
          }
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
    let recipients = liveEventRecipients.get(evt.runId);
    // Events may be emitted with an internal run id while the UI
    // recipient was registered on the linked client run id.
    if ((!recipients || recipients.size === 0) && visibleRunId !== evt.runId) {
      const linkedRecipients = liveEventRecipients.get(clientRunId);
      if (linkedRecipients && linkedRecipients.size > 0) {
        recipients = linkedRecipients;
        for (const connId of linkedRecipients) {
          liveEventRecipients.add(evt.runId, connId);
        }
      }
    }
    if ((!recipients || recipients.size === 0) && payloadSessionKey) {
      const sessionRecipients = sessionLiveEventRecipients.get(payloadSessionKey);
      if (sessionRecipients && sessionRecipients.size > 0) {
        recipients = sessionRecipients;
        for (const connId of sessionRecipients) {
          liveEventRecipients.add(evt.runId, connId);
          if (visibleRunId !== evt.runId) {
            liveEventRecipients.add(clientRunId, connId);
          }
        }
      }
    }
    if (recipients && recipients.size > 0) {
      broadcastToConnIds("agent", agentPayload, recipients);
    } else if (!isToolEvent) {
      broadcast("agent", agentPayload);
    }

    const runCompleted = eventType === "run.completed";
    const activityStarted = eventType === "activity.started";
    const activityCompleted = eventType === "activity.completed";
    const outputData = (evt.output ?? eventData) as Record<string, unknown> | undefined;
    const isAssistantOutput = eventType === "activity.output" && eventKind === "assistant_message";
    const isReasoningStart = activityStarted && eventKind === "reasoning";
    const isReasoningEnd = activityCompleted && eventKind === "reasoning";

    const setChatPhase = (
      phase: "processing" | "thinking" | "typing" | "tool_running",
      opts?: { allowNew?: boolean; silent?: boolean },
    ) => {
      const previous = chatRunState.phases.get(clientRunId);
      if (previous === "typing" && phase !== "typing") {
        const bufferedText = stripInlineDirectiveTagsForDisplay(
          chatRunState.buffers.get(clientRunId) ?? "",
        ).text;
        const lastBroadcastLen = chatRunState.deltaLastBroadcastLen.get(clientRunId) ?? 0;
        const committedVisibleText = bufferedText.slice(0, Math.max(0, lastBroadcastLen)).trim();
        if (committedVisibleText) {
          chatRunState.committedVisibleText.set(clientRunId, committedVisibleText);
          if (clientRunId !== evt.runId) {
            chatRunState.committedVisibleText.set(evt.runId, committedVisibleText);
          }
          if (sessionKey) {
            persistCanonicalAssistantTimelineRow({
              sessionKey,
              clientRunId,
              text: committedVisibleText,
              seq: evt.seq,
            });
          }
        }
      }
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
      if (!isAborted && eventType === "run.started" && !chatLink) {
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
      if ((!isToolEvent || toolVerbose !== "off") && payloadSessionKey) {
        nodeSendToSession(
          payloadSessionKey,
          "agent",
          isToolEvent ? toolPayloadForSession : agentPayload,
        );
      }
      if (!isAborted && eventType.startsWith("activity.") && eventKind === "compaction") {
        setChatPhase("processing");
      }
      if (!isAborted && isToolEvent) {
        setChatPhase("tool_running");
      }
      if (!isAborted && isToolEvent) {
        setChatPhase("tool_running");
      }
      if (!isAborted && activityCompleted && isToolEvent) {
        setChatPhase("processing");
      }
      if (
        !isAborted &&
        (isReasoningStart || (eventType === "activity.output" && eventKind === "reasoning"))
      ) {
        setChatPhase("thinking");
      }
      if (!isAborted && isReasoningEnd) {
        setChatPhase("processing");
      }
      if (!isAborted && activityCompleted && eventKind === "assistant_message") {
        setChatPhase("processing");
      }
      if (
        !isAborted &&
        isAssistantOutput &&
        (typeof outputData?.text === "string" || typeof outputData?.delta === "string")
      ) {
        setChatPhase("typing", { allowNew: true, silent: true });
        emitChatDelta(
          sessionKey,
          clientRunId,
          evt.runId,
          evt.seq,
          typeof outputData?.text === "string" ? outputData.text : "",
          outputData?.delta,
        );
      } else if (!isAborted && runCompleted) {
        const evtStopReason = typeof evt.stopReason === "string" ? evt.stopReason : undefined;
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
            evt.outcome === "failed" ? "error" : "done",
            evt.error,
            evtStopReason,
          );
        } else if (evt.runId === visibleRunId) {
          emitChatFinal(
            sessionKey,
            eventRunId,
            evt.runId,
            evt.seq,
            evt.outcome === "failed" ? "error" : "done",
            evt.error,
            evtStopReason,
          );
        }
      } else if (isAborted && runCompleted) {
        chatRunState.abortedRuns.delete(clientRunId);
        chatRunState.abortedRuns.delete(evt.runId);
        chatRunState.buffers.delete(clientRunId);
        chatRunState.committedVisibleText.delete(clientRunId);
        chatRunState.committedVisibleText.delete(evt.runId);
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

    if (runCompleted) {
      liveEventRecipients.markFinal(evt.runId);
      clearAgentRunContext(evt.runId);
      agentRunSeq.delete(evt.runId);
      agentRunSeq.delete(clientRunId);
    }
  };
}
