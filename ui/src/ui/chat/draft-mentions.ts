import type { WorkspaceAgentRow } from "../types.ts";

export type DraftMentionMatch = {
  query: string;
  start: number;
  end: number;
};

export type MentionSuggestion = {
  id: string;
  mention: string;
  name: string;
  title?: string | null;
  emoji?: string | null;
  color?: string | null;
};

function parseSessionAgentId(sessionKey: string): string | null {
  const match = /^agent:([^:]+):/.exec(sessionKey.trim());
  return match?.[1] ?? null;
}

export function findDraftMentionAtSelection(
  text: string,
  selectionStart: number,
  selectionEnd = selectionStart,
): DraftMentionMatch | null {
  if (selectionStart !== selectionEnd) {
    return null;
  }
  const safeStart = Math.max(0, Math.min(selectionStart, text.length));
  const beforeCaret = text.slice(0, safeStart);
  const atIndex = beforeCaret.lastIndexOf("@");
  if (atIndex < 0) {
    return null;
  }
  const previous = atIndex === 0 ? "" : (text[atIndex - 1] ?? "");
  if (/[a-z0-9_@]/i.test(previous)) {
    return null;
  }
  const afterCaret = text.slice(safeStart);
  const suffix = /^[a-z0-9_]*/i.exec(afterCaret)?.[0] ?? "";
  const token = text.slice(atIndex, safeStart + suffix.length);
  if (!/^@[a-z0-9_]*$/i.test(token)) {
    return null;
  }
  return {
    query: token.slice(1).toLowerCase(),
    start: atIndex,
    end: atIndex + token.length,
  };
}

export function applyDraftMentionSuggestion(
  text: string,
  range: Pick<DraftMentionMatch, "start" | "end">,
  mention: string,
): { text: string; caret: number } {
  const before = text.slice(0, range.start);
  const after = text.slice(range.end);
  const needsSpaceAfter = after.length === 0 ? true : !/^[\s.,!?;:)\]}]/.test(after);
  const inserted = `${mention}${needsSpaceAfter ? " " : ""}`;
  return {
    text: `${before}${inserted}${after}`,
    caret: before.length + inserted.length,
  };
}

function resolveAllowedMentionIds(
  currentAgent: WorkspaceAgentRow | null,
  agents: WorkspaceAgentRow[],
): Set<string> {
  if (!currentAgent) {
    return new Set(agents.map((agent) => agent.id));
  }
  const allowed = new Set<string>();
  const directReports = currentAgent.directReports ?? [];
  if (directReports.length > 0) {
    for (const id of directReports) {
      allowed.add(id);
    }
    if (currentAgent.reportsTo) {
      allowed.add(currentAgent.reportsTo);
    }
    return allowed;
  }
  if (currentAgent.reportsTo) {
    allowed.add(currentAgent.reportsTo);
    for (const agent of agents) {
      if (agent.id !== currentAgent.id && agent.reportsTo === currentAgent.reportsTo) {
        allowed.add(agent.id);
      }
    }
  }
  return allowed;
}

export function buildMentionSuggestions(params: {
  sessionKey: string;
  query: string | null | undefined;
  agents: WorkspaceAgentRow[];
}): MentionSuggestion[] {
  const query = (params.query ?? "").trim().toLowerCase();
  const currentAgentId = parseSessionAgentId(params.sessionKey);
  const currentAgent = params.agents.find((agent) => agent.id === currentAgentId) ?? null;
  const allowedIds = resolveAllowedMentionIds(currentAgent, params.agents);
  return params.agents
    .filter((agent) => agent.id !== currentAgentId)
    .filter((agent) => allowedIds.size === 0 || allowedIds.has(agent.id))
    .filter((agent) => {
      if (!query) {
        return true;
      }
      const haystack = `${agent.id} ${agent.name ?? ""} ${agent.title ?? ""}`.toLowerCase();
      return haystack.includes(query);
    })
    .toSorted((left, right) => {
      const leftStarts = left.id.startsWith(query) ? 0 : 1;
      const rightStarts = right.id.startsWith(query) ? 0 : 1;
      if (leftStarts !== rightStarts) {
        return leftStarts - rightStarts;
      }
      return (left.name ?? left.id).localeCompare(right.name ?? right.id);
    })
    .slice(0, 8)
    .map((agent) => ({
      id: agent.id,
      mention: `@${agent.id}`,
      name: agent.name ?? agent.id,
      title: agent.title ?? agent.description ?? null,
      emoji: agent.emoji ?? null,
      color: agent.color ?? null,
    }));
}
