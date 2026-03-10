import { html, nothing } from "lit";
import { ref } from "lit/directives/ref.js";
import { repeat } from "lit/directives/repeat.js";
import { applyDraftMentionSuggestion, type MentionSuggestion } from "../chat/draft-mentions.ts";
import {
  renderMessageGroup,
  renderReadingIndicatorGroup,
  renderStreamingGroup,
} from "../chat/grouped-render.ts";
import { normalizeMessage, normalizeRoleForGrouping } from "../chat/message-normalizer.ts";
import { extractToolCards } from "../chat/tool-cards.ts";
import {
  buildPrimaryToolDedupeKey,
  buildToolDedupeKeys,
  resolveToolCallId,
  resolveToolRunId,
  resolveToolSessionKey,
} from "../chat/tool-identity.ts";
import { icons } from "../icons.ts";
import { detectTextDirection } from "../text-direction.ts";
import type { SessionsListResult } from "../types.ts";
import type { WorkspaceAgentRow } from "../types.ts";
import type { ChatItem, MessageGroup } from "../types/chat-types.ts";
import type { ChatAttachment, ChatQueueItem } from "../ui-types.ts";
import { renderMarkdownSidebar } from "./markdown-sidebar.ts";
import "../components/resizable-divider.ts";

export type CompactionIndicatorStatus = {
  active: boolean;
  startedAt: number | null;
  completedAt: number | null;
};

export type FallbackIndicatorStatus = {
  phase?: "active" | "cleared";
  selected: string;
  active: string;
  previous?: string;
  reason?: string;
  attempts: string[];
  occurredAt: number;
};

export type ChatProps = {
  sessionKey: string;
  onSessionKeyChange: (next: string) => void;
  thinkingLevel: string | null;
  showThinking: boolean;
  loading: boolean;
  sending: boolean;
  canAbort?: boolean;
  hideNewSessionButton?: boolean;
  compactionStatus?: CompactionIndicatorStatus | null;
  fallbackStatus?: FallbackIndicatorStatus | null;
  messages: unknown[];
  toolMessages: unknown[];
  stream: string | null;
  streamStartedAt: number | null;
  assistantAvatarUrl?: string | null;
  draft: string;
  queue: ChatQueueItem[];
  connected: boolean;
  canSend: boolean;
  disabledReason: string | null;
  error: string | null;
  sessions: SessionsListResult | null;
  // Focus mode
  focusMode: boolean;
  // Sidebar state
  sidebarOpen?: boolean;
  sidebarContent?: string | null;
  sidebarError?: string | null;
  splitRatio?: number;
  assistantName: string;
  assistantLabelTooltip?: string | null;
  assistantAvatar: string | null;
  assistantAccent?: string | null;
  agentDirectory?: WorkspaceAgentRow[];
  // Image attachments
  attachments?: ChatAttachment[];
  onAttachmentsChange?: (attachments: ChatAttachment[]) => void;
  // Scroll control
  showNewMessages?: boolean;
  onScrollToBottom?: () => void;
  // Event handlers
  onRefresh: () => void;
  onToggleFocusMode: () => void;
  onDraftChange: (next: string, selectionStart?: number, selectionEnd?: number) => void;
  mentionSuggestions?: MentionSuggestion[];
  mentionSelectedIndex?: number;
  mentionRangeStart?: number | null;
  mentionRangeEnd?: number | null;
  onMentionHighlight?: (nextIndex: number) => void;
  onMentionDismiss?: () => void;
  liveToolEventsEnabled: boolean;
  onToggleLiveToolEvents: () => void;
  shouldEmitToolResult: boolean;
  onToggleShouldEmitToolResult: () => void;
  shouldEmitToolOutput: boolean;
  onToggleShouldEmitToolOutput: () => void;
  onSend: () => void;
  onAbort?: () => void;
  onQueueRemove: (id: string) => void;
  onQueueEdit: (id: string) => void;
  newSessionBusy?: boolean;
  onNewSession: () => void;
  onOpenSidebar?: (content: string) => void;
  onCloseSidebar?: () => void;
  onSplitRatioChange?: (ratio: number) => void;
  onChatScroll?: (event: Event) => void;
};

const COMPACTION_TOAST_DURATION_MS = 5000;
const FALLBACK_TOAST_DURATION_MS = 8000;

function adjustTextareaHeight(el: HTMLTextAreaElement) {
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

function renderCompactionIndicator(status: CompactionIndicatorStatus | null | undefined) {
  if (!status) {
    return nothing;
  }

  // Show "compacting..." while active
  if (status.active) {
    return html`
      <div class="compaction-indicator compaction-indicator--active" role="status" aria-live="polite">
        ${icons.loader} Compacting context...
      </div>
    `;
  }

  // Show "compaction complete" briefly after completion
  if (status.completedAt) {
    const elapsed = Date.now() - status.completedAt;
    if (elapsed < COMPACTION_TOAST_DURATION_MS) {
      return html`
        <div class="compaction-indicator compaction-indicator--complete" role="status" aria-live="polite">
          ${icons.check} Context compacted
        </div>
      `;
    }
  }

  return nothing;
}

function renderFallbackIndicator(status: FallbackIndicatorStatus | null | undefined) {
  if (!status) {
    return nothing;
  }
  const phase = status.phase ?? "active";
  const elapsed = Date.now() - status.occurredAt;
  if (elapsed >= FALLBACK_TOAST_DURATION_MS) {
    return nothing;
  }
  const details = [
    `Selected: ${status.selected}`,
    phase === "cleared" ? `Active: ${status.selected}` : `Active: ${status.active}`,
    phase === "cleared" && status.previous ? `Previous fallback: ${status.previous}` : null,
    status.reason ? `Reason: ${status.reason}` : null,
    status.attempts.length > 0 ? `Attempts: ${status.attempts.slice(0, 3).join(" | ")}` : null,
  ]
    .filter(Boolean)
    .join(" • ");
  const message =
    phase === "cleared"
      ? `Fallback cleared: ${status.selected}`
      : `Fallback active: ${status.active}`;
  const className =
    phase === "cleared"
      ? "compaction-indicator compaction-indicator--fallback-cleared"
      : "compaction-indicator compaction-indicator--fallback";
  const icon = phase === "cleared" ? icons.check : icons.brain;
  return html`
    <div
      class=${className}
      role="status"
      aria-live="polite"
      title=${details}
    >
      ${icon} ${message}
    </div>
  `;
}

function generateAttachmentId(): string {
  return `att-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function handlePaste(e: ClipboardEvent, props: ChatProps) {
  const items = e.clipboardData?.items;
  if (!items || !props.onAttachmentsChange) {
    return;
  }

  const imageItems: DataTransferItem[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.type.startsWith("image/")) {
      imageItems.push(item);
    }
  }

  if (imageItems.length === 0) {
    return;
  }

  e.preventDefault();

  for (const item of imageItems) {
    const file = item.getAsFile();
    if (!file) {
      continue;
    }

    const reader = new FileReader();
    reader.addEventListener("load", () => {
      const dataUrl = reader.result as string;
      const newAttachment: ChatAttachment = {
        id: generateAttachmentId(),
        dataUrl,
        mimeType: file.type,
      };
      const current = props.attachments ?? [];
      props.onAttachmentsChange?.([...current, newAttachment]);
    });
    reader.readAsDataURL(file);
  }
}

function appendFilesAsAttachments(files: FileList | File[], props: ChatProps) {
  if (!props.onAttachmentsChange) {
    return;
  }
  const current = props.attachments ?? [];
  Array.from(files).forEach((file) => {
    if (!file.type.startsWith("image/")) {
      return;
    }
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      const dataUrl = reader.result as string;
      props.onAttachmentsChange?.([
        ...(props.attachments ?? current),
        {
          id: generateAttachmentId(),
          dataUrl,
          mimeType: file.type,
        },
      ]);
    });
    reader.readAsDataURL(file);
  });
}

function renderAttachmentPreview(props: ChatProps) {
  const attachments = props.attachments ?? [];
  if (attachments.length === 0) {
    return nothing;
  }

  return html`
    <div class="chat-attachments">
      ${attachments.map(
        (att) => html`
          <div class="chat-attachment">
            <img
              src=${att.dataUrl}
              alt="Attachment preview"
              class="chat-attachment__img"
            />
            <button
              class="chat-attachment__remove"
              type="button"
              aria-label="Remove attachment"
              @click=${() => {
                const next = (props.attachments ?? []).filter((a) => a.id !== att.id);
                props.onAttachmentsChange?.(next);
              }}
            >
              ${icons.x}
            </button>
          </div>
        `,
      )}
    </div>
  `;
}

export function renderChat(props: ChatProps) {
  let attachmentInput: HTMLInputElement | null = null;
  let composerInput: HTMLTextAreaElement | null = null;
  const canCompose = props.connected;
  const isBusy = props.sending || props.stream !== null;
  const canAbort = Boolean(props.canAbort && props.onAbort);
  const showNewSessionButton = !props.hideNewSessionButton;
  const activeSession = props.sessions?.sessions?.find((row) => row.key === props.sessionKey);
  const reasoningLevel = activeSession?.reasoningLevel ?? "off";
  const showReasoning = props.showThinking && reasoningLevel !== "off";
  const assistantIdentity = {
    name: props.assistantName,
    avatar: props.assistantAvatar ?? props.assistantAvatarUrl ?? null,
  };

  const hasAttachments = (props.attachments?.length ?? 0) > 0;
  const canQueueDraft = props.draft.trim().length > 0 || hasAttachments;
  const mentionSuggestions = props.mentionSuggestions ?? [];
  const mentionMenuOpen =
    mentionSuggestions.length > 0 &&
    typeof props.mentionRangeStart === "number" &&
    typeof props.mentionRangeEnd === "number";
  const composePlaceholder = props.connected
    ? hasAttachments
      ? "Add a message or paste more images..."
      : "Message (↩ to send, Shift+↩ for line breaks, paste images)"
    : "Connect to the gateway to start chatting…";

  const splitRatio = props.splitRatio ?? 0.6;
  const sidebarOpen = Boolean(props.sidebarOpen && props.onCloseSidebar);

  const commitMentionSelection = (index: number) => {
    if (
      !mentionMenuOpen ||
      index < 0 ||
      index >= mentionSuggestions.length ||
      typeof props.mentionRangeStart !== "number" ||
      typeof props.mentionRangeEnd !== "number"
    ) {
      return;
    }
    const next = applyDraftMentionSuggestion(
      props.draft,
      {
        start: props.mentionRangeStart,
        end: props.mentionRangeEnd,
      },
      mentionSuggestions[index].mention,
    );
    props.onDraftChange(next.text, next.caret, next.caret);
    props.onMentionDismiss?.();
    requestAnimationFrame(() => {
      if (!composerInput) {
        return;
      }
      composerInput.focus();
      composerInput.setSelectionRange(next.caret, next.caret);
      adjustTextareaHeight(composerInput);
    });
  };
  const thread = html`
    <div
      class="chat-thread"
      role="log"
      aria-live="polite"
      @scroll=${props.onChatScroll}
    >
      ${
        props.loading
          ? html`
              <div class="muted">Loading chat…</div>
            `
          : nothing
      }
      ${repeat(
        buildChatItems(props),
        (item) => item.key,
        (item) => {
          if (item.kind === "divider") {
            return html`
              <div class="chat-divider" role="separator" data-ts=${String(item.timestamp)}>
                <span class="chat-divider__line"></span>
                <span class="chat-divider__label">${item.label}</span>
                <span class="chat-divider__line"></span>
              </div>
            `;
          }

          if (item.kind === "reading-indicator") {
            return renderReadingIndicatorGroup(assistantIdentity);
          }

          if (item.kind === "stream") {
            return renderStreamingGroup(
              item.text,
              item.startedAt,
              props.onOpenSidebar,
              assistantIdentity,
              props.assistantLabelTooltip ?? null,
              props.assistantAccent,
              props.agentDirectory,
            );
          }

          if (item.kind === "group") {
            return renderMessageGroup(item, {
              onOpenSidebar: props.onOpenSidebar,
              showReasoning,
              showToolOutput: props.shouldEmitToolOutput,
              assistantName: props.assistantName,
              assistantLabelTooltip: props.assistantLabelTooltip ?? null,
              assistantAvatar: assistantIdentity.avatar,
              assistantAccent: props.assistantAccent,
              agentDirectory: props.agentDirectory,
            });
          }

          return nothing;
        },
      )}
    </div>
  `;

  return html`
    <section class="card chat">
      ${props.disabledReason ? html`<div class="callout">${props.disabledReason}</div>` : nothing}

      ${props.error ? html`<div class="callout danger">${props.error}</div>` : nothing}

      ${
        props.focusMode
          ? html`
            <button
              class="chat-focus-exit"
              type="button"
              @click=${props.onToggleFocusMode}
              aria-label="Exit focus mode"
              title="Exit focus mode"
            >
              ${icons.x}
            </button>
          `
          : nothing
      }

      <div
        class="chat-split-container ${sidebarOpen ? "chat-split-container--open" : ""}"
      >
        <div
          class="chat-main"
          style="flex: ${sidebarOpen ? `0 0 ${splitRatio * 100}%` : "1 1 100%"}"
        >
          ${thread}
        </div>

        ${
          sidebarOpen
            ? html`
              <resizable-divider
                .splitRatio=${splitRatio}
                @resize=${(e: CustomEvent) => props.onSplitRatioChange?.(e.detail.splitRatio)}
              ></resizable-divider>
              <div class="chat-sidebar">
                ${renderMarkdownSidebar({
                  content: props.sidebarContent ?? null,
                  error: props.sidebarError ?? null,
                  onClose: props.onCloseSidebar!,
                  onViewRawText: () => {
                    if (!props.sidebarContent || !props.onOpenSidebar) {
                      return;
                    }
                    props.onOpenSidebar(`\`\`\`\n${props.sidebarContent}\n\`\`\``);
                  },
                })}
              </div>
            `
            : nothing
        }
      </div>

      ${renderFallbackIndicator(props.fallbackStatus)}
      ${renderCompactionIndicator(props.compactionStatus)}

      ${
        props.showNewMessages
          ? html`
            <button
              class="btn chat-new-messages"
              type="button"
              @click=${props.onScrollToBottom}
            >
              New messages ${icons.arrowDown}
            </button>
          `
          : nothing
      }

      <div class="chat-compose">
        ${
          props.queue.length
            ? html`
              <div class="chat-queue" role="status" aria-live="polite">
                <div class="chat-queue__title">Queued (${props.queue.length})</div>
                <div class="chat-queue__list">
                  ${props.queue.map(
                    (item) => html`
                      <div class="chat-queue__item">
                        <div class="chat-queue__text">
                          ${
                            item.text ||
                            (item.attachments?.length ? `Image (${item.attachments.length})` : "")
                          }
                        </div>
                        <div class="chat-queue__actions">
                          <button
                            class="btn chat-queue__edit"
                            type="button"
                            aria-label="Edit queued message"
                            title="Edit queued message"
                            @click=${() => props.onQueueEdit(item.id)}
                          >
                            ${icons.edit}
                          </button>
                          <button
                            class="btn chat-queue__remove"
                            type="button"
                            aria-label="Remove queued message"
                            title="Remove queued message"
                            @click=${() => props.onQueueRemove(item.id)}
                          >
                            ${icons.x}
                          </button>
                        </div>
                      </div>
                    `,
                  )}
                </div>
              </div>
            `
            : nothing
        }
        ${renderAttachmentPreview(props)}
        <div class="chat-compose__row">
          <input
            ${ref((el) => {
              attachmentInput = el as HTMLInputElement | null;
            })}
            class="chat-compose__file-input"
            type="file"
            accept="image/*"
            multiple
            @change=${(e: Event) => {
              const input = e.target as HTMLInputElement;
              if (input.files?.length) {
                appendFilesAsAttachments(input.files, props);
              }
              input.value = "";
            }}
          />
          <button
            class="chat-compose__icon-btn"
            type="button"
            aria-label="Attach images"
            title="Attach images"
            ?disabled=${!props.connected}
            @click=${() => attachmentInput?.click()}
          >
            ${icons.paperclip}
          </button>
          <label class="field chat-compose__field">
            <span>Message</span>
            ${
              mentionMenuOpen
                ? html`
                  <div class="chat-mention-menu" role="listbox" aria-label="Agent mentions">
                    ${mentionSuggestions.map((suggestion, index) => {
                      const selected = index === (props.mentionSelectedIndex ?? 0);
                      const accent = suggestion.color?.trim();
                      const style = accent ? `--chat-mention-accent: ${accent};` : nothing;
                      return html`
                        <button
                          class="chat-mention-menu__item ${selected ? "is-selected" : ""}"
                          type="button"
                          role="option"
                          aria-selected=${selected ? "true" : "false"}
                          style=${style}
                          @mousedown=${(event: MouseEvent) => {
                            event.preventDefault();
                            commitMentionSelection(index);
                          }}
                        >
                          <span class="chat-mention-menu__avatar">
                            ${suggestion.emoji?.trim() || suggestion.name.charAt(0).toUpperCase()}
                          </span>
                          <span class="chat-mention-menu__meta">
                            <span class="chat-mention-menu__name">${suggestion.name}</span>
                            <span class="chat-mention-menu__mention">${suggestion.mention}</span>
                          </span>
                          ${
                            suggestion.title
                              ? html`<span class="chat-mention-menu__title">${suggestion.title}</span>`
                              : nothing
                          }
                        </button>
                      `;
                    })}
                  </div>
                `
                : nothing
            }
            <textarea
              ${ref((el) => {
                composerInput = (el as HTMLTextAreaElement | null) ?? null;
                if (composerInput) {
                  adjustTextareaHeight(composerInput);
                }
              })}
              .value=${props.draft}
              dir=${detectTextDirection(props.draft)}
              ?disabled=${!props.connected}
              @keydown=${(e: KeyboardEvent) => {
                if (mentionMenuOpen) {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    props.onMentionHighlight?.(
                      ((props.mentionSelectedIndex ?? 0) + 1) % mentionSuggestions.length,
                    );
                    return;
                  }
                  if (e.key === "ArrowUp") {
                    e.preventDefault();
                    props.onMentionHighlight?.(
                      ((props.mentionSelectedIndex ?? 0) - 1 + mentionSuggestions.length) %
                        mentionSuggestions.length,
                    );
                    return;
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    props.onMentionDismiss?.();
                    return;
                  }
                  if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
                    e.preventDefault();
                    commitMentionSelection(props.mentionSelectedIndex ?? 0);
                    return;
                  }
                }
                if (e.key !== "Enter") {
                  return;
                }
                if (e.isComposing || e.keyCode === 229) {
                  return;
                }
                if (e.shiftKey) {
                  return;
                } // Allow Shift+Enter for line breaks
                if (!props.connected) {
                  return;
                }
                e.preventDefault();
                if (canCompose) {
                  props.onSend();
                }
              }}
              @input=${(e: Event) => {
                const target = e.target as HTMLTextAreaElement;
                adjustTextareaHeight(target);
                props.onDraftChange(target.value, target.selectionStart, target.selectionEnd);
              }}
              @click=${(e: Event) => {
                const target = e.target as HTMLTextAreaElement;
                props.onDraftChange(target.value, target.selectionStart, target.selectionEnd);
              }}
              @keyup=${(e: Event) => {
                const target = e.target as HTMLTextAreaElement;
                props.onDraftChange(target.value, target.selectionStart, target.selectionEnd);
              }}
              @select=${(e: Event) => {
                const target = e.target as HTMLTextAreaElement;
                props.onDraftChange(target.value, target.selectionStart, target.selectionEnd);
              }}
              @blur=${() => props.onMentionDismiss?.()}
              @paste=${(e: ClipboardEvent) => handlePaste(e, props)}
              placeholder=${composePlaceholder}
            ></textarea>
          </label>
          <div class="chat-compose__actions">
            ${
              canAbort && canQueueDraft
                ? html`
                    <button
                      class="chat-compose__queue-btn"
                      type="button"
                      aria-label="Queue message"
                      title="Queue message"
                      @click=${props.onSend}
                    >
                      Queue
                    </button>
                  `
                : nothing
            }
            ${
              !canAbort && showNewSessionButton
                ? html`
                    <button
                      class="chat-compose__icon-btn"
                      type="button"
                      aria-label=${props.newSessionBusy ? "Clearing conversation" : "New session"}
                      title=${props.newSessionBusy ? "Clearing conversation…" : "New session"}
                      ?disabled=${!props.connected || props.sending || Boolean(props.newSessionBusy)}
                      @click=${props.onNewSession}
                    >
                      ${icons.penLine}
                    </button>
                  `
                : nothing
            }
            <button
              class="chat-compose__send-btn ${canAbort ? "is-stop" : ""}"
              aria-label=${canAbort ? "Stop" : isBusy ? "Queue message" : "Send message"}
              title=${canAbort ? "Stop" : isBusy ? "Queue message" : "Send message"}
              ?disabled=${!props.connected}
              @click=${canAbort ? props.onAbort : props.onSend}
            >
              <span class="chat-compose__send-icon">${canAbort ? icons.stop : icons.arrowUp}</span>
            </button>
          </div>
        </div>
      </div>
    </section>
  `;
}

const CHAT_HISTORY_RENDER_LIMIT = 200;
const TOOL_BLOCK_TYPES = new Set(["toolcall", "tooluse", "toolresult"]);

function humanizeAgentId(agentId: string): string {
  return agentId
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function normalizeAgentAccent(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(trimmed) ? trimmed : undefined;
}

function resolvePeerSpeakerMeta(
  normalized: ReturnType<typeof normalizeMessage>,
  agentDirectory?: WorkspaceAgentRow[],
): {
  speakerLabel?: string;
  speakerAvatar?: string;
  speakerAccent?: string;
} {
  const speakerKey = normalized.speakerKey?.trim() ?? "";
  if (!speakerKey.startsWith("peer:")) {
    return {
      speakerLabel: normalized.speakerLabel,
      speakerAvatar: normalized.speakerAvatar,
      speakerAccent: normalized.speakerAccent,
    };
  }
  const agentId = speakerKey.slice("peer:".length).trim();
  if (!agentId) {
    return {
      speakerLabel: normalized.speakerLabel,
      speakerAvatar: normalized.speakerAvatar,
      speakerAccent: normalized.speakerAccent,
    };
  }
  const agent = agentDirectory?.find((entry) => entry.id === agentId);
  return {
    speakerLabel: agent?.name?.trim() || normalized.speakerLabel || humanizeAgentId(agentId),
    speakerAvatar: agent?.emoji?.trim() || normalized.speakerAvatar,
    speakerAccent: normalizeAgentAccent(agent?.color) || normalized.speakerAccent,
  };
}

type ToolIdentityEntry = {
  source: "history" | "live";
  messageIndex: number;
  toolCallId: string;
  snakeToolCallId: string;
  runId: string;
  sessionKey: string;
  name: string;
  timestamp: number;
  phase: "start" | "result";
  hasOutput: boolean;
  dedupeKeys: string[];
  primaryKey: string | null;
};

function normalizeToolBlockType(value: unknown): string {
  return typeof value === "string"
    ? value
        .trim()
        .toLowerCase()
        .replace(/[\s_-]+/g, "")
    : "";
}

function hasCanonicalToolInvocationMarker(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  const marker = (message as { __openclaw?: unknown }).__openclaw;
  if (!marker || typeof marker !== "object") {
    return false;
  }
  return (marker as { canonicalToolInvocation?: unknown }).canonicalToolInvocation === true;
}

function stripToolBlocksFromHistoryMessage(message: unknown): unknown {
  if (!message || typeof message !== "object") {
    return message;
  }
  const raw = message as Record<string, unknown>;
  if (!Array.isArray(raw.content)) {
    return message;
  }
  const filteredContent = raw.content.filter((entry) => {
    if (!entry || typeof entry !== "object") {
      return true;
    }
    const block = entry as Record<string, unknown>;
    const normalizedType = normalizeToolBlockType(block.type);
    return !TOOL_BLOCK_TYPES.has(normalizedType);
  });
  if (filteredContent.length === raw.content.length) {
    return message;
  }
  const hasTextField = typeof raw.text === "string" && raw.text.trim().length > 0;
  if (filteredContent.length === 0 && !hasTextField) {
    return null;
  }
  return {
    ...raw,
    content: filteredContent,
  };
}

function normalizeHistoryToolCallIds(messages: unknown[], defaultSessionKey: string): unknown[] {
  const pendingByScopeAndName = new Map<string, string[]>();
  const seqByScopeAndName = new Map<string, number>();

  const scopeKey = (scope: string, name: string) => `${scope}::${name}`;

  const nextSyntheticId = (scope: string, name: string) => {
    const key = scopeKey(scope, name);
    const next = (seqByScopeAndName.get(key) ?? 0) + 1;
    seqByScopeAndName.set(key, next);
    return `history:${scope}:${name}:${next}`;
  };

  const enqueuePending = (scope: string, name: string, id: string) => {
    const key = scopeKey(scope, name);
    const queue = pendingByScopeAndName.get(key) ?? [];
    queue.push(id);
    pendingByScopeAndName.set(key, queue);
  };

  const dequeuePending = (scope: string, name: string): string | null => {
    const key = scopeKey(scope, name);
    const queue = pendingByScopeAndName.get(key);
    if (!queue || queue.length === 0) {
      return null;
    }
    const id = queue.shift() ?? null;
    if (queue.length === 0) {
      pendingByScopeAndName.delete(key);
    } else {
      pendingByScopeAndName.set(key, queue);
    }
    return id;
  };

  const peekPending = (scope: string, name: string): string | null => {
    const key = scopeKey(scope, name);
    const queue = pendingByScopeAndName.get(key);
    if (!queue || queue.length === 0) {
      return null;
    }
    return queue[queue.length - 1] ?? null;
  };

  const dropPendingId = (scope: string, name: string, id: string) => {
    const key = scopeKey(scope, name);
    const queue = pendingByScopeAndName.get(key);
    if (!queue || queue.length === 0) {
      return;
    }
    const filtered = queue.filter((entry) => entry !== id);
    if (filtered.length === 0) {
      pendingByScopeAndName.delete(key);
      return;
    }
    pendingByScopeAndName.set(key, filtered);
  };

  return messages.map((message) => {
    if (!message || typeof message !== "object") {
      return message;
    }
    const raw = message as Record<string, unknown>;
    const cards = extractToolCards(message);
    if (cards.length === 0) {
      return message;
    }
    const runId = resolveToolRunId(raw);
    const sessionKey = resolveToolSessionKey(raw) || defaultSessionKey;
    const scope = runId || sessionKey || "__session__";
    const firstCard = cards[0];
    const name = firstCard?.name?.trim().toLowerCase() ?? "";
    if (!name) {
      return message;
    }
    const hasOutput = cards.some(
      (card) => typeof card.text === "string" && card.text.trim().length > 0,
    );
    const existingId = resolveToolCallId(raw);
    if (existingId) {
      if (!hasOutput) {
        enqueuePending(scope, name, existingId);
      } else {
        dropPendingId(scope, name, existingId);
      }
      return message;
    }
    const syntheticId = hasOutput
      ? (dequeuePending(scope, name) ?? nextSyntheticId(scope, name))
      : (peekPending(scope, name) ?? nextSyntheticId(scope, name));
    if (!hasOutput) {
      enqueuePending(scope, name, syntheticId);
    }
    return {
      ...raw,
      toolCallId: syntheticId,
      tool_call_id: syntheticId,
    };
  });
}

function buildToolIdentityEntries(
  message: unknown,
  source: "history" | "live",
  messageIndex: number,
): ToolIdentityEntry[] {
  const raw = message as Record<string, unknown>;
  const toolCallId = resolveToolCallId(raw);
  const snakeToolCallId = typeof raw.tool_call_id === "string" ? raw.tool_call_id.trim() : "";
  const runId = resolveToolRunId(raw);
  const sessionKey = resolveToolSessionKey(raw);
  const timestamp = normalizeMessage(message).timestamp;
  const cards = extractToolCards(message);
  if (cards.length === 0) {
    return [];
  }
  return cards.map((card) => {
    const hasOutput = typeof card.text === "string" && card.text.trim().length > 0;
    const phase: "start" | "result" = card.kind === "result" ? "result" : "start";
    const dedupeKeys = buildToolDedupeKeys({
      toolCallId,
      runId,
      sessionKey,
      name: card.name,
      timestamp,
    });
    const primaryKey = buildPrimaryToolDedupeKey({
      toolCallId,
      runId,
      sessionKey,
      name: card.name,
      timestamp,
    });
    return {
      source,
      messageIndex,
      toolCallId,
      snakeToolCallId,
      runId,
      sessionKey,
      name: card.name,
      timestamp,
      phase,
      hasOutput,
      dedupeKeys,
      primaryKey,
    };
  });
}

function shareAnyKey(left: string[], right: Set<string>): boolean {
  if (left.length === 0 || right.size === 0) {
    return false;
  }
  return left.some((key) => right.has(key));
}

function groupMessages(
  items: ChatItem[],
  agentDirectory?: WorkspaceAgentRow[],
): Array<ChatItem | MessageGroup> {
  const result: Array<ChatItem | MessageGroup> = [];
  let currentGroup: MessageGroup | null = null;

  for (const item of items) {
    if (item.kind !== "message") {
      if (currentGroup) {
        result.push(currentGroup);
        currentGroup = null;
      }
      result.push(item);
      continue;
    }

    const normalized = normalizeMessage(item.message);
    const role = normalizeRoleForGrouping(normalized.role);
    const speakerKey = normalized.speakerKey ?? role;
    const peerMeta = resolvePeerSpeakerMeta(normalized, agentDirectory);
    const timestamp = normalized.timestamp || Date.now();

    if (!currentGroup || currentGroup.role !== role || currentGroup.speakerKey !== speakerKey) {
      if (currentGroup) {
        result.push(currentGroup);
      }
      currentGroup = {
        kind: "group",
        key: `group:${role}:${item.key}`,
        role,
        speakerKey,
        speakerLabel: peerMeta.speakerLabel ?? normalized.speakerLabel,
        speakerInitial: normalized.speakerInitial,
        speakerAvatar: peerMeta.speakerAvatar ?? normalized.speakerAvatar,
        speakerAccent: peerMeta.speakerAccent ?? normalized.speakerAccent,
        messages: [{ message: item.message, key: item.key }],
        timestamp,
        isStreaming: false,
      };
    } else {
      currentGroup.messages.push({ message: item.message, key: item.key });
    }
  }

  if (currentGroup) {
    result.push(currentGroup);
  }
  return result;
}

function buildChatItems(props: ChatProps): Array<ChatItem | MessageGroup> {
  const items: ChatItem[] = [];
  const historyRaw = Array.isArray(props.messages) ? props.messages : [];
  const tools = Array.isArray(props.toolMessages) ? props.toolMessages : [];
  const seenMessageKeys = new Set<string>();
  const hasCanonicalToolInvocations = tools.some(hasCanonicalToolInvocationMarker);
  const history = hasCanonicalToolInvocations
    ? historyRaw
    : normalizeHistoryToolCallIds(historyRaw, props.sessionKey);
  const historyToolKeys = new Set<string>();
  const historyToolIdentities: ToolIdentityEntry[] = [];
  const liveToolIdentities: ToolIdentityEntry[] = [];
  const historyToolKeysWithOutput = new Set<string>();
  const historyStart = Math.max(0, history.length - CHAT_HISTORY_RENDER_LIMIT);

  for (let i = historyStart; i < history.length; i++) {
    const msg = history[i];
    const entries = buildToolIdentityEntries(msg, "history", i);
    for (const entry of entries) {
      const key = entry.primaryKey;
      if (!key) {
        continue;
      }
      if (entry.hasOutput) {
        historyToolKeysWithOutput.add(key);
      }
    }
  }

  if (historyStart > 0) {
    items.push({
      kind: "message",
      key: "chat:history:notice",
      message: {
        role: "system",
        content: `Showing last ${CHAT_HISTORY_RENDER_LIMIT} messages (${historyStart} hidden).`,
        timestamp: Date.now(),
      },
    });
  }
  for (let i = historyStart; i < history.length; i++) {
    const original = history[i];
    const msg = hasCanonicalToolInvocations
      ? stripToolBlocksFromHistoryMessage(original)
      : original;
    if (msg === null) {
      continue;
    }
    const normalized = normalizeMessage(msg);
    const raw = msg as Record<string, unknown>;
    const marker = raw.__openclaw as Record<string, unknown> | undefined;
    if (marker && marker.kind === "compaction") {
      items.push({
        kind: "divider",
        key:
          typeof marker.id === "string"
            ? `divider:compaction:${marker.id}`
            : `divider:compaction:${normalized.timestamp}:${i}`,
        label: "Compaction",
        timestamp: normalized.timestamp ?? Date.now(),
      });
      continue;
    }

    if (!props.shouldEmitToolResult && normalizeRoleForGrouping(normalized.role) === "tool") {
      continue;
    }

    const toolEntries = buildToolIdentityEntries(msg, "history", i);
    for (const entry of toolEntries) {
      historyToolIdentities.push(entry);
      for (const key of entry.dedupeKeys) {
        historyToolKeys.add(key);
      }
    }
    const hasPendingOnlyToolRows = toolEntries.some(
      (entry) => !entry.hasOutput && Boolean(entry.primaryKey),
    );
    const shouldDropPendingOnlyHistoryRow =
      hasPendingOnlyToolRows &&
      toolEntries.every(
        (entry) =>
          !entry.hasOutput &&
          Boolean(entry.primaryKey) &&
          historyToolKeysWithOutput.has(entry.primaryKey!),
      );
    if (shouldDropPendingOnlyHistoryRow) {
      continue;
    }

    const key = messageKey(msg, i);
    if (seenMessageKeys.has(key)) {
      continue;
    }
    seenMessageKeys.add(key);
    items.push({
      kind: "message",
      key,
      message: msg,
    });
  }
  if (props.showThinking && props.shouldEmitToolResult) {
    const toolItemsByKey = new Map<
      string,
      { item: ChatItem; hasOutput: boolean; timestamp: number; order: number }
    >();
    for (let i = 0; i < tools.length; i++) {
      const tool = tools[i] as Record<string, unknown>;
      const liveEntries = buildToolIdentityEntries(tool, "live", i);
      if (liveEntries.length === 0) {
        continue;
      }
      liveToolIdentities.push(...liveEntries);
      const dedupeAgainstHistory = liveEntries.some((entry) =>
        shareAnyKey(entry.dedupeKeys, historyToolKeys),
      );
      if (dedupeAgainstHistory) {
        continue;
      }
      const withOutput = liveEntries.some((entry) => entry.hasOutput);
      const timestamp = normalizeMessage(tool).timestamp;
      const fallbackKey = `tool:fallback:${i}`;
      const primaryKey = liveEntries.find((entry) => entry.primaryKey)?.primaryKey ?? fallbackKey;
      const candidate: ChatItem = {
        kind: "message",
        key: messageKey(tools[i], i + history.length),
        message: tools[i],
      };
      const current = toolItemsByKey.get(primaryKey);
      if (!current) {
        toolItemsByKey.set(primaryKey, {
          item: candidate,
          hasOutput: withOutput,
          timestamp,
          order: i,
        });
        continue;
      }
      const shouldReplace =
        (withOutput && !current.hasOutput) ||
        (withOutput === current.hasOutput && timestamp > current.timestamp) ||
        (withOutput === current.hasOutput && timestamp === current.timestamp && i > current.order);
      if (shouldReplace) {
        toolItemsByKey.set(primaryKey, {
          item: candidate,
          hasOutput: withOutput,
          timestamp,
          order: i,
        });
      }
    }
    const toolItems = Array.from(toolItemsByKey.values())
      .toSorted((a, b) => a.timestamp - b.timestamp || a.order - b.order)
      .map((entry) => entry.item);
    const sortable = [...items, ...toolItems].map((item, order) => ({
      item,
      order,
      ts:
        item.kind === "divider"
          ? item.timestamp
          : item.kind === "message"
            ? normalizeMessage(item.message).timestamp
            : item.kind === "stream"
              ? item.startedAt
              : 0,
    }));
    sortable.sort((a, b) => {
      if (a.ts !== b.ts) {
        return a.ts - b.ts;
      }
      return a.order - b.order;
    });
    items.length = 0;
    for (const entry of sortable) {
      items.push(entry.item);
    }
  }

  if (props.stream !== null) {
    const key = `stream:${props.sessionKey}:${props.streamStartedAt ?? "live"}`;
    if (props.stream.trim().length > 0) {
      items.push({
        kind: "stream",
        key,
        text: props.stream,
        startedAt: props.streamStartedAt ?? Date.now(),
      });
    } else {
      items.push({ kind: "reading-indicator", key });
    }
  }

  return groupMessages(items, props.agentDirectory);
}

function messageKey(message: unknown, index: number): string {
  const m = message as Record<string, unknown>;
  const normalized = normalizeMessage(message);
  const cards = extractToolCards(message);
  if (cards.length > 0) {
    const primaryToolKey = buildPrimaryToolDedupeKey({
      toolCallId: resolveToolCallId(m),
      runId: resolveToolRunId(m),
      sessionKey: resolveToolSessionKey(m),
      name: cards[0]?.name,
      timestamp: normalized.timestamp,
    });
    if (primaryToolKey) {
      return primaryToolKey;
    }
  }
  const id = typeof m.id === "string" ? m.id : "";
  if (id) {
    return `msg:${id}`;
  }
  const messageId = typeof m.messageId === "string" ? m.messageId : "";
  if (messageId) {
    return `msg:${messageId}`;
  }
  const idempotencyKey = typeof m.idempotencyKey === "string" ? m.idempotencyKey.trim() : "";
  if (idempotencyKey) {
    return `msg:idem:${idempotencyKey}`;
  }
  const timestamp = typeof m.timestamp === "number" ? m.timestamp : null;
  const role = typeof m.role === "string" ? m.role : "unknown";
  if (timestamp != null) {
    return `msg:${role}:${timestamp}:${index}`;
  }
  return `msg:${role}:${index}`;
}
