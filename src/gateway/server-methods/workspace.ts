import fs from "node:fs/promises";
import path from "node:path";
import { resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { listCoreToolSections } from "../../agents/tool-catalog.js";
import {
  expandToolGroups,
  normalizeToolList,
  resolveToolProfilePolicy,
} from "../../agents/tool-policy-shared.js";
import { type OpenClawConfig, loadConfig } from "../../config/config.js";
import { readFileWithinRoot, SafeOpenError } from "../../infra/fs-safe.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { errorShape, ErrorCodes } from "../protocol/index.js";
import { listAgentsForGateway } from "../session-utils.js";
import type { GatewayRequestHandlers } from "./types.js";

type WorkspaceRegistryAgent = {
  id: string;
  name?: string;
  title?: string | null;
  reportsTo?: string | null;
  directReports?: string[];
  soulPath?: string | null;
  color?: string | null;
  emoji?: string | null;
  tools?: string[];
  description?: string | null;
  workspaceDir?: string;
};

type WorkspaceRegistryResult = {
  workspaceDir: string;
  registryPath: string | null;
  defaultId: string;
  agents: WorkspaceRegistryAgent[];
};

type WorkspaceFileEntry = {
  id: string;
  label: string;
  relativePath: string;
  missing: boolean;
  size?: number;
  updatedAtMs?: number;
};

type WorkspaceTicketStatus = "backlog" | "todo" | "in-progress" | "review" | "done";
type WorkspaceTicketPriority = "low" | "medium" | "high";
type WorkspaceTicketRole = "lead-dev" | "ux-ui" | "qa";
type WorkspaceTicketWorkState = "idle" | "starting" | "working" | "done" | "failed";

type WorkspaceTicket = {
  id: string;
  title: string;
  description: string;
  status: WorkspaceTicketStatus;
  priority: WorkspaceTicketPriority;
  assigneeId: string | null;
  assigneeRole: WorkspaceTicketRole | null;
  workState: WorkspaceTicketWorkState;
  workStartedAt: number | null;
  workError: string | null;
  workResult: string | null;
  createdAt: number;
  updatedAt: number;
};

type SoulMetadata = {
  title: string | null;
  description: string | null;
};

const ROOT_COLORS = ["#f5c518", "#f59e0b", "#eab308"];
const MANAGER_COLORS = ["#a855f7", "#8b5cf6", "#ec4899", "#14b8a6"];
const MEMBER_COLORS = ["#3b82f6", "#22c55e", "#f97316", "#ef4444", "#14b8a6", "#60a5fa", "#84cc16"];
const CORE_TOOL_IDS = listCoreToolSections()
  .flatMap((section) => section.tools.map((tool) => tool.id))
  .toSorted((a, b) => a.localeCompare(b));
const KANBAN_STATUS_VALUES = new Set<WorkspaceTicketStatus>([
  "backlog",
  "todo",
  "in-progress",
  "review",
  "done",
]);
const KANBAN_PRIORITY_VALUES = new Set<WorkspaceTicketPriority>(["low", "medium", "high"]);
const KANBAN_ROLE_VALUES = new Set<WorkspaceTicketRole>(["lead-dev", "ux-ui", "qa"]);
const KANBAN_WORK_STATE_VALUES = new Set<WorkspaceTicketWorkState>([
  "idle",
  "starting",
  "working",
  "done",
  "failed",
]);

function assignClawPortColors(agents: WorkspaceRegistryAgent[]): Map<string, string> {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const colors = new Map<string, string>();

  const roots = agents.filter((agent) => (agent.reportsTo ?? null) === null);

  roots.forEach((root, index) => {
    colors.set(root.id, ROOT_COLORS[index % ROOT_COLORS.length]);
  });

  roots.forEach((root) => {
    const children = (root.directReports ?? [])
      .map((id) => byId.get(id))
      .filter(Boolean) as WorkspaceRegistryAgent[];
    let managerIndex = 0;
    let memberIndex = 0;
    for (const child of children) {
      if (colors.has(child.id)) {
        continue;
      }
      if ((child.directReports?.length ?? 0) > 0) {
        colors.set(child.id, MANAGER_COLORS[managerIndex % MANAGER_COLORS.length]);
        managerIndex += 1;
      } else {
        colors.set(child.id, MEMBER_COLORS[memberIndex % MEMBER_COLORS.length]);
        memberIndex += 1;
      }
    }
  });

  const visitDescendants = (agentId: string) => {
    const agent = byId.get(agentId);
    if (!agent) {
      return;
    }
    let childIndex = 0;
    for (const childId of agent.directReports ?? []) {
      const child = byId.get(childId);
      if (!child) {
        continue;
      }
      if (!colors.has(child.id)) {
        colors.set(child.id, MEMBER_COLORS[childIndex % MEMBER_COLORS.length]);
      }
      childIndex += 1;
      visitDescendants(child.id);
    }
  };

  roots.forEach((root) => visitDescendants(root.id));

  let fallbackIndex = 0;
  for (const agent of agents) {
    if (!colors.has(agent.id)) {
      colors.set(agent.id, MEMBER_COLORS[fallbackIndex % MEMBER_COLORS.length]);
      fallbackIndex += 1;
    }
  }
  return colors;
}

function childWorkspaceSegment(agentId: string, parentId: string | null): string {
  if (!parentId) {
    return agentId;
  }
  const prefix = `${parentId}-`;
  return agentId.startsWith(prefix) ? agentId.slice(prefix.length) : agentId;
}

function buildSoulPaths(agents: WorkspaceRegistryAgent[]): Map<string, string> {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const cache = new Map<string, string>();

  const resolve = (agentId: string): string => {
    const cached = cache.get(agentId);
    if (cached) {
      return cached;
    }
    const agent = byId.get(agentId);
    if (!agent) {
      return "SOUL.md";
    }
    const parentId = agent.reportsTo ?? null;
    const relative = childWorkspaceSegment(agent.id, parentId);
    let soulPath: string;
    if (parentId && byId.has(parentId)) {
      const parentDir = path.posix.dirname(resolve(parentId));
      soulPath =
        parentDir === "."
          ? path.posix.join("agents", relative, "SOUL.md")
          : path.posix.join(parentDir, relative, "SOUL.md");
    } else if (parentId === null) {
      soulPath = "SOUL.md";
    } else {
      soulPath = path.posix.join("agents", relative, "SOUL.md");
    }
    cache.set(agentId, soulPath);
    return soulPath;
  };

  for (const agent of agents) {
    resolve(agent.id);
  }
  return cache;
}

function truncateSentence(text: string, max = 120): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) {
    return normalized;
  }
  const cut = normalized.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trim()}…`;
}

function parseSoulMetadata(markdown: string): SoulMetadata {
  const lines = markdown.split(/\r?\n/);
  const heading = lines.find((line) => line.trim().startsWith("# "))?.trim() ?? "";
  const headingTitle = heading.includes("--") ? heading.split("--").slice(1).join("--").trim() : "";
  const identityIndex = lines.findIndex((line) => line.trim().toLowerCase() === "## identity");
  if (identityIndex === -1) {
    return { title: headingTitle || null, description: null };
  }

  const paragraphs: string[] = [];
  let current = "";
  for (const rawLine of lines.slice(identityIndex + 1)) {
    const line = rawLine.trim();
    if (!line) {
      if (current) {
        paragraphs.push(current.trim());
        current = "";
      }
      continue;
    }
    if (line.startsWith("## ")) {
      break;
    }
    current += `${current ? " " : ""}${line}`;
  }
  if (current) {
    paragraphs.push(current.trim());
  }

  const descriptiveParagraph =
    paragraphs.find((paragraph) => !paragraph.toLowerCase().startsWith("i am ")) ??
    paragraphs[0] ??
    "";

  return {
    title: headingTitle || null,
    description: descriptiveParagraph ? truncateSentence(descriptiveParagraph) : null,
  };
}

async function readSoulMetadata(agent: WorkspaceRegistryAgent): Promise<SoulMetadata | null> {
  const workspaceDir = agent.workspaceDir?.trim();
  const soulPath = agent.soulPath?.trim();
  if (!workspaceDir || !soulPath) {
    return null;
  }
  try {
    const content = await fs.readFile(path.resolve(workspaceDir, soulPath), "utf8");
    return parseSoulMetadata(content);
  } catch {
    return null;
  }
}

function resolveWorkspaceAgentTools(cfg: OpenClawConfig, agentToolConfig: unknown): string[] {
  const toolConfig = (agentToolConfig ?? {}) as {
    profile?: string;
    allow?: string[];
    alsoAllow?: string[];
    deny?: string[];
  };
  const globalToolConfig = (cfg.tools ?? {}) as {
    profile?: string;
    allow?: string[];
    alsoAllow?: string[];
    deny?: string[];
  };
  const profile = toolConfig.profile ?? globalToolConfig.profile;
  const profilePolicy = resolveToolProfilePolicy(profile);
  const allowInputs = [
    ...(profilePolicy?.allow ?? []),
    ...(globalToolConfig.allow ?? []),
    ...(globalToolConfig.alsoAllow ?? []),
    ...(toolConfig.allow ?? []),
    ...(toolConfig.alsoAllow ?? []),
  ];
  const hasExplicitAllow = allowInputs.length > 0;
  const allowed = hasExplicitAllow
    ? expandToolGroups(normalizeToolList(allowInputs))
    : [...CORE_TOOL_IDS];
  const denySet = new Set(
    expandToolGroups(
      normalizeToolList([
        ...(profilePolicy?.deny ?? []),
        ...(globalToolConfig.deny ?? []),
        ...(toolConfig.deny ?? []),
      ]),
    ),
  );
  return allowed.filter((tool) => !denySet.has(tool)).toSorted((a, b) => a.localeCompare(b));
}

function buildWorkspaceAgentsFromOpenClaw() {
  const cfg = loadConfig();
  const gatewayAgents = listAgentsForGateway(cfg);
  const toolsByAgentId = new Map<string, unknown>();
  for (const entry of cfg.agents?.list ?? []) {
    const id = typeof entry?.id === "string" ? entry.id.trim() : "";
    if (!id) {
      continue;
    }
    toolsByAgentId.set(normalizeAgentId(id), entry.tools);
  }
  const soulPaths = buildSoulPaths(
    gatewayAgents.agents.map((entry) => ({
      id: entry.id,
      reportsTo: entry.reportsTo ?? null,
    })),
  );
  const agents: WorkspaceRegistryAgent[] = gatewayAgents.agents.map((entry) => {
    const workspaceDir = resolveAgentWorkspaceDir(cfg, entry.id);
    const displayName = entry.name?.trim() || entry.identity?.name?.trim() || entry.id;
    return {
      id: entry.id,
      name: displayName,
      title: entry.identity?.theme?.trim() || null,
      reportsTo: entry.reportsTo ?? null,
      directReports: entry.directReports ?? [],
      soulPath: soulPaths.get(entry.id) ?? "SOUL.md",
      color: entry.identity?.color?.trim() || null,
      emoji: entry.identity?.emoji?.trim() || null,
      tools: resolveWorkspaceAgentTools(cfg, toolsByAgentId.get(entry.id)),
      description: null,
      workspaceDir,
    };
  });
  return {
    cfg,
    defaultId: gatewayAgents.defaultId,
    workspaceDir: resolveAgentWorkspaceDir(cfg, gatewayAgents.defaultId),
    agents,
  };
}

async function loadWorkspaceRegistry(): Promise<WorkspaceRegistryResult> {
  const { defaultId, workspaceDir, agents } = buildWorkspaceAgentsFromOpenClaw();
  const assignedColors = assignClawPortColors(agents);
  const enrichedAgents = await Promise.all(
    agents.map(async (agent) => {
      const soul = await readSoulMetadata(agent);
      const title =
        soul?.title?.trim() ||
        agent.title?.trim() ||
        (agent.reportsTo == null ? "Orchestrator" : null);
      const description =
        soul?.description?.trim() ||
        agent.description?.trim() ||
        (agent.reportsTo == null ? "Workspace root orchestrator." : null);
      return {
        ...agent,
        color: agent.color?.trim() || assignedColors.get(agent.id) || null,
        title,
        description,
      };
    }),
  );
  return {
    workspaceDir,
    registryPath: null,
    defaultId,
    agents:
      enrichedAgents.length > 0
        ? enrichedAgents
        : [
            {
              id: defaultId,
              name: defaultId,
              title: "Orchestrator",
              description: "Workspace root orchestrator.",
              reportsTo: null,
              directReports: [],
            },
          ],
  };
}

async function statIfPresent(
  absPath: string,
): Promise<{ size: number; updatedAtMs: number } | null> {
  try {
    const stat = await fs.stat(absPath);
    if (!stat.isFile()) {
      return null;
    }
    return { size: stat.size, updatedAtMs: Math.floor(stat.mtimeMs) };
  } catch {
    return null;
  }
}

function uniqueById(entries: WorkspaceFileEntry[]): WorkspaceFileEntry[] {
  const seen = new Set<string>();
  const output: WorkspaceFileEntry[] = [];
  for (const entry of entries) {
    if (seen.has(entry.id)) {
      continue;
    }
    seen.add(entry.id);
    output.push(entry);
  }
  return output;
}

async function listWorkspaceFilesForAgent(
  agent: WorkspaceRegistryAgent,
): Promise<WorkspaceFileEntry[]> {
  const workspaceDir = agent.workspaceDir?.trim();
  if (!workspaceDir) {
    return [];
  }
  const candidates: Array<{ label: string; relativePath: string }> = [];
  const soulPath = agent.soulPath?.trim();
  if (soulPath) {
    candidates.push({ label: "SOUL.md", relativePath: soulPath });
    const dir = path.posix.dirname(soulPath);
    if (dir && dir !== ".") {
      for (const name of ["TOOLS.md", "USER.md", "MEMORY.md", "memory.md", "IDENTITY.md"]) {
        candidates.push({ label: name, relativePath: path.posix.join(dir, name) });
      }
    }
  }
  if (agent.reportsTo == null) {
    for (const name of ["IDENTITY.md", "MEMORY.md", "memory.md", "TOOLS.md", "USER.md"]) {
      candidates.push({ label: name, relativePath: name });
    }
  }

  const entries: WorkspaceFileEntry[] = [];
  for (const candidate of uniqueById(
    candidates.map((item) => ({
      id: item.relativePath,
      label: item.label,
      relativePath: item.relativePath,
      missing: true,
    })),
  )) {
    const absPath = path.resolve(workspaceDir, candidate.relativePath);
    const meta = await statIfPresent(absPath);
    entries.push(
      meta
        ? {
            ...candidate,
            missing: false,
            size: meta.size,
            updatedAtMs: meta.updatedAtMs,
          }
        : candidate,
    );
  }
  return entries;
}

async function readWorkspaceFile(params: {
  workspaceDir: string;
  relativePath: string;
}): Promise<string> {
  const result = await readFileWithinRoot({
    rootDir: params.workspaceDir,
    relativePath: params.relativePath,
    maxBytes: 1024 * 1024,
  });
  return result.buffer.toString("utf8");
}

function workspaceKanbanStorePath(workspaceDir: string): string {
  return path.resolve(workspaceDir, ".openclaw", "workspace", "kanban", "tickets.json");
}

function createWorkspaceTicketId(): string {
  const randomPart =
    typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return `ticket-${randomPart}`;
}

function normalizeStatus(value: unknown): WorkspaceTicketStatus {
  return KANBAN_STATUS_VALUES.has(value as WorkspaceTicketStatus)
    ? (value as WorkspaceTicketStatus)
    : "backlog";
}

function normalizePriority(value: unknown): WorkspaceTicketPriority {
  return KANBAN_PRIORITY_VALUES.has(value as WorkspaceTicketPriority)
    ? (value as WorkspaceTicketPriority)
    : "medium";
}

function normalizeRole(value: unknown): WorkspaceTicketRole | null {
  return KANBAN_ROLE_VALUES.has(value as WorkspaceTicketRole)
    ? (value as WorkspaceTicketRole)
    : null;
}

function normalizeWorkState(value: unknown): WorkspaceTicketWorkState {
  return KANBAN_WORK_STATE_VALUES.has(value as WorkspaceTicketWorkState)
    ? (value as WorkspaceTicketWorkState)
    : "idle";
}

function normalizeTicket(raw: unknown): WorkspaceTicket | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const entry = raw as Record<string, unknown>;
  const title = typeof entry.title === "string" ? entry.title.trim() : "";
  if (!title) {
    return null;
  }
  const assigneeId =
    typeof entry.assigneeId === "string" && entry.assigneeId.trim() ? entry.assigneeId : null;
  const assigneeRole = assigneeId ? normalizeRole(entry.assigneeRole) : null;
  const now = Date.now();
  return {
    id: typeof entry.id === "string" && entry.id.trim() ? entry.id : createWorkspaceTicketId(),
    title,
    description: typeof entry.description === "string" ? entry.description : "",
    status: normalizeStatus(entry.status),
    priority: normalizePriority(entry.priority),
    assigneeId,
    assigneeRole,
    workState: normalizeWorkState(entry.workState),
    workStartedAt: typeof entry.workStartedAt === "number" ? entry.workStartedAt : null,
    workError: typeof entry.workError === "string" ? entry.workError : null,
    workResult: typeof entry.workResult === "string" ? entry.workResult : null,
    createdAt: typeof entry.createdAt === "number" ? entry.createdAt : now,
    updatedAt: typeof entry.updatedAt === "number" ? entry.updatedAt : now,
  };
}

async function readWorkspaceKanbanTickets(workspaceDir: string): Promise<WorkspaceTicket[]> {
  const storePath = workspaceKanbanStorePath(workspaceDir);
  try {
    const raw = await fs.readFile(storePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .map((entry) => normalizeTicket(entry))
      .filter((ticket): ticket is WorkspaceTicket => ticket !== null)
      .toSorted((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

async function writeWorkspaceKanbanTickets(
  workspaceDir: string,
  tickets: WorkspaceTicket[],
): Promise<void> {
  const storePath = workspaceKanbanStorePath(workspaceDir);
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(storePath, JSON.stringify(tickets, null, 2), "utf8");
}

export const workspaceHandlers: GatewayRequestHandlers = {
  "workspace.agents.list": async ({ respond }) => {
    try {
      const registry = await loadWorkspaceRegistry();
      respond(true, registry, undefined);
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, err instanceof Error ? err.message : String(err)),
      );
    }
  },
  "workspace.files.list": async ({ params, respond }) => {
    const agentId = typeof params.agentId === "string" ? params.agentId.trim() : "";
    if (!agentId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "missing agentId"));
      return;
    }
    try {
      const registry = await loadWorkspaceRegistry();
      const agent = registry.agents.find((entry) => entry.id === agentId);
      if (!agent) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `agent "${agentId}" not found`),
        );
        return;
      }
      const workspaceDir = agent.workspaceDir?.trim() || registry.workspaceDir;
      const files = await listWorkspaceFilesForAgent(agent);
      respond(true, { agentId, workspace: workspaceDir, files }, undefined);
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, err instanceof Error ? err.message : String(err)),
      );
    }
  },
  "workspace.files.get": async ({ params, respond }) => {
    const agentId = typeof params.agentId === "string" ? params.agentId.trim() : "";
    const relativePath = typeof params.relativePath === "string" ? params.relativePath.trim() : "";
    if (!agentId || !relativePath) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "missing agentId or relativePath"),
      );
      return;
    }
    try {
      const registry = await loadWorkspaceRegistry();
      const agent = registry.agents.find((entry) => entry.id === agentId);
      if (!agent) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `agent "${agentId}" not found`),
        );
        return;
      }
      const workspaceDir = agent.workspaceDir?.trim() || registry.workspaceDir;
      const files = await listWorkspaceFilesForAgent(agent);
      const file = files.find((entry) => entry.relativePath === relativePath);
      if (!file) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `file "${relativePath}" not available`),
        );
        return;
      }
      if (file.missing) {
        respond(true, { agentId, workspace: workspaceDir, file }, undefined);
        return;
      }
      const content = await readWorkspaceFile({
        workspaceDir,
        relativePath,
      });
      respond(
        true,
        {
          agentId,
          workspace: workspaceDir,
          file: { ...file, content },
        },
        undefined,
      );
    } catch (err) {
      const message =
        err instanceof SafeOpenError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, message));
    }
  },
  "workspace.kanban.list": async ({ respond }) => {
    try {
      const registry = await loadWorkspaceRegistry();
      const workspace = registry.workspaceDir;
      const tickets = await readWorkspaceKanbanTickets(workspace);
      respond(true, { workspace, tickets }, undefined);
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, err instanceof Error ? err.message : String(err)),
      );
    }
  },
  "workspace.kanban.create": async ({ params, respond }) => {
    const title = typeof params.title === "string" ? params.title.trim() : "";
    if (!title) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "missing title"));
      return;
    }
    try {
      const registry = await loadWorkspaceRegistry();
      const workspace = registry.workspaceDir;
      const now = Date.now();
      const assigneeId =
        typeof params.assigneeId === "string" && params.assigneeId.trim()
          ? params.assigneeId.trim()
          : null;
      const ticket: WorkspaceTicket = {
        id: createWorkspaceTicketId(),
        title,
        description: typeof params.description === "string" ? params.description.trim() : "",
        status: "backlog",
        priority: normalizePriority(params.priority),
        assigneeId,
        assigneeRole: assigneeId ? normalizeRole(params.assigneeRole) : null,
        workState: "idle",
        workStartedAt: null,
        workError: null,
        workResult: null,
        createdAt: now,
        updatedAt: now,
      };
      const current = await readWorkspaceKanbanTickets(workspace);
      const next = [ticket, ...current];
      await writeWorkspaceKanbanTickets(workspace, next);
      respond(true, { workspace, ticket }, undefined);
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, err instanceof Error ? err.message : String(err)),
      );
    }
  },
  "workspace.kanban.update": async ({ params, respond }) => {
    const ticketId = typeof params.ticketId === "string" ? params.ticketId.trim() : "";
    const patch =
      params.patch && typeof params.patch === "object" && !Array.isArray(params.patch)
        ? (params.patch as Record<string, unknown>)
        : null;
    if (!ticketId || !patch) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "missing ticketId or patch"),
      );
      return;
    }
    try {
      const registry = await loadWorkspaceRegistry();
      const workspace = registry.workspaceDir;
      const current = await readWorkspaceKanbanTickets(workspace);
      const index = current.findIndex((ticket) => ticket.id === ticketId);
      if (index < 0) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `ticket "${ticketId}" not found`),
        );
        return;
      }
      const existing = current[index];
      const nextAssigneeId = Object.hasOwn(patch, "assigneeId")
        ? typeof patch.assigneeId === "string" && patch.assigneeId.trim()
          ? patch.assigneeId.trim()
          : null
        : existing.assigneeId;
      const nextAssigneeRole =
        nextAssigneeId === null
          ? null
          : Object.hasOwn(patch, "assigneeRole")
            ? normalizeRole(patch.assigneeRole)
            : existing.assigneeRole;
      const nextTitle = Object.hasOwn(patch, "title")
        ? typeof patch.title === "string"
          ? patch.title.trim()
          : ""
        : existing.title;
      if (!nextTitle) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "title cannot be empty"));
        return;
      }
      const updated: WorkspaceTicket = {
        ...existing,
        title: nextTitle,
        description: Object.hasOwn(patch, "description")
          ? typeof patch.description === "string"
            ? patch.description.trim()
            : ""
          : existing.description,
        status: Object.hasOwn(patch, "status") ? normalizeStatus(patch.status) : existing.status,
        priority: Object.hasOwn(patch, "priority")
          ? normalizePriority(patch.priority)
          : existing.priority,
        assigneeId: nextAssigneeId,
        assigneeRole: nextAssigneeRole,
        workState: Object.hasOwn(patch, "workState")
          ? normalizeWorkState(patch.workState)
          : existing.workState,
        workStartedAt: Object.hasOwn(patch, "workStartedAt")
          ? typeof patch.workStartedAt === "number"
            ? patch.workStartedAt
            : null
          : existing.workStartedAt,
        workError: Object.hasOwn(patch, "workError")
          ? typeof patch.workError === "string"
            ? patch.workError
            : null
          : existing.workError,
        workResult: Object.hasOwn(patch, "workResult")
          ? typeof patch.workResult === "string"
            ? patch.workResult
            : null
          : existing.workResult,
        updatedAt: Date.now(),
      };
      const next = [...current];
      next[index] = updated;
      await writeWorkspaceKanbanTickets(workspace, next);
      respond(true, { workspace, ticket: updated }, undefined);
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, err instanceof Error ? err.message : String(err)),
      );
    }
  },
  "workspace.kanban.move": async ({ params, respond }) => {
    const ticketId = typeof params.ticketId === "string" ? params.ticketId.trim() : "";
    if (!ticketId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "missing ticketId"));
      return;
    }
    try {
      const registry = await loadWorkspaceRegistry();
      const workspace = registry.workspaceDir;
      const current = await readWorkspaceKanbanTickets(workspace);
      const index = current.findIndex((ticket) => ticket.id === ticketId);
      if (index < 0) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `ticket "${ticketId}" not found`),
        );
        return;
      }
      const updated: WorkspaceTicket = {
        ...current[index],
        status: normalizeStatus(params.status),
        updatedAt: Date.now(),
      };
      const next = [...current];
      next[index] = updated;
      await writeWorkspaceKanbanTickets(workspace, next);
      respond(true, { workspace, ticket: updated }, undefined);
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, err instanceof Error ? err.message : String(err)),
      );
    }
  },
  "workspace.kanban.delete": async ({ params, respond }) => {
    const ticketId = typeof params.ticketId === "string" ? params.ticketId.trim() : "";
    if (!ticketId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "missing ticketId"));
      return;
    }
    try {
      const registry = await loadWorkspaceRegistry();
      const workspace = registry.workspaceDir;
      const current = await readWorkspaceKanbanTickets(workspace);
      const next = current.filter((ticket) => ticket.id !== ticketId);
      if (next.length === current.length) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `ticket "${ticketId}" not found`),
        );
        return;
      }
      await writeWorkspaceKanbanTickets(workspace, next);
      respond(true, { workspace, ticketId, ok: true }, undefined);
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, err instanceof Error ? err.message : String(err)),
      );
    }
  },
};
