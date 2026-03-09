import type { OpenClawConfig } from "../../config/config.js";
import { isSubagentSessionKey } from "../../routing/session-key.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { listAgentIds } from "../agent-scope.js";
import {
  listSpawnedSessionKeys,
  resolveInternalSessionKey,
  resolveMainSessionAlias,
} from "./sessions-resolution.js";
import {
  buildAgentMention,
  buildAgentSessionKey,
  deriveHierarchyPeerAgentIds,
  discoverTeammatesForAgent,
  normalizeAgentMention,
  TEAMMATE_AGENT_TO_AGENT_ALLOW,
} from "./teammate-discovery.js";

export type SessionToolsVisibility = "self" | "tree" | "agent" | "all";

export type AgentToAgentPolicy = {
  enabled: boolean;
  usesTeammatesAllow: boolean;
  matchesAllow: (agentId: string) => boolean;
  isAllowed: (requesterAgentId: string, targetAgentId: string) => boolean;
};

export type SessionAccessAction = "history" | "send" | "list";

export type SessionAccessResult =
  | { allowed: true }
  | { allowed: false; error: string; status: "forbidden" };

export function resolveSessionToolsVisibility(cfg: OpenClawConfig): SessionToolsVisibility {
  const raw = (cfg.tools as { sessions?: { visibility?: unknown } } | undefined)?.sessions
    ?.visibility;
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (value === "self" || value === "tree" || value === "agent" || value === "all") {
    return value;
  }
  return "tree";
}

export function resolveEffectiveSessionToolsVisibility(params: {
  cfg: OpenClawConfig;
  sandboxed: boolean;
}): SessionToolsVisibility {
  const visibility = resolveSessionToolsVisibility(params.cfg);
  if (!params.sandboxed) {
    return visibility;
  }
  const sandboxClamp = params.cfg.agents?.defaults?.sandbox?.sessionToolsVisibility ?? "spawned";
  if (sandboxClamp === "spawned" && visibility !== "tree") {
    return "tree";
  }
  return visibility;
}

export function resolveSandboxSessionToolsVisibility(cfg: OpenClawConfig): "spawned" | "all" {
  return cfg.agents?.defaults?.sandbox?.sessionToolsVisibility ?? "spawned";
}

export function resolveSandboxedSessionToolContext(params: {
  cfg: OpenClawConfig;
  agentSessionKey?: string;
  sandboxed?: boolean;
}): {
  mainKey: string;
  alias: string;
  visibility: "spawned" | "all";
  requesterInternalKey: string | undefined;
  effectiveRequesterKey: string;
  restrictToSpawned: boolean;
} {
  const { mainKey, alias } = resolveMainSessionAlias(params.cfg);
  const visibility = resolveSandboxSessionToolsVisibility(params.cfg);
  const requesterInternalKey =
    typeof params.agentSessionKey === "string" && params.agentSessionKey.trim()
      ? resolveInternalSessionKey({
          key: params.agentSessionKey,
          alias,
          mainKey,
        })
      : undefined;
  const effectiveRequesterKey = requesterInternalKey ?? alias;
  const restrictToSpawned =
    params.sandboxed === true &&
    visibility === "spawned" &&
    !!requesterInternalKey &&
    !isSubagentSessionKey(requesterInternalKey);
  return {
    mainKey,
    alias,
    visibility,
    requesterInternalKey,
    effectiveRequesterKey,
    restrictToSpawned,
  };
}

export function createAgentToAgentPolicy(cfg: OpenClawConfig): AgentToAgentPolicy {
  const routingA2A = cfg.tools?.agentToAgent;
  const enabled = routingA2A?.enabled === true;
  const allowPatterns = Array.isArray(routingA2A?.allow) ? routingA2A.allow : [];
  const usesTeammatesAllow = allowPatterns.some(
    (pattern) =>
      String(pattern ?? "")
        .trim()
        .toLowerCase() === TEAMMATE_AGENT_TO_AGENT_ALLOW,
  );
  const staticPatterns = allowPatterns.filter(
    (pattern) =>
      String(pattern ?? "")
        .trim()
        .toLowerCase() !== TEAMMATE_AGENT_TO_AGENT_ALLOW,
  );
  const matchesAllow = (agentId: string) => {
    if (staticPatterns.length === 0) {
      return allowPatterns.length === 0;
    }
    return staticPatterns.some((pattern) => {
      const raw = String(pattern ?? "").trim();
      if (!raw) {
        return false;
      }
      if (raw === "*") {
        return true;
      }
      if (!raw.includes("*")) {
        return raw === agentId;
      }
      const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`^${escaped.replaceAll("\\*", ".*")}$`, "i");
      return re.test(agentId);
    });
  };
  const isAllowed = (requesterAgentId: string, targetAgentId: string) => {
    if (requesterAgentId === targetAgentId) {
      return true;
    }
    if (!enabled) {
      return false;
    }
    return matchesAllow(requesterAgentId) && matchesAllow(targetAgentId);
  };
  return { enabled, usesTeammatesAllow, matchesAllow, isAllowed };
}

export async function resolveTeammateAllowTargetIds(params: {
  cfg: OpenClawConfig;
  requesterAgentId: string;
  workspaceDir?: string;
  policy?: AgentToAgentPolicy;
}): Promise<Set<string>> {
  const policy = params.policy ?? createAgentToAgentPolicy(params.cfg);
  if (!policy.enabled || !policy.usesTeammatesAllow || !params.workspaceDir?.trim()) {
    return new Set<string>();
  }
  try {
    const discovery = await discoverTeammatesForAgent({
      config: params.cfg,
      requesterAgentId: params.requesterAgentId,
      workspaceDir: params.workspaceDir,
    });
    return deriveHierarchyPeerAgentIds(discovery);
  } catch {
    return new Set<string>();
  }
}

export async function resolveAllowedAgentMentionTarget(params: {
  cfg: OpenClawConfig;
  requesterSessionKey: string;
  mention: string;
  workspaceDir?: string;
  action?: SessionAccessAction;
  policy?: AgentToAgentPolicy;
}): Promise<
  | { ok: true; agentId: string; mention: string; sessionKey: string }
  | { ok: false; status: "forbidden" | "error"; error: string }
> {
  const normalizedMention = normalizeAgentMention(params.mention);
  if (!normalizedMention) {
    return {
      ok: false,
      status: "error",
      error: `Invalid teammate mention: ${params.mention}`,
    };
  }

  const requesterAgentId = resolveAgentIdFromSessionKey(params.requesterSessionKey);
  const policy = params.policy ?? createAgentToAgentPolicy(params.cfg);
  const teammateAllowTargetIds = await resolveTeammateAllowTargetIds({
    cfg: params.cfg,
    requesterAgentId,
    workspaceDir: params.workspaceDir,
    policy,
  });

  let matchedAgentId: string | null = null;
  let matchedAllowedAgentId: string | null = null;
  for (const candidateId of listAgentIds(params.cfg)) {
    if (candidateId === requesterAgentId) {
      continue;
    }
    if (buildAgentMention(candidateId) !== normalizedMention) {
      continue;
    }
    matchedAgentId = candidateId;
    if (
      policy.isAllowed(requesterAgentId, candidateId) ||
      teammateAllowTargetIds.has(candidateId)
    ) {
      matchedAllowedAgentId = candidateId;
      break;
    }
  }

  if (!matchedAgentId) {
    return {
      ok: false,
      status: "error",
      error: `No agent found for mention: ${normalizedMention}`,
    };
  }

  if (!matchedAllowedAgentId) {
    return {
      ok: false,
      status: "forbidden",
      error: a2aDeniedMessage(params.action ?? "send"),
    };
  }

  return {
    ok: true,
    agentId: matchedAllowedAgentId,
    mention: buildAgentMention(matchedAllowedAgentId),
    sessionKey: buildAgentSessionKey(matchedAllowedAgentId),
  };
}

function actionPrefix(action: SessionAccessAction): string {
  if (action === "history") {
    return "Session history";
  }
  if (action === "send") {
    return "Session send";
  }
  return "Session list";
}

function a2aDisabledMessage(action: SessionAccessAction): string {
  if (action === "history") {
    return "Agent-to-agent history is disabled. Set tools.agentToAgent.enabled=true to allow cross-agent access.";
  }
  if (action === "send") {
    return "Agent-to-agent messaging is disabled. Set tools.agentToAgent.enabled=true to allow cross-agent sends.";
  }
  return "Agent-to-agent listing is disabled. Set tools.agentToAgent.enabled=true to allow cross-agent visibility.";
}

function a2aDeniedMessage(action: SessionAccessAction): string {
  if (action === "history") {
    return "Agent-to-agent history denied by tools.agentToAgent.allow.";
  }
  if (action === "send") {
    return "Agent-to-agent messaging denied by tools.agentToAgent.allow.";
  }
  return "Agent-to-agent listing denied by tools.agentToAgent.allow.";
}

function crossVisibilityMessage(action: SessionAccessAction): string {
  if (action === "history") {
    return "Session history visibility is restricted. Set tools.sessions.visibility=all to allow cross-agent access.";
  }
  if (action === "send") {
    return "Session send visibility is restricted. Set tools.sessions.visibility=all to allow cross-agent access.";
  }
  return "Session list visibility is restricted. Set tools.sessions.visibility=all to allow cross-agent access.";
}

function selfVisibilityMessage(action: SessionAccessAction): string {
  return `${actionPrefix(action)} visibility is restricted to the current session (tools.sessions.visibility=self).`;
}

function treeVisibilityMessage(action: SessionAccessAction): string {
  return `${actionPrefix(action)} visibility is restricted to the current session tree (tools.sessions.visibility=tree).`;
}

export async function createSessionVisibilityGuard(params: {
  action: SessionAccessAction;
  requesterSessionKey: string;
  visibility: SessionToolsVisibility;
  a2aPolicy: AgentToAgentPolicy;
  cfg?: OpenClawConfig;
  workspaceDir?: string;
}): Promise<{
  check: (targetSessionKey: string) => SessionAccessResult;
}> {
  const requesterAgentId = resolveAgentIdFromSessionKey(params.requesterSessionKey);
  const teammateAllowTargetIds = await resolveTeammateAllowTargetIds({
    cfg: params.cfg ?? ({} as OpenClawConfig),
    requesterAgentId,
    workspaceDir: params.workspaceDir,
    policy: params.a2aPolicy,
  });
  const spawnedKeys =
    params.visibility === "tree"
      ? await listSpawnedSessionKeys({ requesterSessionKey: params.requesterSessionKey })
      : null;

  const check = (targetSessionKey: string): SessionAccessResult => {
    const targetAgentId = resolveAgentIdFromSessionKey(targetSessionKey);
    const isCrossAgent = targetAgentId !== requesterAgentId;
    if (isCrossAgent) {
      if (params.visibility !== "all") {
        return {
          allowed: false,
          status: "forbidden",
          error: crossVisibilityMessage(params.action),
        };
      }
      if (!params.a2aPolicy.enabled) {
        return {
          allowed: false,
          status: "forbidden",
          error: a2aDisabledMessage(params.action),
        };
      }
      if (
        !params.a2aPolicy.isAllowed(requesterAgentId, targetAgentId) &&
        !teammateAllowTargetIds.has(targetAgentId)
      ) {
        return {
          allowed: false,
          status: "forbidden",
          error: a2aDeniedMessage(params.action),
        };
      }
      return { allowed: true };
    }

    if (params.visibility === "self" && targetSessionKey !== params.requesterSessionKey) {
      return {
        allowed: false,
        status: "forbidden",
        error: selfVisibilityMessage(params.action),
      };
    }

    if (
      params.visibility === "tree" &&
      targetSessionKey !== params.requesterSessionKey &&
      !spawnedKeys?.has(targetSessionKey)
    ) {
      return {
        allowed: false,
        status: "forbidden",
        error: treeVisibilityMessage(params.action),
      };
    }

    return { allowed: true };
  };

  return { check };
}
