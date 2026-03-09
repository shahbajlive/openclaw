import { t } from "../i18n/index.ts";
import type { IconName } from "./icons.js";

export const TAB_GROUPS = [
  { label: "chat", tabs: ["chat"] },
  {
    label: "workspace",
    tabs: ["workspace-map", "workspace-messages", "workspace-kanban"],
  },
  {
    label: "control",
    tabs: ["overview", "channels", "instances", "sessions", "usage", "cron"],
  },
  { label: "agent", tabs: ["agents", "skills", "nodes"] },
  { label: "settings", tabs: ["config", "debug", "logs"] },
] as const;

export type Tab =
  | "agents"
  | "overview"
  | "channels"
  | "instances"
  | "sessions"
  | "usage"
  | "cron"
  | "skills"
  | "nodes"
  | "chat"
  | "workspace-messages"
  | "workspace-kanban"
  | "workspace-map"
  | "workspace-crons"
  | "workspace-activity"
  | "workspace-memory"
  | "workspace-costs"
  | "workspace-settings"
  | "config"
  | "debug"
  | "logs";

export const WORKSPACE_TABS = [
  "workspace-map",
  "workspace-messages",
  "workspace-kanban",
] as const satisfies readonly Tab[];

const TAB_PATHS: Record<Tab, string> = {
  agents: "/agents",
  overview: "/overview",
  channels: "/channels",
  instances: "/instances",
  sessions: "/sessions",
  usage: "/usage",
  cron: "/cron",
  skills: "/skills",
  nodes: "/nodes",
  chat: "/chat",
  "workspace-messages": "/workspace/messages",
  "workspace-kanban": "/workspace/kanban",
  "workspace-map": "/workspace/map",
  "workspace-crons": "/workspace/crons",
  "workspace-activity": "/workspace/activity",
  "workspace-memory": "/workspace/memory",
  "workspace-costs": "/workspace/costs",
  "workspace-settings": "/workspace/settings",
  config: "/config",
  debug: "/debug",
  logs: "/logs",
};

const PATH_TO_TAB = new Map(Object.entries(TAB_PATHS).map(([tab, path]) => [path, tab as Tab]));

export function normalizeBasePath(basePath: string): string {
  if (!basePath) {
    return "";
  }
  let base = basePath.trim();
  if (!base.startsWith("/")) {
    base = `/${base}`;
  }
  if (base === "/") {
    return "";
  }
  if (base.endsWith("/")) {
    base = base.slice(0, -1);
  }
  return base;
}

export function normalizePath(path: string): string {
  if (!path) {
    return "/";
  }
  let normalized = path.trim();
  if (!normalized.startsWith("/")) {
    normalized = `/${normalized}`;
  }
  if (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

export function pathForTab(tab: Tab, basePath = ""): string {
  const base = normalizeBasePath(basePath);
  const path = TAB_PATHS[tab];
  return base ? `${base}${path}` : path;
}

export function tabFromPath(pathname: string, basePath = ""): Tab | null {
  const base = normalizeBasePath(basePath);
  let path = pathname || "/";
  if (base) {
    if (path === base) {
      path = "/";
    } else if (path.startsWith(`${base}/`)) {
      path = path.slice(base.length);
    }
  }
  let normalized = normalizePath(path).toLowerCase();
  if (normalized.endsWith("/index.html")) {
    normalized = "/";
  }
  if (normalized === "/") {
    return "chat";
  }
  return PATH_TO_TAB.get(normalized) ?? null;
}

export function inferBasePathFromPathname(pathname: string): string {
  let normalized = normalizePath(pathname);
  if (normalized.endsWith("/index.html")) {
    normalized = normalizePath(normalized.slice(0, -"/index.html".length));
  }
  if (normalized === "/") {
    return "";
  }
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length === 0) {
    return "";
  }
  for (let i = 0; i < segments.length; i++) {
    const candidate = `/${segments.slice(i).join("/")}`.toLowerCase();
    if (PATH_TO_TAB.has(candidate)) {
      const prefix = segments.slice(0, i);
      return prefix.length ? `/${prefix.join("/")}` : "";
    }
  }
  return `/${segments.join("/")}`;
}

export function iconForTab(tab: Tab): IconName {
  switch (tab) {
    case "agents":
      return "folder";
    case "chat":
      return "messageSquare";
    case "workspace-messages":
      return "messageSquare";
    case "workspace-kanban":
      return "folder";
    case "workspace-map":
      return "folder";
    case "workspace-crons":
      return "loader";
    case "workspace-activity":
      return "scrollText";
    case "workspace-memory":
      return "fileText";
    case "workspace-costs":
      return "barChart";
    case "workspace-settings":
      return "settings";
    case "overview":
      return "barChart";
    case "channels":
      return "link";
    case "instances":
      return "radio";
    case "sessions":
      return "fileText";
    case "usage":
      return "barChart";
    case "cron":
      return "loader";
    case "skills":
      return "zap";
    case "nodes":
      return "monitor";
    case "config":
      return "settings";
    case "debug":
      return "bug";
    case "logs":
      return "scrollText";
    default:
      return "folder";
  }
}

export function isWorkspaceTab(tab: Tab): boolean {
  return (WORKSPACE_TABS as readonly Tab[]).includes(tab);
}

export function titleForTab(tab: Tab) {
  switch (tab) {
    case "workspace-messages":
      return "Messages";
    case "workspace-kanban":
      return "Kanban";
    case "workspace-map":
      return "Map";
    case "workspace-crons":
      return "Crons";
    case "workspace-activity":
      return "Activity";
    case "workspace-memory":
      return "Memory";
    case "workspace-costs":
      return "Costs";
    case "workspace-settings":
      return "Settings";
    default:
      return t(`tabs.${tab}`);
  }
}

export function subtitleForTab(tab: Tab) {
  switch (tab) {
    case "workspace-messages":
      return "Agent chat routed through real OpenClaw sessions.";
    case "workspace-kanban":
      return "Workspace task board with agent assignments.";
    case "workspace-map":
      return "Workspace team hierarchy from OpenClaw agent data.";
    case "workspace-crons":
      return "Scheduled jobs and recent runs.";
    case "workspace-activity":
      return "Gateway logs and activity stream.";
    case "workspace-memory":
      return "Workspace memory and agent instruction files.";
    case "workspace-costs":
      return "Token usage and cost analysis.";
    case "workspace-settings":
      return "Workspace-facing gateway configuration.";
    default:
      return t(`subtitles.${tab}`);
  }
}
