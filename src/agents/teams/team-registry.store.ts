import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Team } from "./types.js";
import { STATE_DIR } from "../../config/paths.js";
import { loadJsonFile, saveJsonFile } from "../../infra/json-file.js";

const TEAMS_DIRNAME = "teams";

/**
 * Resolve the base path for team storage.
 * Reads from config if available, otherwise defaults to ~/.openclaw/teams.
 */
export function resolveTeamBasePath(cfg?: {
  gateway?: { teams?: { storage?: { basePath?: string } } };
}): string {
  const configured = cfg?.gateway?.teams?.storage?.basePath;
  if (configured) {
    // Expand ~ to homedir
    if (configured.startsWith("~/")) {
      return path.join(os.homedir(), configured.slice(2));
    }
    return configured;
  }
  return path.join(STATE_DIR, TEAMS_DIRNAME);
}

/**
 * Resolve the directory path for a specific team.
 */
function resolveTeamDir(teamId: string, cfg?: Parameters<typeof resolveTeamBasePath>[0]): string {
  const basePath = resolveTeamBasePath(cfg);
  return path.join(basePath, teamId);
}

/**
 * Resolve the config.json path for a specific team.
 */
function resolveTeamConfigPath(
  teamId: string,
  cfg?: Parameters<typeof resolveTeamBasePath>[0],
): string {
  return path.join(resolveTeamDir(teamId, cfg), "config.json");
}

/**
 * Save a team to disk.
 * Writes config.json to ~/.openclaw/teams/{teamId}/config.json
 */
export function saveTeamToDisk(team: Team, cfg?: Parameters<typeof resolveTeamBasePath>[0]): void {
  const configPath = resolveTeamConfigPath(team.teamId, cfg);
  saveJsonFile(configPath, team);
}

/**
 * Load a team from disk.
 * Returns null if the team doesn't exist or is corrupt.
 */
export function loadTeamFromDisk(
  teamId: string,
  cfg?: Parameters<typeof resolveTeamBasePath>[0],
): Team | null {
  const configPath = resolveTeamConfigPath(teamId, cfg);
  const raw = loadJsonFile(configPath);
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const team = raw as Partial<Team>;
  // Basic validation
  if (!team.teamId || !team.teamName || !team.leadSessionKey) {
    return null;
  }
  // Ensure teammates is a record (not undefined or null)
  if (!team.teammates || typeof team.teammates !== "object") {
    team.teammates = {};
  }
  return team as Team;
}

/**
 * Load all teams from disk.
 * Scans ~/.openclaw/teams/ directory for team dirs, loads each config.json
 */
export function loadAllTeamsFromDisk(
  cfg?: Parameters<typeof resolveTeamBasePath>[0],
): Map<string, Team> {
  const basePath = resolveTeamBasePath(cfg);
  const teams = new Map<string, Team>();

  try {
    if (!fs.existsSync(basePath)) {
      return teams;
    }

    const entries = fs.readdirSync(basePath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const teamId = entry.name;
      const team = loadTeamFromDisk(teamId, cfg);
      if (team) {
        teams.set(teamId, team);
      }
    }
  } catch {
    // Return empty map on any error (permission issues, etc.)
  }

  return teams;
}

/**
 * Delete a team from disk.
 * Removes entire ~/.openclaw/teams/{teamId}/ directory
 */
export function deleteTeamFromDisk(
  teamId: string,
  cfg?: Parameters<typeof resolveTeamBasePath>[0],
): void {
  const teamDir = resolveTeamDir(teamId, cfg);
  try {
    if (fs.existsSync(teamDir)) {
      fs.rmSync(teamDir, { recursive: true, force: true });
    }
  } catch {
    // Ignore deletion errors
  }
}
