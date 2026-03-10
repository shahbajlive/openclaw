import fs from "node:fs/promises";
import path from "node:path";
import { listCoreToolSections } from "../../agents/tool-catalog.js";
import {
  expandToolGroups,
  normalizeToolList,
  resolveToolProfilePolicy,
} from "../../agents/tool-policy-shared.js";
import type { OpenClawConfig } from "../../config/config.js";
import { listAgentsForGateway } from "../../gateway/session-utils.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { resolveAgentConfig, resolveAgentWorkspaceDir } from "../agent-scope.js";
import { DEFAULT_SOUL_FILENAME } from "../workspace.js";

export const TEAMMATE_AGENT_TO_AGENT_ALLOW = "@teammates";
const VALID_AGENT_ALIAS_RE = /^@?[a-z0-9_]{1,64}$/i;
const CORE_TOOL_IDS = listCoreToolSections()
  .flatMap((section) => section.tools.map((tool) => tool.id))
  .toSorted((a, b) => a.localeCompare(b));

type TeammateAgent = {
  id: string;
  name: string;
  title?: string;
  reportsTo?: string | null;
  directReports?: string[];
  tools: string[];
  workspaceDir: string;
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
  error?: "requester_not_found" | "parent_not_found";
  missingParentId?: string;
};

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
  const token =
    normalizeAgentAlias(alias) ??
    normalizeAgentAlias(agentId) ??
    normalizeAgentId(agentId).replaceAll("-", "_");
  return `@${token}`;
}

export function normalizeAgentMention(value: string | undefined | null): string | null {
  const normalized = normalizeAgentAlias(value);
  return normalized ? `@${normalized}` : null;
}

function resolveMentionAlias(
  config: OpenClawConfig | undefined,
  agentId: string,
): string | undefined {
  return normalizeAgentAlias(resolveAgentConfig(config ?? {}, agentId)?.alias) ?? undefined;
}

function resolveConfiguredAgentTools(cfg: OpenClawConfig, agentId: string): string[] {
  const toolConfig = (resolveAgentConfig(cfg, agentId)?.tools ?? {}) as {
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

function buildTeammateAgents(cfg: OpenClawConfig): TeammateAgent[] {
  const gatewayAgents = listAgentsForGateway(cfg);
  return gatewayAgents.agents.map((entry) => {
    return {
      id: entry.id,
      name: entry.name?.trim() || entry.identity?.name?.trim() || entry.id,
      title: entry.identity?.theme?.trim() || undefined,
      reportsTo: entry.reportsTo ?? null,
      directReports: normalizeDirectReports(entry.directReports),
      tools: resolveConfiguredAgentTools(cfg, entry.id),
      workspaceDir: resolveAgentWorkspaceDir(cfg, entry.id),
    };
  });
}

function hasMessageAccess(agent: TeammateAgent | null | undefined): boolean {
  return agent?.tools.includes("message") ?? false;
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
  agent: TeammateAgent,
  soulCache: Map<string, string | null>,
): Promise<string | undefined> {
  const soulPath = path.join(agent.workspaceDir, DEFAULT_SOUL_FILENAME);
  if (!soulCache.has(soulPath)) {
    try {
      const raw = await fs.readFile(soulPath, "utf8");
      soulCache.set(soulPath, extractSoulBrief(raw) ?? null);
    } catch {
      soulCache.set(soulPath, null);
    }
  }
  return soulCache.get(soulPath) ?? agent.title;
}

export async function discoverTeammatesForAgent(params: {
  config?: OpenClawConfig;
  requesterAgentId: string;
  workspaceDir?: string;
}): Promise<DiscoverTeammatesData> {
  const requesterAgentId = normalizeAgentId(params.requesterAgentId);
  const cfg = params.config ?? {};
  const agents = buildTeammateAgents(cfg);
  const byId = new Map<string, TeammateAgent>(agents.map((agent) => [agent.id, agent]));
  const requester = byId.get(requesterAgentId);
  const requesterSummary: RelatedAgentSummary = {
    id: requesterAgentId,
    name: requester?.name ?? requesterAgentId,
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
      error: "parent_not_found",
      missingParentId: parentId,
    };
  }

  const missingChildIds: string[] = [];
  const teammates: TeammateEntry[] = [];
  const soulCache = new Map<string, string | null>();
  const parentBrief = await resolveAgentBrief(parent, soulCache);
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
    const brief = await resolveAgentBrief(target, soulCache);
    teammates.push({
      id: target.id,
      name: target.name,
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
    name: parent.name,
    mention: buildAgentMention(parent.id, resolveMentionAlias(params.config, parent.id)),
    brief: parentBrief,
  };

  return {
    requester: {
      id: requester.id,
      name: requester.name,
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
