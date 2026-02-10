/**
 * Team color palette for visual distinction in TUI.
 * Each team gets a unique color based on team ID hash.
 */

import { createHash } from "node:crypto";

// ANSI color codes for team themes
export const TEAM_COLORS = [
  { bg: "\x1b[44m", fg: "\x1b[94m", name: "blue" }, // Blue
  { bg: "\x1b[42m", fg: "\x1b[92m", name: "green" }, // Green
  { bg: "\x1b[45m", fg: "\x1b[95m", name: "magenta" }, // Magenta
  { bg: "\x1b[46m", fg: "\x1b[96m", name: "cyan" }, // Cyan
  { bg: "\x1b[43m", fg: "\x1b[93m", name: "yellow" }, // Yellow
  { bg: "\x1b[41m", fg: "\x1b[91m", name: "red" }, // Red
];

/**
 * Teammate pane colors for TUI-rendered badges.
 * Rotates through this palette to match tmux border colors.
 */
export const TEAMMATE_COLORS = [
  { fg: "#7DD3A5", name: "green" },
  { fg: "#F6C453", name: "yellow" },
  { fg: "#F2A65A", name: "orange" },
  { fg: "#F97066", name: "pink" },
  { fg: "#8CC8FF", name: "cyan" },
  { fg: "#C084FC", name: "purple" },
  { fg: "#E87B6B", name: "rust" },
];

/**
 * Get a consistent color palette for a team based on team ID.
 */
export function getTeamColor(teamId: string): { bg: string; fg: string; name: string } {
  const hash = createHash("sha256").update(teamId).digest();
  const index = hash[0] % TEAM_COLORS.length;
  return TEAM_COLORS[index];
}

/**
 * Get a teammate color by pane index.
 */
export function getTeammateColor(paneIndex: number): { fg: string; name: string } {
  return TEAMMATE_COLORS[paneIndex % TEAMMATE_COLORS.length];
}
