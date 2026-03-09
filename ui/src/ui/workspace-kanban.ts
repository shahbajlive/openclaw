export type WorkspaceTicketStatus = "backlog" | "todo" | "in-progress" | "review" | "done";
export type WorkspaceTicketPriority = "low" | "medium" | "high";
export type WorkspaceTicketRole = "lead-dev" | "ux-ui" | "qa";
export type WorkspaceTicketWorkState = "idle" | "starting" | "working" | "done" | "failed";

export type WorkspaceTicket = {
  id: string;
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
  createdAt: number;
  updatedAt: number;
};

export const WORKSPACE_KANBAN_COLUMNS: Array<{
  id: WorkspaceTicketStatus;
  title: string;
}> = [
  { id: "backlog", title: "Backlog" },
  { id: "todo", title: "To Do" },
  { id: "in-progress", title: "In Progress" },
  { id: "review", title: "Review" },
  { id: "done", title: "Done" },
];

export const WORKSPACE_KANBAN_ROLES: Array<{
  id: WorkspaceTicketRole;
  title: string;
}> = [
  { id: "lead-dev", title: "Lead Dev" },
  { id: "ux-ui", title: "UX/UI Lead" },
  { id: "qa", title: "QA" },
];

export const WORKSPACE_KANBAN_WORK_STATES: Array<{
  id: WorkspaceTicketWorkState;
  title: string;
}> = [
  { id: "idle", title: "Idle" },
  { id: "starting", title: "Starting" },
  { id: "working", title: "Working" },
  { id: "done", title: "Done" },
  { id: "failed", title: "Failed" },
];
