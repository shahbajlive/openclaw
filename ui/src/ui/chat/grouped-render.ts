import { html, nothing } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import type { AssistantIdentity } from "../assistant-identity.ts";
import { toSanitizedMarkdownHtml } from "../markdown.ts";
import { openExternalUrlSafe } from "../open-external-url.ts";
import { detectTextDirection } from "../text-direction.ts";
import type { WorkspaceAgentRow } from "../types.ts";
import type { MessageGroup, MessageGroupChild } from "../types/chat-types.ts";
import { renderCopyAsMarkdownButton } from "./copy-as-markdown.ts";
import {
  extractTextCached,
  extractThinkingCached,
  formatReasoningMarkdown,
} from "./message-extract.ts";
import { isToolResultMessage, normalizeRoleForGrouping } from "./message-normalizer.ts";
import { extractToolCards, renderToolCardSidebar } from "./tool-cards.ts";

type ImageBlock = {
  url: string;
  alt?: string;
};

const AGENT_MENTION_TOKEN_RE = /(^|[^a-z0-9_])(@[a-z0-9_]+)(?=$|[^a-z0-9_])/gi;

function extractImages(message: unknown): ImageBlock[] {
  const m = message as Record<string, unknown>;
  const content = m.content;
  const images: ImageBlock[] = [];

  if (Array.isArray(content)) {
    for (const block of content) {
      if (typeof block !== "object" || block === null) {
        continue;
      }
      const b = block as Record<string, unknown>;

      if (b.type === "image") {
        // Handle source object format (from sendChatMessage)
        const source = b.source as Record<string, unknown> | undefined;
        if (source?.type === "base64" && typeof source.data === "string") {
          const data = source.data;
          const mediaType = (source.media_type as string) || "image/png";
          // If data is already a data URL, use it directly
          const url = data.startsWith("data:") ? data : `data:${mediaType};base64,${data}`;
          images.push({ url });
        } else if (typeof b.url === "string") {
          images.push({ url: b.url });
        }
      } else if (b.type === "image_url") {
        // OpenAI format
        const imageUrl = b.image_url as Record<string, unknown> | undefined;
        if (typeof imageUrl?.url === "string") {
          images.push({ url: imageUrl.url });
        }
      }
    }
  }

  return images;
}

function formatRelativeTimestamp(timestamp: number): string {
  const diffMs = Date.now() - timestamp;
  if (!Number.isFinite(diffMs)) {
    return "";
  }
  const absMs = Math.abs(diffMs);
  if (absMs < 60_000) {
    return "just now";
  }
  const minutes = Math.floor(absMs / 60_000);
  if (minutes < 60) {
    return diffMs >= 0 ? `${minutes}m ago` : `in ${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return diffMs >= 0 ? `${hours}h ago` : `in ${hours}h`;
  }
  const days = Math.floor(hours / 24);
  if (days === 1 && diffMs >= 0) {
    return "yesterday";
  }
  if (days < 7) {
    return diffMs >= 0 ? `${days}d ago` : `in ${days}d`;
  }
  return new Date(timestamp).toLocaleDateString();
}

function formatAbsoluteTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleString([], {
    hour: "numeric",
    minute: "2-digit",
    month: "short",
    day: "numeric",
  });
}

export function renderReadingIndicatorGroup(
  assistant?: AssistantIdentity,
  opts?: { compact?: boolean },
) {
  return html`
    <div class="chat-group assistant ${opts?.compact ? "chat-group--continuation" : ""}">
      ${opts?.compact ? nothing : renderAvatar("assistant", assistant)}
      <div class="chat-group-messages">
        <div class="chat-bubble chat-reading-indicator" aria-hidden="true">
          <span class="chat-reading-indicator__dots">
            <span></span><span></span><span></span>
          </span>
        </div>
      </div>
    </div>
  `;
}

export function renderProcessingIndicatorGroup(
  assistant?: AssistantIdentity,
  phase?: "processing" | "thinking" | "typing" | "tool_running" | "finalizing" | null,
  opts?: { compact?: boolean },
) {
  const startedAt = Date.now();
  const absoluteTimestamp = formatAbsoluteTimestamp(startedAt);
  return html`
    <div class="chat-group assistant ${opts?.compact ? "chat-group--continuation" : ""}">
      ${opts?.compact ? nothing : renderAvatar("assistant", assistant)}
      <div class="chat-group-messages">
        <div class="chat-bubble chat-reading-indicator" aria-hidden="true">
          <span class="chat-reading-indicator__dots">
            <span></span><span></span><span></span>
          </span>
        </div>
        ${
          phase === "thinking"
            ? html`
                <div class="chat-group-footer">
                  <span class="chat-sender-name">${assistant?.name ?? "Assistant"}</span>
                  <span class="chat-group-status" title=${absoluteTimestamp}>Thinking...</span>
                </div>
              `
            : nothing
        }
      </div>
    </div>
  `;
}

export function renderStreamingGroup(
  text: string,
  startedAt: number,
  onOpenSidebar?: (content: string) => void,
  assistant?: AssistantIdentity,
  assistantLabelTooltip?: string | null,
  runPhase?: "processing" | "thinking" | "typing" | "tool_running" | "finalizing" | null,
  typingActive?: boolean,
  assistantAccent?: string | null,
  agentDirectory?: WorkspaceAgentRow[],
  opts?: { compact?: boolean },
) {
  const name = assistant?.name ?? "Assistant";
  const absoluteTimestamp = formatAbsoluteTimestamp(startedAt);

  return html`
    <div class="chat-group assistant ${opts?.compact ? "chat-group--continuation" : ""}">
      ${
        opts?.compact
          ? nothing
          : renderAvatar("assistant", {
              name,
              avatar: assistant?.avatar ?? null,
              accent: assistantAccent ?? null,
            })
      }
      <div class="chat-group-messages">
        ${renderGroupedMessage(
          {
            role: "assistant",
            content: [{ type: "text", text }],
            timestamp: startedAt,
          },
          { isStreaming: true, showReasoning: false, showToolOutput: true },
          onOpenSidebar,
          agentDirectory,
        )}
        <div class="chat-group-footer">
          <span class="chat-sender-name" title=${assistantLabelTooltip || nothing}>${name}</span>
          ${
            runPhase === "thinking"
              ? html`<span class="chat-group-status" title=${absoluteTimestamp}>Thinking...</span>`
              : typingActive
                ? html`<span class="chat-group-status" title=${absoluteTimestamp}>Typing...</span>`
                : nothing
          }
        </div>
      </div>
    </div>
  `;
}

export function renderMessageGroup(
  group: MessageGroup,
  opts: {
    onOpenSidebar?: (content: string) => void;
    showReasoning: boolean;
    showToolOutput: boolean;
    assistantName?: string;
    assistantLabelTooltip?: string | null;
    assistantAvatar?: string | null;
    assistantAccent?: string | null;
    agentDirectory?: WorkspaceAgentRow[];
  },
) {
  const normalizedRole = normalizeRoleForGrouping(group.role);
  const identityRole =
    normalizedRole === "tool" || normalizedRole === "peer" ? "assistant" : normalizedRole;
  const assistantName = opts.assistantName ?? "Assistant";
  const who =
    group.speakerLabel ??
    (identityRole === "user"
      ? "You"
      : identityRole === "assistant"
        ? assistantName
        : identityRole === "system"
          ? "System"
          : identityRole);
  const roleClass =
    identityRole === "user" || identityRole === "system"
      ? "user"
      : identityRole === "assistant"
        ? "assistant"
        : "other";
  const timestamp = formatRelativeTimestamp(group.timestamp);
  const absoluteTimestamp = formatAbsoluteTimestamp(group.timestamp);
  const isPeer = normalizedRole === "peer";
  const lastChild = group.children[group.children.length - 1];
  const hasActiveTail =
    lastChild?.kind === "reading-indicator" || lastChild?.kind === "processing-indicator";
  const groupClasses = [
    "chat-group",
    roleClass,
    isPeer ? "is-peer" : "",
    hasActiveTail ? "chat-group--has-active-tail" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const groupStyle = group.speakerAccent ? `--chat-peer-accent: ${group.speakerAccent};` : nothing;
  const senderTitle =
    identityRole === "assistant" && !group.speakerLabel
      ? (opts.assistantLabelTooltip ?? null)
      : null;
  const hideFooterForDots = hasActiveTail;
  return html`
    <div class=${groupClasses} style=${groupStyle}>
      ${renderAvatar(identityRole, {
        name: group.speakerLabel ?? (identityRole === "system" ? "System" : assistantName),
        avatar:
          normalizedRole === "peer"
            ? (group.speakerAvatar ?? null)
            : (opts.assistantAvatar ?? null),
        accent:
          normalizedRole === "peer"
            ? (group.speakerAccent ?? null)
            : (opts.assistantAccent ?? null),
      })}
      <div class="chat-group-messages">
        ${group.children.map((child, index) =>
          renderGroupChild(child, {
            isLast: index === group.children.length - 1,
            showReasoning: opts.showReasoning,
            showToolOutput: opts.showToolOutput,
            onOpenSidebar: opts.onOpenSidebar,
            agentDirectory: opts.agentDirectory,
          }),
        )}
        ${
          hideFooterForDots
            ? nothing
            : html`
              <div class="chat-group-footer">
                <span class="chat-sender-name" title=${senderTitle || nothing}>${who}</span>
                <span class="chat-group-timestamp" title=${absoluteTimestamp}>${timestamp}</span>
              </div>
            `
        }
      </div>
    </div>
  `;
}

function renderGroupChild(
  child: MessageGroupChild,
  opts: {
    isLast: boolean;
    showReasoning: boolean;
    showToolOutput: boolean;
    onOpenSidebar?: (content: string) => void;
    agentDirectory?: WorkspaceAgentRow[];
  },
) {
  if (child.kind === "message") {
    return renderGroupedMessage(
      child.message,
      {
        isStreaming: false,
        showReasoning: opts.showReasoning,
        showToolOutput: opts.showToolOutput,
      },
      opts.onOpenSidebar,
      opts.agentDirectory,
    );
  }
  if (child.kind === "stream") {
    return renderGroupedMessage(
      {
        role: "assistant",
        content: [{ type: "text", text: child.text }],
        timestamp: child.startedAt,
      },
      { isStreaming: true, showReasoning: false, showToolOutput: true },
      opts.onOpenSidebar,
      opts.agentDirectory,
    );
  }
  return html`
    <div class="chat-bubble chat-reading-indicator" aria-hidden="true">
      <span class="chat-reading-indicator__dots"> <span></span><span></span><span></span> </span>
    </div>
  `;
}

function renderAvatar(
  role: string,
  assistant?: Pick<AssistantIdentity, "name" | "avatar"> & { accent?: string | null },
) {
  const normalized = normalizeRoleForGrouping(role);
  const assistantName = assistant?.name?.trim() || "Assistant";
  const assistantAvatar = assistant?.avatar?.trim() || "";
  const assistantAccent = assistant?.accent?.trim() || "";
  const initial =
    normalized === "user"
      ? "U"
      : normalized === "system"
        ? "S"
        : normalized === "assistant"
          ? assistantName.charAt(0).toUpperCase() || "A"
          : normalized === "tool"
            ? "⚙"
            : "?";
  const className =
    normalized === "user" || normalized === "system"
      ? "user"
      : normalized === "assistant"
        ? "assistant"
        : normalized === "peer"
          ? "assistant"
          : normalized === "tool"
            ? "tool"
            : "other";
  const style = assistantAccent ? `--chat-peer-accent: ${assistantAccent};` : nothing;

  if (assistantAvatar && normalized === "assistant") {
    if (isAvatarUrl(assistantAvatar)) {
      return html`<img
        class="chat-avatar ${className}"
        src="${assistantAvatar}"
        alt="${assistantName}"
        style=${style}
      />`;
    }
    return html`<div class="chat-avatar ${className}" style=${style}>${assistantAvatar}</div>`;
  }

  return html`<div class="chat-avatar ${className}" style=${style}>${initial}</div>`;
}

function isAvatarUrl(value: string): boolean {
  return (
    /^https?:\/\//i.test(value) || /^data:image\//i.test(value) || value.startsWith("/") // Relative paths from avatar endpoint
  );
}

function buildMentionAccentMap(agentDirectory?: WorkspaceAgentRow[]): Map<string, string> {
  const accents = new Map<string, string>();
  for (const agent of agentDirectory ?? []) {
    const agentId = agent.id?.trim();
    const color = agent.color?.trim();
    if (!agentId || !color) {
      continue;
    }
    accents.set(`@${agentId}`, color);
  }
  return accents;
}

function highlightAgentMentionsInHtml(
  htmlString: string,
  agentDirectory?: WorkspaceAgentRow[],
): string {
  if (!htmlString || !agentDirectory?.length || typeof document === "undefined") {
    return htmlString;
  }
  const mentionAccents = buildMentionAccentMap(agentDirectory);
  if (mentionAccents.size === 0) {
    return htmlString;
  }
  const template = document.createElement("template");
  template.innerHTML = htmlString;
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  let current = walker.nextNode();
  while (current) {
    const textNode = current as Text;
    const parentTag = textNode.parentElement?.tagName?.toLowerCase();
    if (
      textNode.nodeValue?.includes("@") &&
      parentTag !== "code" &&
      parentTag !== "pre" &&
      parentTag !== "a"
    ) {
      textNodes.push(textNode);
    }
    current = walker.nextNode();
  }
  for (const textNode of textNodes) {
    const text = textNode.nodeValue ?? "";
    AGENT_MENTION_TOKEN_RE.lastIndex = 0;
    const matches = [...text.matchAll(AGENT_MENTION_TOKEN_RE)];
    if (matches.length === 0) {
      continue;
    }
    const fragment = document.createDocumentFragment();
    let cursor = 0;
    for (const match of matches) {
      const mention = match[2] ?? "";
      const accent = mentionAccents.get(mention);
      const fullMatch = match[0] ?? "";
      const prefixLength = fullMatch.length - mention.length;
      const start = (match.index ?? 0) + prefixLength;
      const end = start + mention.length;
      if (start > cursor) {
        fragment.append(document.createTextNode(text.slice(cursor, start)));
      }
      if (accent) {
        const mentionEl = document.createElement("span");
        mentionEl.className = "chat-agent-mention";
        mentionEl.style.setProperty("--chat-agent-mention-accent", accent);
        mentionEl.textContent = mention;
        fragment.append(mentionEl);
      } else {
        fragment.append(document.createTextNode(mention));
      }
      cursor = end;
    }
    if (cursor < text.length) {
      fragment.append(document.createTextNode(text.slice(cursor)));
    }
    textNode.parentNode?.replaceChild(fragment, textNode);
  }
  return template.innerHTML;
}

function renderMessageImages(images: ImageBlock[]) {
  if (images.length === 0) {
    return nothing;
  }

  const openImage = (url: string) => {
    openExternalUrlSafe(url, { allowDataImage: true });
  };

  return html`
    <div class="chat-message-images">
      ${images.map(
        (img) => html`
          <img
            src=${img.url}
            alt=${img.alt ?? "Attached image"}
            class="chat-message-image"
            @click=${() => openImage(img.url)}
          />
        `,
      )}
    </div>
  `;
}

function renderGroupedMessage(
  message: unknown,
  opts: { isStreaming: boolean; showReasoning: boolean; showToolOutput: boolean },
  onOpenSidebar?: (content: string) => void,
  agentDirectory?: WorkspaceAgentRow[],
) {
  const m = message as Record<string, unknown>;
  const role = typeof m.role === "string" ? m.role : "unknown";
  const isToolResult =
    isToolResultMessage(message) ||
    role.toLowerCase() === "toolresult" ||
    role.toLowerCase() === "tool_result" ||
    typeof m.toolCallId === "string" ||
    typeof m.tool_call_id === "string";

  const toolCards = extractToolCards(message);
  const hasToolCards = toolCards.length > 0;
  const images = extractImages(message);
  const hasImages = images.length > 0;

  const extractedText = extractTextCached(message);
  const extractedThinking =
    opts.showReasoning && role === "assistant" ? extractThinkingCached(message) : null;
  const markdownBase = extractedText?.trim() ? extractedText : null;
  const markdown =
    (!opts.showToolOutput && isToolResult) || (opts.showToolOutput && isToolResult && hasToolCards)
      ? null
      : markdownBase;
  const reasoningMarkdown = extractedThinking ? formatReasoningMarkdown(extractedThinking) : null;
  const canCopyMarkdown = role === "assistant" && Boolean(markdown?.trim());

  const bubbleClasses = [
    "chat-bubble",
    canCopyMarkdown ? "has-copy" : "",
    opts.isStreaming ? "streaming" : "",
    "fade-in",
  ]
    .filter(Boolean)
    .join(" ");

  if (!markdown && hasToolCards && isToolResult) {
    return html`${toolCards.map((card) => renderToolCardSidebar(card, onOpenSidebar, opts.showToolOutput))}`;
  }

  if (!markdown && !hasToolCards && !hasImages) {
    return nothing;
  }

  return html`
    <div class="${bubbleClasses}">
      ${canCopyMarkdown ? renderCopyAsMarkdownButton(markdown!) : nothing}
      ${renderMessageImages(images)}
      ${
        reasoningMarkdown
          ? html`<div class="chat-thinking">${unsafeHTML(
              highlightAgentMentionsInHtml(
                toSanitizedMarkdownHtml(reasoningMarkdown),
                agentDirectory,
              ),
            )}</div>`
          : nothing
      }
      ${
        markdown
          ? html`<div class="chat-text" dir="${detectTextDirection(markdown)}">${unsafeHTML(
              highlightAgentMentionsInHtml(toSanitizedMarkdownHtml(markdown), agentDirectory),
            )}</div>`
          : nothing
      }
      ${toolCards.map((card) => renderToolCardSidebar(card, onOpenSidebar, opts.showToolOutput))}
    </div>
  `;
}
