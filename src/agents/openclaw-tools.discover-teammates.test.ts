import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { createPerSenderSessionConfig } from "./test-helpers/session-config.js";

let configOverride: ReturnType<(typeof import("../config/config.js"))["loadConfig"]> = {
  session: createPerSenderSessionConfig(),
};

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => configOverride,
    resolveGatewayPort: () => 18789,
  };
});

import "./test-helpers/fast-core-tools.js";
import { createOpenClawTools } from "./openclaw-tools.js";

type AgentFixture = {
  id: string;
  workspace: string;
  name?: string;
  alias?: string;
  default?: boolean;
  reportsTo?: string | null;
  directReports?: string[];
  toolsAllow?: string[];
};

const tempDirs: string[] = [];

async function createWorkspace(extraFiles: Record<string, string> = {}): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-teammates-"));
  tempDirs.push(dir);
  for (const [relativePath, content] of Object.entries(extraFiles)) {
    const fullPath = path.join(dir, relativePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, "utf8");
  }
  return dir;
}

function applyAgentConfig(agents: AgentFixture[]) {
  configOverride = {
    session: createPerSenderSessionConfig(),
    agents: {
      list: agents.map((agent) => ({
        id: agent.id,
        default: agent.default,
        name: agent.name,
        alias: agent.alias,
        workspace: agent.workspace,
        reportsTo: agent.reportsTo === undefined ? undefined : agent.reportsTo,
        directReports: agent.directReports,
        tools: { allow: agent.toolsAllow ?? ["read"] },
      })),
    },
  } as OpenClawConfig;
}

function requireTool(workspaceDir: string, agentSessionKey: string) {
  const tool = createOpenClawTools({
    workspaceDir,
    agentSessionKey,
  }).find((candidate) => candidate.name === "discover_teammates");
  if (!tool) {
    throw new Error("missing discover_teammates tool");
  }
  return tool;
}

function readText(result: unknown): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
  return content?.find((entry) => entry.type === "text")?.text ?? "";
}

function readDetails(result: unknown) {
  return (result as { details?: Record<string, unknown> }).details ?? {};
}

beforeEach(() => {
  configOverride = {
    session: createPerSenderSessionConfig(),
  };
});

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("discover_teammates", () => {
  it("derives hierarchy from agents.list and reads briefs from workspace-root SOUL.md", async () => {
    const runtimeWorkspaceDir = await createWorkspace();
    const mainWorkspace = await createWorkspace();
    const leadWorkspace = await createWorkspace({
      "SOUL.md": `# Developer Lead

Entry point into the development team.
`,
    });
    const backendWorkspace = await createWorkspace();
    const frontendWorkspace = await createWorkspace({
      "SOUL.md": `# Frontend Engineer

Owns UI implementation and review quality.
`,
    });
    const securityWorkspace = await createWorkspace();

    applyAgentConfig([
      {
        id: "main",
        default: true,
        name: "Main",
        workspace: mainWorkspace,
        directReports: ["developer-lead"],
        toolsAllow: ["message"],
      },
      {
        id: "developer-lead",
        name: "Developer Lead",
        workspace: leadWorkspace,
        reportsTo: "main",
        directReports: ["backend_engineer", "frontend_engineer", "security_engineer"],
        toolsAllow: ["message"],
      },
      {
        id: "backend_engineer",
        name: "Backend Engineer",
        workspace: backendWorkspace,
        reportsTo: "developer-lead",
        toolsAllow: ["read", "write", "exec"],
      },
      {
        id: "frontend_engineer",
        name: "Frontend Engineer",
        alias: "ui_review",
        workspace: frontendWorkspace,
        reportsTo: "developer-lead",
        toolsAllow: ["read", "write", "exec"],
      },
      {
        id: "security_engineer",
        name: "Security Engineer",
        workspace: securityWorkspace,
        reportsTo: "developer-lead",
        toolsAllow: ["read", "write", "exec", "message"],
      },
    ]);

    const result = await requireTool(
      runtimeWorkspaceDir,
      "agent:backend_engineer:clawport",
    ).execute("call-leaf", {});

    const details = readDetails(result);
    expect(details).toMatchObject({
      reportsTo: {
        id: "developer-lead",
        name: "Developer Lead",
        mention: "@developer_lead",
        brief: "Entry point into the development team.",
      },
      canDirectMessage: false,
    });
    expect((details.siblings as Array<{ id: string }>).map((entry) => entry.id)).toEqual([
      "frontend_engineer",
      "security_engineer",
    ]);
    expect(
      (details.siblings as Array<{ id: string; mention: string }>).find(
        (entry) => entry.id === "frontend_engineer",
      )?.mention,
    ).toBe("@ui_review");
    expect(
      (details.siblings as Array<{ id: string; brief?: string }>).find(
        (entry) => entry.id === "frontend_engineer",
      )?.brief,
    ).toBe("Owns UI implementation and review quality.");
    expect(readText(result)).toContain("Whom to report:");
    expect(readText(result)).toContain("Siblings:");
  });

  it("shows direct reports for non-leaf agents", async () => {
    const runtimeWorkspaceDir = await createWorkspace();
    const mainWorkspace = await createWorkspace();
    const leadWorkspace = await createWorkspace();
    const backendWorkspace = await createWorkspace();

    applyAgentConfig([
      {
        id: "main",
        default: true,
        name: "Main",
        workspace: mainWorkspace,
        directReports: ["developer-lead"],
        toolsAllow: ["message"],
      },
      {
        id: "developer-lead",
        name: "Developer Lead",
        workspace: leadWorkspace,
        reportsTo: "main",
        directReports: ["backend_engineer"],
        toolsAllow: ["message"],
      },
      {
        id: "backend_engineer",
        name: "Backend Engineer",
        workspace: backendWorkspace,
        reportsTo: "developer-lead",
      },
    ]);

    const result = await requireTool(runtimeWorkspaceDir, "agent:developer-lead:clawport").execute(
      "call-manager",
      {},
    );

    expect(readDetails(result)).toMatchObject({
      reportsTo: { id: "main", name: "Main" },
      commands: [
        { id: "backend_engineer", name: "Backend Engineer", mention: "@backend_engineer" },
      ],
    });
    expect(readText(result)).toContain("Who are on my command:");
  });
});
