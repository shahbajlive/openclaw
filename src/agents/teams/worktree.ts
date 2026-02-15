import fs from "node:fs/promises";
import path from "node:path";
import type { SwarmTask } from "./types.js";
import { runCommandWithTimeout } from "../../process/exec.js";

const DEFAULT_WORKTREE_ROOT = "openclaw";
const DEFAULT_TEAM_WORKTREE_DIR = "_team";
const DEFAULT_GIT_TIMEOUT_MS = 15_000;

type GitCommandResult = {
  code: number;
  stdout: string;
  stderr: string;
};

export type TeamWorktreeOptions = {
  worktreeRoot?: string;
  teamWorktreeDir?: string;
  gitTimeoutMs?: number;
};

export class TeamWorktree {
  private readonly worktreeRoot: string;
  private readonly teamWorktreeDir: string;
  private readonly gitTimeoutMs: number;

  constructor(opts: TeamWorktreeOptions = {}) {
    this.worktreeRoot = opts.worktreeRoot ?? DEFAULT_WORKTREE_ROOT;
    this.teamWorktreeDir = opts.teamWorktreeDir ?? DEFAULT_TEAM_WORKTREE_DIR;
    this.gitTimeoutMs = opts.gitTimeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
  }

  public async switchTaskWorktreeAndBranch(
    teamId: string,
    task: SwarmTask,
    opts?: { syncWithTeam?: boolean },
  ): Promise<void> {
    const syncWithTeam = opts?.syncWithTeam ?? true;
    const sessionName = task.contextSessionKey.trim();
    if (!sessionName) {
      throw new Error(`Task "${task.taskId}" has no session name.`);
    }

    const gitRoot = await this.detectGitRoot(process.cwd());
    if (!gitRoot) return;

    const workspaceDir = this.sessionWorkspaceDir(teamId, sessionName);
    await fs.mkdir(path.dirname(workspaceDir), { recursive: true });

    await this.ensureWorktree(gitRoot, workspaceDir, `session "${sessionName}"`);
    await this.ensureTeamBranchWorktree(teamId, gitRoot);
    const teamBranch = this.teamBranchName(teamId);
    const branchExists = await this.branchExists(workspaceDir, sessionName);
    if (!branchExists) {
      await this.switchBranch(workspaceDir, sessionName, teamBranch);
      return;
    }

    await this.switchBranch(workspaceDir, sessionName);
    if (!syncWithTeam) return;

    const dirty = await this.isWorktreeDirty(workspaceDir);
    if (dirty) {
      throw new Error(
        `Task "${task.taskId}" branch "${sessionName}" has local changes; cannot rebase before starting work.`,
      );
    }

    const rebase = await runCommandWithTimeout(["git", "-C", workspaceDir, "rebase", teamBranch], {
      timeoutMs: this.gitTimeoutMs,
    });
    if (rebase.code !== 0) {
      await runCommandWithTimeout(["git", "-C", workspaceDir, "rebase", "--abort"], {
        timeoutMs: this.gitTimeoutMs,
      });
      throw new Error(
        `Failed to rebase branch "${sessionName}" onto "${teamBranch}" before starting task "${task.taskId}".`,
      );
    }
  }

  public async detectGitRoot(cwd: string): Promise<string | undefined> {
    const res = await runCommandWithTimeout(["git", "-C", cwd, "rev-parse", "--show-toplevel"], {
      timeoutMs: this.gitTimeoutMs,
    });
    if (res.code !== 0) return undefined;
    const root = res.stdout.trim();
    return root ? path.resolve(root) : undefined;
  }

  public async pathExists(target: string): Promise<boolean> {
    try {
      await fs.access(target);
      return true;
    } catch {
      return false;
    }
  }

  public async commitRaisePrAndMerge(
    teamId: string,
    task: SwarmTask,
    answer: string,
  ): Promise<{ commitId: string; prRef: string; teamBranch: string }> {
    const sessionName = task.contextSessionKey.trim();
    if (!sessionName) {
      throw new Error(`Task "${task.taskId}" has no session name.`);
    }

    const gitRoot = await this.detectGitRoot(process.cwd());
    if (!gitRoot) {
      throw new Error("Git root not found.");
    }

    await this.switchTaskWorktreeAndBranch(teamId, task, { syncWithTeam: false });
    const sourceWorkspace = this.sessionWorkspaceDir(teamId, sessionName);
    const teamWorkspace = await this.ensureTeamBranchWorktree(teamId, gitRoot);
    const teamBranch = this.teamBranchName(teamId);

    await this.gitOrThrow(
      ["git", "-C", sourceWorkspace, "add", "-A"],
      "Failed to stage task changes.",
    );

    const commitTitle = `task_submit: ${task.title} (${task.taskId})`;
    const commitBody = answer.trim() ? answer.trim() : "No answer body provided.";
    await this.gitOrThrow(
      [
        "git",
        "-C",
        sourceWorkspace,
        "commit",
        "--allow-empty",
        "-m",
        commitTitle,
        "-m",
        commitBody,
      ],
      `Failed to commit task "${task.taskId}".`,
    );

    const commitRes = await this.gitOrThrow(
      ["git", "-C", sourceWorkspace, "rev-parse", "HEAD"],
      "Failed to resolve commit SHA.",
    );
    const commitId = commitRes.stdout.trim();
    const prRef = `pr:${sessionName}->${teamBranch}:${commitId.slice(0, 12)}`;

    const merge = await runCommandWithTimeout(
      ["git", "-C", teamWorkspace, "merge", "--no-ff", "--no-edit", sessionName],
      { timeoutMs: this.gitTimeoutMs },
    );
    if (merge.code !== 0) {
      await runCommandWithTimeout(["git", "-C", teamWorkspace, "merge", "--abort"], {
        timeoutMs: this.gitTimeoutMs,
      });
      throw new Error(`Failed to merge "${sessionName}" into "${teamBranch}".`);
    }

    return { commitId, prRef, teamBranch };
  }

  public async ensureTeamBranchWorktree(teamId: string, gitRoot: string): Promise<string> {
    const teamWorkspace = this.teamWorkspaceDir(teamId);
    await fs.mkdir(path.dirname(teamWorkspace), { recursive: true });
    await this.ensureWorktree(gitRoot, teamWorkspace, `team "${teamId}"`);
    await this.switchBranch(teamWorkspace, this.teamBranchName(teamId));
    return teamWorkspace;
  }

  public async gitOrThrow(command: string[], message: string): Promise<GitCommandResult> {
    const res = await runCommandWithTimeout(command, { timeoutMs: this.gitTimeoutMs });
    if (res.code !== 0) {
      throw new Error(message);
    }
    return { code: 0, stdout: res.stdout, stderr: res.stderr };
  }

  public sessionWorkspaceDir(teamId: string, sessionName: string): string {
    return path.resolve(this.worktreeRoot, teamId, sessionName);
  }

  public teamWorkspaceDir(teamId: string): string {
    return path.resolve(this.worktreeRoot, teamId, this.teamWorktreeDir);
  }

  public teamBranchName(teamId: string): string {
    return `team-${teamId}`;
  }

  private async hasWorktree(gitRoot: string, workspaceDir: string): Promise<boolean> {
    const res = await runCommandWithTimeout(
      ["git", "-C", gitRoot, "worktree", "list", "--porcelain"],
      { timeoutMs: this.gitTimeoutMs },
    );
    if (res.code !== 0) return false;
    const target = path.resolve(workspaceDir);
    for (const line of res.stdout.split("\n")) {
      if (!line.startsWith("worktree ")) {
        continue;
      }
      const listed = path.resolve(line.slice("worktree ".length).trim());
      if (listed === target) return true;
    }
    return false;
  }

  private async ensureWorktree(
    gitRoot: string,
    workspaceDir: string,
    label: string,
  ): Promise<void> {
    const isRegistered = await this.hasWorktree(gitRoot, workspaceDir);
    if (isRegistered) return;
    const exists = await this.pathExists(workspaceDir);
    if (exists) return;
    const add = await runCommandWithTimeout(
      ["git", "-C", gitRoot, "worktree", "add", "--detach", workspaceDir],
      { timeoutMs: this.gitTimeoutMs },
    );
    if (add.code !== 0) {
      throw new Error(`Failed to create worktree for ${label}.`);
    }
  }

  private async switchBranch(
    workspaceDir: string,
    branchName: string,
    startPoint?: string,
  ): Promise<void> {
    const exists = await this.branchExists(workspaceDir, branchName);
    const switchArgs = exists
      ? ["git", "-C", workspaceDir, "switch", branchName]
      : startPoint
        ? ["git", "-C", workspaceDir, "switch", "-c", branchName, startPoint]
        : ["git", "-C", workspaceDir, "switch", "-c", branchName];
    await this.gitOrThrow(switchArgs, `Failed to switch branch "${branchName}".`);
  }

  private async branchExists(workspaceDir: string, branchName: string): Promise<boolean> {
    const branchRef = `refs/heads/${branchName}`;
    const exists = await runCommandWithTimeout(
      ["git", "-C", workspaceDir, "show-ref", "--verify", "--quiet", branchRef],
      { timeoutMs: this.gitTimeoutMs },
    );
    return exists.code === 0;
  }

  private async isWorktreeDirty(workspaceDir: string): Promise<boolean> {
    const status = await this.gitOrThrow(
      ["git", "-C", workspaceDir, "status", "--porcelain"],
      "Failed to inspect task branch status.",
    );
    return status.stdout.trim().length > 0;
  }
}
