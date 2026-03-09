import { html, nothing } from "lit";
import type { WorkspaceAgentsListResult, WorkspaceFilesListResult } from "../types.ts";

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

export function renderWorkspaceMemory(props: WorkspaceMemoryProps) {
  const content = props.activeFile ? (props.fileContents[props.activeFile] ?? "") : "";
  return html`
    <section class="card">
      <div class="row" style="justify-content: space-between;">
        <div>
          <div class="card-title">Workspace Memory</div>
          <div class="card-sub">Read agent instruction and memory files from the workspace.</div>
        </div>
        <button class="btn" ?disabled=${props.loading} @click=${props.onRefresh}>
          ${props.loading ? "Loading…" : "Refresh"}
        </button>
      </div>
      ${
        props.error
          ? html`<div class="callout danger" style="margin-top: 12px;">${props.error}</div>`
          : nothing
      }
      <div class="filters" style="margin-top: 14px;">
        <label class="field" style="min-width: 280px;">
          <span>Agent</span>
          <select
            .value=${props.selectedAgentId ?? ""}
            @change=${(event: Event) =>
              props.onSelectAgent((event.target as HTMLSelectElement).value)}
          >
            ${(props.agents?.agents ?? []).map(
              (agent) => html`
                <option value=${agent.id}>${agent.name || agent.id}</option>
              `,
            )}
          </select>
        </label>
      </div>
      <div class="grid" style="grid-template-columns: minmax(240px, 320px) minmax(0, 1fr); gap: 16px; margin-top: 16px;">
        <div class="card" style="margin: 0;">
          <div class="card-title">Files</div>
          <div class="card-sub">Available workspace-backed files for the selected agent.</div>
          <div style="margin-top: 12px; display: grid; gap: 8px;">
            ${(props.files?.files ?? []).map(
              (file) => html`
                <button
                  class="btn"
                  style="justify-content: space-between; ${props.activeFile === file.relativePath ? "border-color: var(--accent);" : ""}"
                  @click=${() => props.onSelectFile(file.relativePath)}
                >
                  <span>${file.label}</span>
                  <span class="mono">${file.missing ? "missing" : "open"}</span>
                </button>
              `,
            )}
            ${
              !props.loading && (props.files?.files?.length ?? 0) === 0
                ? html`
                    <div class="muted">No workspace files available.</div>
                  `
                : nothing
            }
          </div>
        </div>
        <div class="card" style="margin: 0;">
          <div class="card-title">${props.activeFile || "Select a file"}</div>
          ${
            props.files?.workspace
              ? html`<div class="card-sub mono">${props.files.workspace}</div>`
              : nothing
          }
          ${
            props.activeFile
              ? html`
                  <pre class="mono" style="margin-top: 14px; white-space: pre-wrap; overflow-x: auto;">${content}</pre>
                `
              : html`
                  <div class="muted" style="margin-top: 14px">Pick a file to inspect its contents.</div>
                `
          }
        </div>
      </div>
    </section>
  `;
}
