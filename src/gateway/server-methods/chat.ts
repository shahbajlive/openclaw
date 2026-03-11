import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CURRENT_SESSION_VERSION } from "@mariozechner/pi-coding-agent";
import {
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveSessionAgentId,
} from "../../agents/agent-scope.js";
import { resolveThinkingDefault } from "../../agents/model-selection.js";
import { abortEmbeddedPiRun, isEmbeddedPiRunActive } from "../../agents/pi-embedded.js";
import { resolveAgentTimeoutMs } from "../../agents/timeout.js";
import { createAgentToAgentPolicy } from "../../agents/tools/sessions-access.js";
import { dispatchInboundMessage } from "../../auto-reply/dispatch.js";
import { enqueueFollowupRun, resolveQueueSettings } from "../../auto-reply/reply/queue.js";
import {
  ensureFollowupRunId,
  getExistingFollowupQueue,
  markFollowupQueueItemSteering,
  popSteeredFollowupQueueItems,
  popFollowupQueueItem,
  removeFollowupQueueItem,
} from "../../auto-reply/reply/queue/state.js";
import { createReplyDispatcher } from "../../auto-reply/reply/reply-dispatcher.js";
import { buildBareSessionResetPrompt } from "../../auto-reply/reply/session-reset-prompt.js";
import type { MsgContext } from "../../auto-reply/templating.js";
import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../../auto-reply/tokens.js";
import { createReplyPrefixOptions } from "../../channels/reply-prefix.js";
import { loadConfig } from "../../config/config.js";
import { resolveSessionFilePath, resolveSessionFilePathOptions } from "../../config/sessions.js";
import {
  clearAgentRunContext,
  emitAgentEvent,
  getAgentRunContext,
} from "../../infra/agent-events.js";
import { jsonUtf8Bytes } from "../../infra/json-utf8-bytes.js";
import type { InputProvenance } from "../../sessions/input-provenance.js";
import { resolveSendPolicy } from "../../sessions/send-policy.js";
import { parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import {
  stripInlineDirectiveTagsForDisplay,
  stripInlineDirectiveTagsFromMessageForDisplay,
} from "../../utils/directive-tags.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  isWebchatClient,
  normalizeMessageChannel,
} from "../../utils/message-channel.js";
import {
  abortChatRunById,
  abortChatRunsForSessionKey,
  type ChatAbortControllerEntry,
  type ChatAbortOps,
  isChatStopCommandText,
  resolveChatRunExpiresAtMs,
} from "../chat-abort.js";
import { type ChatImageContent, parseMessageWithAttachments } from "../chat-attachments.js";
import { stripEnvelopeFromMessage, stripEnvelopeFromMessages } from "../chat-sanitize.js";
import {
  GATEWAY_CLIENT_CAPS,
  GATEWAY_CLIENT_MODES,
  hasGatewayClientCap,
} from "../protocol/client-info.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateChatAbortParams,
  validateChatHistoryParams,
  validateChatInjectParams,
  validateChatQueueItemActionParams,
  validateChatSendParams,
} from "../protocol/index.js";
import { CHAT_SEND_SESSION_KEY_MAX_LENGTH } from "../protocol/schema/primitives.js";
import { getMaxChatHistoryMessagesBytes } from "../server-constants.js";
import {
  capArrayByJsonBytes,
  loadSessionEntry,
  readSessionMessages,
  resolveSessionModelRef,
} from "../session-utils.js";
import { formatForLog } from "../ws-log.js";
import { listActiveAgentRunsForSession } from "./agent-job.js";
import { resolveMentionRouteInText } from "./agent-mentions.js";
import { injectTimestamp, timestampOptsFromConfig } from "./agent-timestamp.js";
import { setGatewayDedupeEntry } from "./agent-wait-dedupe.js";
import { agentHandlers } from "./agent.js";
import { normalizeRpcAttachmentsToChatAttachments } from "./attachment-normalize.js";
import {
  appendInjectedAssistantMessageToTranscript,
  appendInjectedUserMessageToTranscript,
} from "./chat-transcript-inject.js";
import type { GatewayClient, GatewayRequestContext, GatewayRequestHandlers } from "./types.js";

type TranscriptAppendResult = {
  ok: boolean;
  messageId?: string;
  message?: Record<string, unknown>;
  error?: string;
};

type AbortOrigin = "rpc" | "stop-command";

type AbortedPartialSnapshot = {
  runId: string;
  sessionId: string;
  text: string;
  abortOrigin: AbortOrigin;
};

const CHAT_HISTORY_TEXT_MAX_CHARS = 12_000;
const CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES = 128 * 1024;
const CHAT_HISTORY_OVERSIZED_PLACEHOLDER = "[chat.history omitted: message too large]";
const BARE_SESSION_RESET_RE = /^\/(?:new|reset)\s*$/i;
let chatHistoryPlaceholderEmitCount = 0;
const CHANNEL_AGNOSTIC_SESSION_SCOPES = new Set([
  "main",
  "direct",
  "dm",
  "group",
  "channel",
  "cron",
  "run",
  "subagent",
  "acp",
  "thread",
  "topic",
]);
const CHANNEL_SCOPED_SESSION_SHAPES = new Set(["direct", "dm", "group", "channel"]);

type ChatSendDeliveryEntry = {
  deliveryContext?: {
    channel?: string;
    to?: string;
    accountId?: string;
    threadId?: string | number;
  };
  lastChannel?: string;
  lastTo?: string;
  lastAccountId?: string;
  lastThreadId?: string | number;
};

type ChatSendOriginatingRoute = {
  originatingChannel: string;
  originatingTo?: string;
  accountId?: string;
  messageThreadId?: string | number;
  explicitDeliverRoute: boolean;
};

type ChatQueuedMessageSnapshot = {
  id: string;
  text: string;
  createdAt: number;
  steering?: boolean;
};

type ChatQueueChangedPayload = {
  sessionKey: string;
  queue: ChatQueuedMessageSnapshot[];
};

type QueuedChatMessage = {
  role: "user";
  content: Array<{ type: "text"; text: string }>;
  timestamp: number;
  idempotencyKey: string;
  queued: true;
};

type ChatQueueCandidate = {
  key: string;
};

function resolveQueuedChatMessages(params: {
  sessionKey: string;
  canonicalKey: string;
  sessionId?: string;
}): ChatQueuedMessageSnapshot[] {
  const seen = new Set<string>();
  const snapshots: ChatQueuedMessageSnapshot[] = [];
  const candidates = [params.canonicalKey, params.sessionKey, params.sessionId]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim());

  for (const key of candidates) {
    const queue = getExistingFollowupQueue(key);
    if (!queue?.items.length) {
      continue;
    }
    for (const item of queue.items) {
      const id =
        item.id?.trim() ||
        item.messageId?.trim() ||
        `${item.enqueuedAt}:${item.summaryLine?.trim() || item.prompt.trim().slice(0, 64)}`;
      if (seen.has(id)) {
        continue;
      }
      seen.add(id);
      snapshots.push({
        id,
        text: item.summaryLine?.trim() || item.prompt.trim(),
        createdAt: item.enqueuedAt,
        steering: item.steering === true,
      });
    }
  }

  return snapshots.toSorted((a, b) => a.createdAt - b.createdAt);
}

function resolveQueueCandidates(params: {
  sessionKey: string;
  canonicalKey: string;
  sessionId?: string;
}): ChatQueueCandidate[] {
  const seen = new Set<string>();
  const values = [params.canonicalKey, params.sessionKey, params.sessionId]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim());
  const candidates: ChatQueueCandidate[] = [];
  for (const key of values) {
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    candidates.push({ key });
  }
  return candidates;
}

function resolveQueueItemSnapshot(item: {
  id?: string;
  messageId?: string;
  enqueuedAt: number;
  summaryLine?: string;
  prompt: string;
  steering?: boolean;
}) {
  const id =
    item.id?.trim() ||
    item.messageId?.trim() ||
    `${item.enqueuedAt}:${item.summaryLine?.trim() || item.prompt.trim().slice(0, 64)}`;
  return {
    id,
    text: item.summaryLine?.trim() || item.prompt.trim(),
    createdAt: item.enqueuedAt,
    editable: true,
    sendable: item.steering !== true,
    steering: item.steering === true,
  };
}

function buildQueuedChatMessage(params: {
  itemId: string;
  text: string;
  createdAt: number;
}): QueuedChatMessage {
  return {
    role: "user",
    content: [{ type: "text", text: params.text }],
    timestamp: params.createdAt,
    idempotencyKey: params.itemId,
    queued: true,
  };
}

function findQueuedChatMessage(params: {
  sessionKey: string;
  canonicalKey: string;
  sessionId?: string;
  itemId: string;
}) {
  const lookupId = params.itemId.trim();
  if (!lookupId) {
    return null;
  }
  for (const candidate of resolveQueueCandidates(params)) {
    const queue = getExistingFollowupQueue(candidate.key);
    if (!queue?.items.length) {
      continue;
    }
    const item = queue.items.find((entry) => {
      const snapshot = resolveQueueItemSnapshot(entry);
      const messageId = entry.messageId?.trim();
      return snapshot.id === lookupId || messageId === lookupId;
    });
    if (item) {
      return { key: candidate.key, item };
    }
  }
  return null;
}

function resolveChatSendOriginatingRoute(params: {
  client?: { mode?: string | null; id?: string | null } | null;
  deliver?: boolean;
  entry?: ChatSendDeliveryEntry;
  hasConnectedClient?: boolean;
  mainKey?: string;
  sessionKey: string;
}): ChatSendOriginatingRoute {
  const shouldDeliverExternally = params.deliver === true;
  if (!shouldDeliverExternally) {
    return {
      originatingChannel: INTERNAL_MESSAGE_CHANNEL,
      explicitDeliverRoute: false,
    };
  }

  const routeChannelCandidate = normalizeMessageChannel(
    params.entry?.deliveryContext?.channel ?? params.entry?.lastChannel,
  );
  const routeToCandidate = params.entry?.deliveryContext?.to ?? params.entry?.lastTo;
  const routeAccountIdCandidate =
    params.entry?.deliveryContext?.accountId ?? params.entry?.lastAccountId ?? undefined;
  const routeThreadIdCandidate =
    params.entry?.deliveryContext?.threadId ?? params.entry?.lastThreadId;
  if (params.sessionKey.length > CHAT_SEND_SESSION_KEY_MAX_LENGTH) {
    return {
      originatingChannel: INTERNAL_MESSAGE_CHANNEL,
      explicitDeliverRoute: false,
    };
  }

  const parsedSessionKey = parseAgentSessionKey(params.sessionKey);
  const sessionScopeParts = (parsedSessionKey?.rest ?? params.sessionKey)
    .split(":", 3)
    .filter(Boolean);
  const sessionScopeHead = sessionScopeParts[0];
  const sessionChannelHint = normalizeMessageChannel(sessionScopeHead);
  const normalizedSessionScopeHead = (sessionScopeHead ?? "").trim().toLowerCase();
  const sessionPeerShapeCandidates = [sessionScopeParts[1], sessionScopeParts[2]]
    .map((part) => (part ?? "").trim().toLowerCase())
    .filter(Boolean);
  const isChannelAgnosticSessionScope = CHANNEL_AGNOSTIC_SESSION_SCOPES.has(
    normalizedSessionScopeHead,
  );
  const isChannelScopedSession = sessionPeerShapeCandidates.some((part) =>
    CHANNEL_SCOPED_SESSION_SHAPES.has(part),
  );
  const hasLegacyChannelPeerShape =
    !isChannelScopedSession &&
    typeof sessionScopeParts[1] === "string" &&
    sessionChannelHint === routeChannelCandidate;
  const isFromWebchatClient =
    isWebchatClient(params.client) || params.client?.mode === GATEWAY_CLIENT_MODES.UI;
  const configuredMainKey = (params.mainKey ?? "main").trim().toLowerCase();
  const isConfiguredMainSessionScope =
    normalizedSessionScopeHead.length > 0 && normalizedSessionScopeHead === configuredMainKey;

  // Keep explicit delivery for channel-scoped sessions, but refuse to inherit
  // stale external routes for shared-main and other channel-agnostic webchat/UI
  // turns where the session key does not encode the user's current target.
  // Preserve the old configured-main contract: any connected non-webchat client
  // may inherit the last external route even when client metadata is absent.
  const canInheritDeliverableRoute = Boolean(
    sessionChannelHint &&
    sessionChannelHint !== INTERNAL_MESSAGE_CHANNEL &&
    ((!isChannelAgnosticSessionScope && (isChannelScopedSession || hasLegacyChannelPeerShape)) ||
      (isConfiguredMainSessionScope && params.hasConnectedClient && !isFromWebchatClient)),
  );
  const hasDeliverableRoute =
    canInheritDeliverableRoute &&
    routeChannelCandidate &&
    routeChannelCandidate !== INTERNAL_MESSAGE_CHANNEL &&
    typeof routeToCandidate === "string" &&
    routeToCandidate.trim().length > 0;

  if (!hasDeliverableRoute) {
    return {
      originatingChannel: INTERNAL_MESSAGE_CHANNEL,
      explicitDeliverRoute: false,
    };
  }

  return {
    originatingChannel: routeChannelCandidate,
    originatingTo: routeToCandidate,
    accountId: routeAccountIdCandidate,
    messageThreadId: routeThreadIdCandidate,
    explicitDeliverRoute: true,
  };
}

function stripDisallowedChatControlChars(message: string): string {
  let output = "";
  for (const char of message) {
    const code = char.charCodeAt(0);
    if (code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127)) {
      output += char;
    }
  }
  return output;
}

function buildSteerMessagesPrefix(messages: Array<{ text: string }>): string {
  const cleaned = messages.map((message) => message.text.trim()).filter(Boolean);
  if (cleaned.length === 0) {
    return "";
  }
  const lines = cleaned.map((message) => `- ${message.replace(/\n/g, "\n  ")}`);
  return `Queued context to include in this turn:\n${lines.join("\n")}\n\n`;
}

export function sanitizeChatSendMessageInput(
  message: string,
): { ok: true; message: string } | { ok: false; error: string } {
  const normalized = message.normalize("NFC");
  if (normalized.includes("\u0000")) {
    return { ok: false, error: "message must not contain null bytes" };
  }
  return { ok: true, message: stripDisallowedChatControlChars(normalized) };
}

function truncateChatHistoryText(text: string): { text: string; truncated: boolean } {
  if (text.length <= CHAT_HISTORY_TEXT_MAX_CHARS) {
    return { text, truncated: false };
  }
  return {
    text: `${text.slice(0, CHAT_HISTORY_TEXT_MAX_CHARS)}\n...(truncated)...`,
    truncated: true,
  };
}

function sanitizeChatHistoryContentBlock(block: unknown): { block: unknown; changed: boolean } {
  if (!block || typeof block !== "object") {
    return { block, changed: false };
  }
  const entry = { ...(block as Record<string, unknown>) };
  let changed = false;
  if (typeof entry.text === "string") {
    const stripped = stripInlineDirectiveTagsForDisplay(entry.text);
    const res = truncateChatHistoryText(stripped.text);
    entry.text = res.text;
    changed ||= stripped.changed || res.truncated;
  }
  if (typeof entry.partialJson === "string") {
    const res = truncateChatHistoryText(entry.partialJson);
    entry.partialJson = res.text;
    changed ||= res.truncated;
  }
  if (typeof entry.arguments === "string") {
    const res = truncateChatHistoryText(entry.arguments);
    entry.arguments = res.text;
    changed ||= res.truncated;
  }
  if (typeof entry.thinking === "string") {
    const res = truncateChatHistoryText(entry.thinking);
    entry.thinking = res.text;
    changed ||= res.truncated;
  }
  if ("thinkingSignature" in entry) {
    delete entry.thinkingSignature;
    changed = true;
  }
  const type = typeof entry.type === "string" ? entry.type : "";
  if (type === "image" && typeof entry.data === "string") {
    const bytes = Buffer.byteLength(entry.data, "utf8");
    delete entry.data;
    entry.omitted = true;
    entry.bytes = bytes;
    changed = true;
  }
  return { block: changed ? entry : block, changed };
}

function sanitizeChatHistoryMessage(message: unknown): { message: unknown; changed: boolean } {
  if (!message || typeof message !== "object") {
    return { message, changed: false };
  }
  const entry = { ...(message as Record<string, unknown>) };
  let changed = false;

  if ("details" in entry) {
    delete entry.details;
    changed = true;
  }
  if ("usage" in entry) {
    delete entry.usage;
    changed = true;
  }
  if ("cost" in entry) {
    delete entry.cost;
    changed = true;
  }

  if (typeof entry.content === "string") {
    const stripped = stripInlineDirectiveTagsForDisplay(entry.content);
    const res = truncateChatHistoryText(stripped.text);
    entry.content = res.text;
    changed ||= stripped.changed || res.truncated;
  } else if (Array.isArray(entry.content)) {
    const updated = entry.content.map((block) => sanitizeChatHistoryContentBlock(block));
    if (updated.some((item) => item.changed)) {
      entry.content = updated.map((item) => item.block);
      changed = true;
    }
  }

  if (typeof entry.text === "string") {
    const stripped = stripInlineDirectiveTagsForDisplay(entry.text);
    const res = truncateChatHistoryText(stripped.text);
    entry.text = res.text;
    changed ||= stripped.changed || res.truncated;
  }

  return { message: changed ? entry : message, changed };
}

/**
 * Extract the visible text from an assistant history message for silent-token checks.
 * Returns `undefined` for non-assistant messages or messages with no extractable text.
 * When `entry.text` is present it takes precedence over `entry.content` to avoid
 * dropping messages that carry real text alongside a stale `content: "NO_REPLY"`.
 */
function extractAssistantTextForSilentCheck(message: unknown): string | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const entry = message as Record<string, unknown>;
  if (entry.role !== "assistant") {
    return undefined;
  }
  if (typeof entry.text === "string") {
    return entry.text;
  }
  if (typeof entry.content === "string") {
    return entry.content;
  }
  if (!Array.isArray(entry.content) || entry.content.length === 0) {
    return undefined;
  }

  const texts: string[] = [];
  for (const block of entry.content) {
    if (!block || typeof block !== "object") {
      return undefined;
    }
    const typed = block as { type?: unknown; text?: unknown };
    if (typed.type !== "text" || typeof typed.text !== "string") {
      return undefined;
    }
    texts.push(typed.text);
  }
  return texts.length > 0 ? texts.join("\n") : undefined;
}

function assistantMessageHasRenderableNonTextContent(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  const entry = message as Record<string, unknown>;
  if (entry.role !== "assistant" || !Array.isArray(entry.content)) {
    return false;
  }
  return entry.content.some((block) => {
    if (!block || typeof block !== "object") {
      return false;
    }
    const typed = block as { type?: unknown };
    const normalizedType = normalizeToolBlockType(typed.type);
    return normalizedType.length > 0 && normalizedType !== "text";
  });
}

function shouldDropEmptyAssistantHistoryMessage(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  const entry = message as Record<string, unknown>;
  if (entry.role !== "assistant") {
    return false;
  }
  const text = extractAssistantTextForSilentCheck(message);
  if (typeof text === "string" && text.trim().length > 0) {
    return false;
  }
  return !assistantMessageHasRenderableNonTextContent(message);
}

function isTerminalAssistantHistoryMessage(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  const entry = message as Record<string, unknown>;
  if (entry.role !== "assistant") {
    return false;
  }
  if (shouldDropEmptyAssistantHistoryMessage(message)) {
    return true;
  }
  const text = extractAssistantTextForSilentCheck(message);
  return typeof text === "string" && text.trim().length > 0;
}

function hasTerminalAssistantHistorySince(messages: unknown[], startedAtMs: number): boolean {
  return messages.some((message) => {
    if (!message || typeof message !== "object") {
      return false;
    }
    const entry = message as Record<string, unknown>;
    return (
      isTerminalAssistantHistoryMessage(message) &&
      typeof entry.timestamp === "number" &&
      entry.timestamp >= startedAtMs
    );
  });
}

function shouldSuppressRecoveredBlankActiveRun(params: {
  startedAtMs: number;
  streamText: string;
  historyMessages: unknown[];
}): boolean {
  return (
    params.streamText.trim().length === 0 &&
    hasTerminalAssistantHistorySince(params.historyMessages, params.startedAtMs)
  );
}

function sanitizeChatHistoryMessages(messages: unknown[]): unknown[] {
  if (messages.length === 0) {
    return messages;
  }
  let changed = false;
  const next: unknown[] = [];
  for (const message of messages) {
    const res = sanitizeChatHistoryMessage(message);
    changed ||= res.changed;
    // Drop assistant messages whose entire visible text is the silent reply token.
    const text = extractAssistantTextForSilentCheck(res.message);
    if (text !== undefined && isSilentReplyText(text, SILENT_REPLY_TOKEN)) {
      changed = true;
      continue;
    }
    if (shouldDropEmptyAssistantHistoryMessage(res.message)) {
      changed = true;
      continue;
    }
    next.push(res.message);
  }
  return changed ? next : messages;
}

type CanonicalToolInvocation = {
  toolCallId: string;
  tool_call_id: string;
  runId?: string;
  sessionKey: string;
  name: string;
  args?: unknown;
  output?: string;
  startedAt: number;
  updatedAt: number;
  phase: "start" | "result";
  message: Record<string, unknown>;
};

type ActiveChatRunSnapshot = {
  runId: string;
  sessionKey: string;
  startedAtMs: number;
  expiresAtMs: number;
  streamText: string;
  effectiveUserMessage?: string;
  inputProvenance?: InputProvenance;
};

type MutableToolInvocation = {
  key: string;
  order: number;
  toolCallId: string;
  runId?: string;
  sessionKey: string;
  name: string;
  args?: unknown;
  output?: string;
  startedAt: number;
  updatedAt: number;
  phase: "start" | "result";
};

function toTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeToolBlockType(value: unknown): string {
  return toTrimmedString(value)
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
}

function coerceToolArgs(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  const trimmed = value.trim();
  if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) {
    return value;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function extractToolResultTextFromValue(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.text === "string") {
    return record.text;
  }
  if (typeof record.content === "string") {
    return record.content;
  }
  if (!Array.isArray(record.content)) {
    return undefined;
  }
  const textParts = record.content
    .map((item) => {
      if (!item || typeof item !== "object") {
        return null;
      }
      const block = item as Record<string, unknown>;
      if (
        normalizeToolBlockType(block.type) === "text" &&
        typeof block.text === "string" &&
        block.text.length > 0
      ) {
        return block.text;
      }
      return null;
    })
    .filter((part): part is string => Boolean(part));
  if (textParts.length === 0) {
    return undefined;
  }
  return textParts.join("\n");
}

function buildCanonicalToolInvocationMessage(entry: {
  toolCallId: string;
  runId?: string;
  sessionKey: string;
  name: string;
  args?: unknown;
  output?: string;
  timestamp: number;
}): Record<string, unknown> {
  const content: Array<Record<string, unknown>> = [
    {
      type: "toolcall",
      name: entry.name,
      arguments: entry.args ?? {},
    },
  ];
  if (typeof entry.output === "string" && entry.output.length > 0) {
    content.push({
      type: "toolresult",
      name: entry.name,
      text: entry.output,
    });
  }
  const message: Record<string, unknown> = {
    role: "assistant",
    toolCallId: entry.toolCallId,
    tool_call_id: entry.toolCallId,
    sessionKey: entry.sessionKey,
    content,
    timestamp: entry.timestamp,
    __openclaw: { canonicalToolInvocation: true },
  };
  if (entry.runId) {
    message.runId = entry.runId;
  }
  return message;
}

function buildCanonicalToolInvocations(params: {
  messages: unknown[];
  defaultSessionKey: string;
}): CanonicalToolInvocation[] {
  const invocations = new Map<string, MutableToolInvocation>();
  const pendingByScopeAndName = new Map<string, string[]>();
  const seqByScopeAndName = new Map<string, number>();
  let creationOrder = 0;

  const resolveScopeAndNameKey = (scope: string, name: string) => `${scope}::${name}`;

  const nextSyntheticId = (scope: string, name: string) => {
    const key = resolveScopeAndNameKey(scope, name);
    const next = (seqByScopeAndName.get(key) ?? 0) + 1;
    seqByScopeAndName.set(key, next);
    return `history:${scope}:${name}:${next}`;
  };

  const enqueuePending = (scope: string, name: string, invocationKey: string) => {
    const key = resolveScopeAndNameKey(scope, name);
    const queue = pendingByScopeAndName.get(key) ?? [];
    if (!queue.includes(invocationKey)) {
      queue.push(invocationKey);
      pendingByScopeAndName.set(key, queue);
    }
  };

  const dequeuePending = (scope: string, name: string) => {
    const key = resolveScopeAndNameKey(scope, name);
    const queue = pendingByScopeAndName.get(key);
    if (!queue || queue.length === 0) {
      return null;
    }
    const invocationKey = queue.shift() ?? null;
    if (queue.length === 0) {
      pendingByScopeAndName.delete(key);
    } else {
      pendingByScopeAndName.set(key, queue);
    }
    return invocationKey;
  };

  const dropPending = (scope: string, name: string, invocationKey: string) => {
    const key = resolveScopeAndNameKey(scope, name);
    const queue = pendingByScopeAndName.get(key);
    if (!queue || queue.length === 0) {
      return;
    }
    const filtered = queue.filter((existing) => existing !== invocationKey);
    if (filtered.length === 0) {
      pendingByScopeAndName.delete(key);
      return;
    }
    pendingByScopeAndName.set(key, filtered);
  };

  const upsertInvocation = (params: {
    key: string;
    toolCallId: string;
    runId?: string;
    sessionKey: string;
    name: string;
    args?: unknown;
    output?: string;
    timestamp: number;
    phase: "start" | "result";
  }) => {
    const existing = invocations.get(params.key);
    if (!existing) {
      const created: MutableToolInvocation = {
        key: params.key,
        order: creationOrder++,
        toolCallId: params.toolCallId,
        runId: params.runId,
        sessionKey: params.sessionKey,
        name: params.name,
        args: params.args,
        output: params.output,
        startedAt: params.timestamp,
        updatedAt: params.timestamp,
        phase: params.phase,
      };
      invocations.set(params.key, created);
      return created;
    }
    existing.toolCallId = params.toolCallId || existing.toolCallId;
    if (params.runId) {
      existing.runId = params.runId;
    }
    if (params.sessionKey) {
      existing.sessionKey = params.sessionKey;
    }
    if (params.name && (!existing.name || existing.name === "tool")) {
      existing.name = params.name;
    }
    if (params.args !== undefined && existing.args === undefined) {
      existing.args = params.args;
    }
    if (params.output !== undefined) {
      existing.output = params.output;
      existing.phase = "result";
    } else if (existing.phase !== "result") {
      existing.phase = params.phase;
    }
    existing.startedAt = Math.min(existing.startedAt, params.timestamp);
    existing.updatedAt = Math.max(existing.updatedAt, params.timestamp);
    return existing;
  };

  for (let index = 0; index < params.messages.length; index += 1) {
    const message = params.messages[index];
    if (!message || typeof message !== "object") {
      continue;
    }
    const record = message as Record<string, unknown>;
    const messageRunId = toTrimmedString(record.runId) || toTrimmedString(record.run_id);
    const messageSessionKey =
      toTrimmedString(record.sessionKey) ||
      toTrimmedString(record.session_key) ||
      params.defaultSessionKey;
    const messageToolCallId =
      toTrimmedString(record.toolCallId) || toTrimmedString(record.tool_call_id);
    const timestamp = typeof record.timestamp === "number" ? record.timestamp : Date.now() + index;
    const scope = messageRunId || messageSessionKey || "__session__";

    const calls: Array<{ id?: string; name: string; args?: unknown }> = [];
    const results: Array<{ id?: string; name: string; output?: string }> = [];
    const content = Array.isArray(record.content) ? record.content : [];
    for (const block of content) {
      if (!block || typeof block !== "object") {
        continue;
      }
      const entry = block as Record<string, unknown>;
      const type = normalizeToolBlockType(entry.type);
      const blockName = toTrimmedString(entry.name) || "tool";
      const blockId =
        toTrimmedString(entry.id) ||
        toTrimmedString(entry.toolCallId) ||
        toTrimmedString(entry.tool_call_id) ||
        undefined;
      if (
        type === "toolcall" ||
        type === "tooluse" ||
        (type === "" && toTrimmedString(entry.name) && ("arguments" in entry || "args" in entry))
      ) {
        calls.push({
          id: blockId ?? (messageToolCallId || undefined),
          name: blockName,
          args: coerceToolArgs(entry.arguments ?? entry.args),
        });
        continue;
      }
      if (type === "toolresult") {
        results.push({
          id: blockId ?? (messageToolCallId || undefined),
          name:
            blockName ||
            toTrimmedString(record.toolName) ||
            toTrimmedString(record.tool_name) ||
            "tool",
          output: extractToolResultTextFromValue(entry),
        });
      }
    }

    const role = toTrimmedString(record.role).toLowerCase();
    if ((role === "toolresult" || role === "tool_result") && results.length === 0) {
      results.push({
        id: messageToolCallId || undefined,
        name: toTrimmedString(record.toolName) || toTrimmedString(record.tool_name) || "tool",
        output: extractToolResultTextFromValue(record),
      });
    }

    for (const call of calls) {
      const normalizedName = call.name.trim().toLowerCase() || "tool";
      const toolCallId =
        call.id && call.id.trim() ? call.id.trim() : nextSyntheticId(scope, normalizedName);
      const key = call.id ? `id:${toolCallId}` : `synthetic:${toolCallId}`;
      const invocation = upsertInvocation({
        key,
        toolCallId,
        runId: messageRunId || undefined,
        sessionKey: messageSessionKey,
        name: call.name || "tool",
        args: call.args,
        timestamp,
        phase: "start",
      });
      if (invocation.phase !== "result") {
        enqueuePending(scope, normalizedName, key);
      }
    }

    for (const result of results) {
      const normalizedName = result.name.trim().toLowerCase() || "tool";
      let key: string;
      let toolCallId: string;
      if (result.id && result.id.trim()) {
        toolCallId = result.id.trim();
        key = `id:${toolCallId}`;
      } else {
        const pendingKey = dequeuePending(scope, normalizedName);
        if (pendingKey) {
          key = pendingKey;
          const pending = invocations.get(pendingKey);
          toolCallId = pending?.toolCallId ?? nextSyntheticId(scope, normalizedName);
        } else {
          toolCallId = nextSyntheticId(scope, normalizedName);
          key = `synthetic:${toolCallId}`;
        }
      }
      upsertInvocation({
        key,
        toolCallId,
        runId: messageRunId || undefined,
        sessionKey: messageSessionKey,
        name: result.name || "tool",
        output: result.output,
        timestamp,
        phase: "result",
      });
      dropPending(scope, normalizedName, key);
    }
  }

  const sorted = [...invocations.values()].toSorted(
    (a, b) => a.startedAt - b.startedAt || a.order - b.order,
  );
  return sorted.map((entry) => ({
    toolCallId: entry.toolCallId,
    tool_call_id: entry.toolCallId,
    ...(entry.runId ? { runId: entry.runId } : {}),
    sessionKey: entry.sessionKey,
    name: entry.name,
    ...(entry.args !== undefined ? { args: entry.args } : {}),
    ...(entry.output !== undefined ? { output: entry.output } : {}),
    startedAt: entry.startedAt,
    updatedAt: entry.updatedAt,
    phase: entry.phase,
    message: buildCanonicalToolInvocationMessage({
      toolCallId: entry.toolCallId,
      runId: entry.runId,
      sessionKey: entry.sessionKey,
      name: entry.name,
      args: entry.args,
      output: entry.output,
      timestamp: entry.startedAt,
    }),
  }));
}

function resolveActiveChatRunSnapshot(params: {
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
  chatRunBuffers: Map<string, string>;
  dedupe: Map<string, { payload?: unknown }>;
  historyMessages: unknown[];
  activeAgentRuns?: Array<{
    runId: string;
    sessionKey: string;
    startedAt: number;
    inputProvenance?: InputProvenance;
    queuedChatItemId?: string;
  }>;
  requestedSessionKey: string;
  canonicalSessionKey: string;
}): ActiveChatRunSnapshot | null {
  const now = Date.now();
  const isTerminalChatRun = (runId: string): boolean => {
    const dedupeEntry = params.dedupe.get(`chat:${runId}`);
    if (!dedupeEntry || !dedupeEntry.payload || typeof dedupeEntry.payload !== "object") {
      return false;
    }
    const payload = dedupeEntry.payload as Record<string, unknown>;
    const status = typeof payload.status === "string" ? payload.status : "";
    return status === "ok" || status === "error";
  };

  let selectedChatRun: { runId: string; entry: ChatAbortControllerEntry } | null = null;
  for (const [runId, entry] of params.chatAbortControllers) {
    if (entry.controller.signal.aborted) {
      continue;
    }
    if (entry.expiresAtMs <= now) {
      continue;
    }
    if (isTerminalChatRun(runId)) {
      continue;
    }
    if (
      entry.sessionKey !== params.requestedSessionKey &&
      entry.sessionKey !== params.canonicalSessionKey
    ) {
      continue;
    }
    if (!selectedChatRun || entry.startedAtMs > selectedChatRun.entry.startedAtMs) {
      selectedChatRun = { runId, entry };
    }
  }

  const selectedAgentRun =
    params.activeAgentRuns?.find(
      (entry) =>
        (entry.sessionKey === params.requestedSessionKey ||
          entry.sessionKey === params.canonicalSessionKey) &&
        (entry.inputProvenance?.kind === "inter_session" || Boolean(entry.queuedChatItemId)),
    ) ?? null;

  if (
    selectedChatRun &&
    (!selectedAgentRun || selectedChatRun.entry.startedAtMs >= selectedAgentRun.startedAt)
  ) {
    const rawStream = params.chatRunBuffers.get(selectedChatRun.runId) ?? "";
    const stripped = stripInlineDirectiveTagsForDisplay(rawStream);
    const truncated = truncateChatHistoryText(stripped.text);
    if (
      shouldSuppressRecoveredBlankActiveRun({
        startedAtMs: selectedChatRun.entry.startedAtMs,
        streamText: truncated.text,
        historyMessages: params.historyMessages,
      })
    ) {
      return null;
    }
    return {
      runId: selectedChatRun.runId,
      sessionKey: selectedChatRun.entry.sessionKey,
      startedAtMs: selectedChatRun.entry.startedAtMs,
      expiresAtMs: selectedChatRun.entry.expiresAtMs,
      streamText: truncated.text,
      ...(selectedChatRun.entry.effectiveUserMessage
        ? { effectiveUserMessage: selectedChatRun.entry.effectiveUserMessage }
        : {}),
    };
  }

  if (!selectedAgentRun) {
    return null;
  }

  const rawStream = params.chatRunBuffers.get(selectedAgentRun.runId) ?? "";
  const stripped = stripInlineDirectiveTagsForDisplay(rawStream);
  const truncated = truncateChatHistoryText(stripped.text);
  if (
    shouldSuppressRecoveredBlankActiveRun({
      startedAtMs: selectedAgentRun.startedAt,
      streamText: truncated.text,
      historyMessages: params.historyMessages,
    })
  ) {
    return null;
  }
  return {
    runId: selectedAgentRun.runId,
    sessionKey: selectedAgentRun.sessionKey,
    startedAtMs: selectedAgentRun.startedAt,
    expiresAtMs: now + 60_000,
    streamText: truncated.text,
    ...(selectedAgentRun.inputProvenance
      ? { inputProvenance: selectedAgentRun.inputProvenance }
      : {}),
  };
}

function buildOversizedHistoryPlaceholder(message?: unknown): Record<string, unknown> {
  const role =
    message &&
    typeof message === "object" &&
    typeof (message as { role?: unknown }).role === "string"
      ? (message as { role: string }).role
      : "assistant";
  const timestamp =
    message &&
    typeof message === "object" &&
    typeof (message as { timestamp?: unknown }).timestamp === "number"
      ? (message as { timestamp: number }).timestamp
      : Date.now();
  return {
    role,
    timestamp,
    content: [{ type: "text", text: CHAT_HISTORY_OVERSIZED_PLACEHOLDER }],
    __openclaw: { truncated: true, reason: "oversized" },
  };
}

function replaceOversizedChatHistoryMessages(params: {
  messages: unknown[];
  maxSingleMessageBytes: number;
}): { messages: unknown[]; replacedCount: number } {
  const { messages, maxSingleMessageBytes } = params;
  if (messages.length === 0) {
    return { messages, replacedCount: 0 };
  }
  let replacedCount = 0;
  const next = messages.map((message) => {
    if (jsonUtf8Bytes(message) <= maxSingleMessageBytes) {
      return message;
    }
    replacedCount += 1;
    return buildOversizedHistoryPlaceholder(message);
  });
  return { messages: replacedCount > 0 ? next : messages, replacedCount };
}

function enforceChatHistoryFinalBudget(params: { messages: unknown[]; maxBytes: number }): {
  messages: unknown[];
  placeholderCount: number;
} {
  const { messages, maxBytes } = params;
  if (messages.length === 0) {
    return { messages, placeholderCount: 0 };
  }
  if (jsonUtf8Bytes(messages) <= maxBytes) {
    return { messages, placeholderCount: 0 };
  }
  const last = messages.at(-1);
  if (last && jsonUtf8Bytes([last]) <= maxBytes) {
    return { messages: [last], placeholderCount: 0 };
  }
  const placeholder = buildOversizedHistoryPlaceholder(last);
  if (jsonUtf8Bytes([placeholder]) <= maxBytes) {
    return { messages: [placeholder], placeholderCount: 1 };
  }
  return { messages: [], placeholderCount: 0 };
}

function resolveTranscriptPath(params: {
  sessionId: string;
  storePath: string | undefined;
  sessionFile?: string;
  agentId?: string;
}): string | null {
  const { sessionId, storePath, sessionFile, agentId } = params;
  if (!storePath && !sessionFile) {
    return null;
  }
  try {
    const sessionsDir = storePath ? path.dirname(storePath) : undefined;
    return resolveSessionFilePath(
      sessionId,
      sessionFile ? { sessionFile } : undefined,
      sessionsDir || agentId ? { sessionsDir, agentId } : undefined,
    );
  } catch {
    return null;
  }
}

function ensureTranscriptFile(params: { transcriptPath: string; sessionId: string }): {
  ok: boolean;
  error?: string;
} {
  if (fs.existsSync(params.transcriptPath)) {
    return { ok: true };
  }
  try {
    fs.mkdirSync(path.dirname(params.transcriptPath), { recursive: true });
    const header = {
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: params.sessionId,
      timestamp: new Date().toISOString(),
      cwd: process.cwd(),
    };
    fs.writeFileSync(params.transcriptPath, `${JSON.stringify(header)}\n`, {
      encoding: "utf-8",
      mode: 0o600,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function transcriptHasIdempotencyKey(transcriptPath: string, idempotencyKey: string): boolean {
  try {
    const lines = fs.readFileSync(transcriptPath, "utf-8").split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      const parsed = JSON.parse(line) as { message?: { idempotencyKey?: unknown } };
      if (parsed?.message?.idempotencyKey === idempotencyKey) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

function appendAssistantTranscriptMessage(params: {
  message: string;
  label?: string;
  sessionId: string;
  storePath: string | undefined;
  sessionFile?: string;
  agentId?: string;
  createIfMissing?: boolean;
  idempotencyKey?: string;
  abortMeta?: {
    aborted: true;
    origin: AbortOrigin;
    runId: string;
  };
}): TranscriptAppendResult {
  const transcriptPath = resolveTranscriptPath({
    sessionId: params.sessionId,
    storePath: params.storePath,
    sessionFile: params.sessionFile,
    agentId: params.agentId,
  });
  if (!transcriptPath) {
    return { ok: false, error: "transcript path not resolved" };
  }

  if (!fs.existsSync(transcriptPath)) {
    if (!params.createIfMissing) {
      return { ok: false, error: "transcript file not found" };
    }
    const ensured = ensureTranscriptFile({
      transcriptPath,
      sessionId: params.sessionId,
    });
    if (!ensured.ok) {
      return { ok: false, error: ensured.error ?? "failed to create transcript file" };
    }
  }

  if (params.idempotencyKey && transcriptHasIdempotencyKey(transcriptPath, params.idempotencyKey)) {
    return { ok: true };
  }

  return appendInjectedAssistantMessageToTranscript({
    transcriptPath,
    message: params.message,
    label: params.label,
    idempotencyKey: params.idempotencyKey,
    abortMeta: params.abortMeta,
  });
}

function appendUserTranscriptMessage(params: {
  message: string;
  sessionId: string;
  storePath: string | undefined;
  sessionFile?: string;
  agentId?: string;
  createIfMissing?: boolean;
  idempotencyKey?: string;
  provenance?: Record<string, unknown>;
}): TranscriptAppendResult {
  const transcriptPath = resolveTranscriptPath({
    sessionId: params.sessionId,
    storePath: params.storePath,
    sessionFile: params.sessionFile,
    agentId: params.agentId,
  });
  if (!transcriptPath) {
    return { ok: false, error: "transcript path not resolved" };
  }

  if (!fs.existsSync(transcriptPath)) {
    if (!params.createIfMissing) {
      return { ok: false, error: "transcript file not found" };
    }
    const ensured = ensureTranscriptFile({
      transcriptPath,
      sessionId: params.sessionId,
    });
    if (!ensured.ok) {
      return { ok: false, error: ensured.error ?? "failed to create transcript file" };
    }
  }

  if (params.idempotencyKey && transcriptHasIdempotencyKey(transcriptPath, params.idempotencyKey)) {
    return { ok: true };
  }

  return appendInjectedUserMessageToTranscript({
    transcriptPath,
    message: params.message,
    idempotencyKey: params.idempotencyKey,
    provenance: params.provenance,
  });
}

async function forwardMentionRouteToAgent(params: {
  message: string;
  targetSessionKey: string;
  requesterSessionKey: string;
  attachments?: Array<{
    type?: string;
    mimeType?: string;
    fileName?: string;
    content?: unknown;
  }>;
  idempotencyKey: string;
  context: GatewayRequestContext;
  client: GatewayClient | null;
}): Promise<
  | { ok: true; payload?: unknown; delivery: "started" | "queued" }
  | { ok: false; payload?: unknown; error: ReturnType<typeof errorShape> }
> {
  const target = loadSessionEntry(params.targetSessionKey);
  const targetSessionKey = target.canonicalKey || params.targetSessionKey.trim();
  const targetEntry = target.entry;
  const targetSessionId = targetEntry?.sessionId?.trim();
  if (!targetSessionId) {
    return {
      ok: false,
      error: errorShape(ErrorCodes.INVALID_REQUEST, "target teammate session not found"),
    };
  }

  const inputProvenance: InputProvenance = {
    kind: "inter_session",
    sourceSessionKey: params.requesterSessionKey,
    sourceChannel: "webchat",
    sourceTool: "mention_route",
  };
  const hasAttachments = Array.isArray(params.attachments) && params.attachments.length > 0;
  const targetBusy =
    isEmbeddedPiRunActive(targetSessionId) ||
    listActiveAgentRunsForSession(params.targetSessionKey).length > 0 ||
    (targetSessionKey !== params.targetSessionKey.trim()
      ? listActiveAgentRunsForSession(targetSessionKey).length > 0
      : false);

  if (targetBusy && !hasAttachments) {
    const targetAgentId = resolveSessionAgentId({
      sessionKey: targetSessionKey,
      config: target.cfg,
    });
    const { provider, model } = resolveSessionModelRef(target.cfg, targetEntry, targetAgentId);
    const sessionFile =
      targetEntry?.sessionFile ||
      resolveSessionFilePath(
        targetSessionId,
        targetEntry,
        resolveSessionFilePathOptions({
          agentId: targetAgentId,
          storePath: target.storePath,
        }),
      );
    const queueSettings = resolveQueueSettings({
      cfg: target.cfg,
      channel: INTERNAL_MESSAGE_CHANNEL,
      sessionEntry: targetEntry,
      inlineMode: "followup",
    });
    const queueSettingsForControlUi = {
      ...queueSettings,
      dropPolicy: queueSettings.dropPolicy === "new" ? "summarize" : queueSettings.dropPolicy,
    } as const;
    const stampedMessage = injectTimestamp(
      params.message,
      timestampOptsFromConfig(target.cfg),
    ).trim();
    const queuedRun = ensureFollowupRunId({
      id: params.idempotencyKey,
      prompt: stampedMessage,
      messageId: params.idempotencyKey,
      summaryLine: params.message.trim(),
      enqueuedAt: Date.now(),
      originatingChatType: "direct",
      run: {
        agentId: targetAgentId,
        agentDir: resolveAgentDir(target.cfg, targetAgentId),
        sessionId: targetSessionId,
        sessionKey: targetSessionKey,
        messageProvider: INTERNAL_MESSAGE_CHANNEL,
        agentAccountId: targetEntry?.accountId,
        groupId: targetEntry?.groupId,
        groupChannel: targetEntry?.groupChannel,
        groupSpace: targetEntry?.groupSpace,
        inputProvenance,
        sessionFile,
        workspaceDir: resolveAgentWorkspaceDir(target.cfg, targetAgentId),
        config: target.cfg,
        provider,
        model,
        timeoutMs: resolveAgentTimeoutMs({ cfg: target.cfg }),
        blockReplyBreak: "text_end",
      },
    });
    const enqueued = enqueueFollowupRun(
      targetSessionKey,
      queuedRun,
      queueSettingsForControlUi,
      "message-id",
    );
    if (!enqueued) {
      return {
        ok: false,
        payload: {
          ok: false,
          item: null,
          queue: resolveQueuedMessagesForSessionKey(targetSessionKey),
        },
        error: errorShape(ErrorCodes.UNAVAILABLE, "agent route queue failed"),
      };
    }
    const itemId = queuedRun.id ?? params.idempotencyKey;
    broadcastQueuedChatEvent({
      context: params.context,
      sessionKey: targetSessionKey,
      itemId,
      text: params.message.trim(),
      createdAt: queuedRun.enqueuedAt,
    });
    const queue = broadcastChatQueueChanged({
      context: params.context,
      sessionKey: targetSessionKey,
      queueLookupSessionKey: targetSessionKey,
    });
    return {
      ok: true,
      delivery: "queued",
      payload: {
        ok: true,
        item: resolveQueueItemSnapshot(queuedRun),
        queue,
      },
    };
  }

  return await new Promise((resolve) => {
    let settled = false;
    const settle = (
      result:
        | { ok: true; payload?: unknown; delivery: "started" | "queued" }
        | { ok: false; payload?: unknown; error: ReturnType<typeof errorShape> },
    ) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    };

    const respond: Parameters<GatewayRequestHandlers["agent"]>[0]["respond"] = (
      ok,
      payload,
      error,
    ) => {
      if (ok) {
        settle({ ok: true, payload, delivery: "started" });
        return;
      }
      settle({
        ok: false,
        payload,
        error: errorShape(
          ErrorCodes.UNAVAILABLE,
          typeof error?.message === "string" ? error.message : "agent route failed",
        ),
      });
    };

    const result = agentHandlers.agent({
      req: {
        type: "req",
        id: `${params.idempotencyKey}:mention-route`,
        method: "agent",
      },
      params: {
        message: params.message,
        sessionKey: params.targetSessionKey,
        attachments: params.attachments,
        deliver: false,
        idempotencyKey: params.idempotencyKey,
        inputProvenance,
      },
      context: params.context,
      client: params.client,
      isWebchatConnect: () => false,
      respond,
    });

    void Promise.resolve(result).catch((err) => {
      settle({
        ok: false,
        error: errorShape(ErrorCodes.UNAVAILABLE, String(err)),
      });
    });
  });
}

function collectSessionAbortPartials(params: {
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
  chatRunBuffers: Map<string, string>;
  sessionKey: string;
  abortOrigin: AbortOrigin;
}): AbortedPartialSnapshot[] {
  const out: AbortedPartialSnapshot[] = [];
  for (const [runId, active] of params.chatAbortControllers) {
    if (active.sessionKey !== params.sessionKey) {
      continue;
    }
    const text = params.chatRunBuffers.get(runId);
    if (!text || !text.trim()) {
      continue;
    }
    out.push({
      runId,
      sessionId: active.sessionId,
      text,
      abortOrigin: params.abortOrigin,
    });
  }
  return out;
}

function persistAbortedPartials(params: {
  context: Pick<GatewayRequestContext, "logGateway">;
  sessionKey: string;
  snapshots: AbortedPartialSnapshot[];
}) {
  if (params.snapshots.length === 0) {
    return;
  }
  const { storePath, entry } = loadSessionEntry(params.sessionKey);
  for (const snapshot of params.snapshots) {
    const sessionId = entry?.sessionId ?? snapshot.sessionId ?? snapshot.runId;
    const appended = appendAssistantTranscriptMessage({
      message: snapshot.text,
      sessionId,
      storePath,
      sessionFile: entry?.sessionFile,
      createIfMissing: true,
      idempotencyKey: `${snapshot.runId}:assistant`,
      abortMeta: {
        aborted: true,
        origin: snapshot.abortOrigin,
        runId: snapshot.runId,
      },
    });
    if (!appended.ok) {
      params.context.logGateway.warn(
        `chat.abort transcript append failed: ${appended.error ?? "unknown error"}`,
      );
    }
  }
}

function createChatAbortOps(context: GatewayRequestContext): ChatAbortOps {
  return {
    chatAbortControllers: context.chatAbortControllers,
    chatRunBuffers: context.chatRunBuffers,
    chatDeltaSentAt: context.chatDeltaSentAt,
    chatAbortedRuns: context.chatAbortedRuns,
    removeChatRun: context.removeChatRun,
    agentRunSeq: context.agentRunSeq,
    broadcast: context.broadcast,
    nodeSendToSession: context.nodeSendToSession,
  };
}

function abortChatRunsForSessionKeyWithPartials(params: {
  context: GatewayRequestContext;
  ops: ChatAbortOps;
  sessionKey: string;
  abortOrigin: AbortOrigin;
  stopReason?: string;
}) {
  const snapshots = collectSessionAbortPartials({
    chatAbortControllers: params.context.chatAbortControllers,
    chatRunBuffers: params.context.chatRunBuffers,
    sessionKey: params.sessionKey,
    abortOrigin: params.abortOrigin,
  });
  const res = abortChatRunsForSessionKey(params.ops, {
    sessionKey: params.sessionKey,
    stopReason: params.stopReason,
  });
  if (res.aborted) {
    persistAbortedPartials({
      context: params.context,
      sessionKey: params.sessionKey,
      snapshots,
    });
  }
  return res;
}

function nextChatSeq(context: { agentRunSeq: Map<string, number> }, runId: string) {
  const next = (context.agentRunSeq.get(runId) ?? 0) + 1;
  context.agentRunSeq.set(runId, next);
  return next;
}

function broadcastChatFinal(params: {
  context: Pick<GatewayRequestContext, "broadcast" | "nodeSendToSession" | "agentRunSeq">;
  runId: string;
  sessionKey: string;
  message?: Record<string, unknown>;
}) {
  const seq = nextChatSeq({ agentRunSeq: params.context.agentRunSeq }, params.runId);
  const strippedEnvelopeMessage = stripEnvelopeFromMessage(params.message) as
    | Record<string, unknown>
    | undefined;
  const payload = {
    runId: params.runId,
    sessionKey: params.sessionKey,
    seq,
    state: "final" as const,
    message: stripInlineDirectiveTagsFromMessageForDisplay(strippedEnvelopeMessage),
  };
  params.context.broadcast("chat", payload);
  params.context.nodeSendToSession(params.sessionKey, "chat", payload);
  params.context.agentRunSeq.delete(params.runId);
}

function broadcastChatError(params: {
  context: Pick<GatewayRequestContext, "broadcast" | "nodeSendToSession" | "agentRunSeq">;
  runId: string;
  sessionKey: string;
  errorMessage?: string;
}) {
  const seq = nextChatSeq({ agentRunSeq: params.context.agentRunSeq }, params.runId);
  const payload = {
    runId: params.runId,
    sessionKey: params.sessionKey,
    seq,
    state: "error" as const,
    errorMessage: params.errorMessage,
  };
  params.context.broadcast("chat", payload);
  params.context.nodeSendToSession(params.sessionKey, "chat", payload);
  params.context.agentRunSeq.delete(params.runId);
}

function broadcastChatAborted(params: {
  context: Pick<GatewayRequestContext, "broadcast" | "nodeSendToSession" | "agentRunSeq">;
  runId: string;
  sessionKey: string;
  stopReason?: string;
  message?: Record<string, unknown>;
}) {
  const seq = nextChatSeq({ agentRunSeq: params.context.agentRunSeq }, params.runId);
  const strippedEnvelopeMessage = stripEnvelopeFromMessage(params.message) as
    | Record<string, unknown>
    | undefined;
  const payload = {
    runId: params.runId,
    sessionKey: params.sessionKey,
    seq,
    state: "aborted" as const,
    stopReason: params.stopReason,
    message: stripInlineDirectiveTagsFromMessageForDisplay(strippedEnvelopeMessage),
  };
  params.context.broadcast("chat", payload);
  params.context.nodeSendToSession(params.sessionKey, "chat", payload);
  params.context.agentRunSeq.delete(params.runId);
}

function resolveQueuedMessagesForSessionKey(sessionKey: string) {
  const { canonicalKey, entry } = loadSessionEntry(sessionKey);
  return resolveQueuedChatMessages({
    sessionKey,
    canonicalKey: canonicalKey || sessionKey,
    sessionId: entry?.sessionId,
  });
}

function broadcastChatQueueChanged(params: {
  context: Pick<GatewayRequestContext, "broadcast" | "nodeSendToSession">;
  sessionKey: string;
  queueLookupSessionKey?: string;
}) {
  const payload: ChatQueueChangedPayload = {
    sessionKey: params.sessionKey,
    queue: resolveQueuedMessagesForSessionKey(params.queueLookupSessionKey ?? params.sessionKey),
  };
  params.context.broadcast("chat.queue.changed", payload);
  params.context.nodeSendToSession(params.sessionKey, "chat.queue.changed", payload);
  return payload.queue;
}

function broadcastQueuedChatEvent(params: {
  context: Pick<GatewayRequestContext, "broadcast" | "nodeSendToSession" | "agentRunSeq">;
  sessionKey: string;
  itemId: string;
  text: string;
  createdAt: number;
}) {
  const seq = nextChatSeq({ agentRunSeq: params.context.agentRunSeq }, params.itemId);
  const payload = {
    runId: params.itemId,
    sessionKey: params.sessionKey,
    seq,
    state: "queued" as const,
    queueItemId: params.itemId,
    source: "queue",
    message: buildQueuedChatMessage({
      itemId: params.itemId,
      text: params.text,
      createdAt: params.createdAt,
    }),
  };
  params.context.broadcast("chat", payload);
  params.context.nodeSendToSession(params.sessionKey, "chat", payload);
}

function broadcastQueuedChatRemovedEvent(params: {
  context: Pick<GatewayRequestContext, "broadcast" | "nodeSendToSession" | "agentRunSeq">;
  sessionKey: string;
  itemId: string;
}) {
  const seq = nextChatSeq({ agentRunSeq: params.context.agentRunSeq }, params.itemId);
  const payload = {
    runId: params.itemId,
    sessionKey: params.sessionKey,
    seq,
    state: "queue_removed" as const,
    queueItemId: params.itemId,
    source: "queue",
  };
  params.context.broadcast("chat", payload);
  params.context.nodeSendToSession(params.sessionKey, "chat", payload);
  params.context.agentRunSeq.delete(params.itemId);
}

export const chatHandlers: GatewayRequestHandlers = {
  "chat.history": async ({ params, respond, context }) => {
    if (!validateChatHistoryParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid chat.history params: ${formatValidationErrors(validateChatHistoryParams.errors)}`,
        ),
      );
      return;
    }
    const { sessionKey, limit } = params as {
      sessionKey: string;
      limit?: number;
    };
    const { cfg, storePath, entry, canonicalKey } = loadSessionEntry(sessionKey);
    const sessionId = entry?.sessionId;
    const rawMessages =
      sessionId && storePath ? readSessionMessages(sessionId, storePath, entry?.sessionFile) : [];
    const hardMax = 1000;
    const defaultLimit = 200;
    const requested = typeof limit === "number" ? limit : defaultLimit;
    const max = Math.min(hardMax, requested);
    const sliced = rawMessages.length > max ? rawMessages.slice(-max) : rawMessages;
    const sanitized = stripEnvelopeFromMessages(sliced);
    const normalized = sanitizeChatHistoryMessages(sanitized);
    const maxHistoryBytes = getMaxChatHistoryMessagesBytes();
    const perMessageHardCap = Math.min(CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES, maxHistoryBytes);
    const replaced = replaceOversizedChatHistoryMessages({
      messages: normalized,
      maxSingleMessageBytes: perMessageHardCap,
    });
    const capped = capArrayByJsonBytes(replaced.messages, maxHistoryBytes).items;
    const bounded = enforceChatHistoryFinalBudget({ messages: capped, maxBytes: maxHistoryBytes });
    const placeholderCount = replaced.replacedCount + bounded.placeholderCount;
    if (placeholderCount > 0) {
      chatHistoryPlaceholderEmitCount += placeholderCount;
      context.logGateway.debug(
        `chat.history omitted oversized payloads placeholders=${placeholderCount} total=${chatHistoryPlaceholderEmitCount}`,
      );
    }
    let thinkingLevel = entry?.thinkingLevel;
    if (!thinkingLevel) {
      const sessionAgentId = resolveSessionAgentId({ sessionKey, config: cfg });
      const { provider, model } = resolveSessionModelRef(cfg, entry, sessionAgentId);
      const catalog = await context.loadGatewayModelCatalog();
      thinkingLevel = resolveThinkingDefault({
        cfg,
        provider,
        model,
        catalog,
      });
    }
    const verboseLevel = entry?.verboseLevel ?? cfg.agents?.defaults?.verboseDefault;
    const toolInvocations = buildCanonicalToolInvocations({
      messages: bounded.messages,
      defaultSessionKey: canonicalKey || sessionKey,
    });
    const activeAgentRuns = new Map<
      string,
      {
        runId: string;
        sessionKey: string;
        startedAt: number;
        inputProvenance?: InputProvenance;
        queuedChatItemId?: string;
      }
    >();
    for (const candidate of [
      ...listActiveAgentRunsForSession(sessionKey),
      ...(canonicalKey && canonicalKey !== sessionKey
        ? listActiveAgentRunsForSession(canonicalKey)
        : []),
    ]) {
      const runContext = getAgentRunContext(candidate.runId);
      activeAgentRuns.set(candidate.runId, {
        ...candidate,
        queuedChatItemId: runContext?.queuedChatItemId?.trim() || undefined,
      });
    }
    const activeRun = resolveActiveChatRunSnapshot({
      chatAbortControllers: context.chatAbortControllers,
      chatRunBuffers: context.chatRunBuffers,
      dedupe: context.dedupe,
      historyMessages: bounded.messages,
      activeAgentRuns: [...activeAgentRuns.values()],
      requestedSessionKey: sessionKey,
      canonicalSessionKey: canonicalKey || sessionKey,
    });
    const activeQueuedChatItemIds = new Set(
      [...activeAgentRuns.values()]
        .map((candidate) => candidate.queuedChatItemId || "")
        .filter((value) => value.length > 0),
    );
    const queuedMessages = resolveQueuedChatMessages({
      sessionKey,
      canonicalKey: canonicalKey || sessionKey,
      sessionId,
    }).filter((item) => !activeQueuedChatItemIds.has(item.id));
    respond(true, {
      sessionKey,
      sessionId,
      messages: bounded.messages,
      toolInvocations,
      activeRun,
      queuedMessages,
      thinkingLevel,
      verboseLevel,
    });
  },
  "chat.queue.enqueue": async ({ params, respond, context, client }) => {
    if (!validateChatSendParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid chat.queue.enqueue params: ${formatValidationErrors(validateChatSendParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as {
      sessionKey: string;
      message: string;
      idempotencyKey: string;
      timeoutMs?: number;
      thinking?: string;
    };
    const sanitizedMessageResult = sanitizeChatSendMessageInput(p.message);
    if (!sanitizedMessageResult.ok) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, sanitizedMessageResult.error),
      );
      return;
    }
    const parsedMessage = sanitizedMessageResult.message;
    if (!parsedMessage.trim()) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "message is required"));
      return;
    }

    const cfg = loadConfig();
    const rawSessionKey = p.sessionKey.trim();
    const { canonicalKey, storePath, entry } = loadSessionEntry(rawSessionKey);
    const sessionKey = canonicalKey || rawSessionKey;
    const requesterAgentId = resolveSessionAgentId({ sessionKey, config: cfg });
    const clientRunId = p.idempotencyKey.trim() || crypto.randomUUID();
    const trimmedMessage = parsedMessage.trim();
    const clientInfo = client?.connect?.client;
    const { originatingChannel, originatingTo, accountId, messageThreadId } =
      resolveChatSendOriginatingRoute({
        client: clientInfo,
        deliver: false,
        entry,
        hasConnectedClient: client?.connect !== undefined,
        mainKey: cfg.session?.mainKey,
        sessionKey,
      });
    const stampedMessage = injectTimestamp(parsedMessage, timestampOptsFromConfig(cfg)).trim();
    const sessionId = entry?.sessionId?.trim() || clientRunId;
    const agentDir = resolveAgentDir(cfg, requesterAgentId);
    const workspaceDir = resolveAgentWorkspaceDir(cfg, requesterAgentId);
    const { provider, model } = resolveSessionModelRef(cfg, entry, requesterAgentId);
    const sessionFile =
      entry?.sessionFile ||
      resolveSessionFilePath(
        sessionId,
        entry,
        resolveSessionFilePathOptions({
          agentId: requesterAgentId,
          storePath,
        }),
      );
    const queueSettings = resolveQueueSettings({
      cfg,
      channel: INTERNAL_MESSAGE_CHANNEL,
      sessionEntry: entry,
      inlineMode: "followup",
    });
    const queueSettingsForControlUi = {
      ...queueSettings,
      // An explicit UI queue action should not be rejected because the generic
      // queue policy is configured to drop new items when full.
      dropPolicy: queueSettings.dropPolicy === "new" ? "summarize" : queueSettings.dropPolicy,
    } as const;
    const queuedRun = ensureFollowupRunId({
      id: clientRunId,
      prompt: stampedMessage,
      messageId: clientRunId,
      summaryLine: trimmedMessage,
      enqueuedAt: Date.now(),
      originatingChannel,
      originatingTo,
      originatingAccountId: accountId,
      originatingThreadId: messageThreadId,
      originatingChatType: "direct",
      run: {
        agentId: requesterAgentId,
        agentDir,
        sessionId,
        sessionKey,
        messageProvider: INTERNAL_MESSAGE_CHANNEL,
        agentAccountId: entry?.accountId,
        groupId: entry?.groupId,
        groupChannel: entry?.groupChannel,
        groupSpace: entry?.groupSpace,
        senderId: clientInfo?.id,
        senderName: clientInfo?.displayName,
        senderUsername: clientInfo?.displayName,
        sessionFile,
        workspaceDir,
        config: cfg,
        provider,
        model,
        timeoutMs: p.timeoutMs ?? resolveAgentTimeoutMs({ cfg }),
        blockReplyBreak: "text_end",
      },
    });
    const enqueued = enqueueFollowupRun(sessionKey, queuedRun, queueSettingsForControlUi, "none");
    if (!enqueued) {
      respond(true, {
        ok: false,
        item: null,
        queue: resolveQueuedMessagesForSessionKey(sessionKey),
      });
      return;
    }
    broadcastQueuedChatEvent({
      context,
      sessionKey: rawSessionKey,
      itemId: clientRunId,
      text: trimmedMessage,
      createdAt: queuedRun.enqueuedAt,
    });
    const queue = broadcastChatQueueChanged({
      context,
      sessionKey: rawSessionKey,
      queueLookupSessionKey: sessionKey,
    });
    respond(true, { ok: true, item: resolveQueueItemSnapshot(queuedRun), queue });
  },
  "chat.queue.remove": ({ params, respond, context }) => {
    if (!validateChatQueueItemActionParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid chat.queue.remove params: ${formatValidationErrors(validateChatQueueItemActionParams.errors)}`,
        ),
      );
      return;
    }
    const { sessionKey, itemId } = params as { sessionKey: string; itemId: string };
    const { canonicalKey, entry } = loadSessionEntry(sessionKey);
    const resolvedSessionKey = canonicalKey || sessionKey;
    const removed = findQueuedChatMessage({
      sessionKey,
      canonicalKey: resolvedSessionKey,
      sessionId: entry?.sessionId,
      itemId,
    });
    if (!removed) {
      respond(true, {
        ok: false,
        removed: false,
        queue: resolveQueuedMessagesForSessionKey(resolvedSessionKey),
      });
      return;
    }
    const result = removeFollowupQueueItem(removed.key, itemId);
    if (result.removed) {
      broadcastQueuedChatRemovedEvent({ context, sessionKey, itemId });
    }
    const queue = broadcastChatQueueChanged({
      context,
      sessionKey,
      queueLookupSessionKey: resolvedSessionKey,
    });
    respond(true, { ok: result.removed !== null, removed: result.removed !== null, queue });
  },
  "chat.queue.edit": ({ params, respond, context }) => {
    if (!validateChatQueueItemActionParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid chat.queue.edit params: ${formatValidationErrors(validateChatQueueItemActionParams.errors)}`,
        ),
      );
      return;
    }
    const { sessionKey, itemId } = params as { sessionKey: string; itemId: string };
    const { canonicalKey, entry } = loadSessionEntry(sessionKey);
    const resolvedSessionKey = canonicalKey || sessionKey;
    const removed = findQueuedChatMessage({
      sessionKey,
      canonicalKey: resolvedSessionKey,
      sessionId: entry?.sessionId,
      itemId,
    });
    if (!removed) {
      respond(true, {
        ok: false,
        item: null,
        queue: resolveQueuedMessagesForSessionKey(resolvedSessionKey),
      });
      return;
    }
    const result = popFollowupQueueItem(removed.key, itemId);
    if (result.removed) {
      broadcastQueuedChatRemovedEvent({ context, sessionKey, itemId });
    }
    const queue = broadcastChatQueueChanged({
      context,
      sessionKey,
      queueLookupSessionKey: resolvedSessionKey,
    });
    respond(true, {
      ok: result.removed !== null,
      item: result.removed ? resolveQueueItemSnapshot(result.removed) : null,
      queue,
    });
  },
  "chat.queue.steer": ({ params, respond, context }) => {
    if (!validateChatQueueItemActionParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid chat.queue.steer params: ${formatValidationErrors(validateChatQueueItemActionParams.errors)}`,
        ),
      );
      return;
    }
    const { sessionKey, itemId } = params as { sessionKey: string; itemId: string };
    const { canonicalKey, entry } = loadSessionEntry(sessionKey);
    const resolvedSessionKey = canonicalKey || sessionKey;
    const removed = findQueuedChatMessage({
      sessionKey,
      canonicalKey: resolvedSessionKey,
      sessionId: entry?.sessionId,
      itemId,
    });
    if (!removed) {
      respond(true, {
        ok: false,
        item: null,
        queue: resolveQueuedMessagesForSessionKey(resolvedSessionKey),
      });
      return;
    }
    const result = markFollowupQueueItemSteering(removed.key, itemId, true);
    const queue = broadcastChatQueueChanged({
      context,
      sessionKey,
      queueLookupSessionKey: resolvedSessionKey,
    });
    respond(true, {
      ok: result.item !== null,
      item: result.item ? resolveQueueItemSnapshot(result.item) : null,
      queue,
    });
  },
  "chat.abort": ({ params, respond, context }) => {
    if (!validateChatAbortParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid chat.abort params: ${formatValidationErrors(validateChatAbortParams.errors)}`,
        ),
      );
      return;
    }
    const { sessionKey: rawSessionKey, runId } = params as {
      sessionKey: string;
      runId?: string;
    };

    const ops = createChatAbortOps(context);

    if (!runId) {
      const res = abortChatRunsForSessionKeyWithPartials({
        context,
        ops,
        sessionKey: rawSessionKey,
        abortOrigin: "rpc",
        stopReason: "rpc",
      });
      respond(true, { ok: true, aborted: res.aborted, runIds: res.runIds });
      return;
    }

    const active = context.chatAbortControllers.get(runId);
    if (!active) {
      const runContext = getAgentRunContext(runId);
      if (runContext?.queuedChatItemId) {
        const runSessionKey = runContext.sessionKey?.trim() || rawSessionKey;
        if (runSessionKey !== rawSessionKey) {
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.INVALID_REQUEST, "runId does not match sessionKey"),
          );
          return;
        }

        const sessionId =
          runContext.sessionId?.trim() || loadSessionEntry(runSessionKey).entry?.sessionId?.trim();
        if (!sessionId) {
          respond(true, { ok: true, aborted: false, runIds: [] });
          return;
        }

        const aborted = abortEmbeddedPiRun(sessionId);
        if (aborted) {
          emitAgentEvent({
            runId,
            sessionKey: runSessionKey,
            stream: "lifecycle",
            data: {
              phase: "end",
              endedAt: Date.now(),
              aborted: true,
            },
          });
          clearAgentRunContext(runId);
          broadcastChatAborted({
            context,
            runId,
            sessionKey: runSessionKey,
            stopReason: "rpc",
          });
        }
        respond(true, { ok: true, aborted, runIds: aborted ? [runId] : [] });
        return;
      }
      respond(true, { ok: true, aborted: false, runIds: [] });
      return;
    }
    if (active.sessionKey !== rawSessionKey) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "runId does not match sessionKey"),
      );
      return;
    }

    const partialText = context.chatRunBuffers.get(runId);
    const res = abortChatRunById(ops, {
      runId,
      sessionKey: rawSessionKey,
      stopReason: "rpc",
    });
    if (res.aborted && partialText && partialText.trim()) {
      persistAbortedPartials({
        context,
        sessionKey: rawSessionKey,
        snapshots: [
          {
            runId,
            sessionId: active.sessionId,
            text: partialText,
            abortOrigin: "rpc",
          },
        ],
      });
    }
    respond(true, {
      ok: true,
      aborted: res.aborted,
      runIds: res.aborted ? [runId] : [],
    });
  },
  "chat.send": async ({ params, respond, context, client }) => {
    if (!validateChatSendParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid chat.send params: ${formatValidationErrors(validateChatSendParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as {
      sessionKey: string;
      message: string;
      queueMode?: string;
      thinking?: string;
      deliver?: boolean;
      attachments?: Array<{
        type?: string;
        mimeType?: string;
        fileName?: string;
        content?: unknown;
      }>;
      timeoutMs?: number;
      idempotencyKey: string;
    };
    const sanitizedMessageResult = sanitizeChatSendMessageInput(p.message);
    if (!sanitizedMessageResult.ok) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, sanitizedMessageResult.error),
      );
      return;
    }
    const inboundMessage = sanitizedMessageResult.message;
    const stopCommand = isChatStopCommandText(inboundMessage);
    const normalizedAttachments = normalizeRpcAttachmentsToChatAttachments(p.attachments);
    const rawMessage = inboundMessage.trim();
    if (!rawMessage && normalizedAttachments.length === 0) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "message or attachment required"),
      );
      return;
    }
    let parsedMessage = inboundMessage;
    let parsedImages: ChatImageContent[] = [];
    if (normalizedAttachments.length > 0) {
      try {
        const parsed = await parseMessageWithAttachments(inboundMessage, normalizedAttachments, {
          maxBytes: 5_000_000,
          log: context.logGateway,
        });
        parsedMessage = parsed.message;
        parsedImages = parsed.images;
      } catch (err) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, String(err)));
        return;
      }
    }
    const rawSessionKey = p.sessionKey;
    const { cfg, storePath, entry, canonicalKey: sessionKey } = loadSessionEntry(rawSessionKey);
    const timeoutMs = resolveAgentTimeoutMs({
      cfg,
      overrideMs: p.timeoutMs,
    });
    const now = Date.now();
    const clientRunId = p.idempotencyKey;
    const effectiveUserMessage =
      normalizedAttachments.length === 0 && BARE_SESSION_RESET_RE.test(rawMessage)
        ? buildBareSessionResetPrompt(cfg)
        : undefined;

    const sendPolicy = resolveSendPolicy({
      cfg,
      entry,
      sessionKey,
      channel: entry?.channel,
      chatType: entry?.chatType,
    });
    if (sendPolicy === "deny") {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "send blocked by session policy"),
      );
      return;
    }

    const requesterAgentId = resolveSessionAgentId({
      sessionKey,
      config: cfg,
    });
    const mentionRoute = BARE_SESSION_RESET_RE.test(rawMessage)
      ? null
      : await resolveMentionRouteInText({
          text: parsedMessage,
          cfg,
          requesterSessionKey: sessionKey,
          workspaceDir: resolveAgentWorkspaceDir(cfg, requesterAgentId),
          action: "send",
          policy: createAgentToAgentPolicy(cfg),
        });
    if (mentionRoute && !mentionRoute.ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, mentionRoute.error));
      return;
    }
    if (mentionRoute?.ok) {
      if (!mentionRoute.bodyWithoutMention.trim() && normalizedAttachments.length === 0) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "message body required after teammate mention when no attachment is provided",
          ),
        );
        return;
      }
      const persisted = appendUserTranscriptMessage({
        message: parsedMessage.trim(),
        sessionId: entry?.sessionId ?? clientRunId,
        storePath,
        sessionFile: entry?.sessionFile,
        agentId: requesterAgentId,
        createIfMissing: true,
        idempotencyKey: clientRunId,
      });
      if (!persisted.ok) {
        context.logGateway.warn(
          `chat mention route user transcript append failed: ${persisted.error ?? "unknown error"}`,
        );
      }

      const routedMessage = mentionRoute.bodyWithoutMention.trim();

      const routed = await forwardMentionRouteToAgent({
        message: routedMessage,
        targetSessionKey: mentionRoute.sessionKey,
        requesterSessionKey: sessionKey,
        attachments: p.attachments,
        idempotencyKey: clientRunId,
        context,
        client,
      });
      if (!routed.ok) {
        respond(false, routed.payload, routed.error);
        return;
      }

      const payload = {
        runId: clientRunId,
        status: "started" as const,
        routedTo: mentionRoute.mention,
      };
      setGatewayDedupeEntry({
        dedupe: context.dedupe,
        key: `chat:${clientRunId}`,
        entry: {
          ts: Date.now(),
          ok: true,
          payload,
        },
      });
      respond(true, payload, undefined, { runId: clientRunId });
      return;
    }

    if (stopCommand) {
      const res = abortChatRunsForSessionKeyWithPartials({
        context,
        ops: createChatAbortOps(context),
        sessionKey: rawSessionKey,
        abortOrigin: "stop-command",
        stopReason: "stop",
      });
      respond(true, { ok: true, aborted: res.aborted, runIds: res.runIds });
      return;
    }

    const cached = context.dedupe.get(`chat:${clientRunId}`);
    if (cached) {
      respond(cached.ok, cached.payload, cached.error, {
        cached: true,
      });
      return;
    }

    const activeExisting = context.chatAbortControllers.get(clientRunId);
    if (activeExisting) {
      const inFlightEffectiveUserMessage =
        typeof activeExisting.effectiveUserMessage === "string"
          ? activeExisting.effectiveUserMessage
          : effectiveUserMessage;
      respond(
        true,
        {
          runId: clientRunId,
          status: "in_flight" as const,
          ...(inFlightEffectiveUserMessage
            ? { effectiveUserMessage: inFlightEffectiveUserMessage }
            : {}),
        },
        undefined,
        {
          cached: true,
          runId: clientRunId,
        },
      );
      return;
    }

    try {
      const abortController = new AbortController();
      context.chatAbortControllers.set(clientRunId, {
        controller: abortController,
        sessionId: entry?.sessionId ?? clientRunId,
        sessionKey: rawSessionKey,
        startedAtMs: now,
        expiresAtMs: resolveChatRunExpiresAtMs({ now, timeoutMs }),
        effectiveUserMessage,
      });
      const ackPayload = {
        runId: clientRunId,
        status: "started" as const,
        ...(effectiveUserMessage ? { effectiveUserMessage } : {}),
      };
      respond(true, ackPayload, undefined, { runId: clientRunId });

      const trimmedMessage = parsedMessage.trim();
      const injectThinking = Boolean(
        p.thinking && trimmedMessage && !trimmedMessage.startsWith("/"),
      );
      const commandBody = injectThinking ? `/think ${p.thinking} ${parsedMessage}` : parsedMessage;
      const clientInfo = client?.connect?.client;
      const {
        originatingChannel,
        originatingTo,
        accountId,
        messageThreadId,
        explicitDeliverRoute,
      } = resolveChatSendOriginatingRoute({
        client: clientInfo,
        deliver: p.deliver,
        entry,
        hasConnectedClient: client?.connect !== undefined,
        mainKey: cfg.session?.mainKey,
        sessionKey,
      });
      const steeredItems = popSteeredFollowupQueueItems(sessionKey);
      const steerPrefix = buildSteerMessagesPrefix(
        steeredItems.map((item) => ({
          text: item.summaryLine?.trim() || item.prompt.trim(),
        })),
      );
      // Inject timestamp so agents know the current date/time.
      // Only BodyForAgent gets the timestamp — Body stays raw for UI display.
      // See: https://github.com/moltbot/moltbot/issues/3658
      const stampedMessage = injectTimestamp(
        `${steerPrefix}${parsedMessage}`,
        timestampOptsFromConfig(cfg),
      );

      const ctx: MsgContext = {
        Body: parsedMessage,
        BodyForAgent: stampedMessage,
        BodyForCommands: commandBody,
        RawBody: parsedMessage,
        CommandBody: commandBody,
        SessionKey: sessionKey,
        Provider: INTERNAL_MESSAGE_CHANNEL,
        Surface: INTERNAL_MESSAGE_CHANNEL,
        OriginatingChannel: originatingChannel,
        OriginatingTo: originatingTo,
        ExplicitDeliverRoute: explicitDeliverRoute,
        AccountId: accountId,
        MessageThreadId: messageThreadId,
        ChatType: "direct",
        CommandAuthorized: true,
        MessageSid: clientRunId,
        SenderId: clientInfo?.id,
        SenderName: clientInfo?.displayName,
        SenderUsername: clientInfo?.displayName,
        GatewayClientScopes: client?.connect?.scopes,
      };

      const agentId = requesterAgentId;
      const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
        cfg,
        agentId,
        channel: INTERNAL_MESSAGE_CHANNEL,
      });
      const finalReplyParts: string[] = [];
      const dispatcher = createReplyDispatcher({
        ...prefixOptions,
        onError: (err) => {
          context.logGateway.warn(`webchat dispatch failed: ${formatForLog(err)}`);
        },
        deliver: async (payload, info) => {
          if (info.kind !== "final") {
            return;
          }
          const text = payload.text?.trim() ?? "";
          if (!text) {
            return;
          }
          finalReplyParts.push(text);
        },
      });

      let agentRunStarted = false;
      void dispatchInboundMessage({
        ctx,
        cfg,
        dispatcher,
        replyOptions: {
          runId: clientRunId,
          abortSignal: abortController.signal,
          images: parsedImages.length > 0 ? parsedImages : undefined,
          forceQueueMode: p.queueMode === "followup" ? "followup" : undefined,
          onAgentRunStart: (runId) => {
            agentRunStarted = true;
            const connId = typeof client?.connId === "string" ? client.connId : undefined;
            const wantsToolEvents = hasGatewayClientCap(
              client?.connect?.caps,
              GATEWAY_CLIENT_CAPS.TOOL_EVENTS,
            );
            if (connId && wantsToolEvents) {
              context.registerToolEventRecipient(runId, connId);
              // Register for any other active runs *in the same session* so
              // late-joining clients (e.g. page refresh mid-response) receive
              // in-progress tool events without leaking cross-session data.
              for (const [activeRunId, active] of context.chatAbortControllers) {
                if (activeRunId !== runId && active.sessionKey === p.sessionKey) {
                  context.registerToolEventRecipient(activeRunId, connId);
                }
              }
            }
          },
          onModelSelected,
        },
      })
        .then(async () => {
          const combinedReply = finalReplyParts
            .map((part) => part.trim())
            .filter(Boolean)
            .join("\n\n")
            .trim();
          let message: Record<string, unknown> | undefined;
          if (combinedReply) {
            const assistantMentionRoute = await resolveMentionRouteInText({
              text: combinedReply,
              cfg,
              requesterSessionKey: sessionKey,
              workspaceDir: resolveAgentWorkspaceDir(cfg, agentId),
              action: "send",
              policy: createAgentToAgentPolicy(cfg),
            });
            if (assistantMentionRoute?.ok && assistantMentionRoute.bodyWithoutMention.trim()) {
              const routed = await forwardMentionRouteToAgent({
                message: assistantMentionRoute.bodyWithoutMention.trim(),
                targetSessionKey: assistantMentionRoute.sessionKey,
                requesterSessionKey: sessionKey,
                idempotencyKey: `${clientRunId}:assistant-mention-route`,
                context,
                client,
              });
              if (!routed.ok) {
                context.logGateway.warn(`assistant mention route failed: ${routed.error.message}`);
              } else if (!agentRunStarted) {
                const { storePath: latestStorePath, entry: latestEntry } =
                  loadSessionEntry(sessionKey);
                const sessionId = latestEntry?.sessionId ?? entry?.sessionId ?? clientRunId;
                const routedLabel =
                  routed.delivery === "queued" ? "Queued for teammate" : "Sent to teammate";
                const routedNotice = `Delivered to ${assistantMentionRoute.mention}.`;
                const appended = appendAssistantTranscriptMessage({
                  message: routedNotice,
                  label: routedLabel,
                  sessionId,
                  storePath: latestStorePath,
                  sessionFile: latestEntry?.sessionFile,
                  agentId,
                  createIfMissing: true,
                  idempotencyKey: `${clientRunId}:assistant-mention-route-notice`,
                });
                message = appended.ok
                  ? appended.message
                  : {
                      role: "assistant",
                      content: [{ type: "text", text: `[${routedLabel}]\n\n${routedNotice}` }],
                      timestamp: Date.now(),
                      stopReason: "stop",
                      usage: { input: 0, output: 0, totalTokens: 0 },
                    };
              }
            } else if (assistantMentionRoute && !assistantMentionRoute.ok) {
              context.logGateway.warn(
                `assistant mention route skipped: ${assistantMentionRoute.error}`,
              );
            }
            if (!agentRunStarted && !message) {
              const { storePath: latestStorePath, entry: latestEntry } =
                loadSessionEntry(sessionKey);
              const sessionId = latestEntry?.sessionId ?? entry?.sessionId ?? clientRunId;
              const appended = appendAssistantTranscriptMessage({
                message: combinedReply,
                sessionId,
                storePath: latestStorePath,
                sessionFile: latestEntry?.sessionFile,
                agentId,
                createIfMissing: true,
              });
              if (appended.ok) {
                message = appended.message;
              } else {
                context.logGateway.warn(
                  `webchat transcript append failed: ${appended.error ?? "unknown error"}`,
                );
                const now = Date.now();
                message = {
                  role: "assistant",
                  content: [{ type: "text", text: combinedReply }],
                  timestamp: now,
                  stopReason: "stop",
                  usage: { input: 0, output: 0, totalTokens: 0 },
                };
              }
            }
          }
          if (!agentRunStarted) {
            broadcastChatFinal({
              context,
              runId: clientRunId,
              sessionKey: rawSessionKey,
              message,
            });
          }
          setGatewayDedupeEntry({
            dedupe: context.dedupe,
            key: `chat:${clientRunId}`,
            entry: {
              ts: Date.now(),
              ok: true,
              payload: { runId: clientRunId, status: "ok" as const },
            },
          });
        })
        .catch((err) => {
          const error = errorShape(ErrorCodes.UNAVAILABLE, String(err));
          setGatewayDedupeEntry({
            dedupe: context.dedupe,
            key: `chat:${clientRunId}`,
            entry: {
              ts: Date.now(),
              ok: false,
              payload: {
                runId: clientRunId,
                status: "error" as const,
                summary: String(err),
              },
              error,
            },
          });
          broadcastChatError({
            context,
            runId: clientRunId,
            sessionKey: rawSessionKey,
            errorMessage: String(err),
          });
        })
        .finally(() => {
          context.chatAbortControllers.delete(clientRunId);
        });
    } catch (err) {
      const error = errorShape(ErrorCodes.UNAVAILABLE, String(err));
      const payload = {
        runId: clientRunId,
        status: "error" as const,
        summary: String(err),
      };
      setGatewayDedupeEntry({
        dedupe: context.dedupe,
        key: `chat:${clientRunId}`,
        entry: {
          ts: Date.now(),
          ok: false,
          payload,
          error,
        },
      });
      respond(false, payload, error, {
        runId: clientRunId,
        error: formatForLog(err),
      });
    }
  },
  "chat.inject": async ({ params, respond, context }) => {
    if (!validateChatInjectParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid chat.inject params: ${formatValidationErrors(validateChatInjectParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as {
      sessionKey: string;
      message: string;
      label?: string;
    };

    // Load session to find transcript file
    const rawSessionKey = p.sessionKey;
    const { cfg, storePath, entry } = loadSessionEntry(rawSessionKey);
    const sessionId = entry?.sessionId;
    if (!sessionId || !storePath) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "session not found"));
      return;
    }

    const appended = appendAssistantTranscriptMessage({
      message: p.message,
      label: p.label,
      sessionId,
      storePath,
      sessionFile: entry?.sessionFile,
      agentId: resolveSessionAgentId({ sessionKey: rawSessionKey, config: cfg }),
      createIfMissing: false,
    });
    if (!appended.ok || !appended.messageId || !appended.message) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          `failed to write transcript: ${appended.error ?? "unknown error"}`,
        ),
      );
      return;
    }

    // Broadcast to webchat for immediate UI update
    const chatPayload = {
      runId: `inject-${appended.messageId}`,
      sessionKey: rawSessionKey,
      seq: 0,
      state: "final" as const,
      message: stripInlineDirectiveTagsFromMessageForDisplay(
        stripEnvelopeFromMessage(appended.message) as Record<string, unknown>,
      ),
    };
    context.broadcast("chat", chatPayload);
    context.nodeSendToSession(rawSessionKey, "chat", chatPayload);

    respond(true, { ok: true, messageId: appended.messageId });
  },
};
