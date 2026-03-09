import { html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import type { AppViewState } from "../ui/app-view-state.ts";
import {
  WORKSPACE_KANBAN_COLUMNS,
  WORKSPACE_KANBAN_ROLES,
  type WorkspaceTicket,
  type WorkspaceTicketPriority,
  type WorkspaceTicketRole,
  type WorkspaceTicketStatus,
} from "../ui/workspace-kanban.ts";
import { renderWorkspaceMessagesThread, selectWorkspaceMessagesAgent } from "./messages-page.ts";

function priorityLabel(priority: WorkspaceTicketPriority): string {
  return priority === "high" ? "High" : priority === "low" ? "Low" : "Med";
}

function assigneeName(state: AppViewState, ticket: WorkspaceTicket): string {
  if (!ticket.assigneeId) {
    return "Unassigned";
  }
  const agent = state.workspaceAgentsList?.agents.find((entry) => entry.id === ticket.assigneeId);
  return agent?.name || ticket.assigneeId;
}

function sortTickets(tickets: WorkspaceTicket[]): WorkspaceTicket[] {
  return [...tickets].toSorted((a, b) => b.updatedAt - a.updatedAt);
}

function ticketCountByStatus(tickets: WorkspaceTicket[], status: WorkspaceTicketStatus): number {
  return tickets.reduce((count, ticket) => count + (ticket.status === status ? 1 : 0), 0);
}

function statusLabel(status: WorkspaceTicketStatus): string {
  return WORKSPACE_KANBAN_COLUMNS.find((column) => column.id === status)?.title ?? status;
}

function assigneeEmoji(state: AppViewState, ticket: WorkspaceTicket): string {
  if (!ticket.assigneeId) {
    return "🤖";
  }
  const agent = state.workspaceAgentsList?.agents.find((entry) => entry.id === ticket.assigneeId);
  return agent?.emoji?.trim() || "🤖";
}

function syncTicketAgentChat(state: AppViewState, ticket: WorkspaceTicket) {
  if (!ticket.assigneeId) {
    return;
  }
  const agent = state.workspaceAgentsList?.agents.find((entry) => entry.id === ticket.assigneeId);
  if (!agent) {
    return;
  }
  selectWorkspaceMessagesAgent(state, agent);
}

function relativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) {
    return "just now";
  }
  if (mins < 60) {
    return `${mins}m ago`;
  }
  const hours = Math.floor(mins / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  if (days < 30) {
    return `${days}d ago`;
  }
  return `${Math.floor(days / 30)}mo ago`;
}

export function renderWorkspaceKanbanPage(state: AppViewState) {
  const createDisabled = state.workspaceKanbanLoading || !state.workspaceKanbanDraftTitle.trim();
  const roleDisabled = !state.workspaceKanbanDraftAssigneeId;
  const selectedTicket = state.workspaceKanbanSelectedTicketId
    ? (state.workspaceKanbanTickets.find(
        (ticket) => ticket.id === state.workspaceKanbanSelectedTicketId,
      ) ?? null)
    : null;
  const selectedTicketAgent = selectedTicket?.assigneeId
    ? (state.workspaceAgentsList?.agents.find((entry) => entry.id === selectedTicket.assigneeId) ??
      null)
    : null;
  const assignedAgents = (state.workspaceAgentsList?.agents ?? []).filter((agent) =>
    state.workspaceKanbanTickets.some((ticket) => ticket.assigneeId === agent.id),
  );

  return html`
    <div class="workspace-kanban-shell">
      ${
        selectedTicket
          ? html`<div
              class="workspace-kanban-drawer-backdrop"
              @click=${() => {
                state.workspaceKanbanSelectedTicketId = null;
              }}
            ></div>`
          : nothing
      }
      <section class="workspace-kanban-surface">
        ${
          state.workspaceKanbanError
            ? html`<div class="workspace-alert workspace-alert--danger">${state.workspaceKanbanError}</div>`
            : nothing
        }

        ${
          assignedAgents.length > 0
            ? html`<div class="workspace-kanban-filters">
                <button
                  class="workspace-kanban-filter ${state.workspaceKanbanFilterAgentId === null ? "is-active" : ""}"
                  @click=${() => {
                    state.workspaceKanbanFilterAgentId = null;
                  }}
                >
                  All
                </button>
                ${assignedAgents.map(
                  (agent) => html`<button
                    class="workspace-kanban-filter ${state.workspaceKanbanFilterAgentId === agent.id ? "is-active" : ""}"
                    @click=${() => {
                      state.workspaceKanbanFilterAgentId =
                        state.workspaceKanbanFilterAgentId === agent.id ? null : agent.id;
                    }}
                  >
                    <span>${agent.emoji?.trim() || "🤖"}</span>
                    <span>${agent.name || agent.id}</span>
                  </button>`,
                )}
              </div>`
            : nothing
        }

        <div class="workspace-kanban-board">
          ${WORKSPACE_KANBAN_COLUMNS.map((column) => {
            const tickets = sortTickets(
              state.workspaceKanbanTickets
                .filter((ticket) => ticket.status === column.id)
                .filter((ticket) =>
                  state.workspaceKanbanFilterAgentId
                    ? ticket.assigneeId === state.workspaceKanbanFilterAgentId
                    : true,
                ),
            );
            return html`
              <section class="workspace-kanban-column ${state.workspaceKanbanDragOverStatus === column.id ? "is-drag-over" : ""}">
                <header class="workspace-kanban-column__header">
                  <div class="workspace-kanban-column__title-wrap">
                    <div class="workspace-kanban-column__title">${column.title}</div>
                    <div class="workspace-kanban-column__count">
                      ${ticketCountByStatus(state.workspaceKanbanTickets, column.id)}
                    </div>
                  </div>
                  <button
                    class="workspace-kanban-column__plus"
                    aria-label="Create ticket"
                    @click=${() => {
                      state.workspaceKanbanCreateOpen = true;
                    }}
                  >
                    +
                  </button>
                </header>

                <div
                  class="workspace-kanban-column__body"
                  @dragover=${(event: DragEvent) => {
                    event.preventDefault();
                    state.workspaceKanbanDragOverStatus = column.id;
                  }}
                  @dragleave=${(event: DragEvent) => {
                    if (
                      !(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node)
                    ) {
                      state.workspaceKanbanDragOverStatus = null;
                    }
                  }}
                  @drop=${(event: DragEvent) => {
                    event.preventDefault();
                    state.workspaceKanbanDragOverStatus = null;
                    const ticketId = event.dataTransfer?.getData("text/plain")?.trim();
                    if (!ticketId) {
                      return;
                    }
                    const source = state.workspaceKanbanTickets.find(
                      (ticket) => ticket.id === ticketId,
                    );
                    if (!source || source.status === column.id) {
                      return;
                    }
                    void state.handleMoveWorkspaceKanbanTicket(ticketId, column.id);
                  }}
                >
                  ${repeat(
                    tickets,
                    (ticket) => ticket.id,
                    (ticket) => html`
                      <article
                        class="workspace-ticket is-status-${ticket.status}"
                        draggable="true"
                        @dragstart=${(event: DragEvent) => {
                          event.dataTransfer?.setData("text/plain", ticket.id);
                          if (event.dataTransfer) {
                            event.dataTransfer.effectAllowed = "move";
                          }
                        }}
                        @dragend=${() => {
                          state.workspaceKanbanDragOverStatus = null;
                        }}
                      >
                        <button
                          class="workspace-ticket__click"
                          @click=${() => {
                            state.workspaceKanbanSelectedTicketId = ticket.id;
                            syncTicketAgentChat(state, ticket);
                          }}
                        >
                          <span class="workspace-ticket__title" title=${ticket.title}>${ticket.title}</span>
                          <div class="workspace-ticket__meta-row">
                            <div class="workspace-ticket__meta-left">
                              <span
                                class="workspace-ticket__pill workspace-ticket__pill--agent"
                                title=${assigneeName(state, ticket)}
                              >
                                <span class="workspace-ticket__pill-emoji">🤖</span>
                                <span>${assigneeName(state, ticket)}</span>
                              </span>
                              <span class="workspace-ticket__pill workspace-ticket__pill--priority is-${ticket.priority}">
                                ${priorityLabel(ticket.priority)}
                              </span>
                            </div>
                            <span class="workspace-ticket__pill workspace-ticket__pill--time" title=${new Date(ticket.createdAt).toLocaleString()}
                              >${relativeTime(ticket.createdAt)}</span
                            >
                          </div>
                        </button>
                      </article>
                    `,
                  )}
                  ${
                    tickets.length === 0
                      ? html`
                          <div class="workspace-kanban-column__empty">No tickets</div>
                        `
                      : nothing
                  }
                </div>
              </section>
            `;
          })}
        </div>

        ${
          selectedTicket
            ? html`<div class="workspace-kanban-overlay workspace-kanban-overlay--drawer is-expanded">
                <aside class="workspace-kanban-detail is-expanded">
                  <div class="workspace-kanban-detail__body">
                    <section class="workspace-kanban-detail__hero">
                      <div class="workspace-kanban-detail__title-row">
                        <h3 class="workspace-kanban-detail__title">${selectedTicket.title}</h3>
                        <div class="workspace-kanban-detail__controls">
                          <button
                            class="workspace-kanban-detail__icon-btn is-danger"
                            title="Delete ticket"
                            aria-label="Delete ticket"
                            @click=${async () => {
                              if (!window.confirm(`Delete ticket "${selectedTicket.title}"?`)) {
                                return;
                              }
                              await state.handleDeleteWorkspaceKanbanTicket(selectedTicket.id);
                              state.workspaceKanbanSelectedTicketId = null;
                            }}
                            ?disabled=${state.workspaceKanbanLoading}
                          >
                            🗑
                          </button>
                          <button
                            class="workspace-kanban-detail__icon-btn"
                            title="Close"
                            aria-label="Close"
                            @click=${() => {
                              state.workspaceKanbanSelectedTicketId = null;
                            }}
                          >
                            ✕
                          </button>
                        </div>
                      </div>
                      <div class="workspace-kanban-detail__meta-row">
                        <div class="workspace-kanban-detail__agent-info">
                          <span class="workspace-kanban-detail__agent-emoji">${assigneeEmoji(state, selectedTicket)}</span>
                          <span class="workspace-kanban-detail__agent-name">
                            ${assigneeName(state, selectedTicket)}
                          </span>
                          ${
                            selectedTicket.assigneeRole
                              ? html`<span class="workspace-kanban-detail__agent-role"
                                  >${selectedTicket.assigneeRole}</span
                                >`
                              : nothing
                          }
                        </div>
                        <div class="workspace-kanban-detail__status-info">
                          <span class="workspace-kanban-detail__status-pill">
                            ${statusLabel(selectedTicket.status).toUpperCase()}
                          </span>
                          <span
                            class="workspace-kanban-detail__priority-pill is-${selectedTicket.priority}"
                          >
                            <span class="workspace-kanban-detail__priority-dot"></span>
                            ${priorityLabel(selectedTicket.priority).toUpperCase()}
                          </span>
                        </div>
                      </div>
                    </section>
                    <div class="workspace-kanban-detail__quick-move">
                      <span>MOVE TO</span>
                      <div class="workspace-kanban-detail__quick-move-actions" role="tablist" aria-label="Move ticket to status">
                        ${WORKSPACE_KANBAN_COLUMNS.map(
                          (column) => html`<button
                            class="workspace-kanban-detail__quick-btn ${
                              selectedTicket.status === column.id ? "is-active" : ""
                            }"
                            ?disabled=${selectedTicket.status === column.id}
                            @click=${() => void state.handleMoveWorkspaceKanbanTicket(selectedTicket.id, column.id)}
                          >
                            ${column.title}
                          </button>`,
                        )}
                      </div>
                    </div>
                    <section class="workspace-kanban-detail__chat">
                      <h4>AGENT CHAT</h4>
                      ${
                        selectedTicketAgent
                          ? html`<div class="workspace-kanban-detail__chat-body">
                              ${renderWorkspaceMessagesThread(state, selectedTicketAgent)}
                            </div>`
                          : html`
                              <div class="workspace-kanban-detail__chat-empty">No agent assigned</div>
                            `
                      }
                    </section>
                    ${
                      selectedTicket.description
                        ? html`<div class="workspace-kanban-detail__description">
                            ${selectedTicket.description}
                          </div>`
                        : nothing
                    }
                    ${
                      selectedTicket.workResult
                        ? html`<details class="workspace-ticket__result" open>
                            <summary>Work result</summary>
                            <pre>${selectedTicket.workResult}</pre>
                          </details>`
                        : nothing
                    }
                    ${
                      selectedTicket.workError
                        ? html`<div class="workspace-alert workspace-alert--danger">${selectedTicket.workError}</div>`
                        : nothing
                    }
                    ${
                      selectedTicket.workState === "failed"
                        ? html`<button
                            class="workspace-btn workspace-btn--ghost"
                            @click=${() =>
                              void state.handleUpdateWorkspaceKanbanTicket(selectedTicket.id, {
                                status: "todo",
                                workState: "idle",
                                workError: null,
                                workStartedAt: null,
                              })}
                          >
                            Retry Work
                          </button>`
                        : nothing
                    }
                  </div>
                </aside>
              </div>`
            : nothing
        }
      </section>
      ${
        state.workspaceKanbanCreateOpen
          ? html`<div
              class="workspace-kanban-modal-backdrop"
              @click=${() => {
                state.workspaceKanbanCreateOpen = false;
              }}
            >
              <section class="workspace-kanban-modal" @click=${(event: Event) => event.stopPropagation()}>
                <header class="workspace-kanban-modal__header">
                  <div class="workspace-kanban-modal__title">New Ticket</div>
                  <button
                    class="workspace-btn workspace-btn--ghost workspace-btn--sm"
                    @click=${() => {
                      state.workspaceKanbanCreateOpen = false;
                    }}
                  >
                    Close
                  </button>
                </header>
                <div class="workspace-kanban-modal__body">
                  <label class="field">
                    <span>Title</span>
                    <input
                      .value=${state.workspaceKanbanDraftTitle}
                      @input=${(event: Event) =>
                        (state.workspaceKanbanDraftTitle = (
                          event.target as HTMLInputElement
                        ).value)}
                      placeholder="What needs to be done?"
                    />
                  </label>
                  <label class="field">
                    <span>Description</span>
                    <textarea
                      class="workspace-kanban-textarea"
                      .value=${state.workspaceKanbanDraftDescription}
                      @input=${(event: Event) =>
                        (state.workspaceKanbanDraftDescription = (
                          event.target as HTMLTextAreaElement
                        ).value)}
                      rows="4"
                    ></textarea>
                  </label>
                  <label class="field">
                    <span>Priority</span>
                    <select
                      .value=${state.workspaceKanbanDraftPriority}
                      @change=${(event: Event) =>
                        (state.workspaceKanbanDraftPriority = (event.target as HTMLSelectElement)
                          .value as WorkspaceTicketPriority)}
                    >
                      <option value="low">Low</option>
                      <option value="medium">Medium</option>
                      <option value="high">High</option>
                    </select>
                  </label>
                  <label class="field">
                    <span>Assignee</span>
                    <select
                      .value=${state.workspaceKanbanDraftAssigneeId}
                      @change=${(event: Event) =>
                        state.setWorkspaceKanbanDraftAssignee(
                          (event.target as HTMLSelectElement).value,
                        )}
                    >
                      <option value="">Unassigned</option>
                      ${(state.workspaceAgentsList?.agents ?? []).map(
                        (agent) =>
                          html`<option value=${agent.id}>${agent.name ?? agent.id}</option>`,
                      )}
                    </select>
                  </label>
                  <label class="field">
                    <span>Role</span>
                    <select
                      .value=${state.workspaceKanbanDraftAssigneeRole}
                      ?disabled=${roleDisabled}
                      @change=${(event: Event) =>
                        (state.workspaceKanbanDraftAssigneeRole = (
                          event.target as HTMLSelectElement
                        ).value as WorkspaceTicketRole | "")}
                    >
                      <option value="">Unassigned role</option>
                      ${WORKSPACE_KANBAN_ROLES.map(
                        (role) => html`<option value=${role.id}>${role.title}</option>`,
                      )}
                    </select>
                  </label>
                  <button
                    class="workspace-btn workspace-btn--accent"
                    ?disabled=${createDisabled}
                    @click=${async () => {
                      await state.handleCreateWorkspaceKanbanTicket();
                      if (!state.workspaceKanbanError) {
                        state.workspaceKanbanCreateOpen = false;
                      }
                    }}
                  >
                    ${state.workspaceKanbanLoading ? "Saving..." : "Create Ticket"}
                  </button>
                </div>
              </section>
            </div>`
          : nothing
      }
    </div>
  `;
}
