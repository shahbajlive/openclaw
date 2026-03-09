import { html } from "lit";
import type { AppViewState } from "../ui/app-view-state.ts";

export function renderWorkspaceHost(state: AppViewState) {
  void state;
  return html`
    <main class="workspace-host">
      <section class="workspace-host__card">
        <h1>Opening Workspace</h1>
        <p>Workspace content should be served by the gateway proxy on this route.</p>
      </section>
    </main>
  `;
}
