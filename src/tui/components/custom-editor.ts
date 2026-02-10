import { Editor, Key, matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { theme } from "../theme/theme.js";

export class CustomEditor extends Editor {
  onEscape?: () => void;
  onCtrlC?: () => void;
  onCtrlD?: () => void;
  onCtrlG?: () => void;
  onCtrlL?: () => void;
  onCtrlO?: () => void;
  onCtrlP?: () => void;
  onCtrlT?: () => void;
  onShiftTab?: () => void;
  onShiftUp?: () => void;
  onShiftDown?: () => void;
  onAltEnter?: () => void;

  /** Label to embed in the top border. Can include left (role) and right (tokens) parts. */
  topBorderLabel = "";
  topBorderLeftLabel = "";
  /** Label to embed right-aligned in the bottom border (e.g. model + thinking bars). */
  bottomBorderLabel = "";
  /** Placeholder text shown in the editor when empty (e.g. "gateway not connected"). */
  placeholderText = "";
  /** Whether this pane is active (has terminal focus). Used to hide cursor when inactive. */
  isPaneActive = true;

  handleInput(data: string): void {
    if (matchesKey(data, Key.alt("enter")) && this.onAltEnter) {
      this.onAltEnter();
      return;
    }
    if (matchesKey(data, Key.ctrl("l")) && this.onCtrlL) {
      this.onCtrlL();
      return;
    }
    if (matchesKey(data, Key.ctrl("o")) && this.onCtrlO) {
      this.onCtrlO();
      return;
    }
    if (matchesKey(data, Key.ctrl("p")) && this.onCtrlP) {
      this.onCtrlP();
      return;
    }
    if (matchesKey(data, Key.ctrl("g")) && this.onCtrlG) {
      this.onCtrlG();
      return;
    }
    if (matchesKey(data, Key.ctrl("t")) && this.onCtrlT) {
      this.onCtrlT();
      return;
    }
    if (matchesKey(data, Key.shift("tab")) && this.onShiftTab) {
      this.onShiftTab();
      return;
    }
    if (matchesKey(data, Key.shift("up")) && this.onShiftUp) {
      this.onShiftUp();
      return;
    }
    if (matchesKey(data, Key.shift("down")) && this.onShiftDown) {
      this.onShiftDown();
      return;
    }
    if (matchesKey(data, Key.escape) && this.onEscape && !this.isShowingAutocomplete()) {
      this.onEscape();
      return;
    }
    if (matchesKey(data, Key.ctrl("c")) && this.onCtrlC) {
      this.onCtrlC();
      return;
    }
    if (matchesKey(data, Key.ctrl("d"))) {
      if (this.getText().length === 0 && this.onCtrlD) {
        this.onCtrlD();
      }
      return;
    }
    super.handleInput(data);
  }

  render(width: number): string[] {
    const lines = super.render(width);
    if (lines.length === 0) {
      return lines;
    }

    // Inject labels into top border (line 0)
    if (this.topBorderLeftLabel || this.topBorderLabel) {
      lines[0] = this.embedLabelsInTopBorder(
        lines[0]!,
        this.topBorderLeftLabel,
        this.topBorderLabel,
        width,
      );
    }

    // Find bottom border and inject right-aligned label
    if (this.bottomBorderLabel) {
      const idx = this.findBottomBorderIndex(lines);
      if (idx >= 0) {
        lines[idx] = this.embedLabelInBorder(lines[idx]!, this.bottomBorderLabel, width);
      }
    }

    // Inject > prefix on first content line and placeholder if empty
    if (lines.length > 1) {
      const firstContentIdx = 1;
      const line = lines[firstContentIdx]!;

      if (this.getText().length === 0 && this.placeholderText) {
        // Show placeholder text (dimmed) after the > prefix
        const prefix = theme.accent(">") + " ";
        const prefixWidth = 2; // "> "
        const placeholderStyled = theme.dim(this.placeholderText);
        const remaining = Math.max(0, width - prefixWidth - visibleWidth(placeholderStyled));
        lines[firstContentIdx] = prefix + placeholderStyled + " ".repeat(remaining);
      } else {
        // Inject "> " at the start of the first content line, replacing padding
        const prefix = theme.accent(">") + " ";
        // Replace the first 2 visible characters (spaces from padding) with "> "
        const stripped = line.replace(/^ {1,2}/, "");
        const consumed = line.length - stripped.length;
        if (consumed >= 2) {
          lines[firstContentIdx] = prefix + line.slice(consumed);
        } else {
          // If less than 2 padding chars, just prepend
          lines[firstContentIdx] = prefix + stripped + " ".repeat(Math.max(0, consumed));
        }
      }

      // Hide cursor (white block) when pane is not active
      if (!this.isPaneActive && lines[firstContentIdx]) {
        // The cursor is typically a block character (█ or similar) after the "> " prefix
        // Replace it with a space to hide it
        const line = lines[firstContentIdx]!;
        // Look for common cursor characters and replace with space
        lines[firstContentIdx] = line
          .replace(/[\u2588\u2589\u258A\u258B\u258C\u258D\u258E\u258F]/g, " ") // Block characters
          .replace(/\u25AE/g, " ") // Black vertical rectangle
          .replace(/\u25AF/g, " "); // White vertical rectangle
      }
    }

    return lines;
  }

  /** Embed labels in top border: Format: ------ @role - 20.6k/200k ---- */
  private embedLabelsInTopBorder(
    borderLine: string,
    leftLabel: string,
    rightLabel: string,
    width: number,
  ): string {
    // Format: ------ @role - 20.6k/200k ----
    // rightLabel contains: "@role - tokens" or just "tokens"
    // We want: [left dashes] [middle dashes] [label] [right dashes]
    // Label should be at rightmost position
    if (!rightLabel) {
      return truncateToWidth(borderLine, width, "");
    }

    const labelWidth = visibleWidth(rightLabel);
    const border = "─";
    const leftDashes = 6; // "------"
    const rightDashes = 4; // "----"
    const needWidth = leftDashes + 1 + labelWidth + 1 + rightDashes; // dashes + space + label + space + dashes

    if (needWidth >= width) {
      // Too narrow, truncate the label if needed
      const maxLabelWidth = width - leftDashes - 1 - 1 - rightDashes; // width - left - space - space - right
      const truncatedLabel = truncateToWidth(rightLabel, maxLabelWidth, "");
      const leftBorder = this.borderColor(border.repeat(leftDashes));
      const rightBorder = this.borderColor(border.repeat(rightDashes));
      const result = `${leftBorder} ${truncatedLabel} ${rightBorder}`;
      return truncateToWidth(result, width, "");
    }

    // Calculate how many dashes we need in the middle (fill remaining space between left and label)
    const middleDashes = width - leftDashes - 1 - labelWidth - 1 - rightDashes;

    const leftBorder = this.borderColor(border.repeat(leftDashes));
    const middleBorder = this.borderColor(border.repeat(Math.max(1, middleDashes)));
    const rightBorder = this.borderColor(border.repeat(rightDashes));

    // Format: ------ [middle dashes] @role - 20.6k/200k ----
    const result = `${leftBorder} ${middleBorder} ${rightLabel} ${rightBorder}`;
    // Ensure we don't exceed width
    return truncateToWidth(result, width, "");
  }

  /** Embed a styled label right-aligned in a border line (used for bottom border). */
  /** Format: ----------------@role-token- (dashes on left, @role-token on right) */
  private embedLabelInBorder(borderLine: string, label: string, width: number): string {
    if (!label) {
      return borderLine; // No label, return original border
    }

    const border = "─";
    const labelWidth = visibleWidth(label);
    const needWidth = labelWidth + 1; // label + trailing dash

    if (needWidth >= width) {
      // Too narrow, truncate label
      const truncatedLabel = truncateToWidth(label, width - 1, "");
      const result = `${truncatedLabel}${this.borderColor(border)}`;
      return truncateToWidth(result, width, "");
    }

    // Fill left with dashes, label on right, trailing dash
    const leftLen = width - labelWidth - 1; // -1 for trailing dash
    // Build: [left dashes] [label] [trailing dash]
    return truncateToWidth(
      this.borderColor(border.repeat(leftLen)) + label + this.borderColor(border),
      width,
      "",
    );
  }

  /** Find the bottom border line index (last line that looks like a border). */
  private findBottomBorderIndex(lines: string[]): number {
    for (let i = lines.length - 1; i >= 1; i--) {
      const stripped = lines[i]!.replace(/\x1b\[[0-9;]*m/g, "");
      if (stripped.startsWith("───")) {
        return i;
      }
    }
    return lines.length > 1 ? lines.length - 1 : -1;
  }
}
