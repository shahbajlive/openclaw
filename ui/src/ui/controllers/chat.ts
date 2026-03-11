import { extractRawText, extractText } from "../chat/message-extract.ts";
import {
  buildToolDedupeKeys,
  resolveToolCallId,
  resolveToolRunId,
  resolveToolSessionKey,
} from "../chat/tool-identity.ts";
import type { GatewayBrowserClient } from "../gateway.ts";
import type { ChatAttachment } from "../ui-types.ts";
import type { ChatQueueItem } from "../ui-types.ts";
import { generateUUID } from "../uuid.ts";
import { traceUiWs } from "../ws-trace.ts";

const SILENT_REPLY_PATTERN = /^\s*NO_REPLY\s*$/;
const ASSISTANT_DUPLICATE_WINDOW_MS = 10_000;

function isSilentReplyStream(text: string): boolean {
  return SILENT_REPLY_PATTERN.test(text);
}

/** Client-side defense-in-depth: detect assistant messages whose text is purely NO_REPLY. */
function isAssistantSilentReply(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  const entry = message as Record<string, unknown>;
  const role = typeof entry.role === "string" ? entry.role.toLowerCase() : "";
  if (role !== "assistant") {
    return false;
  }
  // entry.text takes precedence — matches gateway extractAssistantTextForSilentCheck
  if (typeof entry.text === "string") {
    return isSilentReplyStream(entry.text);
  }
  const text = extractText(message);
  return typeof text === "string" && isSilentReplyStream(text);
}

export type ChatState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  sessionKey: string;
  chatLoading: boolean;
  chatMessages: unknown[];
  chatToolMessages: unknown[];
  chatThinkingLevel: string | null;
  chatSending: boolean;
  chatMessage: string;
  chatDraftSelectionStart?: number | null;
  chatDraftSelectionEnd?: number | null;
  chatAttachments: ChatAttachment[];
  chatQueue: ChatQueueItem[];
  chatQueueRequestInFlight?: boolean;
  chatRunId: string | null;
  chatRunPhase: "processing" | "thinking" | "typing" | "tool_running" | "finalizing" | null;
  chatResetInFlight?: boolean;
  chatStream: string | null;
  chatStreamStartedAt: number | null;
  chatStreamCommittedPrefixLength?: number;
  lastError: string | null;
};

export type ChatEventPayload = {
  runId: string;
  sessionKey: string;
  state: "queued" | "queue_removed" | "started" | "phase" | "delta" | "final" | "aborted" | "error";
  phase?: "processing" | "thinking" | "typing" | "tool_running" | "finalizing";
  message?: unknown;
  errorMessage?: string;
  source?: string;
  queueItemId?: string;
};

export type ChatQueueChangedPayload = {
  sessionKey: string;
  queue?: ChatQueueItem[];
};

type ChatHistoryResponse = {
  messages?: Array<unknown>;
  toolInvocations?: Array<{ message?: unknown }>;
  queuedMessages?: ChatQueueItem[];
  activeRun?: {
    runId?: unknown;
    streamText?: unknown;
    startedAtMs?: unknown;
    phase?: unknown;
    effectiveUserMessage?: unknown;
  } | null;
  thinkingLevel?: string;
};

type ChatSendResponse = {
  runId?: string;
  status?: string;
  routedTo?: string;
  effectiveUserMessage?: string;
};

type ChatQueueActionResponse = {
  ok?: boolean;
  item?: ChatQueueItem | null;
  queue?: ChatQueueItem[];
};

function normalizeQueueItem(item: ChatQueueItem): ChatQueueItem {
  return {
    id: typeof item?.id === "string" ? item.id : generateUUID(),
    text: typeof item?.text === "string" ? item.text : "",
    createdAt: typeof item?.createdAt === "number" ? item.createdAt : Date.now(),
    attachments: Array.isArray(item?.attachments) ? item.attachments : undefined,
    source: "backend",
    editable: item?.editable ?? true,
    sendable: item?.sendable ?? true,
    steering: item?.steering ?? false,
    pendingAction: undefined,
  };
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

function normalizeQueueSnapshot(queue: ChatQueueItem[] | undefined): ChatQueueItem[] | null {
  if (!Array.isArray(queue)) {
    return null;
  }
  return queue.map((item) => normalizeQueueItem(item));
}

function filterQueuedTranscriptMessages(
  messages: unknown[],
  queuedItems: ChatQueueItem[],
): unknown[] {
  if (!messages.length || !queuedItems.length) {
    return messages;
  }
  const queuedIds = new Set(
    queuedItems.map((item) => item.id.trim()).filter((id) => id.length > 0),
  );
  if (queuedIds.size === 0) {
    return messages;
  }
  return messages.filter((message) => {
    if (!message || typeof message !== "object") {
      return true;
    }
    const entry = message as Record<string, unknown>;
    const idempotencyKey = trimIdempotencyKey(entry.idempotencyKey);
    if (!idempotencyKey || !queuedIds.has(idempotencyKey)) {
      return true;
    }
    const role = typeof entry.role === "string" ? entry.role.toLowerCase() : "";
    return role !== "user";
  });
}

function extractToolTimestamp(message: unknown): number | null {
  if (!message || typeof message !== "object") {
    return null;
  }
  const raw = (message as { timestamp?: unknown }).timestamp;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

function extractToolName(message: unknown): string | null {
  if (!message || typeof message !== "object") {
    return null;
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return null;
  }
  for (const item of content) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as { type?: unknown; name?: unknown };
    const type = typeof record.type === "string" ? record.type.trim().toLowerCase() : "";
    if (
      (type === "toolcall" || type === "tool_call" || type === "tooluse" || type === "tool_use") &&
      typeof record.name === "string" &&
      record.name.trim()
    ) {
      return record.name.trim();
    }
  }
  return null;
}

function mergeHydratedToolMessages(historyMessages: unknown[], liveMessages: unknown[]): unknown[] {
  if (historyMessages.length === 0) {
    return liveMessages;
  }
  if (liveMessages.length === 0) {
    return historyMessages;
  }

  const liveKeys = new Set<string>();
  for (const message of liveMessages) {
    const keys = buildToolDedupeKeys({
      toolCallId: resolveToolCallId(message),
      runId: resolveToolRunId(message),
      sessionKey: resolveToolSessionKey(message),
      name: extractToolName(message),
      timestamp: extractToolTimestamp(message),
    });
    for (const key of keys) {
      liveKeys.add(key);
    }
  }

  const preservedHistory = historyMessages.filter((message) => {
    const keys = buildToolDedupeKeys({
      toolCallId: resolveToolCallId(message),
      runId: resolveToolRunId(message),
      sessionKey: resolveToolSessionKey(message),
      name: extractToolName(message),
      timestamp: extractToolTimestamp(message),
    });
    return !keys.some((key) => liveKeys.has(key));
  });

  return [...preservedHistory, ...liveMessages];
}

function matchesQueuedItemForCurrentSession(
  state: Pick<ChatState, "chatQueue">,
  payload?: Pick<ChatEventPayload, "source" | "queueItemId">,
): boolean {
  if (payload?.source !== "queue") {
    return false;
  }
  const queueItemId = typeof payload.queueItemId === "string" ? payload.queueItemId.trim() : "";
  if (!queueItemId) {
    return false;
  }
  return state.chatQueue.some((item) => item.id === queueItemId);
}

function normalizeChatPhase(
  phase: unknown,
): "processing" | "thinking" | "typing" | "tool_running" | "finalizing" | null {
  switch (phase) {
    case "processing":
    case "thinking":
    case "typing":
    case "tool_running":
    case "finalizing":
      return phase;
    default:
      return null;
  }
}

function commitVisibleStreamToTranscript(
  state: Pick<ChatState, "chatMessages" | "chatStream" | "chatStreamStartedAt" | "chatRunId">,
  opts?: { clearOnly?: boolean; timestamp?: number },
) {
  const streamText = typeof state.chatStream === "string" ? state.chatStream : "";
  const trimmed = streamText.trim();
  if (!opts?.clearOnly && trimmed && !isSilentReplyStream(trimmed)) {
    const timestamp =
      typeof state.chatStreamStartedAt === "number"
        ? state.chatStreamStartedAt
        : (opts?.timestamp ?? Date.now());
    state.chatMessages = [
      ...state.chatMessages,
      buildAssistantTextMessage(streamText, timestamp, state.chatRunId),
    ];
  }
  state.chatStream = null;
  state.chatStreamStartedAt = null;
}

function applyQueueSnapshot(state: ChatState, queue: ChatQueueItem[] | undefined) {
  const normalized = normalizeQueueSnapshot(queue);
  if (normalized) {
    state.chatQueue = normalized;
  }
}

export async function loadChatHistory(state: ChatState) {
  if (!state.client || !state.connected) {
    return;
  }
  traceUiWs({
    ts: Date.now(),
    event: "chat.loadHistory.start",
    instanceId: null,
    sessionKey: state.sessionKey,
    runId: state.chatRunId,
    tab: null,
    details: {
      toolCountBefore: state.chatToolMessages.length,
      messageCountBefore: state.chatMessages.length,
    },
  });
  const previousRunId = state.chatRunId;
  state.chatLoading = true;
  state.lastError = null;
  try {
    const res = await state.client.request<ChatHistoryResponse>("chat.history", {
      sessionKey: state.sessionKey,
      limit: 200,
    });
    const queueSnapshot = Array.isArray(res.queuedMessages)
      ? res.queuedMessages.map((item) => normalizeQueueItem(item))
      : [];
    const messages = Array.isArray(res.messages) ? res.messages : [];
    state.chatMessages = filterQueuedTranscriptMessages(
      orderChatMessages(messages.filter((message) => !isAssistantSilentReply(message))),
      queueSnapshot,
    );
    const toolInvocations = Array.isArray(res.toolInvocations) ? res.toolInvocations : [];
    const hydratedToolMessages = toolInvocations
      .map((row) => row?.message)
      .filter((message): message is unknown => message !== undefined);
    state.chatToolMessages = mergeHydratedToolMessages(
      hydratedToolMessages,
      Array.isArray(state.chatToolMessages) ? state.chatToolMessages : [],
    );
    state.chatQueue = queueSnapshot;
    state.chatThinkingLevel = res.thinkingLevel ?? null;
    const activeRun = res.activeRun;
    const activeRunId =
      activeRun && typeof activeRun.runId === "string" ? activeRun.runId.trim() : "";
    if (activeRunId) {
      const streamText = typeof activeRun?.streamText === "string" ? activeRun.streamText : "";
      const activeRunPhase = normalizeChatPhase(activeRun?.phase) ?? "processing";
      const effectiveUserMessage =
        typeof activeRun?.effectiveUserMessage === "string"
          ? activeRun.effectiveUserMessage.trim()
          : "";
      state.chatRunId = activeRunId;
      state.chatRunPhase = activeRunPhase;
      if (effectiveUserMessage) {
        upsertChatMessage(
          state,
          buildSystemTextMessage(
            effectiveUserMessage,
            typeof activeRun?.startedAtMs === "number" ? activeRun.startedAtMs : Date.now(),
            `${activeRunId}:effective-user-message`,
          ),
        );
      }
      if (activeRunPhase === "typing" && streamText.trim()) {
        state.chatStream = streamText;
        state.chatStreamStartedAt =
          typeof activeRun?.startedAtMs === "number" ? activeRun.startedAtMs : Date.now();
      } else {
        state.chatStream = null;
        state.chatStreamStartedAt = null;
        if (streamText.trim() && !isSilentReplyStream(streamText)) {
          state.chatMessages = [
            ...state.chatMessages,
            buildAssistantTextMessage(
              streamText,
              typeof activeRun?.startedAtMs === "number" ? activeRun.startedAtMs : Date.now(),
              activeRunId,
            ),
          ];
        }
      }
      state.chatStreamCommittedPrefixLength = 0;
      state.chatSending = false;
    } else {
      state.chatRunId = null;
      state.chatRunPhase = state.chatSending ? "processing" : null;
      state.chatStream = null;
      state.chatStreamStartedAt = state.chatSending
        ? (state.chatStreamStartedAt ?? Date.now())
        : null;
      state.chatStreamCommittedPrefixLength = 0;
      if (previousRunId) {
        state.chatResetInFlight = false;
      }
    }
    traceUiWs({
      ts: Date.now(),
      event: "chat.loadHistory.end",
      instanceId: null,
      sessionKey: state.sessionKey,
      runId: state.chatRunId,
      tab: null,
      details: {
        toolCountAfter: state.chatToolMessages.length,
        messageCountAfter: state.chatMessages.length,
        activeRunId: state.chatRunId,
      },
    });
  } catch (err) {
    state.lastError = String(err);
    traceUiWs({
      ts: Date.now(),
      event: "chat.loadHistory.error",
      instanceId: null,
      sessionKey: state.sessionKey,
      runId: state.chatRunId,
      tab: null,
      details: { error: String(err) },
    });
  } finally {
    state.chatLoading = false;
  }
}

export async function enqueueChatMessage(
  state: ChatState,
  message: string,
  opts?: { idempotencyKey?: string },
): Promise<boolean> {
  if (!state.client || !state.connected) {
    return false;
  }
  if (state.chatQueueRequestInFlight) {
    return false;
  }
  const msg = message.trim();
  if (!msg) {
    return false;
  }
  state.lastError = null;
  state.chatQueueRequestInFlight = true;

  try {
    const res = await state.client.request<ChatQueueActionResponse>("chat.queue.enqueue", {
      sessionKey: state.sessionKey,
      message: msg,
      idempotencyKey: opts?.idempotencyKey?.trim() || generateUUID(),
    });
    if (res.ok !== true) {
      state.lastError = "Queue request was not accepted by the backend.";
      return false;
    }
    applyQueueSnapshot(state, res.queue);
    return true;
  } catch (err) {
    const error = String(err);
    state.lastError = error;
    state.chatMessages = [
      ...state.chatMessages,
      {
        role: "assistant",
        content: [{ type: "text", text: "Error: " + error }],
        timestamp: Date.now(),
      },
    ];
    return false;
  } finally {
    state.chatQueueRequestInFlight = false;
  }
}

export async function removeQueuedChatMessage(state: ChatState, itemId: string): Promise<boolean> {
  if (!state.client || !state.connected) {
    return false;
  }
  try {
    const res = await state.client.request<ChatQueueActionResponse>("chat.queue.remove", {
      sessionKey: state.sessionKey,
      itemId,
    });
    applyQueueSnapshot(state, res.queue);
    return res.ok === true;
  } catch (err) {
    state.lastError = String(err);
    return false;
  }
}

export async function popQueuedChatMessageForEdit(
  state: ChatState,
  itemId: string,
): Promise<ChatQueueItem | null> {
  if (!state.client || !state.connected) {
    return null;
  }
  try {
    const res = await state.client.request<ChatQueueActionResponse>("chat.queue.edit", {
      sessionKey: state.sessionKey,
      itemId,
    });
    applyQueueSnapshot(state, res.queue);
    return res.item ? normalizeQueueItem(res.item) : null;
  } catch (err) {
    state.lastError = String(err);
    return null;
  }
}

export async function sendQueuedChatMessageNow(state: ChatState, itemId: string): Promise<boolean> {
  if (!state.client || !state.connected) {
    return false;
  }
  try {
    const res = await state.client.request<ChatQueueActionResponse>("chat.queue.steer", {
      sessionKey: state.sessionKey,
      itemId,
    });
    if (res.ok !== true) {
      return false;
    }
    applyQueueSnapshot(state, res.queue);
    return true;
  } catch (err) {
    state.lastError = String(err);
    return false;
  }
}

function dataUrlToBase64(dataUrl: string): { content: string; mimeType: string } | null {
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!match) {
    return null;
  }
  return { mimeType: match[1], content: match[2] };
}

type AssistantMessageNormalizationOptions = {
  roleRequirement: "required" | "optional";
  roleCaseSensitive?: boolean;
  requireContentArray?: boolean;
  allowTextField?: boolean;
};

type UserContentBlock = { type: string; text?: string; source?: unknown };

function normalizeAssistantMessage(
  message: unknown,
  options: AssistantMessageNormalizationOptions,
): Record<string, unknown> | null {
  if (!message || typeof message !== "object") {
    return null;
  }
  const candidate = message as Record<string, unknown>;
  const roleValue = candidate.role;
  if (typeof roleValue === "string") {
    const role = options.roleCaseSensitive ? roleValue : roleValue.toLowerCase();
    if (role !== "assistant") {
      return null;
    }
  } else if (options.roleRequirement === "required") {
    return null;
  }

  if (options.requireContentArray) {
    return Array.isArray(candidate.content) ? candidate : null;
  }
  if (!("content" in candidate) && !(options.allowTextField && "text" in candidate)) {
    return null;
  }
  return candidate;
}

function normalizeAbortedAssistantMessage(message: unknown): Record<string, unknown> | null {
  return normalizeAssistantMessage(message, {
    roleRequirement: "required",
    roleCaseSensitive: true,
    requireContentArray: true,
  });
}

function normalizeFinalAssistantMessage(message: unknown): Record<string, unknown> | null {
  return normalizeAssistantMessage(message, {
    roleRequirement: "optional",
    allowTextField: true,
  });
}

function buildAssistantTextMessage(
  text: string,
  timestamp: number,
  runId?: string | null,
  extras?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...extras,
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp,
    ...(typeof runId === "string" && runId.trim() ? { runId: runId.trim() } : {}),
  };
}

function buildSystemTextMessage(
  text: string,
  timestamp: number,
  idempotencyKey?: string,
): Record<string, unknown> {
  return {
    role: "system",
    content: [{ type: "text", text }],
    timestamp,
    ...(typeof idempotencyKey === "string" && idempotencyKey.trim()
      ? { idempotencyKey: idempotencyKey.trim() }
      : {}),
  };
}

function trimCommittedAssistantMessage(
  message: unknown,
  committedPrefixLength: number,
  fallbackRunId?: string | null,
): Record<string, unknown> | null {
  const normalized = normalizeFinalAssistantMessage(message);
  if (!normalized) {
    return null;
  }
  if (committedPrefixLength <= 0) {
    return normalized;
  }
  const fullText = extractText(normalized);
  if (typeof fullText !== "string") {
    return normalized;
  }
  const remainingText = fullText.slice(Math.max(0, committedPrefixLength));
  if (!remainingText.trim()) {
    return null;
  }
  const timestamp = typeof normalized.timestamp === "number" ? normalized.timestamp : Date.now();
  const runId =
    typeof normalized.runId === "string"
      ? normalized.runId
      : typeof normalized.run_id === "string"
        ? normalized.run_id
        : fallbackRunId;
  const extras: Record<string, unknown> = {};
  if (typeof normalized.idempotencyKey === "string" && normalized.idempotencyKey.trim()) {
    extras.idempotencyKey = normalized.idempotencyKey.trim();
  }
  if (normalized.openclawAbort && typeof normalized.openclawAbort === "object") {
    extras.openclawAbort = normalized.openclawAbort;
  }
  return buildAssistantTextMessage(remainingText, timestamp, runId, extras);
}

function trimIdempotencyKey(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function messageTimestamp(value: unknown): number | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const timestamp = (value as { timestamp?: unknown }).timestamp;
  return typeof timestamp === "number" && Number.isFinite(timestamp) ? timestamp : null;
}

function orderChatMessages(messages: unknown[]): unknown[] {
  return messages
    .map((message, index) => ({
      message,
      index,
      timestamp: messageTimestamp(message) ?? Number.MAX_SAFE_INTEGER,
    }))
    .toSorted((left, right) => left.timestamp - right.timestamp || left.index - right.index)
    .map((entry) => entry.message);
}

function isNearDuplicateAssistantMessage(left: unknown, right: unknown): boolean {
  if (!left || typeof left !== "object" || !right || typeof right !== "object") {
    return false;
  }
  const leftRole =
    typeof (left as Record<string, unknown>).role === "string"
      ? String((left as Record<string, unknown>).role).toLowerCase()
      : "";
  const rightRole =
    typeof (right as Record<string, unknown>).role === "string"
      ? String((right as Record<string, unknown>).role).toLowerCase()
      : "";
  if (leftRole !== "assistant" || rightRole !== "assistant") {
    return false;
  }
  const leftText = extractText(left)?.trim();
  const rightText = extractText(right)?.trim();
  if (!leftText || !rightText || leftText !== rightText) {
    return false;
  }
  const leftTs =
    typeof (left as Record<string, unknown>).timestamp === "number"
      ? ((left as Record<string, unknown>).timestamp as number)
      : null;
  const rightTs =
    typeof (right as Record<string, unknown>).timestamp === "number"
      ? ((right as Record<string, unknown>).timestamp as number)
      : null;
  if (leftTs === null || rightTs === null) {
    return false;
  }
  return Math.abs(leftTs - rightTs) <= ASSISTANT_DUPLICATE_WINDOW_MS;
}

function upsertChatMessage(state: ChatState, message: unknown) {
  const nextId = trimIdempotencyKey((message as { idempotencyKey?: unknown })?.idempotencyKey);
  if (!nextId) {
    const last = state.chatMessages.at(-1);
    if (last && isNearDuplicateAssistantMessage(last, message)) {
      state.chatMessages = orderChatMessages([...state.chatMessages.slice(0, -1), message]);
      return;
    }
    state.chatMessages = orderChatMessages([...state.chatMessages, message]);
    return;
  }
  let replaced = false;
  state.chatMessages = state.chatMessages.map((entry) => {
    const entryId = trimIdempotencyKey((entry as { idempotencyKey?: unknown })?.idempotencyKey);
    if (entryId !== nextId) {
      return entry;
    }
    replaced = true;
    return message;
  });
  if (!replaced) {
    state.chatMessages = [...state.chatMessages, message];
  }
  state.chatMessages = orderChatMessages(state.chatMessages);
}

function removeChatMessageByIdempotencyKey(state: ChatState, id: string) {
  const trimmed = id.trim();
  if (!trimmed) {
    return;
  }
  state.chatMessages = state.chatMessages.filter((entry) => {
    const entryId = trimIdempotencyKey((entry as { idempotencyKey?: unknown })?.idempotencyKey);
    return entryId !== trimmed;
  });
}

function buildChatMessageFromQueueItem(
  item: ChatQueueItem,
  acceptedAt: number,
): Record<string, unknown> {
  const content: UserContentBlock[] = [];
  const text = typeof item.text === "string" ? item.text.trim() : "";
  if (text) {
    content.push({ type: "text", text });
  }
  for (const attachment of item.attachments ?? []) {
    content.push({
      type: "image",
      source: { type: "base64", media_type: attachment.mimeType, data: attachment.dataUrl },
    });
  }
  return {
    role: "user",
    content,
    timestamp: acceptedAt,
    idempotencyKey: item.id,
    queued: false,
  };
}

function markQueuedMessageAccepted(state: ChatState, id: string, acceptedAt: number) {
  const trimmed = id.trim();
  if (!trimmed) {
    return;
  }
  state.chatMessages = state.chatMessages.map((entry) => {
    if (!entry || typeof entry !== "object") {
      return entry;
    }
    const entryRecord = entry as Record<string, unknown>;
    const entryId = trimIdempotencyKey(entryRecord.idempotencyKey);
    if (entryId !== trimmed) {
      return entry;
    }
    const priorTimestamp =
      typeof entryRecord.timestamp === "number" ? entryRecord.timestamp : acceptedAt;
    return {
      ...entryRecord,
      queued: false,
      timestamp: Math.max(priorTimestamp, acceptedAt),
    };
  });
}

function promoteAcceptedQueueItemToTranscript(
  state: ChatState,
  item: ChatQueueItem | undefined,
  acceptedAt: number,
) {
  if (!item) {
    return;
  }
  const itemId = item.id.trim();
  if (!itemId) {
    return;
  }
  const alreadyPresent = state.chatMessages.some((entry) => {
    if (!entry || typeof entry !== "object") {
      return false;
    }
    return trimIdempotencyKey((entry as Record<string, unknown>).idempotencyKey) === itemId;
  });
  if (alreadyPresent) {
    markQueuedMessageAccepted(state, itemId, acceptedAt);
    return;
  }
  upsertChatMessage(state, buildChatMessageFromQueueItem(item, acceptedAt));
}

export async function sendChatMessage(
  state: ChatState,
  message: string,
  attachments?: ChatAttachment[],
): Promise<string | null> {
  if (!state.client || !state.connected) {
    return null;
  }
  const msg = message.trim();
  const hasAttachments = attachments && attachments.length > 0;
  if (!msg && !hasAttachments) {
    return null;
  }

  const now = Date.now();
  const runId = generateUUID();
  traceUiWs({
    ts: now,
    event: "chat.send.request",
    instanceId: null,
    sessionKey: state.sessionKey,
    runId,
    tab: null,
    details: {
      text: msg,
      attachmentCount: attachments?.length ?? 0,
    },
  });

  // Build user message content blocks
  const contentBlocks: UserContentBlock[] = [];
  if (msg) {
    contentBlocks.push({ type: "text", text: msg });
  }
  // Add image previews to the message for display
  if (hasAttachments) {
    for (const att of attachments) {
      contentBlocks.push({
        type: "image",
        source: { type: "base64", media_type: att.mimeType, data: att.dataUrl },
      });
    }
  }

  const optimisticUserMessage = {
    role: "user",
    content: contentBlocks,
    timestamp: now,
    idempotencyKey: runId,
  };
  state.chatMessages = [...state.chatMessages, optimisticUserMessage];

  state.chatSending = true;
  state.chatRunPhase = "processing";
  state.chatStreamStartedAt = now;
  state.lastError = null;

  // Convert attachments to API format
  const apiAttachments = hasAttachments
    ? attachments
        .map((att) => {
          const parsed = dataUrlToBase64(att.dataUrl);
          if (!parsed) {
            return null;
          }
          return {
            type: "image",
            mimeType: parsed.mimeType,
            content: parsed.content,
          };
        })
        .filter((a): a is NonNullable<typeof a> => a !== null)
    : undefined;

  try {
    const response = await state.client.request<ChatSendResponse>("chat.send", {
      sessionKey: state.sessionKey,
      message: msg,
      deliver: false,
      idempotencyKey: runId,
      attachments: apiAttachments,
    });
    traceUiWs({
      ts: Date.now(),
      event: "chat.send.response",
      instanceId: null,
      sessionKey: state.sessionKey,
      runId,
      tab: null,
      details: {
        responseRunId: response?.runId ?? null,
        status: response?.status ?? null,
        routedTo: response?.routedTo ?? null,
      },
    });
    if (typeof response?.routedTo === "string" && response.routedTo.trim()) {
      state.chatSending = false;
      state.chatRunPhase = null;
      state.chatStream = null;
      state.chatStreamStartedAt = null;
      state.chatStreamCommittedPrefixLength = 0;
    } else if (typeof response?.runId === "string" && response.runId.trim()) {
      state.chatRunId = response.runId.trim();
      if (
        typeof response?.effectiveUserMessage === "string" &&
        response.effectiveUserMessage.trim()
      ) {
        upsertChatMessage(
          state,
          buildSystemTextMessage(
            response.effectiveUserMessage.trim(),
            now,
            `${response.runId.trim()}:effective-user-message`,
          ),
        );
      }
    }
    return runId;
  } catch (err) {
    const error = String(err);
    state.lastError = error;
    state.chatSending = false;
    state.chatRunPhase = null;
    state.chatMessages = [
      ...state.chatMessages,
      {
        role: "assistant",
        content: [{ type: "text", text: "Error: " + error }],
        timestamp: Date.now(),
      },
    ];
    return null;
  }
}

export async function abortChatRun(state: ChatState): Promise<boolean> {
  if (!state.client || !state.connected) {
    return false;
  }
  const runId = state.chatRunId;
  traceUiWs({
    ts: Date.now(),
    event: "chat.abort.request",
    instanceId: null,
    sessionKey: state.sessionKey,
    runId,
    tab: null,
    details: {
      hasRunId: Boolean(runId),
      sending: state.chatSending,
      phase: state.chatRunPhase,
    },
  });
  try {
    const response = await state.client.request(
      "chat.abort",
      runId ? { sessionKey: state.sessionKey, runId } : { sessionKey: state.sessionKey },
    );
    traceUiWs({
      ts: Date.now(),
      event: "chat.abort.response",
      instanceId: null,
      sessionKey: state.sessionKey,
      runId,
      tab: null,
      details: {
        response,
      },
    });
    return true;
  } catch (err) {
    state.lastError = String(err);
    return false;
  }
}

export function handleChatEvent(state: ChatState, payload?: ChatEventPayload) {
  if (!payload) {
    return null;
  }
  traceUiWs({
    ts: Date.now(),
    event: "chat.event.received",
    instanceId: null,
    sessionKey: payload.sessionKey ?? state.sessionKey,
    runId: payload.runId ?? state.chatRunId,
    tab: null,
    details: {
      state: payload.state,
      phase: payload.phase ?? null,
      activeRunIdBefore: state.chatRunId,
      activePhaseBefore: state.chatRunPhase,
      streamBefore: state.chatStream,
      streamLenBefore: typeof state.chatStream === "string" ? state.chatStream.length : null,
      committedPrefixBefore: state.chatStreamCommittedPrefixLength ?? 0,
      messageCountBefore: state.chatMessages.length,
      toolCountBefore: state.chatToolMessages.length,
      payloadText: extractText(payload.message),
    },
  });
  if (
    payload.sessionKey !== state.sessionKey &&
    !matchesQueuedItemForCurrentSession(state, payload)
  ) {
    return null;
  }

  if (payload.state === "queued") {
    return "queued";
  }

  if (payload.state === "queue_removed") {
    const queueItemId = typeof payload.queueItemId === "string" ? payload.queueItemId.trim() : "";
    if (queueItemId) {
      removeChatMessageByIdempotencyKey(state, queueItemId);
    }
    return "queue_removed";
  }

  if (payload.state === "started") {
    const startedAt = Date.now();
    state.chatSending = false;
    state.chatRunId = payload.runId;
    state.chatRunPhase = normalizeChatPhase(payload.phase) ?? "processing";
    state.chatStream = "";
    state.chatStreamStartedAt = startedAt;
    state.chatStreamCommittedPrefixLength = 0;
    if (payload.source === "queue") {
      const queueItemId = typeof payload.queueItemId === "string" ? payload.queueItemId.trim() : "";
      if (queueItemId) {
        const acceptedItem = state.chatQueue.find((item) => item.id === queueItemId);
        state.chatQueue = state.chatQueue.filter((item) => item.id !== queueItemId);
        promoteAcceptedQueueItemToTranscript(state, acceptedItem, startedAt);
      } else {
        const [acceptedItem, ...remaining] = state.chatQueue;
        state.chatQueue = remaining;
        promoteAcceptedQueueItemToTranscript(state, acceptedItem, startedAt);
      }
    }
    return "started";
  }

  if (payload.state === "phase") {
    const nextPhase = normalizeChatPhase(payload.phase) ?? "processing";
    if (state.chatRunPhase === "typing" && nextPhase !== "typing") {
      commitVisibleStreamToTranscript(state);
    }
    state.chatRunPhase = nextPhase;
    return "phase";
  }

  // Final from another run (e.g. sub-agent announce): refresh history to show new message.
  // See https://github.com/openclaw/openclaw/issues/1909
  if (payload.runId && state.chatRunId && payload.runId !== state.chatRunId) {
    if (payload.state === "final") {
      const finalMessage = normalizeFinalAssistantMessage(payload.message);
      if (finalMessage && !isAssistantSilentReply(finalMessage)) {
        upsertChatMessage(state, finalMessage);
        return null;
      }
      return "final";
    }
    return null;
  }

  if (payload.state === "delta") {
    state.chatRunPhase = normalizeChatPhase(payload.phase) ?? "typing";
    const next = extractRawText(payload.message);
    if (typeof next === "string" && !isSilentReplyStream(next)) {
      const current = state.chatStream ?? "";
      const merged = appendUniqueSuffix(current, next);
      if (merged !== current) {
        if (!current && next.length > 0) {
          state.chatStreamStartedAt = Date.now();
        }
        state.chatStream = merged;
      }
    }
  } else if (payload.state === "final") {
    state.chatSending = false;
    state.chatRunPhase = null;
    const finalMessage = trimCommittedAssistantMessage(
      payload.message,
      Math.max(0, state.chatStreamCommittedPrefixLength ?? 0),
      payload.runId,
    );
    if (finalMessage && !isAssistantSilentReply(finalMessage)) {
      upsertChatMessage(state, finalMessage);
      traceUiWs({
        ts: Date.now(),
        event: "chat.event.final.upserted-message",
        instanceId: null,
        sessionKey: state.sessionKey,
        runId: payload.runId ?? state.chatRunId,
        tab: null,
        details: {
          finalText: extractText(finalMessage),
          messageCountAfter: state.chatMessages.length,
        },
      });
    } else if (state.chatStream?.trim() && !isSilentReplyStream(state.chatStream)) {
      state.chatMessages = [
        ...state.chatMessages,
        {
          ...buildAssistantTextMessage(state.chatStream, Date.now(), state.chatRunId),
        },
      ];
    }
    state.chatStream = null;
    state.chatRunId = null;
    state.chatStreamStartedAt = null;
    state.chatStreamCommittedPrefixLength = 0;
  } else if (payload.state === "aborted") {
    state.chatSending = false;
    state.chatRunPhase = null;
    const normalizedMessage = trimCommittedAssistantMessage(
      normalizeAbortedAssistantMessage(payload.message),
      Math.max(0, state.chatStreamCommittedPrefixLength ?? 0),
      payload.runId,
    );
    if (normalizedMessage && !isAssistantSilentReply(normalizedMessage)) {
      upsertChatMessage(state, normalizedMessage);
      traceUiWs({
        ts: Date.now(),
        event: "chat.event.aborted.upserted-message",
        instanceId: null,
        sessionKey: state.sessionKey,
        runId: payload.runId ?? state.chatRunId,
        tab: null,
        details: {
          abortedText: extractText(normalizedMessage),
          messageCountAfter: state.chatMessages.length,
        },
      });
    } else {
      const streamedText = state.chatStream ?? "";
      if (streamedText.trim() && !isSilentReplyStream(streamedText)) {
        state.chatMessages = [
          ...state.chatMessages,
          {
            ...buildAssistantTextMessage(streamedText, Date.now(), state.chatRunId),
          },
        ];
      }
    }
    state.chatStream = null;
    state.chatRunId = null;
    state.chatStreamStartedAt = null;
    state.chatStreamCommittedPrefixLength = 0;
  } else if (payload.state === "error") {
    state.chatSending = false;
    state.chatRunPhase = null;
    state.chatStream = null;
    state.chatRunId = null;
    state.chatStreamStartedAt = null;
    state.chatStreamCommittedPrefixLength = 0;
    state.lastError = payload.errorMessage ?? "chat error";
  }
  return payload.state;
}

export function handleChatQueueChangedEvent(state: ChatState, payload?: ChatQueueChangedPayload) {
  if (!payload || payload.sessionKey !== state.sessionKey) {
    return false;
  }
  applyQueueSnapshot(state, payload.queue);
  return true;
}
