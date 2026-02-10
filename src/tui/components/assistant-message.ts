import {
  type Component,
  Container,
  Markdown,
  Spacer,
  Text,
  visibleWidth,
  wrapTextWithAnsi,
} from "@mariozechner/pi-tui";
import chalk from "chalk";
import { markdownTheme, theme } from "../theme/theme.js";
import { splitThinkingFromText } from "../tui-formatters.js";

// ── ThinkingBox ──────────────────────────────────────────────
// Renders a bordered box with "thinking" embedded in the top border:
//
//   ╭── thinking ──────────────────────────────╮
//   │  The user wants me to ask all the        │
//   │  teammates in the team to say hi.        │
//   ╰──────────────────────────────────────────╯
//
// Everything is dim so it reads as secondary context.
// ─────────────────────────────────────────────────────────────

class ThinkingBox implements Component {
  private text = "";
  private cachedWidth = -1;
  private cachedLines: string[] = [];

  setText(text: string) {
    if (this.text !== text) {
      this.text = text;
      this.cachedWidth = -1;
    }
  }

  invalidate() {
    this.cachedWidth = -1;
  }

  render(width: number): string[] {
    if (!this.text || width < 10) {
      return [];
    }
    if (this.cachedWidth === width && this.cachedLines.length > 0) {
      return this.cachedLines;
    }

    const innerWidth = Math.max(1, width - 4); // "│ " + content + " │"

    // ── top border ──
    const label = " thinking ";
    const afterLabel = Math.max(0, width - 2 - label.length - 1);
    const topBorder = `╭─${label}${"─".repeat(afterLabel)}╮`;

    // ── content lines ──
    const contentLines: string[] = [];
    for (const paragraph of this.text.split("\n")) {
      if (!paragraph.trim()) {
        contentLines.push("");
        continue;
      }
      contentLines.push(...wrapTextWithAnsi(paragraph, innerWidth));
    }

    const bordered = contentLines.map((line) => {
      const vis = visibleWidth(line);
      const pad = Math.max(0, innerWidth - vis);
      return `│ ${line}${" ".repeat(pad)} │`;
    });

    // ── bottom border ──
    const bottomBorder = `╰${"─".repeat(Math.max(0, width - 2))}╯`;

    this.cachedLines = [
      theme.dim(topBorder),
      ...bordered.map((l) => theme.dim(l)),
      theme.dim(bottomBorder),
    ];
    this.cachedWidth = width;

    return this.cachedLines;
  }
}

// ── AssistantMessageComponent ────────────────────────────────

export class AssistantMessageComponent extends Container {
  private thinkingBox: ThinkingBox;
  private thinkingSpacer: Spacer;
  private thinkingShown = false;
  private roleBadgeText: Text | null = null;
  private roleBadgeShown = false;
  private body: Markdown;

  constructor(text: string) {
    super();
    this.thinkingBox = new ThinkingBox();
    this.thinkingSpacer = new Spacer(1);

    // Main content
    this.body = new Markdown("", 1, 0, markdownTheme, {
      color: (line) => theme.fg(line),
    });
    this.addChild(new Spacer(1));
    this.addChild(this.body);

    this.setText(text);
  }

  /**
   * Set a colored @Role badge that appears above the message body.
   * Pass null to remove the badge.
   */
  setRoleBadge(role: string | null, color: string | null) {
    if (role) {
      const colorFn = color ? chalk.hex(color) : theme.accent;
      const badgeStr = colorFn(`@${role}`);
      if (!this.roleBadgeText) {
        this.roleBadgeText = new Text(badgeStr, 0, 0);
      } else {
        this.roleBadgeText.setText(badgeStr);
      }
      if (!this.roleBadgeShown) {
        // Insert badge right before the body
        const idx = this.children.indexOf(this.body);
        if (idx >= 0) {
          this.children.splice(idx, 0, this.roleBadgeText);
        }
        this.roleBadgeShown = true;
      }
    } else if (this.roleBadgeShown && this.roleBadgeText) {
      this.removeChild(this.roleBadgeText);
      this.roleBadgeShown = false;
    }
  }

  setText(text: string) {
    const { thinking, content } = splitThinkingFromText(text);

    if (thinking) {
      if (!this.thinkingShown) {
        const idx = this.children.indexOf(this.body);
        if (idx >= 0) {
          this.children.splice(idx, 0, this.thinkingBox, this.thinkingSpacer);
        }
        this.thinkingShown = true;
      }
      this.thinkingBox.setText(thinking);
    } else if (this.thinkingShown) {
      this.removeChild(this.thinkingBox);
      this.removeChild(this.thinkingSpacer);
      this.thinkingShown = false;
    }

    this.body.setText(content);
  }
}
