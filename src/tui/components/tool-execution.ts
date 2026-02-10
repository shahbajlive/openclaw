import { Box, Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { formatToolDetail, resolveToolDisplay } from "../../agents/tool-display.js";
import { markdownTheme, theme } from "../theme/theme.js";

type ToolResultContent = {
  type?: string;
  text?: string;
  mimeType?: string;
  bytes?: number;
  omitted?: boolean;
};

type ToolResult = {
  status?: string;
  content?: ToolResultContent[];
  details?: Record<string, unknown>;
};

function formatArgs(toolName: string, args: unknown): string {
  const display = resolveToolDisplay({ name: toolName, args });
  const detail = formatToolDetail(display);
  if (detail) {
    return detail;
  }
  if (!args || typeof args !== "object") {
    return "";
  }
  try {
    const stringified = JSON.stringify(args);
    // Filter out empty objects
    if (stringified === "{}") {
      return "";
    }
    return stringified;
  } catch {
    return "";
  }
}

function extractText(result?: ToolResult): string {
  if (!result?.content) {
    return "";
  }
  const lines: string[] = [];
  for (const entry of result.content) {
    if (entry.type === "text" && entry.text) {
      lines.push(entry.text);
    } else if (entry.type === "image") {
      const mime = entry.mimeType ?? "image";
      const size = entry.bytes ? ` ${Math.round(entry.bytes / 1024)}kb` : "";
      const omitted = entry.omitted ? " (omitted)" : "";
      lines.push(`[${mime}${size}${omitted}]`);
    }
  }
  return lines.join("\n").trim();
}

/** Lines that are pure JSON structure noise — not useful as a preview. */
const STRUCTURAL_JSON_RE = /^[\[\]{},\s]*$/;

/** Extract a short one-line preview from result content for collapsed display. */
function extractResultPreview(result?: ToolResult, maxLen = 80): string {
  if (!result?.content) {
    return "";
  }
  for (const entry of result.content) {
    if (entry.type !== "text" || !entry.text) {
      continue;
    }
    const raw = entry.text.trim();
    if (!raw) {
      continue;
    }

    // If the text looks like JSON, try to extract key fields for a summary.
    if (raw.startsWith("{")) {
      const summary = tryJsonSummary(raw, maxLen);
      if (summary) {
        return summary;
      }
    }

    // Fallback: first non-structural, non-empty line.
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || STRUCTURAL_JSON_RE.test(trimmed)) {
        continue;
      }
      return trimmed.length > maxLen ? `${trimmed.slice(0, maxLen - 1)}…` : trimmed;
    }
  }
  return "";
}

/**
 * Try to parse JSON and build a short "key: value, key: value" summary
 * from the most informative top-level fields.
 */
function tryJsonSummary(text: string, maxLen: number): string {
  try {
    const obj = JSON.parse(text);
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
      return "";
    }

    // Pick the most informative fields (order of preference).
    const priorityKeys = ["status", "error", "teamId", "taskId", "result", "title", "message"];
    const parts: string[] = [];
    for (const key of priorityKeys) {
      if (key in obj && obj[key] != null) {
        const val = typeof obj[key] === "string" ? obj[key] : JSON.stringify(obj[key]);
        parts.push(`${key}: ${val}`);
      }
    }

    if (parts.length === 0) {
      // Fall back to first few scalar keys
      for (const [key, val] of Object.entries(obj)) {
        if (val == null || typeof val === "object") {
          continue;
        }
        parts.push(`${key}: ${String(val)}`);
        if (parts.length >= 3) {
          break;
        }
      }
    }

    if (parts.length === 0) {
      return "";
    }

    const joined = parts.join(", ");
    return joined.length > maxLen ? `${joined.slice(0, maxLen - 1)}…` : joined;
  } catch {
    return "";
  }
}

export class ToolExecutionComponent extends Container {
  private box: Box;
  private header: Text;
  private subLine: Text;
  private argsLine: Text;
  private output: Markdown;
  private toolName: string;
  private args: unknown;
  private result?: ToolResult;
  private resultStatus?: string;
  private expanded = false;
  private isError = false;
  private isPartial = true;
  /** Track whether detail children (argsLine, output) are currently in the box. */
  private detailsAttached = true;
  /** Track whether subLine is currently in the box. */
  private subLineAttached = false;

  constructor(toolName: string, args: unknown) {
    super();
    this.toolName = toolName;
    this.args = args;
    this.box = new Box(1, 1, (line) => theme.toolPendingBg(line));
    this.header = new Text("", 0, 0);
    this.subLine = new Text("", 0, 0);
    this.argsLine = new Text("", 0, 0);
    this.output = new Markdown("", 0, 0, markdownTheme, {
      color: (line) => theme.toolOutput(line),
    });
    this.addChild(this.box);
    this.box.addChild(this.header);
    this.box.addChild(this.argsLine);
    this.box.addChild(this.output);
    this.refresh();
  }

  setArgs(args: unknown) {
    this.args = args;
    this.refresh();
  }

  setExpanded(expanded: boolean) {
    this.expanded = expanded;
    this.refresh();
  }

  setResult(result: ToolResult | undefined, opts?: { isError?: boolean }) {
    this.result = result;
    this.isPartial = false;
    this.resultStatus = typeof result?.status === "string" ? result?.status : undefined;
    this.isError = Boolean(opts?.isError) || this.resultStatus === "error";
    this.refresh();
  }

  setPartialResult(result: ToolResult | undefined) {
    this.result = result;
    this.isPartial = true;
    this.resultStatus = typeof result?.status === "string" ? result?.status : this.resultStatus;
    this.refresh();
  }

  private attachDetails() {
    if (!this.detailsAttached) {
      this.box.addChild(this.argsLine);
      this.box.addChild(this.output);
      this.detailsAttached = true;
    }
  }

  private detachDetails() {
    if (this.detailsAttached) {
      this.box.removeChild(this.argsLine);
      this.box.removeChild(this.output);
      this.detailsAttached = false;
    }
  }

  private attachSubLine() {
    if (!this.subLineAttached) {
      this.box.addChild(this.subLine);
      this.subLineAttached = true;
    }
  }

  private detachSubLine() {
    if (this.subLineAttached) {
      this.box.removeChild(this.subLine);
      this.subLineAttached = false;
    }
  }

  private refresh() {
    const isTimeout = this.resultStatus === "timeout";
    const isWarning = this.resultStatus === "warning";

    const bg = this.isPartial
      ? theme.toolPendingBg
      : this.isError
        ? theme.toolErrorBg
        : isTimeout || isWarning
          ? theme.toolPendingBg
          : theme.toolSuccessBg;
    this.box.setBgFn((line) => bg(line));

    const display = resolveToolDisplay({
      name: this.toolName,
      args: this.args,
    });

    // Compact single-line display when collapsed
    if (!this.expanded) {
      this.detachDetails();
      this.attachSubLine();

      let statusIcon = "";
      if (this.isPartial) {
        statusIcon = "●";
      } else if (isTimeout) {
        statusIcon = "⏱";
      } else if (isWarning) {
        statusIcon = "⚠";
      } else if (this.isError) {
        statusIcon = "✗";
      } else {
        statusIcon = "✓";
      }

      // Format: [+] emoji Label(detail) statusIcon
      const argLine = formatArgs(this.toolName, this.args);
      const argsInParens = argLine ? `(${argLine})` : "";
      const compactTitle = `[+] ${display.emoji} ${display.label}${argsInParens} ${statusIcon}`;

      this.header.setText(theme.toolTitle(compactTitle));

      // Build sub-line: show result preview when available, else status
      let subContent = "";
      if (this.isPartial) {
        subContent = "running...";
      } else {
        const resultPreview = extractResultPreview(this.result);
        if (resultPreview) {
          subContent = resultPreview;
        } else if (isTimeout) {
          subContent = "timed out";
        } else if (this.isError) {
          subContent = "error";
        } else if (isWarning) {
          subContent = "warning";
        } else {
          subContent = "done";
        }
      }
      this.subLine.setText(theme.dim(`  └─ ${subContent}`));

      return;
    }

    // Expanded view: full details with args and output
    this.attachDetails();
    this.detachSubLine();

    const title = `[-] ${display.emoji} ${display.label}${this.isPartial ? " (running)" : ""}`;
    this.header.setText(theme.toolTitle(theme.bold(title)));

    const argLine = formatArgs(this.toolName, this.args);
    this.argsLine.setText(argLine ? theme.dim(argLine) : theme.dim(" "));

    const raw = extractText(this.result);
    const text = raw || (this.isPartial ? "…" : "");
    this.output.setText(text);
  }
}
