import { Container, Text, visibleWidth } from "@mariozechner/pi-tui";
import { theme } from "../theme/theme.js";
import { ChatLog } from "./chat-log.js";

/**
 * SplitView component that displays multiple ChatLog instances side-by-side.
 * Uses simple container layout with visual separators.
 */
export class SplitView extends Container {
  private panes: Array<{
    chatLog: ChatLog;
    sessionKey: string;
    role?: string;
    container: Container;
  }> = [];
  private activePaneIndex = 0;

  /**
   * Set up the panes for the split view.
   * @param sessionKeys Array of session keys to display (lead + teammates)
   * @param activeIndex Which pane should be highlighted as active
   * @param roles Optional array of role names (index 0 = lead, indices 1+ = teammate roles)
   */
  setPanes(sessionKeys: string[], activeIndex: number, roles?: string[]) {
    this.clear();
    this.panes = [];
    this.activePaneIndex = activeIndex;

    // No limit - show all teammates
    const keys = sessionKeys;

    for (let i = 0; i < keys.length; i++) {
      const sessionKey = keys[i]!;
      const role = roles?.[i];
      const chatLog = new ChatLog();
      const isActive = i === activeIndex;

      // Create a container for each pane
      const paneContainer = new Container();

      // Add a visual indicator at the top
      // Lead (index 0) gets "Lead" label, teammates get their role name or "Pane N" as fallback
      const label =
        i === 0
          ? isActive
            ? theme.bold(theme.accent("▶ Lead"))
            : theme.dim("  Lead")
          : isActive
            ? theme.bold(theme.accent(role ? `▶ @${role}` : `▶ Pane ${i + 1}`))
            : theme.dim(role ? `  @${role}` : `  Pane ${i + 1}`);

      const indicator = new Text(label, 1, 0);
      paneContainer.addChild(indicator);
      paneContainer.addChild(chatLog);

      this.addChild(paneContainer);
      this.panes.push({ chatLog, sessionKey, role, container: paneContainer });
    }
  }

  /**
   * Get the ChatLog for a specific pane index.
   */
  getPane(index: number): ChatLog | undefined {
    return this.panes[index]?.chatLog;
  }

  /**
   * Get the session key for a specific pane index.
   */
  getSessionKey(index: number): string | undefined {
    return this.panes[index]?.sessionKey;
  }

  /**
   * Update which pane is visually highlighted as active.
   */
  setActivePane(index: number) {
    if (index < 0 || index >= this.panes.length) {
      return;
    }

    this.activePaneIndex = index;

    // Update indicators for all panes
    for (let i = 0; i < this.panes.length; i++) {
      const pane = this.panes[i];
      if (pane) {
        const isActive = i === index;
        const indicator = pane.container.children[0];
        if (indicator instanceof Text) {
          // Lead (index 0) gets "Lead" label, teammates get their role name or "Pane N" as fallback
          const label =
            i === 0
              ? isActive
                ? theme.bold(theme.accent("▶ Lead"))
                : theme.dim("  Lead")
              : isActive
                ? theme.bold(theme.accent(pane.role ? `▶ @${pane.role}` : `▶ Pane ${i + 1}`))
                : theme.dim(pane.role ? `  @${pane.role}` : `  Pane ${i + 1}`);
          indicator.setText(label);
        }
      }
    }
  }

  /**
   * Get the total number of panes.
   */
  getPaneCount(): number {
    return this.panes.length;
  }

  /**
   * Render panes in 50/50 left-right split layout.
   * Left: Lead session (pane 0)
   * Right: All teammates (panes 1+) stacked vertically
   * Overrides Container's default vertical stacking.
   */
  render(width: number): string[] {
    if (this.panes.length === 0) {
      return [];
    }

    // Calculate 50/50 split widths
    const separatorWidth = 1; // "│" character between left and right
    const leftWidth = Math.floor((width - separatorWidth) / 2);
    const rightWidth = width - leftWidth - separatorWidth;

    if (leftWidth < 1 || rightWidth < 1) {
      // Not enough space, return empty
      return [];
    }

    // Minimum height for teammate panes
    const minTeammateHeight = 5;

    // Render lead pane (index 0) on the left
    const leadPane = this.panes[0];
    const leftLines: string[] = leadPane ? leadPane.container.render(leftWidth) : [];

    // Render all teammate panes (indices 1+) on the right, stacked vertically
    const teammatePanes = this.panes.slice(1);
    const rightSideLines: string[] = [];

    if (teammatePanes.length > 0) {
      for (let i = 0; i < teammatePanes.length; i++) {
        const teammate = teammatePanes[i]!;
        const teammateLines = teammate.container.render(rightWidth);

        // Ensure minimum height
        const paddedLines = [...teammateLines];
        while (paddedLines.length < minTeammateHeight) {
          paddedLines.push(" ".repeat(rightWidth));
        }

        // Add teammate content
        rightSideLines.push(...paddedLines);

        // Add horizontal separator between teammates (but not after the last one)
        if (i < teammatePanes.length - 1) {
          const separator = theme.dim("─".repeat(rightWidth));
          rightSideLines.push(separator);
        }
      }
    } else {
      // No teammates, just empty right side
      rightSideLines.push(" ".repeat(rightWidth));
    }

    // Pad left and right to the same height
    const maxHeight = Math.max(leftLines.length, rightSideLines.length);

    // Pad left side
    while (leftLines.length < maxHeight) {
      leftLines.push(" ".repeat(leftWidth));
    }

    // Pad right side
    while (rightSideLines.length < maxHeight) {
      rightSideLines.push(" ".repeat(rightWidth));
    }

    // Combine left and right horizontally
    const combinedLines: string[] = [];
    for (let lineIdx = 0; lineIdx < maxHeight; lineIdx++) {
      const leftLine = leftLines[lineIdx]!;
      const rightLine = rightSideLines[lineIdx]!;

      // Pad left line to exactly leftWidth visible characters
      const leftVisible = visibleWidth(leftLine);
      const leftPadding = Math.max(0, leftWidth - leftVisible);
      const paddedLeft = leftLine + " ".repeat(leftPadding);

      // Pad right line to exactly rightWidth visible characters
      const rightVisible = visibleWidth(rightLine);
      const rightPadding = Math.max(0, rightWidth - rightVisible);
      const paddedRight = rightLine + " ".repeat(rightPadding);

      // Combine: left + separator + right
      combinedLines.push(paddedLeft + theme.dim("│") + paddedRight);
    }

    return combinedLines;
  }
}
