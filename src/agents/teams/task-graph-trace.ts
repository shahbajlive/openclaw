import fs from "node:fs";
import path from "node:path";
import type { Task } from "./types.js";
import {
  generateTaskGraphDashboardHtml,
  generateTaskGraphHtmlFromHistory,
} from "./test-graph-gif.js";

const TRACE_ENABLED = "OPENCLAW_TEAM_GRAPH_TRACE";
const TRACE_DIR = "OPENCLAW_TEAM_GRAPH_TRACE_DIR";
const TRACE_PREFIX = "team-task-graph";
const DEFAULT_TRACE_DIR = process.cwd();
const teamFrameCounts = new Map<string, number>();
const tracedTeamIds = new Set<string>();
const tracedTeamOrder: string[] = [];

function isEnabled(): boolean {
  const raw = process.env[TRACE_ENABLED];
  if (!raw) {
    return false;
  }
  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function sanitizeSegment(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "team";
}

function resolveTraceDir(): string {
  const configured = process.env[TRACE_DIR]?.trim();
  return configured ? path.resolve(configured) : DEFAULT_TRACE_DIR;
}

function renderTaskGraph(tasks: Task[]): string[] {
  const lines: string[] = [];
  const edgeSet = new Set<string>();
  lines.push("```mermaid");
  lines.push("graph TD");
  for (const task of tasks) {
    const shortId = task.taskId.slice(0, 8);
    const safeTitle = task.title.replace(/"/g, "'");
    const assigneeSuffix = task.assignee ? ` @${task.assignee}` : "";
    lines.push(`  t_${shortId}["${safeTitle}${assigneeSuffix} (${task.status})"]`);
  }
  for (const task of tasks) {
    const shortId = task.taskId.slice(0, 8);
    for (const dep of task.dependsOn) {
      edgeSet.add(`  t_${dep.slice(0, 8)} --> t_${shortId}`);
    }
  }
  const endTasks = tasks.filter((task) => task.title === "end_task");
  for (const endTask of endTasks) {
    if (endTask.dependsOn.length > 0) {
      continue;
    }
    const endTaskShortId = endTask.taskId.slice(0, 8);
    for (const source of tasks) {
      if (source.taskId === endTask.taskId || source.title === "end_task") {
        continue;
      }
      if (source.status !== "completed" && source.status !== "failed") {
        continue;
      }
      edgeSet.add(`  t_${source.taskId.slice(0, 8)} --> t_${endTaskShortId}`);
    }
  }
  lines.push(...edgeSet);
  lines.push("```");
  return lines;
}

function resolveTracePaths(teamId: string): {
  graphPath: string;
  historyPath: string;
  htmlPath: string;
} {
  const safeTeamId = sanitizeSegment(teamId);
  const dir = resolveTraceDir();
  const stem = `${TRACE_PREFIX}-${safeTeamId}`;
  return {
    graphPath: path.join(dir, `${stem}.md`),
    historyPath: path.join(dir, `${stem}-history.md`),
    htmlPath: path.join(dir, `${stem}.html`),
  };
}

function resolveDashboardPath(): string {
  return path.join(resolveTraceDir(), `${TRACE_PREFIX}-dashboard.html`);
}

export function recordTeamTaskGraphFrame(params: {
  teamId: string;
  tasks: Iterable<Task>;
  event: string;
}): void {
  if (!isEnabled()) {
    return;
  }

  const tasks = Array.from(params.tasks);
  const { graphPath, historyPath } = resolveTracePaths(params.teamId);
  const dir = path.dirname(graphPath);
  fs.mkdirSync(dir, { recursive: true });
  if (!tracedTeamIds.has(params.teamId)) {
    tracedTeamIds.add(params.teamId);
    tracedTeamOrder.push(params.teamId);
  }

  const nextFrame = (teamFrameCounts.get(params.teamId) ?? 0) + 1;
  teamFrameCounts.set(params.teamId, nextFrame);
  const graphLines = renderTaskGraph(tasks);
  const now = new Date().toISOString();
  const label = `${String(nextFrame).padStart(4, "0")} ${params.event}`;
  if (nextFrame === 1) {
    fs.writeFileSync(historyPath, `# Task Graph History (${params.teamId})\n\n`, "utf-8");
    fs.writeFileSync(graphPath, `# Task Graph (${params.teamId})\n\n`, "utf-8");
  }

  const currentLines = [
    `# Task Graph (${params.teamId})`,
    "",
    `Last updated: ${now}`,
    `Snapshot: ${label}`,
    "",
    ...graphLines,
    "",
  ];
  fs.writeFileSync(graphPath, `${currentLines.join("\n")}\n`, "utf-8");

  const historyLines = [`## ${label} (${now})`, ...graphLines, ""];
  fs.appendFileSync(historyPath, `${historyLines.join("\n")}\n`, "utf-8");
}

export function generateTeamTaskGraphHtml(teamId: string): {
  htmlPath: string;
  frameCount: number;
} {
  const { historyPath, htmlPath } = resolveTracePaths(teamId);
  return generateTaskGraphHtmlFromHistory({ historyPath, htmlPath, teamId });
}

export function generateLatestTeamTaskGraphHtml(): {
  teamId: string;
  htmlPath: string;
  frameCount: number;
} | null {
  const teamId = tracedTeamOrder[tracedTeamOrder.length - 1];
  if (!teamId) {
    return null;
  }
  const { historyPath } = resolveTracePaths(teamId);
  if (!fs.existsSync(historyPath)) {
    return null;
  }
  const generated = generateTeamTaskGraphHtml(teamId);
  return { teamId, ...generated };
}

export function generateAllTeamTaskGraphHtml(params?: {
  teamId?: string;
}): Array<{ teamId: string; htmlPath: string; frameCount: number }> {
  const results: Array<{ teamId: string; htmlPath: string; frameCount: number }> = [];
  const targetTeamIds = params?.teamId ? [params.teamId] : Array.from(tracedTeamIds);
  for (const teamId of targetTeamIds) {
    const { historyPath } = resolveTracePaths(teamId);
    if (!fs.existsSync(historyPath)) {
      continue;
    }
    const generated = generateTeamTaskGraphHtml(teamId);
    results.push({ teamId, ...generated });
  }
  return results;
}

export function generateTeamTaskGraphDashboard(params?: {
  teamId?: string;
}): { htmlPath: string; teamCount: number } | null {
  const targetTeamIds = params?.teamId ? [params.teamId] : tracedTeamOrder;
  const histories = targetTeamIds
    .map((teamId) => ({ teamId, ...resolveTracePaths(teamId) }))
    .filter((entry) => fs.existsSync(entry.historyPath))
    .map((entry) => ({ teamId: entry.teamId, historyPath: entry.historyPath }));

  if (histories.length === 0) {
    return null;
  }

  const htmlPath = resolveDashboardPath();
  const generated = generateTaskGraphDashboardHtml({ histories, htmlPath });
  return generated;
}
