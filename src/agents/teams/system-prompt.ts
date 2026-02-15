import Handlebars from "handlebars";
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
const PROMPT_PARTIALS_DIR = path.join(PROMPTS_DIR, "partials");

// Cache compiled templates
const templateCache = new Map<string, HandlebarsTemplateDelegate>();
let partialsRegistered = false;

function registerPromptPartials(): void {
  if (partialsRegistered) return;
  partialsRegistered = true;

  if (!fs.existsSync(PROMPT_PARTIALS_DIR)) return;

  for (const entry of fs.readdirSync(PROMPT_PARTIALS_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const partialName = path.basename(entry.name, ".md");
    const content = fs.readFileSync(path.join(PROMPT_PARTIALS_DIR, entry.name), "utf-8");
    Handlebars.registerPartial(partialName, content);
  }
}

function loadTemplate(filename: string): HandlebarsTemplateDelegate {
  if (templateCache.has(filename)) return templateCache.get(filename)!;

  registerPromptPartials();

  const content = fs.readFileSync(path.join(PROMPTS_DIR, filename), "utf-8");
  const template = Handlebars.compile(content);
  templateCache.set(filename, template);
  return template;
}

function readOptionalStringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = (value as Record<string, unknown>)[key];
  if (typeof raw !== "string") return undefined;
  const text = raw.trim();
  return text || undefined;
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

  return template({
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

  return template({
    teamId: params.team.teamId,
    teamName: params.team.teamName,
    description,
    role,
    teamSize,
    sessionType: params.sessionType || "unknown",
    sessionId: params.sessionId || "unknown",
  });
}
