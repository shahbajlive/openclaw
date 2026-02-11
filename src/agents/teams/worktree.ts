import fs from "node:fs/promises";
import path from "node:path";
import type { Team } from "./types.js";
import { loadConfig } from "../../config/config.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { resolveAgentWorkspaceDir, resolveSessionAgentId } from "../agent-scope.js";

const WORKTREE_DIR = ".worktrees";
const GIT_TIMEOUT_MS = 15_000;

type WorktreeMode = "git-worktree" | "directory";

export type TeamWorktreeResult = {
  workspaceDir: string;
  mode: WorktreeMode;
};

function sanitizePathSegment(value: string): string {
  const trimmed = value.trim().toLowerCase();
  const safe = trimmed.replace(/[^a-z0-9._-]+/g, "-").replace(/-+/g, "-");
  return safe.replace(/^-+|-+$/g, "") || "teammate";
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function detectGitRoot(cwd: string): Promise<string | undefined> {
  const res = await runCommandWithTimeout(["git", "-C", cwd, "rev-parse", "--show-toplevel"], {
    timeoutMs: GIT_TIMEOUT_MS,
  });
  if (res.code !== 0) {
    return undefined;
  }
  const root = res.stdout.trim();
  return root ? path.resolve(root) : undefined;
}

async function listGitWorktreePaths(gitRoot: string): Promise<Set<string>> {
  const res = await runCommandWithTimeout(
    ["git", "-C", gitRoot, "worktree", "list", "--porcelain"],
    {
      timeoutMs: GIT_TIMEOUT_MS,
    },
  );
  if (res.code !== 0) {
    return new Set();
  }
  const paths = new Set<string>();
  for (const line of res.stdout.split("\n")) {
    if (!line.startsWith("worktree ")) {
      continue;
    }
    const worktreePath = line.slice("worktree ".length).trim();
    if (worktreePath) {
      paths.add(path.resolve(worktreePath));
    }
  }
  return paths;
}

async function resolveSourceGitRoot(
  teamWorkspaceDir: string,
  creatorSessionKey?: string,
): Promise<string | undefined> {
  const teamRoot = await detectGitRoot(teamWorkspaceDir);
  if (teamRoot) {
    return teamRoot;
  }

  if (!creatorSessionKey) {
    return undefined;
  }
  const cfg = loadConfig();
  const creatorAgentId = resolveSessionAgentId({ sessionKey: creatorSessionKey, config: cfg });
  const creatorWorkspace = resolveAgentWorkspaceDir(cfg, creatorAgentId, creatorSessionKey);
  return await detectGitRoot(creatorWorkspace);
}

async function ensureGitWorktree(params: { gitRoot: string; targetDir: string }): Promise<boolean> {
  const worktreePaths = await listGitWorktreePaths(params.gitRoot);
  const targetResolved = path.resolve(params.targetDir);
  if (worktreePaths.has(targetResolved)) {
    return true;
  }

  if (await pathExists(targetResolved)) {
    // Existing path that is not a registered worktree - leave it as-is.
    return false;
  }

  const add = await runCommandWithTimeout(
    ["git", "-C", params.gitRoot, "worktree", "add", "--detach", targetResolved],
    { timeoutMs: GIT_TIMEOUT_MS },
  );
  return add.code === 0;
}

function resolveTeamWorkspaceDir(team: Team): string {
  const cfg = loadConfig();
  return resolveAgentWorkspaceDir(cfg, team.teamAgentId, team.leadSessionKey);
}

function resolveWorktreeDir(params: { teamWorkspaceDir: string; teammateKey: string }): string {
  return path.join(params.teamWorkspaceDir, WORKTREE_DIR, sanitizePathSegment(params.teammateKey));
}

export async function ensureLeadWorktree(team: Team): Promise<TeamWorktreeResult> {
  return await ensureTeamWorktreeForMember({ team, teammateKey: "lead" });
}

export async function ensureTeammateWorktree(params: {
  team: Team;
  teammateId: string;
}): Promise<TeamWorktreeResult> {
  return await ensureTeamWorktreeForMember({ team: params.team, teammateKey: params.teammateId });
}

async function ensureTeamWorktreeForMember(params: {
  team: Team;
  teammateKey: string;
}): Promise<TeamWorktreeResult> {
  const teamWorkspaceDir = resolveTeamWorkspaceDir(params.team);
  await fs.mkdir(teamWorkspaceDir, { recursive: true });

  const targetDir = resolveWorktreeDir({ teamWorkspaceDir, teammateKey: params.teammateKey });
  await fs.mkdir(path.dirname(targetDir), { recursive: true });

  const gitRoot = await resolveSourceGitRoot(teamWorkspaceDir, params.team.creatorSessionKey);
  if (gitRoot) {
    try {
      const created = await ensureGitWorktree({ gitRoot, targetDir });
      if (created) {
        return { workspaceDir: targetDir, mode: "git-worktree" };
      }
    } catch {
      // Fall back to a plain directory workspace.
    }
  }

  await fs.mkdir(targetDir, { recursive: true });
  return { workspaceDir: targetDir, mode: "directory" };
}
