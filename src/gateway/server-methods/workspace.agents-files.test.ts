import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayRequestHandlerOptions } from "./types.js";

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  listAgentsForGateway: vi.fn(),
  resolveAgentWorkspaceDir: vi.fn(),
}));

vi.mock("../../config/config.js", () => ({
  loadConfig: mocks.loadConfig,
}));

vi.mock("../session-utils.js", () => ({
  listAgentsForGateway: mocks.listAgentsForGateway,
}));

vi.mock("../../agents/agent-scope.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/agent-scope.js")>();
  return {
    ...actual,
    resolveAgentWorkspaceDir: mocks.resolveAgentWorkspaceDir,
  };
});

import { workspaceHandlers } from "./workspace.js";

type HandlerResult = {
  ok: boolean;
  payload?: unknown;
  error?: { message?: string };
};

async function invokeWorkspaceHandler(
  method: keyof typeof workspaceHandlers,
  params: Record<string, unknown> = {},
): Promise<HandlerResult> {
  let result: HandlerResult | null = null;
  const opts = {
    req: { method, params } as GatewayRequestHandlerOptions["req"],
    params,
    client: null,
    isWebchatConnect: () => false,
    respond: (ok: boolean, payload?: unknown, error?: { message?: string }) => {
      result = { ok, payload, error };
    },
    context: {} as GatewayRequestHandlerOptions["context"],
  } satisfies GatewayRequestHandlerOptions;
  await workspaceHandlers[method](opts);
  if (!result) {
    throw new Error("handler did not respond");
  }
  return result;
}

describe("workspace agent/file gateway handlers", () => {
  let tmpDir = "";
  let workspaceById: Record<string, string> = {};

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-agents-"));
    workspaceById = {
      main: path.join(tmpDir, "main"),
      "developer-lead": path.join(tmpDir, "developer-lead"),
    };
    await Promise.all(
      Object.values(workspaceById).map((dir) => fs.mkdir(dir, { recursive: true })),
    );
    mocks.resolveAgentWorkspaceDir.mockImplementation(
      (_cfg, agentId: string) => workspaceById[agentId],
    );
    mocks.loadConfig.mockReturnValue({
      agents: {
        list: [
          {
            id: "main",
            default: true,
            workspace: workspaceById.main,
          },
          {
            id: "developer-lead",
            workspace: workspaceById["developer-lead"],
            reportsTo: "main",
          },
        ],
      },
    });
    mocks.listAgentsForGateway.mockReturnValue({
      defaultId: "main",
      agents: [
        {
          id: "main",
          name: "Main",
          reportsTo: null,
          directReports: ["developer-lead"],
          identity: {},
        },
        {
          id: "developer-lead",
          name: "Developer Lead",
          reportsTo: "main",
          directReports: [],
          identity: {},
        },
      ],
    });
  });

  afterEach(async () => {
    vi.clearAllMocks();
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("uses each agent workspace root for metadata and bootstrap file access", async () => {
    await fs.writeFile(
      path.join(workspaceById["developer-lead"], "SOUL.md"),
      `# Developer Lead -- Delivery Lead

## Identity

Coordinates delivery planning and specialist handoffs.
`,
      "utf8",
    );
    await fs.writeFile(
      path.join(workspaceById["developer-lead"], "IDENTITY.md"),
      "# Identity",
      "utf8",
    );
    await fs.mkdir(path.join(workspaceById["developer-lead"], "agents", "nested"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(workspaceById["developer-lead"], "agents", "nested", "SOUL.md"),
      "# Nested",
      "utf8",
    );

    const listedAgents = await invokeWorkspaceHandler("workspace.agents.list");
    expect(listedAgents.ok).toBe(true);
    const agentsPayload = listedAgents.payload as {
      workspaceDir: string;
      agents: Array<{
        id: string;
        workspaceDir?: string;
        title?: string | null;
        description?: string | null;
      }>;
    };
    expect(agentsPayload.workspaceDir).toBe(workspaceById.main);
    expect(agentsPayload).not.toHaveProperty("registryPath");
    expect(agentsPayload.agents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "developer-lead",
          workspaceDir: workspaceById["developer-lead"],
          title: "Delivery Lead",
          description: "Coordinates delivery planning and specialist handoffs.",
        }),
      ]),
    );

    const listedFiles = await invokeWorkspaceHandler("workspace.files.list", {
      agentId: "developer-lead",
    });
    expect(listedFiles.ok).toBe(true);
    const filesPayload = listedFiles.payload as {
      workspace: string;
      files: Array<{ relativePath: string }>;
    };
    expect(filesPayload.workspace).toBe(workspaceById["developer-lead"]);
    expect(filesPayload.files.map((file) => file.relativePath)).toEqual(
      expect.arrayContaining(["SOUL.md", "IDENTITY.md"]),
    );
    expect(filesPayload.files.some((file) => file.relativePath.includes("agents/"))).toBe(false);

    const fetchedFile = await invokeWorkspaceHandler("workspace.files.get", {
      agentId: "developer-lead",
      relativePath: "SOUL.md",
    });
    expect(fetchedFile.ok).toBe(true);
    expect((fetchedFile.payload as { file: { content?: string } }).file.content).toContain(
      "Developer Lead",
    );
  });
});
