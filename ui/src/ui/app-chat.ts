import { parseAgentSessionKey } from "../../../src/sessions/session-key-utils.js";
import { scheduleChatScroll } from "./app-scroll.ts";
import { setLastActiveSessionKey } from "./app-settings.ts";
import { resetToolStream } from "./app-tool-stream.ts";
import type { OpenClawApp } from "./app.ts";
import {
  abortChatRun,
  enqueueChatMessage as enqueueChatMessageToBackend,
  loadChatHistory,
  popQueuedChatMessageForEdit,
  removeQueuedChatMessage,
  sendChatMessage,
  sendQueuedChatMessageNow as sendQueuedChatMessageNowBackend,
} from "./controllers/chat.ts";
import { loadSessions } from "./controllers/sessions.ts";
import type { GatewayBrowserClient, GatewayHelloOk } from "./gateway.ts";
import { normalizeBasePath } from "./navigation.ts";
import type { ChatAttachment, ChatQueueItem } from "./ui-types.ts";
import { generateUUID } from "./uuid.ts";

export type ChatHost = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  chatMessage: string;
  chatDraftSelectionStart: number | null;
  chatDraftSelectionEnd: number | null;
  chatMentionQuery: string | null;
  chatMentionStart: number | null;
  chatMentionEnd: number | null;
  chatMentionSelectedIndex: number;
  chatAttachments: ChatAttachment[];
  chatQueue: ChatQueueItem[];
  chatQueueRequestInFlight?: boolean;
  chatRunId: string | null;
  chatResetInFlight: boolean;
  chatLastTerminalRunId?: string | null;
  chatLastTerminalAt?: number | null;
  chatSending: boolean;
  sessionKey: string;
  basePath: string;
  hello: GatewayHelloOk | null;
  chatAvatarUrl: string | null;
  lastError: string | null;
  refreshSessionsAfterChat: Set<string>;
};

export const CHAT_SESSIONS_ACTIVE_MINUTES = 120;

function clearChatMentionState(
  host: Pick<
    ChatHost,
    "chatMentionQuery" | "chatMentionStart" | "chatMentionEnd" | "chatMentionSelectedIndex"
  >,
) {
  host.chatMentionQuery = null;
  host.chatMentionStart = null;
  host.chatMentionEnd = null;
  host.chatMentionSelectedIndex = 0;
}

function insertTextIntoDraftAtSelection(host: ChatHost, text: string) {
  const insert = text.trim();
  if (!insert) {
    return;
  }
  const current = host.chatMessage ?? "";
  const start = Math.max(
    0,
    Math.min(host.chatDraftSelectionStart ?? current.length, current.length),
  );
  const end = Math.max(start, Math.min(host.chatDraftSelectionEnd ?? start, current.length));
  host.chatMessage = `${current.slice(0, start)}${insert}${current.slice(end)}`;
  const nextCaret = start + insert.length;
  host.chatDraftSelectionStart = nextCaret;
  host.chatDraftSelectionEnd = nextCaret;
}

function setQueuedItemPendingAction(
  host: ChatHost,
  id: string,
  pendingAction?: ChatQueueItem["pendingAction"],
) {
  host.chatQueue = host.chatQueue.map((entry) =>
    entry.id === id
      ? {
          ...entry,
          pendingAction,
          sendable: pendingAction ? false : entry.sendable,
          editable: pendingAction ? false : entry.editable,
        }
      : entry,
  );
}

export function isChatBusy(host: ChatHost) {
  return host.chatSending || Boolean(host.chatRunId);
}

export function isChatStopCommand(text: string) {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  const normalized = trimmed.toLowerCase();
  if (normalized === "/stop") {
    return true;
  }
  return (
    normalized === "stop" ||
    normalized === "esc" ||
    normalized === "abort" ||
    normalized === "wait" ||
    normalized === "exit"
  );
}

function isChatResetCommand(text: string) {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  const normalized = trimmed.toLowerCase();
  if (normalized === "/new" || normalized === "/reset") {
    return true;
  }
  return normalized.startsWith("/new ") || normalized.startsWith("/reset ");
}

export async function handleAbortChat(host: ChatHost) {
  if (!host.connected) {
    return;
  }
  host.chatMessage = "";
  clearChatMentionState(host);
  await abortChatRun(host as unknown as OpenClawApp);
}

export async function resetChatSession(host: ChatHost) {
  if (!host.client || !host.connected) {
    return false;
  }
  try {
    await host.client.request("sessions.reset", { key: host.sessionKey });
    host.chatMessage = "";
    clearChatMentionState(host);
    host.chatAttachments = [];
    host.chatQueue = [];
    host.chatRunId = null;
    await refreshChat(host, { scheduleScroll: true });
    return true;
  } catch {
    return false;
  }
}

async function sendChatMessageNow(
  host: ChatHost,
  message: string,
  opts?: {
    previousDraft?: string;
    restoreDraft?: boolean;
    attachments?: ChatAttachment[];
    previousAttachments?: ChatAttachment[];
    restoreAttachments?: boolean;
    refreshSessions?: boolean;
  },
) {
  resetToolStream(host as unknown as Parameters<typeof resetToolStream>[0]);
  host.chatLastTerminalRunId = null;
  host.chatLastTerminalAt = null;
  const runId = await sendChatMessage(host as unknown as OpenClawApp, message, opts?.attachments);
  const ok = Boolean(runId);
  if (!ok && opts?.previousDraft != null) {
    host.chatMessage = opts.previousDraft;
  }
  if (!ok && opts?.previousAttachments) {
    host.chatAttachments = opts.previousAttachments;
  }
  if (ok) {
    setLastActiveSessionKey(
      host as unknown as Parameters<typeof setLastActiveSessionKey>[0],
      host.sessionKey,
    );
  }
  if (ok && opts?.restoreDraft && opts.previousDraft?.trim()) {
    host.chatMessage = opts.previousDraft;
  }
  if (ok && opts?.restoreAttachments && opts.previousAttachments?.length) {
    host.chatAttachments = opts.previousAttachments;
  }
  scheduleChatScroll(host as unknown as Parameters<typeof scheduleChatScroll>[0]);
  if (ok && opts?.refreshSessions && runId) {
    host.refreshSessionsAfterChat.add(runId);
  }
  return ok;
}

export async function removeQueuedMessage(host: ChatHost, id: string) {
  const item = host.chatQueue.find((entry) => entry.id === id);
  if (!item) {
    return;
  }
  if (item.source !== "backend") {
    return;
  }
  setQueuedItemPendingAction(host, id, "removing");
  const removed = await removeQueuedChatMessage(
    host as unknown as Parameters<typeof removeQueuedChatMessage>[0],
    id,
  );
  if (removed) {
    return;
  }
  setQueuedItemPendingAction(host, id, undefined);
}

export async function editQueuedMessage(host: ChatHost, id: string) {
  const item = host.chatQueue.find((entry) => entry.id === id);
  if (!item || item.editable === false) {
    return;
  }
  if (item.source !== "backend") {
    return;
  }
  setQueuedItemPendingAction(host, id, "editing");
  const editableItem = await popQueuedChatMessageForEdit(
    host as unknown as Parameters<typeof popQueuedChatMessageForEdit>[0],
    id,
  );
  if (!editableItem) {
    setQueuedItemPendingAction(host, id, undefined);
    return;
  }
  insertTextIntoDraftAtSelection(host, editableItem.text);
  clearChatMentionState(host);
  host.chatAttachments = editableItem.attachments?.map((att) => ({ ...att })) ?? [];
}

export async function sendQueuedMessageNow(host: ChatHost, id: string) {
  const item = host.chatQueue.find((entry) => entry.id === id);
  if (!item) {
    return;
  }
  if (item.source !== "backend") {
    return;
  }
  setQueuedItemPendingAction(host, id, "steering");
  const steered = await sendQueuedChatMessageNowBackend(
    host as unknown as Parameters<typeof sendQueuedChatMessageNowBackend>[0],
    id,
  );
  if (!steered) {
    setQueuedItemPendingAction(host, id, undefined);
    return;
  }
}

export async function handleSendChat(
  host: ChatHost,
  messageOverride?: string,
  opts?: { restoreDraft?: boolean },
) {
  if (!host.connected) {
    return;
  }
  const previousDraft = host.chatMessage;
  const message = (messageOverride ?? host.chatMessage).trim();
  const attachments = host.chatAttachments ?? [];
  const attachmentsToSend = messageOverride == null ? attachments : [];
  const hasAttachments = attachmentsToSend.length > 0;

  // Allow sending with just attachments (no message text required)
  if (!message && !hasAttachments) {
    return;
  }

  if (isChatStopCommand(message)) {
    await handleAbortChat(host);
    return;
  }

  const refreshSessions = isChatResetCommand(message);
  if (refreshSessions && host.chatResetInFlight) {
    return;
  }
  if (messageOverride == null) {
    host.chatMessage = "";
    clearChatMentionState(host);
    // Clear attachments when sending
    host.chatAttachments = [];
  }

  if (isChatBusy(host)) {
    if (refreshSessions) {
      return;
    }
    if (!attachmentsToSend.length && !refreshSessions) {
      if (host.chatQueueRequestInFlight) {
        return;
      }
      const pendingId = generateUUID();
      host.chatQueue = [
        ...host.chatQueue,
        {
          id: pendingId,
          text: message,
          createdAt: Date.now(),
          source: "local",
          editable: false,
          sendable: false,
          pendingAction: "enqueueing",
        },
      ];
      let ok = false;
      try {
        ok = await enqueueChatMessageToBackend(
          host as unknown as Parameters<typeof enqueueChatMessageToBackend>[0],
          message,
          { idempotencyKey: pendingId },
        );
      } finally {
        host.chatQueue = host.chatQueue.filter(
          (entry) => !(entry.id === pendingId && entry.source === "local"),
        );
      }
      if (!ok) {
        host.lastError ??= "Queue request was not accepted by the backend.";
        if (messageOverride == null) {
          host.chatMessage = previousDraft;
          host.chatAttachments = attachments;
        }
      }
      if (messageOverride == null) {
        if (ok) {
          host.chatMessage = "";
          clearChatMentionState(host);
          host.chatAttachments = [];
        }
      }
      scheduleChatScroll(host as unknown as Parameters<typeof scheduleChatScroll>[0]);
      return;
    }
    host.lastError = "Busy queueing currently supports text-only backend queue items.";
    if (messageOverride == null) {
      host.chatMessage = previousDraft;
      host.chatAttachments = attachments;
    }
    return;
  }

  if (refreshSessions) {
    host.chatResetInFlight = true;
  }
  const ok = await sendChatMessageNow(host, message, {
    previousDraft: messageOverride == null ? previousDraft : undefined,
    restoreDraft: Boolean(messageOverride && opts?.restoreDraft),
    attachments: hasAttachments ? attachmentsToSend : undefined,
    previousAttachments: messageOverride == null ? attachments : undefined,
    restoreAttachments: Boolean(messageOverride && opts?.restoreDraft),
    refreshSessions,
  });
  if (refreshSessions && !ok) {
    host.chatResetInFlight = false;
  }
}

export async function refreshChat(host: ChatHost, opts?: { scheduleScroll?: boolean }) {
  await Promise.all([
    loadChatHistory(host as unknown as OpenClawApp),
    loadSessions(host as unknown as OpenClawApp, {
      activeMinutes: CHAT_SESSIONS_ACTIVE_MINUTES,
    }),
    refreshChatAvatar(host),
  ]);
  if (opts?.scheduleScroll !== false) {
    scheduleChatScroll(host as unknown as Parameters<typeof scheduleChatScroll>[0]);
  }
}

export async function flushChatQueueForEvent(host: ChatHost) {
  void host;
}

type SessionDefaultsSnapshot = {
  defaultAgentId?: string;
};

function resolveAgentIdForSession(host: ChatHost): string | null {
  const parsed = parseAgentSessionKey(host.sessionKey);
  if (parsed?.agentId) {
    return parsed.agentId;
  }
  const snapshot = host.hello?.snapshot as
    | { sessionDefaults?: SessionDefaultsSnapshot }
    | undefined;
  const fallback = snapshot?.sessionDefaults?.defaultAgentId?.trim();
  return fallback || "main";
}

function buildAvatarMetaUrl(basePath: string, agentId: string): string {
  const base = normalizeBasePath(basePath);
  const encoded = encodeURIComponent(agentId);
  return base ? `${base}/avatar/${encoded}?meta=1` : `/avatar/${encoded}?meta=1`;
}

export async function refreshChatAvatar(host: ChatHost) {
  if (!host.connected) {
    host.chatAvatarUrl = null;
    return;
  }
  const agentId = resolveAgentIdForSession(host);
  if (!agentId) {
    host.chatAvatarUrl = null;
    return;
  }
  host.chatAvatarUrl = null;
  const url = buildAvatarMetaUrl(host.basePath, agentId);
  try {
    const res = await fetch(url, { method: "GET" });
    if (!res.ok) {
      host.chatAvatarUrl = null;
      return;
    }
    const data = (await res.json()) as { avatarUrl?: unknown };
    const avatarUrl = typeof data.avatarUrl === "string" ? data.avatarUrl.trim() : "";
    host.chatAvatarUrl = avatarUrl || null;
  } catch {
    host.chatAvatarUrl = null;
  }
}
