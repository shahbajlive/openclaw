import { html, nothing, type TemplateResult } from "lit";
import type { WorkspaceAgentRow, WorkspaceAgentsListResult } from "../types.ts";

type WorkspaceMapProps = {
  loading: boolean;
  error: string | null;
  result: WorkspaceAgentsListResult | null;
  selectedAgentId: string | null;
  onSelectAgent: (agentId: string) => void;
  onRefresh: () => void;
};

function resolveChildren(
  result: WorkspaceAgentsListResult,
  parentId: string | null,
): WorkspaceAgentRow[] {
  return result.agents.filter((agent) => (agent.reportsTo ?? null) === parentId);
}

function renderAgentNode(
  result: WorkspaceAgentsListResult,
  agent: WorkspaceAgentRow,
  props: WorkspaceMapProps,
): TemplateResult {
  const children = resolveChildren(result, agent.id);
  const selected = props.selectedAgentId === agent.id;
  return html`
    <div class="card" style="margin-top: 12px; border-color: ${selected ? "var(--accent)" : "var(--border)"};">
      <div class="row" style="justify-content: space-between; align-items: flex-start;">
        <div>
          <div class="card-title">
            ${agent.emoji ? `${agent.emoji} ` : ""}${agent.name || agent.id}
          </div>
          <div class="card-sub">${agent.title || agent.description || agent.id}</div>
        </div>
        <button class="btn btn--sm" @click=${() => props.onSelectAgent(agent.id)}>Select</button>
      </div>
      <div class="muted mono" style="margin-top: 8px;">${agent.id}</div>
      ${
        children.length > 0
          ? html`
              <div style="margin-top: 14px; padding-left: 18px; border-left: 1px solid var(--border);">
                ${children.map((child) => renderAgentNode(result, child, props))}
              </div>
            `
          : nothing
      }
    </div>
  `;
}

export function renderWorkspaceMap(props: WorkspaceMapProps) {
  const roots = props.result ? resolveChildren(props.result, null) : [];
  return html`
    <section class="card">
      <div class="row" style="justify-content: space-between;">
        <div>
          <div class="card-title">Workspace Map</div>
          <div class="card-sub">Hierarchy from the workspace registry.</div>
        </div>
        <button class="btn" ?disabled=${props.loading} @click=${props.onRefresh}>
          ${props.loading ? "Loading…" : "Refresh"}
        </button>
      </div>
      ${
        props.result
          ? html`<div class="muted mono" style="margin-top: 8px;">Workspace: ${props.result.workspaceDir}</div>`
          : nothing
      }
      ${
        props.result?.registryPath
          ? html`<div class="muted mono" style="margin-top: 4px;">Registry: ${props.result.registryPath}</div>`
          : nothing
      }
      ${
        props.error
          ? html`<div class="callout danger" style="margin-top: 12px;">${props.error}</div>`
          : nothing
      }
      ${
        !props.loading && props.result && roots.length === 0
          ? html`
              <div class="muted" style="margin-top: 12px">No workspace agents found.</div>
            `
          : nothing
      }
      <div style="margin-top: 12px;">
        ${roots.map((agent) => renderAgentNode(props.result!, agent, props))}
      </div>
    </section>
  `;
}
