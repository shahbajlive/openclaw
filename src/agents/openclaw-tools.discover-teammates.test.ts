import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

type RegistryEntry = {
  id: string;
  name?: string;
  title?: string;
  description?: string;
  soulPath?: string;
  reportsTo?: string | null;
  directReports?: string[];
  tools?: string[];
};

const tempDirs: string[] = [];

async function createWorkspace(
  entries: RegistryEntry[],
  extraFiles: Record<string, string> = {},
): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-teammates-"));
  tempDirs.push(dir);
  await fs.mkdir(path.join(dir, "clawport"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "clawport", "agents.json"),
    JSON.stringify(entries, null, 2),
    "utf8",
  );
  for (const [relativePath, content] of Object.entries(extraFiles)) {
    const fullPath = path.join(dir, relativePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, "utf8");
  }
  return dir;
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
  it("returns parent and sibling specialists for a specialist agent", async () => {
    const workspaceDir = await createWorkspace([
      {
        id: "main",
        name: "Main",
        directReports: ["developer-lead"],
        tools: ["message"],
      },
      {
        id: "developer-lead",
        name: "Developer Lead",
        description: "Entry point into the development team.",
        reportsTo: "main",
        directReports: ["backend_engineer", "frontend_engineer", "security_engineer"],
        tools: ["message"],
      },
      {
        id: "backend_engineer",
        name: "Backend Engineer",
        reportsTo: "developer-lead",
        tools: ["read", "write", "exec"],
      },
      {
        id: "frontend_engineer",
        name: "Frontend Engineer",
        reportsTo: "developer-lead",
        tools: ["read", "write", "exec"],
      },
      {
        id: "security_engineer",
        name: "Security Engineer",
        reportsTo: "developer-lead",
        tools: ["read", "write", "exec", "message"],
      },
    ]);
    configOverride = {
      session: createPerSenderSessionConfig(),
      agents: {
        list: [{ id: "frontend_engineer", alias: "ui_review" }],
      },
    };

    const result = await requireTool(workspaceDir, "agent:backend_engineer:clawport").execute(
      "call1",
      {},
    );

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
    expect(
      (details.siblings as Array<{ mention?: string }>).every((entry) => Boolean(entry.mention)),
    ).toBe(true);
    expect((details.siblings as Array<{ id: string }>).map((entry) => entry.id)).toEqual([
      "frontend_engineer",
      "security_engineer",
    ]);
    expect(
      (details.siblings as Array<{ id: string; mention: string }>).find(
        (entry) => entry.id === "frontend_engineer",
      )?.mention,
    ).toBe("@ui_review");
    expect(details.commands).toEqual([]);
    expect(readText(result)).toContain("Whom to report:");
    expect(readText(result)).toContain(
      "- Developer Lead (developer-lead) - Entry point into the development team. [mention: @developer_lead]",
    );
    expect(readText(result)).toContain("Siblings:");
    expect(readText(result)).not.toContain("Who are on my command:");
    expect(readText(result)).toContain(
      "Direct messaging is not available from this session by tool access.",
    );
  });

  it("returns only self when the parent has no other children", async () => {
    const workspaceDir = await createWorkspace([
      {
        id: "main",
        name: "Main",
        directReports: ["developer-lead"],
      },
      {
        id: "developer-lead",
        name: "Developer Lead",
        reportsTo: "main",
        directReports: ["backend_engineer"],
      },
      {
        id: "backend_engineer",
        name: "Backend Engineer",
        reportsTo: "developer-lead",
      },
    ]);

    const result = await requireTool(workspaceDir, "agent:backend_engineer:clawport").execute(
      "call2",
      {},
    );

    const details = readDetails(result);
    expect(details.reportsTo).toMatchObject({
      id: "developer-lead",
      name: "Developer Lead",
    });
    expect(details.commands).toEqual([]);
    expect(details.teammates).toEqual([]);
    expect(details.siblings).toEqual([]);
    expect(readText(result)).toContain("Whom to report:");
    expect(readText(result)).not.toContain("Siblings:");
    expect(readText(result)).not.toContain("Who are on my command:");
  });

  it("lets a non-leaf agent discover its parent and direct reports", async () => {
    const workspaceDir = await createWorkspace([
      {
        id: "main",
        name: "Main",
        directReports: ["developer-lead"],
        tools: ["message"],
      },
      {
        id: "developer-lead",
        name: "Developer Lead",
        reportsTo: "main",
        directReports: ["backend_engineer"],
        tools: ["message"],
      },
      {
        id: "backend_engineer",
        name: "Backend Engineer",
        reportsTo: "developer-lead",
      },
    ]);

    const result = await requireTool(workspaceDir, "agent:developer-lead:clawport").execute(
      "call3",
      {},
    );

    const details = readDetails(result);
    expect(details).toMatchObject({
      reportsTo: { id: "main", name: "Main" },
      canDirectMessage: true,
    });
    expect(details.teammates as Array<{ id: string; relation: string }>).toEqual([
      {
        id: "backend_engineer",
        name: "Backend Engineer",
        mention: "@backend_engineer",
        relation: "direct_report",
        title: undefined,
      },
    ]);
    expect(details.siblings).toEqual([]);
    expect((details.commands as Array<{ id: string }>).map((entry) => entry.id)).toEqual([
      "backend_engineer",
    ]);
    expect(readText(result)).toContain("Whom to report:");
    expect(readText(result)).toContain("Who are on my command:");
    expect(readText(result)).not.toContain("Siblings:");
  });

  it("reports that root agents have no parent discovery scope", async () => {
    const workspaceDir = await createWorkspace([
      {
        id: "main",
        name: "Main",
        directReports: ["developer-lead"],
        tools: ["message"],
      },
      {
        id: "developer-lead",
        name: "Developer Lead",
        reportsTo: "main",
      },
    ]);

    const result = await requireTool(workspaceDir, "agent:main:clawport").execute("call4", {});

    expect(readDetails(result)).toMatchObject({
      reportsTo: null,
      commands: [],
      canDirectMessage: true,
    });
    expect(readDetails(result).siblings).toEqual([]);
    expect(readText(result)).toContain(
      "No parent is configured, so parent-and-siblings discovery is unavailable.",
    );
  });

  it("degrades safely when the configured parent is missing", async () => {
    const workspaceDir = await createWorkspace([
      {
        id: "backend_engineer",
        name: "Backend Engineer",
        reportsTo: "developer-lead",
      },
    ]);

    const result = await requireTool(workspaceDir, "agent:backend_engineer:clawport").execute(
      "call5",
      {},
    );

    expect(readDetails(result)).toMatchObject({
      error: "parent_not_found",
      missingParentId: "developer-lead",
      reportsTo: null,
      commands: [],
      siblings: [],
    });
    expect(readText(result)).toContain("Configured parent developer-lead was not found");
  });

  it("ignores invalid directReports entries without crashing", async () => {
    const workspaceDir = await createWorkspace([
      {
        id: "main",
        name: "Main",
        directReports: ["developer-lead"],
      },
      {
        id: "developer-lead",
        name: "Developer Lead",
        reportsTo: "main",
        directReports: ["backend_engineer", "missing-agent", "frontend_engineer"],
      },
      {
        id: "backend_engineer",
        name: "Backend Engineer",
        reportsTo: "developer-lead",
      },
      {
        id: "frontend_engineer",
        name: "Frontend Engineer",
        reportsTo: "developer-lead",
      },
    ]);

    const result = await requireTool(workspaceDir, "agent:backend_engineer:clawport").execute(
      "call6",
      {},
    );

    expect(readDetails(result)).toMatchObject({
      missingChildIds: ["missing-agent"],
    });
    expect(readText(result)).toContain("Ignored missing directReports entries: missing-agent.");
  });

  it("reports direct messaging availability from the requester's tool access", async () => {
    const workspaceDir = await createWorkspace([
      {
        id: "main",
        name: "Main",
        directReports: ["developer-lead"],
      },
      {
        id: "developer-lead",
        name: "Developer Lead",
        reportsTo: "main",
        directReports: ["backend_engineer", "security_engineer"],
      },
      {
        id: "backend_engineer",
        name: "Backend Engineer",
        reportsTo: "developer-lead",
        tools: ["exec"],
      },
      {
        id: "security_engineer",
        name: "Security Engineer",
        reportsTo: "developer-lead",
        tools: ["message"],
      },
    ]);

    const backendResult = await requireTool(
      workspaceDir,
      "agent:backend_engineer:clawport",
    ).execute("call7", {});
    const securityResult = await requireTool(
      workspaceDir,
      "agent:security_engineer:clawport",
    ).execute("call8", {});

    expect(readDetails(backendResult)).toMatchObject({ canDirectMessage: false });
    expect(readDetails(securityResult)).toMatchObject({ canDirectMessage: true });
  });

  it("uses SOUL content as a fallback brief for discovered teammates", async () => {
    const workspaceDir = await createWorkspace(
      [
        {
          id: "main",
          name: "Main",
          directReports: ["developer-lead"],
        },
        {
          id: "developer-lead",
          name: "Developer Lead",
          reportsTo: "main",
          directReports: ["backend_engineer"],
        },
        {
          id: "backend_engineer",
          name: "Backend Engineer",
          reportsTo: "developer-lead",
          soulPath: "agents/developer-lead/backend-engineer/SOUL.md",
        },
      ],
      {
        "agents/developer-lead/backend-engineer/SOUL.md": `# Backend Engineer

Owns backend implementation, contracts, and server-side reliability.

- Avoids speculative changes
`,
      },
    );

    const result = await requireTool(workspaceDir, "agent:developer-lead:clawport").execute(
      "call9",
      {},
    );

    expect(readText(result)).toContain(
      "- Backend Engineer (backend_engineer) - Owns backend implementation, contracts, and server-side reliability.",
    );
    expect((readDetails(result).teammates as Array<{ brief?: string }>)[0]?.brief).toBe(
      "Owns backend implementation, contracts, and server-side reliability.",
    );
  });

  it("prefers the agent workspace from config over the generic runtime workspace", async () => {
    const runtimeWorkspaceDir = await createWorkspace([]);
    const agentWorkspaceDir = await createWorkspace([
      {
        id: "main",
        name: "Main",
        directReports: ["developer-lead"],
      },
      {
        id: "developer-lead",
        name: "Developer Lead",
        reportsTo: "main",
        directReports: ["backend_engineer"],
      },
      {
        id: "backend_engineer",
        name: "Backend Engineer",
        reportsTo: "developer-lead",
      },
    ]);

    configOverride = {
      session: createPerSenderSessionConfig(),
      agents: {
        defaults: {
          workspace: agentWorkspaceDir,
        },
        list: [
          {
            id: "main",
            workspace: agentWorkspaceDir,
          },
        ],
      },
    };

    const result = await requireTool(runtimeWorkspaceDir, "agent:main:clawport").execute(
      "call10",
      {},
    );

    expect(readDetails(result)).toMatchObject({
      requester: { id: "main", name: "Main" },
      registryPath: path.join(agentWorkspaceDir, "clawport", "agents.json"),
    });
  });

  it("falls back to the default OpenClaw workspace before using the runtime cwd", async () => {
    const runtimeWorkspaceDir = await createWorkspace([]);
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-home-"));
    tempDirs.push(tempHome);
    const defaultWorkspaceDir = path.join(tempHome, ".openclaw", "workspace");
    await fs.mkdir(path.join(defaultWorkspaceDir, "clawport"), { recursive: true });
    await fs.writeFile(
      path.join(defaultWorkspaceDir, "clawport", "agents.json"),
      JSON.stringify(
        [
          {
            id: "main",
            name: "Main",
            directReports: ["developer-lead"],
          },
          {
            id: "developer-lead",
            name: "Developer Lead",
            reportsTo: "main",
            directReports: ["backend_engineer"],
          },
          {
            id: "backend_engineer",
            name: "Backend Engineer",
            reportsTo: "developer-lead",
          },
        ],
        null,
        2,
      ),
      "utf8",
    );

    const originalHome = process.env.HOME;
    process.env.HOME = tempHome;
    try {
      const result = await requireTool(
        runtimeWorkspaceDir,
        "agent:developer-lead:clawport",
      ).execute("call11", {});

      expect(readDetails(result)).toMatchObject({
        requester: { id: "developer-lead", name: "Developer Lead" },
        registryPath: path.join(defaultWorkspaceDir, "clawport", "agents.json"),
      });
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
    }
  });
});
