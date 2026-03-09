import { html, nothing, type TemplateResult } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { renderUsageTab } from "../ui/app-render-usage-tab.ts";
import type { AppViewState } from "../ui/app-view-state.ts";
import { icons } from "../ui/icons.ts";
import {
  iconForTab,
  isWorkspaceTab,
  pathForTab,
  subtitleForTab,
  titleForTab,
  type Tab,
  WORKSPACE_TABS,
} from "../ui/navigation.ts";
import type {
  WorkspaceAgentRow,
  WorkspaceAgentsListResult,
  WorkspaceFilesListResult,
} from "../ui/types.ts";
import type { ChatProps } from "../ui/views/chat.ts";
import { renderChat } from "../ui/views/chat.ts";
import type { ConfigProps } from "../ui/views/config.ts";
import { renderConfig } from "../ui/views/config.ts";
import type { CronProps } from "../ui/views/cron.ts";
import { renderCron } from "../ui/views/cron.ts";
import type { LogsProps } from "../ui/views/logs.ts";
import { renderLogs } from "../ui/views/logs.ts";
import type {
  WorkspaceTicket,
  WorkspaceTicketPriority,
  WorkspaceTicketStatus,
} from "../ui/workspace-kanban.ts";
import { WORKSPACE_KANBAN_COLUMNS } from "../ui/workspace-kanban.ts";

type WorkspaceModuleProps = {
  state: AppViewState;
  messages: WorkspaceMessagesProps;
  map: WorkspaceMapProps;
  memory: WorkspaceMemoryProps;
  kanban: WorkspaceKanbanProps;
  cron: CronProps;
  logs: LogsProps;
  config: ConfigProps;
};

type WorkspaceMessagesProps = {
  agents: WorkspaceAgentsListResult | null;
  agentsLoading: boolean;
  agentsError: string | null;
  selectedAgentId: string | null;
  onSelectAgent: (agentId: string) => void;
  onRefreshAgents: () => void;
  chat: ChatProps;
};

type WorkspaceMapProps = {
  loading: boolean;
  error: string | null;
  result: WorkspaceAgentsListResult | null;
  selectedAgentId: string | null;
  onSelectAgent: (agentId: string) => void;
  onRefresh: () => void;
};

type WorkspaceMemoryProps = {
  loading: boolean;
  error: string | null;
  agents: WorkspaceAgentsListResult | null;
  selectedAgentId: string | null;
  files: WorkspaceFilesListResult | null;
  activeFile: string | null;
  fileContents: Record<string, string>;
  onSelectAgent: (agentId: string) => void;
  onRefresh: () => void;
  onSelectFile: (relativePath: string) => void;
};

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

function resolveSelectedAgent(
  agents: WorkspaceAgentsListResult | null,
  selectedAgentId: string | null,
): WorkspaceAgentRow | null {
  if (!agents) {
    return null;
  }
  const agentId = selectedAgentId ?? agents.defaultId ?? agents.agents[0]?.id ?? null;
  return agents.agents.find((entry) => entry.id === agentId) ?? null;
}

function resolveChildren(
  agents: WorkspaceAgentsListResult | null,
  parentId: string | null,
): WorkspaceAgentRow[] {
  return (agents?.agents ?? []).filter((entry) => (entry.reportsTo ?? null) === parentId);
}

function renderWorkspaceRail(props: WorkspaceModuleProps, selectedAgent: WorkspaceAgentRow | null) {
  const workspaceDir = props.state.workspaceAgentsList?.workspaceDir ?? "Workspace unavailable";
  const registryPath = props.state.workspaceAgentsList?.registryPath ?? "Auto-discovery fallback";
  return html`
    <aside class="workspace-module__rail">
      <div class="workspace-brand">
        <div class="workspace-brand__logo">🦞</div>
        <div>
          <div class="workspace-brand__title">Workspace</div>
          <div class="workspace-brand__sub">ClawPort module inside OpenClaw</div>
        </div>
      </div>

      <nav class="workspace-nav" aria-label="Workspace">
        ${WORKSPACE_TABS.map((tab) => {
          const icon = icons[iconForTab(tab)];
          const active = props.state.tab === tab;
          return html`
            <a
              class="workspace-nav__item ${active ? "is-active" : ""}"
              href=${pathForTab(tab, props.state.basePath)}
            >
              <span class="workspace-nav__icon">${icon}</span>
              <span>
                <span class="workspace-nav__title">${titleForTab(tab)}</span>
                <span class="workspace-nav__desc">${subtitleForTab(tab)}</span>
              </span>
            </a>
          `;
        })}
      </nav>

      <section class="workspace-meta">
        <div class="workspace-meta__label">Workspace</div>
        <div class="workspace-meta__value" title=${workspaceDir}>${workspaceDir}</div>
        <div class="workspace-meta__label">Registry</div>
        <div class="workspace-meta__value" title=${registryPath}>${registryPath}</div>
      </section>

      ${
        selectedAgent
          ? html`
              <section class="workspace-agent-card">
                <div class="workspace-agent-card__header">
                  <div class="workspace-agent-card__emoji">${selectedAgent.emoji ?? "🤖"}</div>
                  <div>
                    <div class="workspace-agent-card__name">${selectedAgent.name ?? selectedAgent.id}</div>
                    <div class="workspace-agent-card__role">
                      ${selectedAgent.title ?? selectedAgent.description ?? selectedAgent.id}
                    </div>
                  </div>
                </div>
                <div class="workspace-agent-card__meta">
                  <span>${selectedAgent.id}</span>
                  ${
                    (selectedAgent.tools?.length ?? 0) > 0
                      ? html`<span>${selectedAgent.tools!.length} tools</span>`
                      : nothing
                  }
                </div>
              </section>
            `
          : nothing
      }
    </aside>
  `;
}

type WorkspaceRenderable = ReturnType<typeof html> | typeof nothing;

function renderPageShell(
  props: WorkspaceModuleProps,
  title: string,
  subtitle: string,
  body: WorkspaceRenderable,
  actions: WorkspaceRenderable = nothing,
) {
  const selectedAgent = resolveSelectedAgent(
    props.state.workspaceAgentsList,
    props.state.workspaceSelectedAgentId,
  );
  return html`
    <div class="workspace-module">
      ${renderWorkspaceRail(props, selectedAgent)}
      <section class="workspace-module__stage">
        <header class="workspace-page-header">
          <div>
            <div class="workspace-page-header__eyebrow">Workspace</div>
            <h1 class="workspace-page-header__title">${title}</h1>
            <p class="workspace-page-header__subtitle">${subtitle}</p>
          </div>
          <div class="workspace-page-header__actions">${actions}</div>
        </header>
        <div class="workspace-page-body">${body}</div>
      </section>
    </div>
  `;
}

function renderMessagesPage(props: WorkspaceMessagesProps) {
  const selectedAgent = resolveSelectedAgent(props.agents, props.selectedAgentId);
  const count = props.agents?.agents.length ?? 0;
  return html`
    <div class="workspace-surface workspace-surface--messages">
      <aside class="workspace-panel workspace-panel--agents">
        <div class="workspace-panel__header">
          <div>
            <div class="workspace-panel__title">Developer Team</div>
            <div class="workspace-panel__sub">${count} agent${count === 1 ? "" : "s"} available</div>
          </div>
          <button class="workspace-btn workspace-btn--ghost" ?disabled=${props.agentsLoading} @click=${props.onRefreshAgents}>
            ${props.agentsLoading ? "Loading…" : "Refresh"}
          </button>
        </div>
        ${
          props.agentsError
            ? html`<div class="workspace-alert workspace-alert--danger">${props.agentsError}</div>`
            : nothing
        }
        <div class="workspace-agent-list">
          ${repeat(
            props.agents?.agents ?? [],
            (agent) => agent.id,
            (agent) => html`
              <button
                class="workspace-agent-list__item ${props.selectedAgentId === agent.id ? "is-active" : ""}"
                @click=${() => props.onSelectAgent(agent.id)}
              >
                <span class="workspace-agent-list__emoji">${agent.emoji ?? "🤖"}</span>
                <span class="workspace-agent-list__content">
                  <span class="workspace-agent-list__name">${agent.name ?? agent.id}</span>
                  <span class="workspace-agent-list__role">${agent.title ?? agent.description ?? agent.id}</span>
                </span>
              </button>
            `,
          )}
        </div>
        ${
          selectedAgent?.tools?.length
            ? html`
                <div class="workspace-inline-meta">
                  ${selectedAgent.tools.map((tool) => html`<span class="workspace-chip">${tool}</span>`)}
                </div>
              `
            : nothing
        }
      </aside>
      <section class="workspace-panel workspace-panel--chat">
        ${renderChat(props.chat)}
      </section>
    </div>
  `;
}

function renderMapNode(
  result: WorkspaceAgentsListResult,
  agent: WorkspaceAgentRow,
  selectedAgentId: string | null,
  onSelectAgent: (agentId: string) => void,
): TemplateResult {
  const children = resolveChildren(result, agent.id);
  return html`
    <div class="workspace-map-node">
      <button
        class="workspace-map-card ${selectedAgentId === agent.id ? "is-active" : ""}"
        @click=${() => onSelectAgent(agent.id)}
      >
        <div class="workspace-map-card__emoji">${agent.emoji ?? "🤖"}</div>
        <div>
          <div class="workspace-map-card__name">${agent.name ?? agent.id}</div>
          <div class="workspace-map-card__role">${agent.title ?? agent.description ?? agent.id}</div>
        </div>
      </button>
      ${
        children.length > 0
          ? html`
              <div class="workspace-map-children">
                ${children.map((child) => renderMapNode(result, child, selectedAgentId, onSelectAgent))}
              </div>
            `
          : nothing
      }
    </div>
  `;
}

function renderMapPage(props: WorkspaceMapProps) {
  const selectedAgent = resolveSelectedAgent(props.result, props.selectedAgentId);
  const roots = resolveChildren(props.result, null);
  return html`
    <div class="workspace-surface workspace-surface--map">
      <section class="workspace-panel">
        <div class="workspace-panel__header">
          <div>
            <div class="workspace-panel__title">Org Map</div>
            <div class="workspace-panel__sub">Hierarchy loaded from the active workspace registry.</div>
          </div>
          <button class="workspace-btn workspace-btn--ghost" ?disabled=${props.loading} @click=${props.onRefresh}>
            ${props.loading ? "Loading…" : "Refresh"}
          </button>
        </div>
        ${
          props.error
            ? html`<div class="workspace-alert workspace-alert--danger">${props.error}</div>`
            : nothing
        }
        <div class="workspace-map-tree">
          ${roots.map((agent) => renderMapNode(props.result!, agent, props.selectedAgentId, props.onSelectAgent))}
        </div>
      </section>
      <aside class="workspace-panel workspace-panel--inspector">
        <div class="workspace-panel__header">
          <div>
            <div class="workspace-panel__title">Inspector</div>
            <div class="workspace-panel__sub">Role, reporting line, and tool surface.</div>
          </div>
        </div>
        ${
          selectedAgent
            ? html`
                <div class="workspace-inspector">
                  <div class="workspace-inspector__hero">
                    <div class="workspace-inspector__emoji">${selectedAgent.emoji ?? "🤖"}</div>
                    <div>
                      <div class="workspace-inspector__name">${selectedAgent.name ?? selectedAgent.id}</div>
                      <div class="workspace-inspector__role">${selectedAgent.title ?? selectedAgent.description ?? selectedAgent.id}</div>
                    </div>
                  </div>
                  <div class="workspace-detail-list">
                    <div><span>ID</span><strong>${selectedAgent.id}</strong></div>
                    <div><span>Reports to</span><strong>${selectedAgent.reportsTo ?? "Root"}</strong></div>
                    <div><span>Direct reports</span><strong>${selectedAgent.directReports?.length ?? 0}</strong></div>
                  </div>
                  ${
                    (selectedAgent.tools?.length ?? 0) > 0
                      ? html`
                          <div class="workspace-inline-meta">
                            ${selectedAgent.tools!.map((tool) => html`<span class="workspace-chip">${tool}</span>`)}
                          </div>
                        `
                      : nothing
                  }
                  ${
                    selectedAgent.soulPath
                      ? html`<div class="workspace-code-path">${selectedAgent.soulPath}</div>`
                      : nothing
                  }
                </div>
              `
            : html`
                <div class="workspace-empty">Select an agent to inspect it.</div>
              `
        }
      </aside>
    </div>
  `;
}

function formatFileSize(size?: number): string {
  if (!size || size <= 0) {
    return "0 B";
  }
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${Math.round(size / 102.4) / 10} KB`;
  }
  return `${Math.round(size / 104857.6) / 10} MB`;
}

function renderMemoryPage(props: WorkspaceMemoryProps) {
  const content = props.activeFile ? (props.fileContents[props.activeFile] ?? "") : "";
  return html`
    <div class="workspace-surface workspace-surface--memory">
      <aside class="workspace-panel workspace-panel--agents">
        <div class="workspace-panel__header">
          <div>
            <div class="workspace-panel__title">Agents</div>
            <div class="workspace-panel__sub">Choose whose workspace files to inspect.</div>
          </div>
        </div>
        <div class="workspace-agent-list">
          ${repeat(
            props.agents?.agents ?? [],
            (agent) => agent.id,
            (agent) => html`
              <button
                class="workspace-agent-list__item ${props.selectedAgentId === agent.id ? "is-active" : ""}"
                @click=${() => props.onSelectAgent(agent.id)}
              >
                <span class="workspace-agent-list__emoji">${agent.emoji ?? "🤖"}</span>
                <span class="workspace-agent-list__content">
                  <span class="workspace-agent-list__name">${agent.name ?? agent.id}</span>
                  <span class="workspace-agent-list__role">${agent.title ?? agent.id}</span>
                </span>
              </button>
            `,
          )}
        </div>
      </aside>
      <section class="workspace-panel workspace-panel--files">
        <div class="workspace-panel__header">
          <div>
            <div class="workspace-panel__title">Memory Files</div>
            <div class="workspace-panel__sub">SOUL, identity, user, and memory artifacts from the real workspace.</div>
          </div>
          <button class="workspace-btn workspace-btn--ghost" ?disabled=${props.loading} @click=${props.onRefresh}>
            ${props.loading ? "Loading…" : "Refresh"}
          </button>
        </div>
        ${
          props.error
            ? html`<div class="workspace-alert workspace-alert--danger">${props.error}</div>`
            : nothing
        }
        <div class="workspace-file-grid">
          <div class="workspace-file-list">
            ${repeat(
              props.files?.files ?? [],
              (file) => file.relativePath,
              (file) => html`
                <button
                  class="workspace-file-list__item ${props.activeFile === file.relativePath ? "is-active" : ""}"
                  @click=${() => props.onSelectFile(file.relativePath)}
                >
                  <span>
                    <strong>${file.label}</strong>
                    <small>${file.relativePath}</small>
                  </span>
                  <span class="workspace-file-list__meta">${file.missing ? "missing" : formatFileSize(file.size)}</span>
                </button>
              `,
            )}
          </div>
          <div class="workspace-file-viewer">
            <div class="workspace-file-viewer__header">
              <div>${props.activeFile ?? "Select a file"}</div>
              ${
                props.files?.workspace
                  ? html`<div class="workspace-file-viewer__path">${props.files.workspace}</div>`
                  : nothing
              }
            </div>
            ${
              props.activeFile
                ? html`<pre class="workspace-code-block">${content}</pre>`
                : html`
                    <div class="workspace-empty">Pick a file to read its contents.</div>
                  `
            }
          </div>
        </div>
      </section>
    </div>
  `;
}

function priorityLabel(priority: WorkspaceTicketPriority): string {
  return priority === "high" ? "High" : priority === "low" ? "Low" : "Medium";
}

function renderKanbanPage(props: WorkspaceKanbanProps) {
  return html`
    <div class="workspace-panel workspace-panel--kanban">
      <div class="workspace-panel__header">
        <div>
          <div class="workspace-panel__title">Kanban</div>
          <div class="workspace-panel__sub">A lightweight planning board for the workspace team.</div>
        </div>
      </div>
      <div class="workspace-kanban-compose">
        <label class="workspace-field">
          <span>Task</span>
          <input .value=${props.draftTitle} @input=${(event: Event) => props.onDraftTitleChange((event.target as HTMLInputElement).value)} />
        </label>
        <label class="workspace-field">
          <span>Priority</span>
          <select .value=${props.draftPriority} @change=${(event: Event) => props.onDraftPriorityChange((event.target as HTMLSelectElement).value as WorkspaceTicketPriority)}>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>
        </label>
        <label class="workspace-field">
          <span>Assignee</span>
          <select .value=${props.draftAssigneeId} @change=${(event: Event) => props.onDraftAssigneeChange((event.target as HTMLSelectElement).value)}>
            <option value="">Unassigned</option>
            ${(props.agents?.agents ?? []).map((agent) => html`<option value=${agent.id}>${agent.name ?? agent.id}</option>`)}
          </select>
        </label>
        <button class="workspace-btn workspace-btn--accent workspace-kanban-compose__submit" @click=${props.onCreateTicket}>
          Add card
        </button>
      </div>
      <label class="workspace-field workspace-field--full">
        <span>Description</span>
        <textarea rows="3" .value=${props.draftDescription} @input=${(event: Event) => props.onDraftDescriptionChange((event.target as HTMLTextAreaElement).value)}></textarea>
      </label>
      <div class="workspace-kanban-board">
        ${WORKSPACE_KANBAN_COLUMNS.map((column) => {
          const tickets = props.tickets.filter((ticket) => ticket.status === column.id);
          return html`
            <section class="workspace-kanban-column">
              <header class="workspace-kanban-column__header">
                <div>
                  <div class="workspace-kanban-column__title">${column.title}</div>
                  <div class="workspace-kanban-column__count">${tickets.length} card${tickets.length === 1 ? "" : "s"}</div>
                </div>
              </header>
              <div class="workspace-kanban-column__body">
                ${tickets.map(
                  (ticket) => html`
                  <article class="workspace-ticket">
                    <div class="workspace-ticket__header">
                      <div>
                        <div class="workspace-ticket__title">${ticket.title}</div>
                        <div class="workspace-ticket__meta">
                          ${ticket.assigneeId || "Unassigned"} • ${priorityLabel(ticket.priority)}
                        </div>
                      </div>
                      <button class="workspace-btn workspace-btn--ghost workspace-btn--tiny" @click=${() => props.onDeleteTicket(ticket.id)}>Delete</button>
                    </div>
                    ${ticket.description ? html`<p class="workspace-ticket__body">${ticket.description}</p>` : nothing}
                    <label class="workspace-field workspace-field--compact">
                      <span>Status</span>
                      <select .value=${ticket.status} @change=${(event: Event) => props.onMoveTicket(ticket.id, (event.target as HTMLSelectElement).value as WorkspaceTicketStatus)}>
                        ${WORKSPACE_KANBAN_COLUMNS.map((option) => html`<option value=${option.id}>${option.title}</option>`)}
                      </select>
                    </label>
                  </article>
                `,
                )}
              </div>
            </section>
          `;
        })}
      </div>
    </div>
  `;
}

function renderStatCard(label: string, value: string, note?: string) {
  return html`
    <section class="workspace-stat-card">
      <div class="workspace-stat-card__label">${label}</div>
      <div class="workspace-stat-card__value">${value}</div>
      ${note ? html`<div class="workspace-stat-card__note">${note}</div>` : nothing}
    </section>
  `;
}

function renderCronsPage(props: CronProps) {
  const healthyJobs = props.jobs.filter((job) => job.state?.lastStatus === "ok").length;
  const errorJobs = props.jobs.filter((job) => job.state?.lastStatus === "error").length;
  const enabledJobs = props.jobs.filter((job) => job.enabled).length;
  return html`
    <div class="workspace-page-stack">
      <div class="workspace-stat-grid">
        ${renderStatCard("Jobs", String(props.jobsTotal || props.jobs.length), `${enabledJobs} enabled`)}
        ${renderStatCard("Healthy", String(healthyJobs), errorJobs > 0 ? `${errorJobs} failing` : "No active failures")}
        ${renderStatCard("Runs", String(props.runsTotal), props.runsScope === "all" ? "Across all jobs" : "Selected job scope")}
      </div>
      ${renderEmbeddedPage(renderCron(props))}
    </div>
  `;
}

function renderActivityPage(props: LogsProps) {
  const total = props.entries.length;
  const errors = props.entries.filter(
    (entry) => entry.level === "error" || entry.level === "fatal",
  ).length;
  const warns = props.entries.filter((entry) => entry.level === "warn").length;
  return html`
    <div class="workspace-page-stack">
      <div class="workspace-stat-grid">
        ${renderStatCard("Total events", String(total), props.file ?? "Gateway logs")}
        ${renderStatCard("Errors", String(errors), warns > 0 ? `${warns} warnings` : "No warnings")}
        ${renderStatCard("Follow mode", props.autoFollow ? "Live" : "Paused", props.truncated ? "Stream truncated" : "Reading full chunk")}
      </div>
      ${renderEmbeddedPage(renderLogs(props))}
    </div>
  `;
}

function renderCostsPage(state: AppViewState) {
  const summary = state.usageCostSummary;
  const sessions = state.usageResult?.sessions ?? [];
  const totalCost =
    summary?.totals?.totalCost != null ? `$${summary.totals.totalCost.toFixed(2)}` : "Loading";
  const totalTokens =
    summary?.totals?.totalTokens != null ? summary.totals.totalTokens.toLocaleString() : "Loading";
  const sessionCount = sessions.length.toLocaleString();
  return html`
    <div class="workspace-page-stack">
      <div class="workspace-stat-grid">
        ${renderStatCard("Estimated cost", totalCost, "Derived from session usage")}
        ${renderStatCard("Tokens", totalTokens, "Input + output + cache")}
        ${renderStatCard("Sessions", sessionCount, state.usageLoading ? "Loading…" : "Current filtered range")}
      </div>
      ${renderEmbeddedPage(renderUsageTab(state, { force: true }))}
    </div>
  `;
}

function renderSettingsPage(props: ConfigProps) {
  const modeLabel = props.formMode === "form" ? "Form mode" : "Raw mode";
  const statusLabel =
    props.valid == null ? "Unknown" : props.valid ? "Valid configuration" : "Invalid configuration";
  return html`
    <div class="workspace-page-stack">
      <div class="workspace-stat-grid">
        ${renderStatCard("Mode", modeLabel, props.searchQuery ? `Search: ${props.searchQuery}` : "Workspace configuration")}
        ${renderStatCard("Status", statusLabel, props.saving ? "Saving…" : props.applying ? "Applying…" : "Ready")}
        ${renderStatCard("Schema", props.schemaLoading ? "Loading" : "Loaded", "OpenClaw-backed settings source")}
      </div>
      ${renderEmbeddedPage(renderConfig(props))}
    </div>
  `;
}

function renderEmbeddedPage(content: WorkspaceRenderable) {
  return html`<div class="workspace-embedded">${content}</div>`;
}

function pageTitle(tab: Tab): string {
  return titleForTab(tab);
}

function pageSubtitle(tab: Tab): string {
  return subtitleForTab(tab);
}

export function renderWorkspaceModule(props: WorkspaceModuleProps) {
  if (!isWorkspaceTab(props.state.tab)) {
    return nothing;
  }

  switch (props.state.tab) {
    case "workspace-messages":
      return renderPageShell(
        props,
        pageTitle(props.state.tab),
        pageSubtitle(props.state.tab),
        renderMessagesPage(props.messages),
      );
    case "workspace-map":
      return renderPageShell(
        props,
        pageTitle(props.state.tab),
        pageSubtitle(props.state.tab),
        renderMapPage(props.map),
      );
    case "workspace-memory":
      return renderPageShell(
        props,
        pageTitle(props.state.tab),
        pageSubtitle(props.state.tab),
        renderMemoryPage(props.memory),
      );
    case "workspace-kanban":
      return renderPageShell(
        props,
        pageTitle(props.state.tab),
        pageSubtitle(props.state.tab),
        renderKanbanPage(props.kanban),
      );
    case "workspace-crons":
      return renderPageShell(
        props,
        pageTitle(props.state.tab),
        pageSubtitle(props.state.tab),
        renderCronsPage(props.cron),
      );
    case "workspace-activity":
      return renderPageShell(
        props,
        pageTitle(props.state.tab),
        pageSubtitle(props.state.tab),
        renderActivityPage(props.logs),
      );
    case "workspace-costs":
      return renderPageShell(
        props,
        pageTitle(props.state.tab),
        pageSubtitle(props.state.tab),
        renderCostsPage(props.state),
      );
    case "workspace-settings":
      return renderPageShell(
        props,
        pageTitle(props.state.tab),
        pageSubtitle(props.state.tab),
        renderSettingsPage(props.config),
      );
    default:
      return nothing;
  }
}
