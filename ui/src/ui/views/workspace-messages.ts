import { html } from "lit";
import type { WorkspaceAgentsListResult } from "../types.ts";
import type { ChatProps } from "./chat.ts";
import { renderChat } from "./chat.ts";

type WorkspaceMessagesProps = {
  agents: WorkspaceAgentsListResult | null;
  agentsLoading: boolean;
  agentsError: string | null;
  selectedAgentId: string | null;
  onSelectAgent: (agentId: string) => void;
  onRefreshAgents: () => void;
  chat: ChatProps;
};

export function renderWorkspaceMessages(props: WorkspaceMessagesProps) {
  return html`
    <section class="card" style="margin-bottom: 16px;">
      <div class="row" style="justify-content: space-between;">
        <div>
          <div class="card-title">Workspace Messages</div>
          <div class="card-sub">Chat with workspace agents through isolated OpenClaw sessions.</div>
        </div>
        <button class="btn" ?disabled=${props.agentsLoading} @click=${props.onRefreshAgents}>
          ${props.agentsLoading ? "Loading…" : "Refresh agents"}
        </button>
      </div>
      ${
        props.agentsError
          ? html`<div class="callout danger" style="margin-top: 12px;">${props.agentsError}</div>`
          : ""
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
    </section>
    ${renderChat(props.chat)}
  `;
}
