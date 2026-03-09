import {
  createAgentToAgentPolicy,
  resolveAllowedAgentMentionTarget,
  type AgentToAgentPolicy,
  type SessionAccessAction,
} from "../../agents/tools/sessions-access.js";
import type { OpenClawConfig } from "../../config/config.js";

export type AgentMentionToken = {
  mention: string;
  start: number;
  end: number;
};

const AGENT_MENTION_TOKEN_RE = /(^|[^a-z0-9_])(@[a-z0-9_]+)(?=$|[^a-z0-9_])/gi;

export function extractAgentMentionTokens(text: string): AgentMentionToken[] {
  const tokens: AgentMentionToken[] = [];
  for (const match of text.matchAll(AGENT_MENTION_TOKEN_RE)) {
    const mention = match[2]?.trim() ?? "";
    if (!mention) {
      continue;
    }
    const fullMatch = match[0] ?? "";
    const prefixLength = fullMatch.length - mention.length;
    const start = (match.index ?? 0) + prefixLength;
    const end = start + mention.length;
    tokens.push({ mention, start, end });
  }
  return tokens;
}

function normalizeRemovedMentionBody(text: string): string {
  return text
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+([,.;:!?])/g, "$1")
    .replace(/([([{])\s+/g, "$1")
    .replace(/\s+([)\]}])/g, "$1")
    .trim();
}

export function removeAgentMentionToken(text: string, token: AgentMentionToken): string {
  const before = text.slice(0, token.start);
  const after = text.slice(token.end);
  return normalizeRemovedMentionBody(`${before}${after}`);
}

export async function resolveMentionRouteInText(params: {
  text: string;
  cfg: OpenClawConfig;
  requesterSessionKey: string;
  workspaceDir?: string;
  action?: SessionAccessAction;
  policy?: AgentToAgentPolicy;
}): Promise<
  | {
      ok: true;
      mention: string;
      body: string;
      bodyWithoutMention: string;
      agentId: string;
      sessionKey: string;
      token: AgentMentionToken;
    }
  | { ok: false; status: "forbidden" | "error"; error: string }
  | null
> {
  const tokens = extractAgentMentionTokens(params.text);
  if (tokens.length === 0) {
    return null;
  }

  const policy = params.policy ?? createAgentToAgentPolicy(params.cfg);
  let forbiddenError: string | null = null;
  let resolved: {
    mention: string;
    body: string;
    bodyWithoutMention: string;
    agentId: string;
    sessionKey: string;
    token: AgentMentionToken;
  } | null = null;

  for (const token of tokens) {
    const target = await resolveAllowedAgentMentionTarget({
      cfg: params.cfg,
      requesterSessionKey: params.requesterSessionKey,
      mention: token.mention,
      workspaceDir: params.workspaceDir,
      action: params.action,
      policy,
    });
    if (!target.ok) {
      if (target.status === "forbidden" && !forbiddenError) {
        forbiddenError = target.error;
      }
      continue;
    }
    if (resolved) {
      return {
        ok: false,
        status: "error",
        error: "Only one teammate mention can be used per message.",
      };
    }
    resolved = {
      mention: target.mention,
      body: params.text.trim(),
      bodyWithoutMention: removeAgentMentionToken(params.text, token),
      agentId: target.agentId,
      sessionKey: target.sessionKey,
      token,
    };
  }

  if (resolved) {
    return { ok: true, ...resolved };
  }
  if (forbiddenError) {
    return { ok: false, status: "forbidden", error: forbiddenError };
  }
  return null;
}
