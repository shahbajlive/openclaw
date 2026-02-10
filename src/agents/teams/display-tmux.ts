// Public API exports expected by callers
export function isTmuxAvailable(): Promise<boolean> {
  return tmuxExists();
}

export function isInsideTmux(): boolean {
  return Boolean(process.env.TMUX);
}

export async function getTerminalMultiplexer(): Promise<"tmux" | "none"> {
  return (await tmuxExists()) ? "tmux" : "none";
}

export async function resolveTeamDisplayMode(mode?: string): Promise<"tmux" | "inline"> {
  if (mode === "tmux") {
    return "tmux";
  }
  if (mode === "inline") {
    return "inline";
  }
  // auto/default: use tmux only when inside tmux, otherwise inline
  if (isInsideTmux() && (await tmuxExists())) {
    return "tmux";
  }
  return "inline";
}

export async function attachTeamTmuxSession(teamName: string): Promise<void> {
  await tmux(["attach-session", "-t", teamName]);
}

export async function switchToTeamTmuxSession(teamName: string): Promise<void> {
  await tmux(["switch-client", "-t", teamName]);
}

export async function killTeamTmuxSession(teamName: string): Promise<void> {
  await tmux(["kill-session", "-t", teamName]);
}

export async function addTeammateTmuxPane(params: {
  session: string;
  targetPane: string;
  command: CliCommand;
  sessionKey: string;
}): Promise<string> {
  const newPane = await spawnPane(
    params.targetPane,
    "bottom",
    undefined,
    params.command,
    params.sessionKey,
  );
  await tmux(["set-option", "-p", "-t", newPane, "@pane_session", params.sessionKey]);
  return newPane;
}

export async function updateTeamTmuxStatusBar(teamName: string): Promise<void> {
  await tmux(["set-option", "-t", teamName, "status-left", `#[bold] openclaw: ${teamName} `]);
}

import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { resolveBonjourCliPath } from "../../gateway/server-discovery.js";

/* =========================================================
 * Async tmux runner
 * =======================================================*/

const execFileAsync = promisify(execFile);

async function tmuxExists(): Promise<boolean> {
  try {
    await execFileAsync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function tmux(args: string[], opts: any = {}) {
  const { stdout } = await execFileAsync("tmux", args, {
    encoding: "utf-8",
    ...opts,
  });
  return stdout.trim();
}

/* =========================================================
 * Utilities
 * =======================================================*/

const TEAMMATE_PANE_COLORS = [
  "green",
  "yellow",
  "colour214",
  "colour205",
  "cyan",
  "colour141",
  "colour167",
];

function paneColor(idx: number) {
  return TEAMMATE_PANE_COLORS[idx % TEAMMATE_PANE_COLORS.length];
}

function sanitize(name: string) {
  return name.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

export function resolveTeamTmuxSessionName(params: { teamName: string; prefix: string }): string {
  return `${sanitize(params.prefix)}-${sanitize(params.teamName)}`;
}

/* =========================================================
 * Openclaw discovery (shared spirit w/ wezterm)
 * =======================================================*/

export type CliCommand = {
  bin: string;
  args: string[];
  cwd?: string;
};

export function findOpenClaw(): CliCommand {
  const envCliPath = process.env.OPENCLAW_CLI_PATH?.trim();
  if (envCliPath) {
    if (envCliPath.endsWith(".js") || envCliPath.endsWith(".mjs")) {
      return { bin: "node", args: [envCliPath] };
    }
    return { bin: envCliPath, args: [] };
  }

  const resolved = resolveBonjourCliPath();
  if (resolved) {
    if (resolved.endsWith(".js") || resolved.endsWith(".mjs")) {
      return { bin: "node", args: [resolved] };
    }
    return { bin: resolved, args: [] };
  }

  try {
    execFileSync("which", ["openclaw"], { stdio: "ignore" });
    return { bin: "openclaw", args: [] };
  } catch {}

  const cwd = process.cwd();
  const pkgPath = path.join(cwd, "package.json");

  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    if (pkg.name === "openclaw") {
      try {
        execFileSync("pnpm", ["--version"], { stdio: "ignore" });
        return { bin: "pnpm", args: ["openclaw"], cwd };
      } catch {}
    }
  }

  return { bin: "openclaw", args: [] };
}

/* =========================================================
 * Layout planner (pure)
 * =======================================================*/

export type PlannedPane =
  | { id: "lead" }
  | { id: string; parent: string; split: "right" | "bottom"; percent?: number };

export function planTmuxLayout(count: number): PlannedPane[] {
  const panes: PlannedPane[] = [{ id: "lead" }];

  if (count === 0) return panes;

  panes.push({ id: "tm-0", parent: "lead", split: "right", percent: 50 });

  for (let i = 1; i < count; i++) {
    panes.push({ id: `tm-${i}`, parent: `tm-${i - 1}`, split: "bottom" });
  }

  return panes;
}

/* =========================================================
 * Idempotent session ensure
 * =======================================================*/

export async function ensureTeamTmuxSession(params: {
  teamName: string;
  prefix: string;
}): Promise<string> {
  const session = resolveTeamTmuxSessionName({
    teamName: params.teamName,
    prefix: params.prefix,
  });

  try {
    await tmux(["has-session", "-t", session]);
    return session;
  } catch {
    await tmux(["new-session", "-d", "-s", session, "-n", "lead"]);

    await tmux(["set-option", "-t", session, "pane-border-status", "top"]);
    await tmux([
      "set-option",
      "-t",
      session,
      "pane-border-format",
      " #[fg=#{@pane_color},bold]@#{pane_title}#[default] ",
    ]);
    const panes = await listPanes(session);
    const leadPaneId = panes[0]?.id ?? `${session}:0.0`;
    await tmux(["set-option", "-p", "-t", leadPaneId, "@pane_color", "cyan"]);

    return session;
  }
}

/* =========================================================
 * Pane helpers
 * =======================================================*/

async function listPanes(session: string) {
  const out = await tmux([
    "list-panes",
    "-t",
    session,
    "-F",
    "#{pane_id}\t#{@pane_session}\t#{pane_title}",
  ]);
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [id, paneSession, title] = line.split("\t");
      return { id, paneSession: paneSession || undefined, title };
    });
}

async function spawnPane(
  targetPane: string,
  direction: "right" | "bottom",
  percent: number | undefined,
  cmd: CliCommand,
  sessionKey: string,
): Promise<string> {
  const splitArgs =
    direction === "right"
      ? ["split-window", "-h", ...(percent ? ["-p", String(percent)] : [])]
      : ["split-window", "-v"];

  await tmux([
    ...splitArgs,
    "-t",
    targetPane,
    `${cmd.bin} ${cmd.args.join(" ")} tui --session ${sessionKey}`,
  ]);

  const newPane = await tmux(["display-message", "-p", "#{pane_id}"]);
  return newPane;
}

function matchesSession(pane: { paneSession?: string; title?: string }, key: string): boolean {
  if (pane.paneSession) {
    return pane.paneSession === key;
  }
  return pane.title?.includes(key) ?? false;
}

/* =========================================================
 * Idempotent orchestrator
 * =======================================================*/

export type TeamTmuxPaneMap = {
  session: string;
  leadPaneId: string;
  teammatePaneIds: Record<string, string>;
};

export async function createTeamTmuxView(params: {
  teamName: string;
  leadSessionKey: string;
  teammates: Array<{
    role: string;
    sessionKey: string;
    currentTask?: string;
    teammateId?: string;
  }>;
  sessionPrefix?: string;
}): Promise<TeamTmuxPaneMap> {
  const session = await ensureTeamTmuxSession({
    teamName: params.teamName,
    prefix: params.sessionPrefix ?? "openclaw-team",
  });

  const openclaw = findOpenClaw();
  const layout = planTmuxLayout(params.teammates.length);

  const panes = await listPanes(session);

  const existingLead = panes.find((p) => matchesSession(p, params.leadSessionKey));
  const leadPaneId = existingLead?.id ?? panes[0]?.id ?? `${session}:0.0`;

  // Lead
  if (!existingLead) {
    await tmux([
      "send-keys",
      "-t",
      leadPaneId,
      `${openclaw.bin} ${openclaw.args.join(" ")} tui --session ${params.leadSessionKey}`,
      "Enter",
    ]);
  }
  await tmux(["set-option", "-p", "-t", leadPaneId, "@pane_session", params.leadSessionKey]);
  await tmux(["select-pane", "-t", leadPaneId, "-T", "Lead"]);

  const paneByPlan = new Map<string, string>();
  paneByPlan.set("lead", leadPaneId);

  const teammatePaneIds: Record<string, string> = {};

  for (let i = 0; i < params.teammates.length; i++) {
    const tm = params.teammates[i]!;
    const plan = layout[i + 1] as any;

    const existing = panes.find((p) => matchesSession(p, tm.sessionKey));
    if (existing) {
      paneByPlan.set(plan.id, existing.id);
      await tmux([
        "select-pane",
        "-t",
        existing.id,
        "-T",
        `@${tm.role}: ${tm.currentTask ?? "Idle"}`,
      ]);
      await tmux(["set-option", "-p", "-t", existing.id, "@pane_color", paneColor(i + 1)]);
      await tmux(["set-option", "-p", "-t", existing.id, "@pane_session", tm.sessionKey]);
      if (tm.teammateId) {
        teammatePaneIds[tm.teammateId] = existing.id;
      }
      continue;
    }

    const parent = paneByPlan.get(plan.parent)!;

    const splitArgs =
      plan.split === "right"
        ? ["split-window", "-h", "-p", String(plan.percent ?? 50)]
        : ["split-window", "-v"];

    await tmux([
      ...splitArgs,
      "-t",
      parent,
      `${openclaw.bin} ${openclaw.args.join(" ")} tui --session ${tm.sessionKey}`,
    ]);

    const newPane = await tmux(["display-message", "-p", "#{pane_id}"]);

    await tmux(["select-pane", "-t", newPane, "-T", `@${tm.role}: ${tm.currentTask ?? "Idle"}`]);

    await tmux(["set-option", "-p", "-t", newPane, "@pane_color", paneColor(i + 1)]);

    await tmux(["set-option", "-p", "-t", newPane, "@pane_session", tm.sessionKey]);

    paneByPlan.set(plan.id, newPane);
    if (tm.teammateId) {
      teammatePaneIds[tm.teammateId] = newPane;
    }
  }

  await tmux(["select-layout", "-t", session, "main-vertical"]);

  return {
    session,
    leadPaneId,
    teammatePaneIds,
  };
}
