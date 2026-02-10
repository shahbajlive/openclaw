import Handlebars from "handlebars";
import fs from "node:fs";
import path from "node:path";
import type { Team, Teammate } from "./types.js";

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

/**
 * Build the system prompt injected into the Team Lead's session.
 * This gives the lead awareness of the team, its mode, and available tools.
 */
export function buildTeamLeadSystemPrompt(params: {
  team: Team;
  teammatesList: Array<{ role: string; status: string; currentTask?: string }>;
  sessionType?: string;
  sessionId?: string;
}): string {
  const template = loadTemplate("team-lead.md");

  return template({
    teamId: params.team.teamId,
    teamName: params.team.teamName,
    description: params.team.description,
    persistent: params.team.persistent,
    teammates: params.teammatesList,
    sessionType: params.sessionType || "unknown",
    sessionId: params.sessionId || "unknown",
  });
}

/**
 * Build the system prompt injected into a Teammate's session.
 * This gives the teammate awareness of its role, the team, and available tools.
 */
export function buildTeammateSystemPrompt(params: {
  team: Team;
  teammate: Teammate;
  otherTeammates: Array<{ role: string; teammateId: string }>;
  sessionType?: string;
  sessionId?: string;
}): string {
  const template = loadTemplate("teammate.md");

  return template({
    teamId: params.team.teamId,
    teamName: params.team.teamName,
    description: params.team.description,
    teammateId: params.teammate.teammateId,
    role: params.teammate.role,
    leadSessionKey: params.team.leadSessionKey,
    otherTeammates: params.otherTeammates,
    requirePlanApproval: params.teammate.requirePlanApproval,
    planApproved: params.teammate.planApproved,
    sessionType: params.sessionType || "unknown",
    sessionId: params.sessionId || "unknown",
  });
}
