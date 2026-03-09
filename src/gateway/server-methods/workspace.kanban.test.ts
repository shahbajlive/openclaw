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

function setupWorkspaceMocks(workspaceDir: string) {
  mocks.loadConfig.mockReturnValue({ agents: { list: [] } });
  mocks.listAgentsForGateway.mockReturnValue({
    defaultId: "main",
    agents: [
      {
        id: "main",
        reportsTo: null,
        directReports: [],
        name: "Main",
        identity: {},
      },
    ],
  });
  mocks.resolveAgentWorkspaceDir.mockReturnValue(workspaceDir);
}

describe("workspace kanban gateway handlers", () => {
  let tmpDir = "";

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-kanban-"));
    setupWorkspaceMocks(tmpDir);
  });

  afterEach(async () => {
    vi.clearAllMocks();
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("creates, lists, updates, moves, and deletes tickets", async () => {
    const created = await invokeWorkspaceHandler("workspace.kanban.create", {
      title: "Implement Kanban",
      description: "Port task model",
      priority: "high",
      assigneeId: "main",
      assigneeRole: "lead-dev",
    });
    expect(created.ok).toBe(true);
    const createdTicket = (created.payload as { ticket: { id: string } }).ticket;

    const listedAfterCreate = await invokeWorkspaceHandler("workspace.kanban.list");
    expect(listedAfterCreate.ok).toBe(true);
    const ticketsAfterCreate = (listedAfterCreate.payload as { tickets: Array<{ id: string }> })
      .tickets;
    expect(ticketsAfterCreate).toHaveLength(1);
    expect(ticketsAfterCreate[0]?.id).toBe(createdTicket.id);

    const updated = await invokeWorkspaceHandler("workspace.kanban.update", {
      ticketId: createdTicket.id,
      patch: {
        status: "todo",
        workState: "failed",
        workError: "needs retry",
        assigneeId: null,
        assigneeRole: "qa",
      },
    });
    expect(updated.ok).toBe(true);
    const updatedTicket = (
      updated.payload as {
        ticket: {
          assigneeId: string | null;
          assigneeRole: string | null;
          status: string;
          workState: string;
        };
      }
    ).ticket;
    expect(updatedTicket.status).toBe("todo");
    expect(updatedTicket.workState).toBe("failed");
    expect(updatedTicket.assigneeId).toBeNull();
    expect(updatedTicket.assigneeRole).toBeNull();

    const moved = await invokeWorkspaceHandler("workspace.kanban.move", {
      ticketId: createdTicket.id,
      status: "review",
    });
    expect(moved.ok).toBe(true);
    expect((moved.payload as { ticket: { status: string } }).ticket.status).toBe("review");

    const deleted = await invokeWorkspaceHandler("workspace.kanban.delete", {
      ticketId: createdTicket.id,
    });
    expect(deleted.ok).toBe(true);
    expect((deleted.payload as { ok: boolean }).ok).toBe(true);

    const listedAfterDelete = await invokeWorkspaceHandler("workspace.kanban.list");
    expect((listedAfterDelete.payload as { tickets: unknown[] }).tickets).toHaveLength(0);
  });

  it("normalizes invalid create/update enum values", async () => {
    const created = await invokeWorkspaceHandler("workspace.kanban.create", {
      title: "Normalize values",
      priority: "urgent",
    });
    expect(created.ok).toBe(true);
    const ticketId = (created.payload as { ticket: { id: string; priority: string } }).ticket.id;
    expect((created.payload as { ticket: { priority: string } }).ticket.priority).toBe("medium");

    const updated = await invokeWorkspaceHandler("workspace.kanban.update", {
      ticketId,
      patch: {
        status: "ship-it",
        workState: "booting",
        priority: "critical",
      },
    });
    expect(updated.ok).toBe(true);
    const ticket = (
      updated.payload as { ticket: { status: string; workState: string; priority: string } }
    ).ticket;
    expect(ticket.status).toBe("backlog");
    expect(ticket.workState).toBe("idle");
    expect(ticket.priority).toBe("medium");
  });

  it("returns not found for missing ticket operations", async () => {
    const missingUpdate = await invokeWorkspaceHandler("workspace.kanban.update", {
      ticketId: "missing",
      patch: { status: "todo" },
    });
    expect(missingUpdate.ok).toBe(false);
    expect(missingUpdate.error?.message).toContain("not found");

    const missingMove = await invokeWorkspaceHandler("workspace.kanban.move", {
      ticketId: "missing",
      status: "done",
    });
    expect(missingMove.ok).toBe(false);
    expect(missingMove.error?.message).toContain("not found");

    const missingDelete = await invokeWorkspaceHandler("workspace.kanban.delete", {
      ticketId: "missing",
    });
    expect(missingDelete.ok).toBe(false);
    expect(missingDelete.error?.message).toContain("not found");
  });
});
