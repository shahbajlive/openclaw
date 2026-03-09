import { html } from "lit";
import type { WorkspaceAgentsListResult } from "../types.ts";
import type {
  WorkspaceTicket,
  WorkspaceTicketPriority,
  WorkspaceTicketStatus,
} from "../workspace-kanban.ts";
import { WORKSPACE_KANBAN_COLUMNS } from "../workspace-kanban.ts";

type WorkspaceKanbanProps = {
  agents: WorkspaceAgentsListResult | null;
  tickets: WorkspaceTicket[];
  draftTitle: string;
  draftDescription: string;
  draftPriority: WorkspaceTicketPriority;
  draftAssigneeId: string;
  onDraftTitleChange: (value: string) => void;
  onDraftDescriptionChange: (value: string) => void;
  onDraftPriorityChange: (value: WorkspaceTicketPriority) => void;
  onDraftAssigneeChange: (value: string) => void;
  onCreateTicket: () => void;
  onMoveTicket: (ticketId: string, status: WorkspaceTicketStatus) => void;
  onDeleteTicket: (ticketId: string) => void;
};

function priorityLabel(priority: WorkspaceTicketPriority): string {
  return priority === "high" ? "High" : priority === "low" ? "Low" : "Medium";
}

export function renderWorkspaceKanban(props: WorkspaceKanbanProps) {
  return html`
    <section class="card">
      <div class="card-title">Workspace Kanban</div>
      <div class="card-sub">A lightweight task board for workspace agents.</div>
      <div class="grid" style="grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-top: 14px;">
        <label class="field">
          <span>Title</span>
          <input .value=${props.draftTitle} @input=${(event: Event) => props.onDraftTitleChange((event.target as HTMLInputElement).value)} />
        </label>
        <label class="field">
          <span>Priority</span>
          <select .value=${props.draftPriority} @change=${(event: Event) => props.onDraftPriorityChange((event.target as HTMLSelectElement).value as WorkspaceTicketPriority)}>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>
        </label>
        <label class="field">
          <span>Assignee</span>
          <select .value=${props.draftAssigneeId} @change=${(event: Event) => props.onDraftAssigneeChange((event.target as HTMLSelectElement).value)}>
            <option value="">Unassigned</option>
            ${(props.agents?.agents ?? []).map(
              (agent) => html`<option value=${agent.id}>${agent.name || agent.id}</option>`,
            )}
          </select>
        </label>
        <div class="field" style="justify-content: end;">
          <span>&nbsp;</span>
          <button class="btn" @click=${props.onCreateTicket}>Add ticket</button>
        </div>
      </div>
      <label class="field" style="margin-top: 12px;">
        <span>Description</span>
        <textarea .value=${props.draftDescription} @input=${(event: Event) => props.onDraftDescriptionChange((event.target as HTMLTextAreaElement).value)} rows="3"></textarea>
      </label>
      <div class="grid" style="grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 12px; margin-top: 18px; align-items: start;">
        ${WORKSPACE_KANBAN_COLUMNS.map((column) => {
          const tickets = props.tickets.filter((ticket) => ticket.status === column.id);
          return html`
            <div class="card" style="margin: 0;">
              <div class="card-title">${column.title}</div>
              <div class="card-sub">${tickets.length} ticket${tickets.length === 1 ? "" : "s"}</div>
              <div style="display: grid; gap: 10px; margin-top: 12px;">
                ${tickets.map(
                  (ticket) => html`
                  <div class="card" style="margin: 0;">
                    <div class="row" style="justify-content: space-between; align-items: flex-start;">
                      <div>
                        <div class="card-title">${ticket.title}</div>
                        <div class="card-sub">${ticket.assigneeId || "Unassigned"} • ${priorityLabel(ticket.priority)}</div>
                      </div>
                      <button class="btn btn--sm" @click=${() => props.onDeleteTicket(ticket.id)}>Delete</button>
                    </div>
                    ${ticket.description ? html`<div style="margin-top: 8px;">${ticket.description}</div>` : ""}
                    <label class="field" style="margin-top: 10px;">
                      <span>Status</span>
                      <select .value=${ticket.status} @change=${(event: Event) => props.onMoveTicket(ticket.id, (event.target as HTMLSelectElement).value as WorkspaceTicketStatus)}>
                        ${WORKSPACE_KANBAN_COLUMNS.map((option) => html`<option value=${option.id}>${option.title}</option>`)}
                      </select>
                    </label>
                  </div>
                `,
                )}
              </div>
            </div>
          `;
        })}
      </div>
    </section>
  `;
}
