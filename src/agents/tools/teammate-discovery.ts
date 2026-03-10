import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../../config/config.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { resolveAgentConfig, resolveAgentWorkspaceDir } from "../agent-scope.js";
import { resolveDefaultAgentWorkspaceDir } from "../workspace.js";

export const TEAMMATE_AGENT_TO_AGENT_ALLOW = "@teammates";
const VALID_AGENT_ALIAS_RE = /^@?[a-z0-9_]{1,64}$/i;

type RegistryAgent = {
  id: string;
  name?: string;
  title?: string;
  description?: string;
  soulPath?: string;
  reportsTo?: string | null;
  directReports?: string[];
  tools?: string[];
};

export type TeammateEntry = {
  id: string;
  name: string;
  mention: string;
  title?: string;
  brief?: string;
  relation: "sibling" | "direct_report";
};

export type RelatedAgentSummary = {
  id: string;
  name: string;
  mention: string;
  brief?: string;
};

export type DiscoverTeammatesData = {
  requester: RelatedAgentSummary;
  reportsTo: RelatedAgentSummary | null;
  parent: RelatedAgentSummary | null;
  commands: RelatedAgentSummary[];
  teammates: TeammateEntry[];
  siblings: RelatedAgentSummary[];
  directReports: RelatedAgentSummary[];
  canDirectMessage: boolean;
  missingChildIds: string[];
  registryPath: string;
  error?: "requester_not_found" | "parent_not_found";
  missingParentId?: string;
};

function normalizeOptionalAgentId(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return normalizeAgentId(trimmed);
}

function normalizeDirectReports(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      continue;
    }
    const trimmed = entry.trim();
    if (!trimmed) {
      continue;
    }
    const normalized = normalizeAgentId(trimmed);
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    ids.push(normalized);
  }
  return ids;
}

function normalizeTools(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const tools: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      continue;
    }
    const trimmed = entry.trim();
    if (trimmed) {
      tools.push(trimmed);
    }
  }
  return tools;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeRegistryEntry(value: unknown): RegistryAgent | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const id = normalizeOptionalAgentId(raw.id);
  if (!id) {
    return null;
  }
  return {
    id,
    name: normalizeOptionalString(raw.name),
    title: normalizeOptionalString(raw.title),
    description: normalizeOptionalString(raw.description),
    soulPath: normalizeOptionalString(raw.soulPath),
    reportsTo: normalizeOptionalAgentId(raw.reportsTo),
    directReports: normalizeDirectReports(raw.directReports),
    tools: normalizeTools(raw.tools),
  };
}

export function buildAgentSessionKey(agentId: string): string {
  return `agent:${normalizeAgentId(agentId)}:clawport`;
}

export function normalizeAgentAlias(value: string | undefined | null): string | null {
  const trimmed = (value ?? "").trim();
  if (!trimmed || !VALID_AGENT_ALIAS_RE.test(trimmed)) {
    return null;
  }
  return trimmed.replace(/^@/, "").toLowerCase();
}

export function buildAgentMention(agentId: string, alias?: string | null): string {
  const token = normalizeAgentAlias(alias) ?? normalizeAgentId(agentId).replaceAll("-", "_");
  return `@${token}`;
}

export function normalizeAgentMention(value: string | undefined | null): string | null {
  const normalized = normalizeAgentAlias(value);
  return normalized ? `@${normalized}` : null;
}

export function displayName(agent: Pick<RegistryAgent, "id" | "name" | "title">): string {
  const name = typeof agent.name === "string" ? agent.name.trim() : "";
  if (name) {
    return name;
  }
  const title = typeof agent.title === "string" ? agent.title.trim() : "";
  if (title) {
    return title;
  }
  return agent.id;
}

function resolveMentionAlias(
  config: OpenClawConfig | undefined,
  agentId: string,
): string | undefined {
  return normalizeAgentAlias(resolveAgentConfig(config ?? {}, agentId)?.alias) ?? undefined;
}

async function loadRegistry(workspaceDir: string): Promise<{
  registryPath: string;
  agents: RegistryAgent[];
}> {
  const registryPath = path.join(workspaceDir, "clawport", "agents.json");
  const raw = await fs.readFile(registryPath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  const source = Array.isArray(parsed)
    ? parsed
    : parsed &&
        typeof parsed === "object" &&
        Array.isArray((parsed as { agents?: unknown[] }).agents)
      ? (parsed as { agents: unknown[] }).agents
      : [];
  const agents = source
    .map((entry) => normalizeRegistryEntry(entry))
    .filter(Boolean) as RegistryAgent[];
  return { registryPath, agents };
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function resolveRegistryWorkspaceDir(params: {
  config?: OpenClawConfig;
  requesterAgentId: string;
  workspaceDir: string;
}): Promise<string> {
  if (params.config) {
    const agentWorkspaceDir = resolveAgentWorkspaceDir(params.config, params.requesterAgentId);
    const agentRegistryPath = path.join(agentWorkspaceDir, "clawport", "agents.json");
    if (await pathExists(agentRegistryPath)) {
      return agentWorkspaceDir;
    }
  }
  const defaultWorkspaceDir = resolveDefaultAgentWorkspaceDir(process.env);
  const defaultRegistryPath = path.join(defaultWorkspaceDir, "clawport", "agents.json");
  if (await pathExists(defaultRegistryPath)) {
    return defaultWorkspaceDir;
  }
  return params.workspaceDir;
}

function hasMessageAccess(agent: RegistryAgent | null | undefined): boolean {
  return (agent?.tools ?? []).some((tool) => tool.trim().toLowerCase() === "message");
}

function extractSoulBrief(raw: string): string | undefined {
  const lines = raw.split(/\r?\n/);
  const paragraphs: string[] = [];
  let current: string[] = [];
  let inCodeBlock = false;

  const flush = () => {
    const text = current.join(" ").replace(/\s+/g, " ").trim();
    if (text) {
      paragraphs.push(text);
    }
    current = [];
  };

  for (const lineRaw of lines) {
    const line = lineRaw.trim();
    if (line.startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) {
      continue;
    }
    if (!line) {
      flush();
      continue;
    }
    if (
      line.startsWith("#") ||
      line.startsWith("- ") ||
      line.startsWith("* ") ||
      line.startsWith(">") ||
      /^\d+\.\s/.test(line)
    ) {
      flush();
      continue;
    }
    current.push(line);
  }
  flush();

  const paragraph = paragraphs.find(Boolean);
  if (!paragraph) {
    return undefined;
  }
  return paragraph.length > 220 ? `${paragraph.slice(0, 217).trimEnd()}...` : paragraph;
}

async function resolveAgentBrief(
  agent: RegistryAgent,
  workspaceDir: string,
  soulCache: Map<string, string | null>,
): Promise<string | undefined> {
  if (agent.description) {
    return agent.description;
  }
  if (agent.soulPath) {
    if (!soulCache.has(agent.soulPath)) {
      const fullPath = path.join(workspaceDir, agent.soulPath);
      try {
        const raw = await fs.readFile(fullPath, "utf8");
        soulCache.set(agent.soulPath, extractSoulBrief(raw) ?? null);
      } catch {
        soulCache.set(agent.soulPath, null);
      }
    }
    const soulBrief = soulCache.get(agent.soulPath);
    if (soulBrief) {
      return soulBrief;
    }
  }
  return agent.title;
}

export async function discoverTeammatesForAgent(params: {
  config?: OpenClawConfig;
  requesterAgentId: string;
  workspaceDir: string;
}): Promise<DiscoverTeammatesData> {
  const requesterAgentId = normalizeAgentId(params.requesterAgentId);
  const registryWorkspaceDir = await resolveRegistryWorkspaceDir({
    config: params.config,
    requesterAgentId,
    workspaceDir: params.workspaceDir,
  });
  const { registryPath, agents } = await loadRegistry(registryWorkspaceDir);
  const byId = new Map<string, RegistryAgent>(agents.map((agent) => [agent.id, agent]));
  const requester = byId.get(requesterAgentId);
  const requesterSummary: RelatedAgentSummary = {
    id: requesterAgentId,
    name: requester ? displayName(requester) : requesterAgentId,
    mention: buildAgentMention(
      requesterAgentId,
      resolveMentionAlias(params.config, requesterAgentId),
    ),
  };
  if (!requester) {
    return {
      requester: requesterSummary,
      reportsTo: null,
      parent: null,
      commands: [],
      teammates: [],
      siblings: [],
      directReports: [],
      canDirectMessage: false,
      missingChildIds: [],
      registryPath,
      error: "requester_not_found",
    };
  }

  const canDirectMessage = hasMessageAccess(requester);
  const parentId = requester.reportsTo ?? null;
  if (!parentId) {
    return {
      requester: requesterSummary,
      reportsTo: null,
      parent: null,
      commands: [],
      teammates: [],
      siblings: [],
      directReports: [],
      canDirectMessage,
      missingChildIds: [],
      registryPath,
    };
  }

  const parent = byId.get(parentId) ?? null;
  if (!parent) {
    return {
      requester: requesterSummary,
      reportsTo: null,
      parent: null,
      commands: [],
      teammates: [],
      siblings: [],
      directReports: [],
      canDirectMessage,
      missingChildIds: [],
      registryPath,
      error: "parent_not_found",
      missingParentId: parentId,
    };
  }

  const missingChildIds: string[] = [];
  const teammates: TeammateEntry[] = [];
  const soulCache = new Map<string, string | null>();
  const parentBrief = await resolveAgentBrief(parent, registryWorkspaceDir, soulCache);
  const requesterHasReports = (requester.directReports?.length ?? 0) > 0;
  const targetIds = requesterHasReports
    ? (requester.directReports ?? [])
    : (parent.directReports ?? []).filter((childId) => childId !== requester.id);

  for (const targetId of targetIds) {
    const target = byId.get(targetId);
    if (!target) {
      missingChildIds.push(targetId);
      continue;
    }
    const brief = await resolveAgentBrief(target, registryWorkspaceDir, soulCache);
    teammates.push({
      id: target.id,
      name: displayName(target),
      mention: buildAgentMention(target.id, resolveMentionAlias(params.config, target.id)),
      title: target.title,
      brief,
      relation: requesterHasReports ? "direct_report" : "sibling",
    });
  }

  const siblings = teammates
    .filter((entry) => entry.relation === "sibling")
    .map((entry) => ({
      id: entry.id,
      name: entry.name,
      mention: entry.mention,
      brief: entry.brief,
    }));
  const directReports = teammates
    .filter((entry) => entry.relation === "direct_report")
    .map((entry) => ({
      id: entry.id,
      name: entry.name,
      mention: entry.mention,
      brief: entry.brief,
    }));
  const reportsTo: RelatedAgentSummary = {
    id: parent.id,
    name: displayName(parent),
    mention: buildAgentMention(parent.id, resolveMentionAlias(params.config, parent.id)),
    brief: parentBrief,
  };

  return {
    requester: {
      id: requester.id,
      name: displayName(requester),
      mention: buildAgentMention(requester.id, resolveMentionAlias(params.config, requester.id)),
    },
    reportsTo,
    parent: reportsTo,
    commands: directReports,
    teammates,
    siblings,
    directReports,
    canDirectMessage,
    missingChildIds,
    registryPath,
  };
}

export function deriveHierarchyPeerAgentIds(discovery: DiscoverTeammatesData): Set<string> {
  const ids = new Set<string>();
  if (discovery.reportsTo?.id) {
    ids.add(discovery.reportsTo.id);
  }
  for (const teammate of discovery.teammates) {
    ids.add(teammate.id);
  }
  ids.delete(discovery.requester.id);
  return ids;
}
