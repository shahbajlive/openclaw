import { extractText } from "../chat/message-extract.ts";
import type { GatewayBrowserClient } from "../gateway.ts";
import type { UiSettings } from "../storage.ts";
import type {
  WorkspaceAgentsListResult,
  WorkspaceConversationSummary,
  WorkspaceFilesGetResult,
  WorkspaceFilesListResult,
  WorkspaceKanbanCreateResult,
  WorkspaceKanbanDeleteResult,
  WorkspaceKanbanListResult,
  WorkspaceKanbanUpdateResult,
  SessionsListResult,
} from "../types.ts";
import type {
  WorkspaceTicket,
  WorkspaceTicketPriority,
  WorkspaceTicketRole,
  WorkspaceTicketStatus,
  WorkspaceTicketWorkState,
} from "../workspace-kanban.ts";

export type WorkspaceState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  settings?: UiSettings;
  applySettings?: (next: UiSettings) => void;
  workspaceAgentsLoading: boolean;
  workspaceAgentsError: string | null;
  workspaceAgentsList: WorkspaceAgentsListResult | null;
  workspaceSelectedAgentId: string | null;
  workspaceConversationSummaries: Record<string, WorkspaceConversationSummary>;
  workspaceMessagesSeenAt: Record<string, number>;
  workspaceUnreadTotal: number;
  sessionsResult: SessionsListResult | null;
  sessionKey: string;
  chatMessages: unknown[];
  workspaceFilesLoading: boolean;
  workspaceFilesError: string | null;
  workspaceFilesList: WorkspaceFilesListResult | null;
  workspaceFileActive: string | null;
  workspaceFileContents: Record<string, string>;
  workspaceKanbanLoading: boolean;
  workspaceKanbanError: string | null;
  workspaceKanbanTickets: WorkspaceTicket[];
};

const ACTIVE_SESSION_WINDOW_MS = 15 * 60 * 1000;

function messageTimestamp(message: unknown): number {
  const entry = message as Record<string, unknown>;
  return typeof entry.timestamp === "number" ? entry.timestamp : 0;
}

function messageRole(message: unknown): string {
  const entry = message as Record<string, unknown>;
  return typeof entry.role === "string" ? entry.role.toLowerCase() : "";
}

function buildPreview(message: unknown, fallback: string): string {
  const role = messageRole(message);
  const text = extractText(message)?.replace(/\s+/g, " ").trim() ?? "";
  if (!text) {
    if (role.includes("tool")) {
      return "Tool output";
    }
    return fallback;
  }
  return text.length > 56 ? `${text.slice(0, 56)}...` : text;
}

function isAgentOnline(state: WorkspaceState, agentId: string): boolean {
  const sessionKey = buildWorkspaceAgentSessionKey(agentId);
  const row = state.sessionsResult?.sessions?.find((entry) => entry.key === sessionKey);
  if (!row?.updatedAt) {
    return false;
  }
  return Date.now() - row.updatedAt < ACTIVE_SESSION_WINDOW_MS;
}

function summarizeMessages(
  state: WorkspaceState,
  agentId: string,
  messages: unknown[],
  fallback: string,
): WorkspaceConversationSummary {
  const last = messages[messages.length - 1] ?? null;
  const lastActivity = last ? messageTimestamp(last) || null : null;
  const seenAt = state.workspaceMessagesSeenAt[agentId] ?? 0;
  const unread = messages.filter((message) => {
    const ts = messageTimestamp(message);
    if (!ts || ts <= seenAt) {
      return false;
    }
    return messageRole(message) === "assistant";
  }).length;
  return {
    agentId,
    lastActivity,
    preview: last ? buildPreview(last, fallback) : fallback,
    unread,
    online: isAgentOnline(state, agentId),
  };
}

function recomputeWorkspaceUnreadTotal(state: WorkspaceState) {
  state.workspaceUnreadTotal = Object.values(state.workspaceConversationSummaries).reduce(
    (total, summary) => total + summary.unread,
    0,
  );
}

function persistWorkspaceSeenAt(state: WorkspaceState) {
  if (!state.applySettings || !state.settings) {
    return;
  }
  state.applySettings({
    ...state.settings,
    workspaceMessagesSeenAt: state.workspaceMessagesSeenAt,
  });
}

export function markWorkspaceAgentSeen(
  state: WorkspaceState,
  agentId: string,
  messages: unknown[] = state.chatMessages,
) {
  const lastTs = messages.reduce<number>(
    (max, message) => Math.max(max, messageTimestamp(message)),
    0,
  );
  if (!lastTs) {
    return;
  }
  state.workspaceMessagesSeenAt = {
    ...state.workspaceMessagesSeenAt,
    [agentId]: lastTs,
  };
  persistWorkspaceSeenAt(state);
  const current = state.workspaceConversationSummaries[agentId];
  if (current) {
    state.workspaceConversationSummaries = {
      ...state.workspaceConversationSummaries,
      [agentId]: { ...current, unread: 0, lastActivity: current.lastActivity ?? lastTs },
    };
    recomputeWorkspaceUnreadTotal(state);
  }
}

export function syncWorkspaceSelectedConversationSummary(
  state: WorkspaceState,
  agentId: string,
  fallback: string,
) {
  const next = summarizeMessages(state, agentId, state.chatMessages, fallback);
  if (state.workspaceMessagesSeenAt[agentId]) {
    next.unread = 0;
  }
  state.workspaceConversationSummaries = {
    ...state.workspaceConversationSummaries,
    [agentId]: next,
  };
  recomputeWorkspaceUnreadTotal(state);
}

export async function loadWorkspaceConversationSummaries(state: WorkspaceState) {
  if (!state.client || !state.connected || !state.workspaceAgentsList?.agents?.length) {
    return;
  }
  const summaries = await Promise.all(
    state.workspaceAgentsList.agents.map(async (agent) => {
      const sessionKey = buildWorkspaceAgentSessionKey(agent.id);
      const messages =
        state.workspaceSelectedAgentId === agent.id && state.sessionKey === sessionKey
          ? state.chatMessages
          : ((
              await state
                .client!.request<{ messages?: unknown[] }>("chat.history", {
                  sessionKey,
                  limit: 30,
                })
                .catch(() => ({ messages: [] }))
            ).messages ?? []);
      return [
        agent.id,
        summarizeMessages(
          state,
          agent.id,
          Array.isArray(messages) ? messages : [],
          agent.description?.trim() || agent.title?.trim() || "Start a conversation",
        ),
      ] as const;
    }),
  );

  state.workspaceConversationSummaries = Object.fromEntries(summaries);
  recomputeWorkspaceUnreadTotal(state);
}

export function buildWorkspaceAgentSessionKey(agentId: string): string {
  return `agent:${agentId}:clawport`;
}

export async function loadWorkspaceAgents(state: WorkspaceState) {
  if (!state.client || !state.connected || state.workspaceAgentsLoading) {
    return;
  }
  state.workspaceAgentsLoading = true;
  state.workspaceAgentsError = null;
  try {
    const res = await state.client.request<WorkspaceAgentsListResult>("workspace.agents.list", {});
    if (res) {
      state.workspaceAgentsList = res;
      const selected = state.workspaceSelectedAgentId;
      const known = res.agents.some((entry) => entry.id === selected);
      if (!selected || !known) {
        state.workspaceSelectedAgentId = res.defaultId ?? res.agents[0]?.id ?? null;
      }
    }
  } catch (err) {
    state.workspaceAgentsError = String(err);
  } finally {
    state.workspaceAgentsLoading = false;
  }
}

export async function loadWorkspaceFiles(state: WorkspaceState, agentId: string) {
  if (!state.client || !state.connected || state.workspaceFilesLoading) {
    return;
  }
  state.workspaceFilesLoading = true;
  state.workspaceFilesError = null;
  try {
    const res = await state.client.request<WorkspaceFilesListResult>("workspace.files.list", {
      agentId,
    });
    if (res) {
      state.workspaceFilesList = res;
      if (
        state.workspaceFileActive &&
        !res.files.some((file) => file.relativePath === state.workspaceFileActive)
      ) {
        state.workspaceFileActive = null;
      }
    }
  } catch (err) {
    state.workspaceFilesError = String(err);
  } finally {
    state.workspaceFilesLoading = false;
  }
}

export async function loadWorkspaceFileContent(
  state: WorkspaceState,
  agentId: string,
  relativePath: string,
) {
  if (!state.client || !state.connected || state.workspaceFilesLoading) {
    return;
  }
  if (Object.hasOwn(state.workspaceFileContents, relativePath)) {
    return;
  }
  state.workspaceFilesLoading = true;
  state.workspaceFilesError = null;
  try {
    const res = await state.client.request<WorkspaceFilesGetResult>("workspace.files.get", {
      agentId,
      relativePath,
    });
    if (res?.file) {
      state.workspaceFileContents = {
        ...state.workspaceFileContents,
        [relativePath]: res.file.content ?? "",
      };
      if (state.workspaceFilesList?.agentId === agentId) {
        state.workspaceFilesList = {
          ...state.workspaceFilesList,
          files: state.workspaceFilesList.files.map((file) =>
            file.relativePath === relativePath ? { ...file, content: res.file.content } : file,
          ),
        };
      }
    }
  } catch (err) {
    state.workspaceFilesError = String(err);
  } finally {
    state.workspaceFilesLoading = false;
  }
}

export async function loadWorkspaceKanban(state: WorkspaceState) {
  if (!state.client || !state.connected || state.workspaceKanbanLoading) {
    return;
  }
  state.workspaceKanbanLoading = true;
  state.workspaceKanbanError = null;
  try {
    const res = await state.client.request<WorkspaceKanbanListResult>("workspace.kanban.list", {});
    if (res?.tickets) {
      state.workspaceKanbanTickets = Array.isArray(res.tickets) ? res.tickets : [];
    }
  } catch (err) {
    state.workspaceKanbanError = String(err);
  } finally {
    state.workspaceKanbanLoading = false;
  }
}

export async function createWorkspaceKanbanTicket(
  state: WorkspaceState,
  input: {
    title: string;
    description: string;
    priority: WorkspaceTicketPriority;
    assigneeId: string | null;
    assigneeRole: WorkspaceTicketRole | null;
  },
) {
  if (!state.client || !state.connected || state.workspaceKanbanLoading) {
    return;
  }
  state.workspaceKanbanLoading = true;
  state.workspaceKanbanError = null;
  try {
    const res = await state.client.request<WorkspaceKanbanCreateResult>("workspace.kanban.create", {
      title: input.title,
      description: input.description,
      priority: input.priority,
      assigneeId: input.assigneeId,
      assigneeRole: input.assigneeId ? input.assigneeRole : null,
    });
    if (res?.ticket) {
      state.workspaceKanbanTickets = [res.ticket, ...state.workspaceKanbanTickets];
    }
  } catch (err) {
    state.workspaceKanbanError = String(err);
  } finally {
    state.workspaceKanbanLoading = false;
  }
}

export async function updateWorkspaceKanbanTicket(
  state: WorkspaceState,
  ticketId: string,
  patch: Partial<{
    title: string;
    description: string;
    status: WorkspaceTicketStatus;
    priority: WorkspaceTicketPriority;
    assigneeId: string | null;
    assigneeRole: WorkspaceTicketRole | null;
    workState: WorkspaceTicketWorkState;
    workStartedAt: number | null;
    workError: string | null;
    workResult: string | null;
  }>,
) {
  if (!state.client || !state.connected || state.workspaceKanbanLoading) {
    return;
  }
  state.workspaceKanbanLoading = true;
  state.workspaceKanbanError = null;
  try {
    const assigneeId = Object.hasOwn(patch, "assigneeId") ? (patch.assigneeId ?? null) : undefined;
    const assigneeRole =
      assigneeId === null
        ? null
        : Object.hasOwn(patch, "assigneeRole")
          ? (patch.assigneeRole ?? null)
          : undefined;
    const res = await state.client.request<WorkspaceKanbanUpdateResult>("workspace.kanban.update", {
      ticketId,
      patch: {
        ...patch,
        ...(assigneeId !== undefined ? { assigneeId } : {}),
        ...(assigneeRole !== undefined ? { assigneeRole } : {}),
      },
    });
    if (res?.ticket) {
      state.workspaceKanbanTickets = state.workspaceKanbanTickets.map((ticket) =>
        ticket.id === ticketId ? res.ticket : ticket,
      );
    }
  } catch (err) {
    state.workspaceKanbanError = String(err);
  } finally {
    state.workspaceKanbanLoading = false;
  }
}

export async function moveWorkspaceKanbanTicket(
  state: WorkspaceState,
  ticketId: string,
  status: WorkspaceTicketStatus,
) {
  if (!state.client || !state.connected || state.workspaceKanbanLoading) {
    return;
  }
  state.workspaceKanbanLoading = true;
  state.workspaceKanbanError = null;
  try {
    const res = await state.client.request<WorkspaceKanbanUpdateResult>("workspace.kanban.move", {
      ticketId,
      status,
    });
    if (res?.ticket) {
      state.workspaceKanbanTickets = state.workspaceKanbanTickets.map((ticket) =>
        ticket.id === ticketId ? res.ticket : ticket,
      );
    }
  } catch (err) {
    state.workspaceKanbanError = String(err);
  } finally {
    state.workspaceKanbanLoading = false;
  }
}

export async function deleteWorkspaceKanbanTicket(state: WorkspaceState, ticketId: string) {
  if (!state.client || !state.connected || state.workspaceKanbanLoading) {
    return;
  }
  state.workspaceKanbanLoading = true;
  state.workspaceKanbanError = null;
  try {
    const res = await state.client.request<WorkspaceKanbanDeleteResult>("workspace.kanban.delete", {
      ticketId,
    });
    if (res?.ok) {
      state.workspaceKanbanTickets = state.workspaceKanbanTickets.filter(
        (ticket) => ticket.id !== ticketId,
      );
    }
  } catch (err) {
    state.workspaceKanbanError = String(err);
  } finally {
    state.workspaceKanbanLoading = false;
  }
}
