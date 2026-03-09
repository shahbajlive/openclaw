import { describe, expect, it, vi } from "vitest";
import type { WorkspaceTicket } from "../workspace-kanban.ts";
import {
  createWorkspaceKanbanTicket,
  deleteWorkspaceKanbanTicket,
  loadWorkspaceKanban,
  moveWorkspaceKanbanTicket,
  updateWorkspaceKanbanTicket,
  type WorkspaceState,
} from "./workspace.ts";

function createState(): WorkspaceState & { requestMock: ReturnType<typeof vi.fn> } {
  const requestMock = vi.fn();
  return {
    requestMock,
    client: {
      request: requestMock,
    } as unknown as WorkspaceState["client"],
    connected: true,
    workspaceAgentsLoading: false,
    workspaceAgentsError: null,
    workspaceAgentsList: null,
    workspaceSelectedAgentId: null,
    workspaceConversationSummaries: {},
    workspaceMessagesSeenAt: {},
    workspaceUnreadTotal: 0,
    sessionsResult: null,
    sessionKey: "main",
    chatMessages: [],
    workspaceFilesLoading: false,
    workspaceFilesError: null,
    workspaceFilesList: null,
    workspaceFileActive: null,
    workspaceFileContents: {},
    workspaceKanbanLoading: false,
    workspaceKanbanError: null,
    workspaceKanbanTickets: [],
  } as WorkspaceState & { requestMock: typeof requestMock };
}

function makeTicket(id: string): WorkspaceTicket {
  return {
    id,
    title: `Ticket ${id}`,
    description: "desc",
    status: "backlog",
    priority: "medium",
    assigneeId: "main",
    assigneeRole: "lead-dev",
    workState: "idle",
    workStartedAt: null,
    workError: null,
    workResult: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

describe("workspace kanban controller", () => {
  it("loads tickets from gateway", async () => {
    const state = createState();
    const request = state.requestMock;
    request.mockResolvedValueOnce({
      workspace: "/tmp/ws",
      tickets: [makeTicket("a")],
    } as never);

    await loadWorkspaceKanban(state);

    expect(request).toHaveBeenCalledWith("workspace.kanban.list", {});
    expect(state.workspaceKanbanTickets).toHaveLength(1);
    expect(state.workspaceKanbanTickets[0]?.id).toBe("a");
  });

  it("creates ticket and clears role when no assignee", async () => {
    const state = createState();
    const request = state.requestMock;
    request.mockResolvedValueOnce({
      workspace: "/tmp/ws",
      ticket: makeTicket("a"),
    } as never);

    await createWorkspaceKanbanTicket(state, {
      title: "New",
      description: "desc",
      priority: "high",
      assigneeId: null,
      assigneeRole: "qa",
    });

    expect(request).toHaveBeenCalledWith("workspace.kanban.create", {
      title: "New",
      description: "desc",
      priority: "high",
      assigneeId: null,
      assigneeRole: null,
    });
    expect(state.workspaceKanbanTickets[0]?.id).toBe("a");
  });

  it("clears role when assignee is unset in update", async () => {
    const state = createState();
    state.workspaceKanbanTickets = [makeTicket("a")];
    const request = state.requestMock;
    request.mockResolvedValueOnce({
      workspace: "/tmp/ws",
      ticket: {
        ...makeTicket("a"),
        assigneeId: null,
        assigneeRole: null,
      },
    } as never);

    await updateWorkspaceKanbanTicket(state, "a", {
      assigneeId: null,
      assigneeRole: "qa",
    });

    expect(request).toHaveBeenCalledWith("workspace.kanban.update", {
      ticketId: "a",
      patch: { assigneeId: null, assigneeRole: null },
    });
    expect(state.workspaceKanbanTickets[0]?.assigneeRole).toBeNull();
  });

  it("moves and deletes tickets", async () => {
    const state = createState();
    state.workspaceKanbanTickets = [makeTicket("a")];
    const request = state.requestMock;
    request
      .mockResolvedValueOnce({
        workspace: "/tmp/ws",
        ticket: { ...makeTicket("a"), status: "review" },
      } as never)
      .mockResolvedValueOnce({
        workspace: "/tmp/ws",
        ticketId: "a",
        ok: true,
      } as never);

    await moveWorkspaceKanbanTicket(state, "a", "review");
    expect(state.workspaceKanbanTickets[0]?.status).toBe("review");

    await deleteWorkspaceKanbanTicket(state, "a");
    expect(state.workspaceKanbanTickets).toHaveLength(0);
  });
});
