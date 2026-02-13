import fs from "node:fs/promises";
import path from "node:path";
import type { Team } from "./types.js";
import { loadConfig } from "../../config/io.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { resolveAgentWorkspaceDir, resolveSessionAgentId } from "../agent-scope.js";
import { RESERVED_MATE_ID } from "./types.js";

const WORKTREE_DIR = ".worktrees";
const GIT_TIMEOUT_MS = 15_000;

type WorktreeMode = "git-worktree" | "directory";

export type TeamWorktreeResult = {
  workspaceDir: string;
  mode: WorktreeMode;
};

type CheckoutTaskBranchParams = {
  teamId: string;
  contextSessionKey: string;
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
