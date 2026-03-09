import fs from "node:fs";
import path from "node:path";

type PromptTeam = {
  teamId: string;
  teamName: string;
  teamAgentId: string;
  description?: string;
};

type PromptTeammate = {
  teammateId: string;
  role?: string;
};

const PROMPTS_DIR = path.join(import.meta.dirname, "prompts");

// Cache loaded templates.
const templateCache = new Map<string, string>();

function loadTemplate(filename: string): string {
  const cached = templateCache.get(filename);
  if (cached) return cached;
  const content = fs.readFileSync(path.join(PROMPTS_DIR, filename), "utf-8");
  templateCache.set(filename, content);
  return content;
}

function readOptionalStringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = (value as Record<string, unknown>)[key];
  if (typeof raw !== "string") return undefined;
  const text = raw.trim();
  return text || undefined;
}

function renderPromptTemplate(template: string, vars: Record<string, string | number | undefined>) {
  // Handle simple Handlebars-style if blocks used by team.md.
  const withIfBlocks = template.replace(
    /{{#if\s+([a-zA-Z0-9_]+)}}([\s\S]*?){{\/if}}/g,
    (_match, key: string, body: string) => {
      const value = vars[key];
      return value === undefined || value === null || value === "" ? "" : body;
    },
  );
  // Handle simple value interpolation.
  return withIfBlocks.replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_match, key: string) => {
    const value = vars[key];
    return value === undefined || value === null ? "" : String(value);
  });
}

/**
 * Build a unified team system prompt.
 * Lead/teammate sessions share the same prompt contract.
 */
export function buildTeamLeadSystemPrompt(params: {
  team: PromptTeam;
  teammatesList: Array<{ role: string; status: string; currentTask?: string }>;
  sessionType?: string;
  sessionId?: string;
}): string {
  const template = loadTemplate("team.md");
  const description = readOptionalStringField(params.team, "description");
  const teamSize = params.teammatesList.length;

  return renderPromptTemplate(template, {
    teamId: params.team.teamId,
    teamName: params.team.teamName,
    teamSize,
    description,
    sessionType: params.sessionType || "unknown",
    sessionId: params.sessionId || "unknown",
  });
}

/**
 * Build the unified team system prompt for a teammate session.
 */
export function buildTeammateSystemPrompt(params: {
  team: PromptTeam;
  teammate: PromptTeammate;
  otherTeammates: Array<{ role: string; teammateId: string }>;
  sessionType?: string;
  sessionId?: string;
}): string {
  const template = loadTemplate("team.md");
  const description = readOptionalStringField(params.team, "description");
  const role = readOptionalStringField(params.teammate, "role") ?? params.teammate.teammateId;
  const teamSize = params.otherTeammates.length + 1;

  return renderPromptTemplate(template, {
    teamId: params.team.teamId,
    teamName: params.team.teamName,
    description,
    role,
    teamSize,
    sessionType: params.sessionType || "unknown",
    sessionId: params.sessionId || "unknown",
  });
}
