import { html, nothing } from "lit";
import { setTab } from "../ui/app-settings.ts";
import type { AppViewState } from "../ui/app-view-state.ts";
import { icons } from "../ui/icons.ts";
import type { WorkspaceAgentRow, WorkspaceAgentsListResult } from "../ui/types.ts";
import "./map-react-host.tsx";

type WorkspaceMapState = AppViewState & {
  workspaceMapLayout?: "teams" | "hierarchy";
  workspaceMapView?: "map" | "grid" | "feed";
  workspaceMapZoom?: number;
  workspaceMapPanX?: number;
  workspaceMapPanY?: number;
  workspaceMapInteracted?: boolean;
  workspaceMapPointerId?: number | null;
  workspaceMapDragStartX?: number;
  workspaceMapDragStartY?: number;
  workspaceMapPanStartX?: number;
  workspaceMapPanStartY?: number;
  workspaceMapQuickViewOpen?: boolean;
};

type MapNode = {
  agent: WorkspaceAgentRow;
  x: number;
  y: number;
};

type MapEdge = {
  from: string;
  to: string;
};

type MapLayoutResult = {
  nodes: MapNode[];
  edges: MapEdge[];
  width: number;
  height: number;
  roots: WorkspaceAgentRow[];
};

type TeamBucket = {
  id: string;
  label: string;
  accent: string;
  roots: WorkspaceAgentRow[];
};

const CARD_WIDTH = 260;
const CARD_HEIGHT = 112;
const CARD_GAP_X = 44;
const CARD_GAP_Y = 110;
const CANVAS_PAD_X = 56;
const CANVAS_PAD_Y = 44;
const GROUP_PAD_X = 26;
const GROUP_PAD_TOP = 44;
const GROUP_GAP = 28;
const GROUP_TOP = 190;
const ROOT_TOP = 28;

type CronStatusTone = "ok" | "error" | "idle";

function agentEmoji(agent: WorkspaceAgentRow): string {
  return agent.emoji?.trim() || "🤖";
}

function agentName(agent: WorkspaceAgentRow): string {
  return agent.name?.trim() || agent.id;
}

function agentRole(agent: WorkspaceAgentRow, result: WorkspaceAgentsListResult): string {
  const title = agent.title?.trim();
  if (title) {
    return title;
  }
  if ((agent.directReports?.length ?? 0) > 0 && (agent.reportsTo ?? null) === null) {
    return "Orchestrator";
  }
  if ((agent.directReports?.length ?? 0) > 0) {
    return "Team lead";
  }
  const manager = agent.reportsTo
    ? result.agents.find((entry) => entry.id === agent.reportsTo)
    : null;
  if (manager) {
    return `Reports to ${agentName(manager)}`;
  }
  return "OpenClaw agent";
}

function agentSummary(agent: WorkspaceAgentRow): string {
  const description = agent.description?.trim();
  if (description) {
    return description;
  }
  const reportCount = agent.directReports?.length ?? 0;
  if (reportCount > 0) {
    return `${reportCount} direct report${reportCount === 1 ? "" : "s"}`;
  }
  return "Native OpenClaw workspace agent";
}

function gridAgentTitle(agent: WorkspaceAgentRow, result: WorkspaceAgentsListResult): string {
  return agent.title?.trim() || agentRole(agent, result);
}

function gridAgentSummary(agent: WorkspaceAgentRow): string {
  return agent.description?.trim() || "";
}

function cronStatusTone(state: WorkspaceMapState, agentId: string): CronStatusTone {
  const relevant = state.cronJobs.filter((cron) => cron.agentId === agentId);
  if (relevant.some((cron) => cron.state?.lastStatus === "error")) {
    return "error";
  }
  if (relevant.some((cron) => cron.state?.lastStatus === "ok")) {
    return "ok";
  }
  return "idle";
}

function cronCount(state: WorkspaceMapState, agentId: string): number {
  return state.cronJobs.filter((cron) => cron.agentId === agentId).length;
}

function scheduleLabel(schedule: { kind?: string } & Record<string, unknown>): string {
  if (schedule.kind === "every") {
    const amount = typeof schedule.amount === "number" ? schedule.amount : null;
    const unit = typeof schedule.unit === "string" ? schedule.unit : "interval";
    return amount ? `Every ${amount} ${unit}` : "Every interval";
  }
  if (schedule.kind === "at") {
    const at = typeof schedule.at === "string" ? schedule.at : "";
    if (!at) {
      return "One-time";
    }
    const ts = Date.parse(at);
    return Number.isFinite(ts) ? new Date(ts).toLocaleString() : at;
  }
  if (schedule.kind === "cron") {
    return typeof schedule.expr === "string" ? schedule.expr : "Cron";
  }
  return "Schedule";
}

function relativeTimeFromMs(timestamp?: number): string {
  if (!timestamp || !Number.isFinite(timestamp)) {
    return "";
  }
  const diffMs = Date.now() - timestamp;
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) {
    return "Just now";
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  if (days === 1) {
    return "Yesterday";
  }
  if (days < 7) {
    return `${days}d ago`;
  }
  return new Date(timestamp).toLocaleDateString();
}

function agentAccent(agent: WorkspaceAgentRow): string {
  const raw = agent.color?.trim();
  return raw || "var(--workspace-border)";
}

function buildChildMap(result: WorkspaceAgentsListResult) {
  const byId = new Map(result.agents.map((agent) => [agent.id, agent]));
  const childIdsByParent = new Map<string | null, string[]>();

  const addChild = (parentId: string | null, childId: string) => {
    const existing = childIdsByParent.get(parentId) ?? [];
    if (!existing.includes(childId)) {
      childIdsByParent.set(parentId, [...existing, childId]);
    }
  };

  for (const agent of result.agents) {
    const normalizedParent =
      agent.reportsTo && byId.has(agent.reportsTo) && agent.reportsTo !== agent.id
        ? agent.reportsTo
        : null;
    addChild(normalizedParent, agent.id);
  }

  for (const agent of result.agents) {
    for (const childId of agent.directReports ?? []) {
      if (!byId.has(childId) || childId === agent.id) {
        continue;
      }
      addChild(agent.id, childId);
    }
  }

  for (const [parentId, childIds] of childIdsByParent.entries()) {
    childIds.sort((a, b) => agentName(byId.get(a)!).localeCompare(agentName(byId.get(b)!)));
    childIdsByParent.set(parentId, childIds);
  }

  return { byId, childIdsByParent };
}

function resolveRoots(result: WorkspaceAgentsListResult): WorkspaceAgentRow[] {
  const { byId, childIdsByParent } = buildChildMap(result);
  const explicitRoots = (childIdsByParent.get(null) ?? [])
    .map((id) => byId.get(id))
    .filter((agent): agent is WorkspaceAgentRow => Boolean(agent));
  if (explicitRoots.length > 0) {
    return explicitRoots;
  }
  return result.agents.slice(0, 1);
}

function buildHierarchyLayout(result: WorkspaceAgentsListResult): MapLayoutResult {
  const { byId, childIdsByParent } = buildChildMap(result);
  const roots = resolveRoots(result);
  const nodes = new Map<string, MapNode>();
  const edges = new Map<string, MapEdge>();

  const placeSubtree = (
    agentId: string,
    depth: number,
    offsetX: number,
    branchSeen: Set<string>,
  ): number => {
    const agent = byId.get(agentId);
    if (!agent) {
      return CARD_WIDTH;
    }
    const children = (childIdsByParent.get(agentId) ?? []).filter(
      (childId) => !branchSeen.has(childId),
    );
    const nextSeen = new Set(branchSeen);
    nextSeen.add(agentId);

    let childX = offsetX;
    const childWidths = children.map((childId) => {
      const width = placeSubtree(childId, depth + 1, childX, nextSeen);
      childX += width + CARD_GAP_X;
      return width;
    });

    const totalChildrenWidth =
      childWidths.length > 0
        ? childWidths.reduce((sum, width) => sum + width, 0) + CARD_GAP_X * (childWidths.length - 1)
        : 0;
    const subtreeWidth = Math.max(CARD_WIDTH, totalChildrenWidth);
    const nodeX = offsetX + subtreeWidth / 2 - CARD_WIDTH / 2;
    const nodeY = depth * (CARD_HEIGHT + CARD_GAP_Y);
    nodes.set(agentId, { agent, x: nodeX, y: nodeY });

    for (const childId of children) {
      if (!byId.has(childId)) {
        continue;
      }
      edges.set(`${agentId}:${childId}`, { from: agentId, to: childId });
    }
    return subtreeWidth;
  };

  let cursorX = 0;
  for (const root of roots) {
    const width = placeSubtree(root.id, 0, cursorX, new Set<string>());
    cursorX += width + CARD_GAP_X * 2;
  }

  const nodeList = [...nodes.values()];
  if (nodeList.length === 0) {
    return {
      nodes: [],
      edges: [],
      width: CARD_WIDTH + CANVAS_PAD_X * 2,
      height: CARD_HEIGHT + CANVAS_PAD_Y * 2,
      roots,
    };
  }

  const minX = Math.min(...nodeList.map((node) => node.x));
  const maxX = Math.max(...nodeList.map((node) => node.x + CARD_WIDTH));
  const maxY = Math.max(...nodeList.map((node) => node.y + CARD_HEIGHT));

  return {
    roots,
    nodes: nodeList.map((node) => ({
      ...node,
      x: node.x - minX + CANVAS_PAD_X,
      y: node.y + CANVAS_PAD_Y,
    })),
    edges: [...edges.values()],
    width: maxX - minX + CANVAS_PAD_X * 2,
    height: maxY + CANVAS_PAD_Y * 2,
  };
}

function buildTeamBuckets(result: WorkspaceAgentsListResult): {
  root: WorkspaceAgentRow | null;
  buckets: TeamBucket[];
} {
  const roots = resolveRoots(result);
  const root = roots[0] ?? null;
  if (!root) {
    return { root: null, buckets: [] };
  }
  const byId = new Map(result.agents.map((agent) => [agent.id, agent]));
  const placed = new Set<string>([root.id]);
  const buckets: TeamBucket[] = [];
  const rootChildren = (root.directReports ?? [])
    .map((id) => byId.get(id))
    .filter((agent): agent is WorkspaceAgentRow => Boolean(agent));

  for (const child of rootChildren) {
    placed.add(child.id);
    if ((child.directReports?.length ?? 0) > 0) {
      buckets.push({
        id: `team:${child.id}`,
        label: `Team ${agentName(child)}`,
        accent: agentAccent(child),
        roots: [child],
      });
      for (const reportId of child.directReports ?? []) {
        placed.add(reportId);
      }
    }
  }

  const soloOps = rootChildren.filter((agent) => (agent.directReports?.length ?? 0) === 0);
  if (soloOps.length > 0) {
    soloOps.forEach((agent) => placed.add(agent.id));
    buckets.push({
      id: "solo",
      label: "Solo Ops",
      accent: agentAccent(root),
      roots: soloOps,
    });
  }

  const disconnected = result.agents.filter(
    (agent) => !placed.has(agent.id) && agent.id !== root.id,
  );
  if (disconnected.length > 0) {
    buckets.push({
      id: "unlinked",
      label: "Unlinked",
      accent: "var(--workspace-border)",
      roots: disconnected,
    });
  }

  return { root, buckets };
}

function buildTeamsLayout(result: WorkspaceAgentsListResult): MapLayoutResult {
  const { byId, childIdsByParent } = buildChildMap(result);
  const { root, buckets } = buildTeamBuckets(result);
  if (!root) {
    return buildHierarchyLayout(result);
  }

  const nodes: MapNode[] = [];
  const edges = new Map<string, MapEdge>();
  const rootNode: MapNode = { agent: root, x: 0, y: ROOT_TOP };
  nodes.push(rootNode);

  let cursorX = 0;
  for (const bucket of buckets) {
    let bucketMinX = Infinity;
    let bucketMaxX = -Infinity;
    let bucketMaxY = 0;

    const placeSubtree = (
      agentId: string,
      depth: number,
      offsetX: number,
      branchSeen: Set<string>,
    ): number => {
      const agent = byId.get(agentId);
      if (!agent) {
        return CARD_WIDTH;
      }
      const children = (childIdsByParent.get(agentId) ?? []).filter(
        (childId) => !branchSeen.has(childId),
      );
      const nextSeen = new Set(branchSeen);
      nextSeen.add(agentId);

      let childX = offsetX;
      const childWidths = children.map((childId) => {
        const width = placeSubtree(childId, depth + 1, childX, nextSeen);
        childX += width + CARD_GAP_X;
        return width;
      });
      const totalChildrenWidth =
        childWidths.length > 0
          ? childWidths.reduce((sum, width) => sum + width, 0) +
            CARD_GAP_X * (childWidths.length - 1)
          : 0;
      const subtreeWidth = Math.max(CARD_WIDTH, totalChildrenWidth);
      const x = offsetX + subtreeWidth / 2 - CARD_WIDTH / 2;
      const y = GROUP_TOP + GROUP_PAD_TOP + depth * (CARD_HEIGHT + CARD_GAP_Y);
      bucketMinX = Math.min(bucketMinX, x);
      bucketMaxX = Math.max(bucketMaxX, x + CARD_WIDTH);
      bucketMaxY = Math.max(bucketMaxY, y + CARD_HEIGHT);
      nodes.push({ agent, x, y });
      for (const childId of children) {
        if (!byId.has(childId)) {
          continue;
        }
        edges.set(`${agentId}:${childId}`, { from: agentId, to: childId });
      }
      return subtreeWidth;
    };

    let localX = cursorX + GROUP_PAD_X;
    for (const bucketRoot of bucket.roots) {
      const width = placeSubtree(bucketRoot.id, 0, localX, new Set<string>());
      localX += width + CARD_GAP_X;
      edges.set(`${root.id}:${bucketRoot.id}`, { from: root.id, to: bucketRoot.id });
    }

    cursorX = Math.max(cursorX, bucketMaxX + GROUP_PAD_X + GROUP_GAP);
  }

  const nonRootNodes = nodes.filter((node) => node.agent.id !== root.id);
  const groupWidth =
    nonRootNodes.length > 0
      ? Math.max(...nonRootNodes.map((node) => node.x + CARD_WIDTH)) -
        Math.min(...nonRootNodes.map((node) => node.x))
      : CARD_WIDTH;
  rootNode.x = Math.max(CANVAS_PAD_X, groupWidth / 2 - CARD_WIDTH / 2 + CANVAS_PAD_X);

  const minX = Math.min(rootNode.x, ...nonRootNodes.map((node) => node.x));
  const maxX = Math.max(
    rootNode.x + CARD_WIDTH,
    ...nonRootNodes.map((node) => node.x + CARD_WIDTH),
  );
  const maxY = Math.max(
    rootNode.y + CARD_HEIGHT,
    ...nonRootNodes.map((node) => node.y + CARD_HEIGHT),
    GROUP_TOP,
  );

  return {
    roots: [root],
    nodes: nodes.map((node) => ({
      ...node,
      x: node.x - minX + CANVAS_PAD_X,
      y: node.y + CANVAS_PAD_Y,
    })),
    edges: [...edges.values()],
    width: maxX - minX + CANVAS_PAD_X * 2,
    height: maxY + CANVAS_PAD_Y * 2,
  };
}

function renderLegend() {
  return html`
    <div class="workspace-map-legend">
      <span class="workspace-map-legend__item">
        <i class="workspace-map-legend__icon is-healthy">${icons.check}</i>
        Healthy
      </span>
      <span class="workspace-map-legend__item">
        <i class="workspace-map-legend__icon is-errors">${icons.bug}</i>
        Errors
      </span>
      <span class="workspace-map-legend__item">
        <i class="workspace-map-legend__icon is-muted">${icons.circle}</i>
        No crons
      </span>
    </div>
  `;
}

function renderViewIcon(view: "map" | "grid" | "feed") {
  if (view === "map") {
    return icons.folder;
  }
  if (view === "grid") {
    return icons.monitor;
  }
  return icons.scrollText;
}

function renderViewSwitcher(state: WorkspaceMapState) {
  return html`
    <div class="workspace-map-view-switcher" role="tablist" aria-label="Workspace map views">
      ${(
        [
          ["map", "Map"],
          ["grid", "Grid"],
          ["feed", "Feed"],
        ] as const
      ).map(
        ([view, label]) => html`
          <button
            class="workspace-map-view-switcher__btn ${state.workspaceMapView === view ? "is-active" : ""}"
            type="button"
            @click=${() => {
              state.workspaceMapView = view;
              if (view === "map") {
                state.workspaceMapInteracted = false;
              }
            }}
          >
            <span class="workspace-map-view-switcher__icon">${renderViewIcon(view)}</span>
            ${label}
          </button>
        `,
      )}
    </div>
  `;
}

function selectAgentAndOpenOverview(state: WorkspaceMapState, agent: WorkspaceAgentRow) {
  state.workspaceSelectedAgentId = agent.id;
  state.applySettings({
    ...state.settings,
    workspaceSelectedAgentId: agent.id,
  });
  state.agentsSelectedId = agent.id;
  state.agentsPanel = "overview";
  setTab(state as unknown as Parameters<typeof setTab>[0], "agents");
}

function selectAgentInMap(state: WorkspaceMapState, agent: WorkspaceAgentRow) {
  state.workspaceSelectedAgentId = agent.id;
  state.workspaceMapQuickViewOpen = true;
  state.applySettings({
    ...state.settings,
    workspaceSelectedAgentId: agent.id,
  });
}

function closeMapQuickView(state: WorkspaceMapState) {
  state.workspaceMapQuickViewOpen = false;
}

function openAgentMessages(state: WorkspaceMapState, agent: WorkspaceAgentRow) {
  state.workspaceSelectedAgentId = agent.id;
  state.applySettings({
    ...state.settings,
    workspaceSelectedAgentId: agent.id,
  });
  setTab(state as unknown as Parameters<typeof setTab>[0], "workspace-messages");
}

function toolLabel(toolId: string): string {
  return toolId.replace(/[_-]+/g, " ").trim();
}

function toolGlyph(toolId: string) {
  const id = toolId.toLowerCase();
  if (id.includes("read")) {
    return icons.folder;
  }
  if (id.includes("write") || id.includes("edit")) {
    return icons.edit;
  }
  if (id.includes("exec") || id.includes("process")) {
    return icons.monitor;
  }
  if (id.includes("message") || id.includes("session")) {
    return icons.messageSquare;
  }
  return icons.wrench;
}

function renderQuickAgentView(
  state: WorkspaceMapState,
  agent: WorkspaceAgentRow,
  result: WorkspaceAgentsListResult,
) {
  const tone = cronStatusTone(state, agent.id);
  const crons = state.cronJobs.filter((cron) => cron.agentId === agent.id);
  const errors = crons.filter((cron) => cron.state?.lastStatus === "error").length;
  const tools = agent.tools?.length ?? 0;
  const reports = agent.directReports?.length ?? 0;
  const manager = agent.reportsTo
    ? (result.agents.find((entry) => entry.id === agent.reportsTo) ?? null)
    : null;
  const directReports = (agent.directReports ?? [])
    .map((id) => result.agents.find((entry) => entry.id === id))
    .filter((entry): entry is WorkspaceAgentRow => Boolean(entry))
    .slice(0, 4);
  const visibleTools = (agent.tools ?? []).slice(0, 8);
  return html`
    <aside class="workspace-map-quickview card">
      <header class="workspace-map-quickview__header">
        <button class="workspace-map-quickview__agent" type="button" @click=${() => selectAgentAndOpenOverview(state, agent)}>
          <span class="workspace-map-quickview__avatar" style=${`--workspace-node-accent:${agentAccent(agent)};`}>
            ${agentEmoji(agent)}
          </span>
          <span class="workspace-map-quickview__identity">
            <strong>${agentName(agent)}</strong>
            <small>${agentRole(agent, result)}</small>
          </span>
        </button>
        <button class="workspace-map-quickview__close" type="button" @click=${() => closeMapQuickView(state)} aria-label="Close quick view">
          ×
        </button>
      </header>
      <p class="workspace-map-quickview__summary">${agentSummary(agent)}</p>
      <div class="workspace-map-quickview__actions">
        <button class="workspace-map-quickview__action is-primary" type="button" @click=${() => openAgentMessages(state, agent)}>
          ${icons.messageSquare}
          Message
        </button>
        <button class="workspace-map-quickview__action" type="button" @click=${() => selectAgentAndOpenOverview(state, agent)}>
          ${icons.folder}
          Profile
        </button>
      </div>
      <div class="workspace-map-quickview__stats">
        <span>${tools} tools</span>
        <span>${reports} report${reports === 1 ? "" : "s"}</span>
        <span>${crons.length} cron${crons.length === 1 ? "" : "s"}</span>
      </div>
      <div class="workspace-map-quickview__status ${tone === "error" ? "is-error" : tone === "ok" ? "is-ok" : "is-idle"}">
        ${tone === "error" ? `${errors} error${errors === 1 ? "" : "s"}` : tone === "ok" ? "Healthy" : "No recent cron health"}
      </div>
      <section class="workspace-map-quickview__section">
        <h4>Capabilities</h4>
        <div class="workspace-map-quickview__capabilities">
          ${
            visibleTools.length > 0
              ? visibleTools.map(
                  (tool) => html`<div class="workspace-map-quickview__capability">
                    <i>${toolGlyph(tool)}</i>
                    <span>${toolLabel(tool)}</span>
                  </div>`,
                )
              : html`
                  <div class="workspace-map-quickview__empty">No configured tools.</div>
                `
          }
        </div>
      </section>
      <section class="workspace-map-quickview__section">
        <h4>Organization</h4>
        <div class="workspace-map-quickview__org">
          ${
            manager
              ? html`<button class="workspace-map-quickview__org-item" type="button" @click=${() => selectAgentInMap(state, manager)}>
                  <span class="workspace-map-quickview__org-emoji">${agentEmoji(manager)}</span>
                  <span class="workspace-map-quickview__org-text">
                    <strong>${agentName(manager)}</strong>
                    <small>Reports to</small>
                  </span>
                </button>`
              : html`
                  <div class="workspace-map-quickview__empty">Root orchestrator.</div>
                `
          }
          ${
            directReports.length > 0
              ? directReports.map(
                  (
                    entry,
                  ) => html`<button class="workspace-map-quickview__org-item" type="button" @click=${() => selectAgentInMap(state, entry)}>
                    <span class="workspace-map-quickview__org-emoji">${agentEmoji(entry)}</span>
                    <span class="workspace-map-quickview__org-text">
                      <strong>${agentName(entry)}</strong>
                      <small>Direct report</small>
                    </span>
                  </button>`,
                )
              : nothing
          }
        </div>
      </section>
    </aside>
  `;
}

function renderGridCard(
  state: WorkspaceMapState,
  result: WorkspaceAgentsListResult,
  agent: WorkspaceAgentRow,
) {
  const selected = state.workspaceSelectedAgentId === agent.id;
  const accent = agentAccent(agent);
  const toolCount = agent.tools?.length ?? 0;
  return html`
    <button
      class="workspace-grid-card card ${selected ? "is-selected" : ""}"
      style=${`--workspace-node-accent:${accent};`}
      type="button"
      @click=${() => selectAgentInMap(state, agent)}
    >
      <div class="workspace-grid-card__avatar">${agentEmoji(agent)}</div>
      <div class="workspace-grid-card__body">
        <div class="workspace-grid-card__name">${agentName(agent)}</div>
        <div class="workspace-grid-card__role">${gridAgentTitle(agent, result)}</div>
        ${
          gridAgentSummary(agent)
            ? html`<div class="workspace-grid-card__summary">${gridAgentSummary(agent)}</div>`
            : nothing
        }
      </div>
      ${
        toolCount > 0
          ? html`<div class="workspace-grid-card__aside">
            <span class="workspace-grid-pill is-tools">${toolCount} tools</span>
          </div>`
          : nothing
      }
    </button>
  `;
}

function renderGridView(state: WorkspaceMapState, result: WorkspaceAgentsListResult) {
  const byId = new Map(result.agents.map((agent) => [agent.id, agent]));
  const roots = resolveRoots(result);
  const root = byId.get(result.defaultId) ?? roots[0] ?? result.agents[0] ?? null;
  const teamManagers =
    root?.directReports
      ?.map((id) => byId.get(id))
      .filter((agent): agent is WorkspaceAgentRow => Boolean(agent))
      .filter((agent) => (agent.directReports?.length ?? 0) > 0) ?? [];
  const soloOps =
    root?.directReports
      ?.map((id) => byId.get(id))
      .filter((agent): agent is WorkspaceAgentRow => Boolean(agent))
      .filter((agent) => (agent.directReports?.length ?? 0) === 0) ?? [];
  const totalCrons = result.agents.reduce((sum, agent) => sum + cronCount(state, agent.id), 0);
  const okCrons = state.cronJobs.filter((cron) => cron.state?.lastStatus === "ok").length;
  const errorCrons = state.cronJobs.filter((cron) => cron.state?.lastStatus === "error").length;
  const healthPct = totalCrons === 0 ? 100 : Math.round((okCrons / Math.max(totalCrons, 1)) * 100);

  return html`
    <div class="workspace-grid-view">
      ${
        root
          ? html`
              <button
                class="workspace-grid-hero card ${state.workspaceSelectedAgentId === root.id ? "is-selected" : ""}"
                style=${`--workspace-node-accent:${agentAccent(root)};`}
                type="button"
                @click=${() => selectAgentInMap(state, root)}
              >
                <div class="workspace-grid-hero__avatar">${agentEmoji(root)}</div>
                <div class="workspace-grid-hero__content">
                  <div class="workspace-grid-hero__name">${agentName(root)}</div>
                  <div class="workspace-grid-hero__role">${gridAgentTitle(root, result)}</div>
                  ${
                    gridAgentSummary(root)
                      ? html`<div class="workspace-grid-hero__summary">${gridAgentSummary(root)}</div>`
                      : nothing
                  }
                </div>
                <div class="workspace-grid-hero__stats">
                  <div class="workspace-grid-hero__stat">
                    <strong>${result.agents.length}</strong>
                    <span>agents</span>
                  </div>
                  <div class="workspace-grid-hero__divider"></div>
                  <div class="workspace-grid-hero__stat">
                    <strong>${totalCrons}</strong>
                    <span>crons</span>
                  </div>
                  <div class="workspace-grid-hero__divider"></div>
                  <div class="workspace-grid-hero__stat">
                    <strong class=${errorCrons > 0 ? "is-danger" : "is-healthy"}>${healthPct}%</strong>
                    <span>health</span>
                  </div>
                </div>
              </button>
            `
          : nothing
      }
      <div class="workspace-grid-columns">
        ${teamManagers.map((manager) => {
          const members =
            manager.directReports
              ?.map((id) => byId.get(id))
              .filter((agent): agent is WorkspaceAgentRow => Boolean(agent)) ?? [];
          const teamErrors = state.cronJobs.filter(
            (cron) =>
              cron.state?.lastStatus === "error" &&
              (cron.agentId === manager.id || members.some((member) => member.id === cron.agentId)),
          ).length;
          return html`
            <section class="workspace-grid-section card">
              <header class="workspace-grid-section__header">
                <div class="workspace-grid-section__lead">
                  <div
                    class="workspace-grid-section__badge"
                    style=${`--workspace-node-accent:${agentAccent(manager)};`}
                  >
                    ${agentEmoji(manager)}
                  </div>
                  <div class="workspace-grid-section__title">Team ${agentName(manager)}</div>
                </div>
                <div class="workspace-grid-section__count">
                  ${1 + members.length} agents
                  ${teamErrors > 0 ? html`<span class="workspace-grid-section__errors">${teamErrors} err</span>` : nothing}
                </div>
              </header>
              <div class="workspace-grid-stack">
                ${renderGridCard(state, result, manager)}
                ${members.map((member) => renderGridCard(state, result, member))}
              </div>
            </section>
          `;
        })}
        ${
          soloOps.length > 0
            ? html`
            <section class="workspace-grid-section card">
              <header class="workspace-grid-section__header">
                <div class="workspace-grid-section__lead">
                  <div class="workspace-grid-section__badge is-neutral">⚡</div>
                  <div class="workspace-grid-section__title">Solo Ops</div>
                </div>
                <div class="workspace-grid-section__count">${soloOps.length} agents</div>
              </header>
                  <div class="workspace-grid-stack">
                    ${soloOps.map((agent) => renderGridCard(state, result, agent))}
                  </div>
                </section>
              `
            : nothing
        }
      </div>
    </div>
  `;
}

function renderFeedView(state: WorkspaceMapState, result: WorkspaceAgentsListResult) {
  const items = state.cronJobs
    .filter((cron) => cron.agentId && result.agents.some((agent) => agent.id === cron.agentId))
    .toSorted((a, b) => (b.state?.lastRunAtMs ?? 0) - (a.state?.lastRunAtMs ?? 0));
  const selectedFilter = state.workspaceMapFeedFilter ?? "all";
  const filtered = items.filter((cron) => {
    const status = cron.state?.lastStatus ?? "idle";
    if (selectedFilter === "all") {
      return true;
    }
    if (selectedFilter === "ok") {
      return status === "ok";
    }
    return status === "error";
  });
  const byId = new Map(result.agents.map((agent) => [agent.id, agent]));
  const counts = {
    all: items.length,
    ok: items.filter((cron) => cron.state?.lastStatus === "ok").length,
    error: items.filter((cron) => cron.state?.lastStatus === "error").length,
  };
  const idleCount = items.filter((cron) => !cron.state?.lastStatus).length;

  return html`
    <div class="workspace-feed-view">
      <div class="workspace-feed-stats">
        <div class="workspace-feed-stat"><strong>${counts.all}</strong><span>Total crons</span></div>
        <div class="workspace-feed-stat"><strong>${counts.ok}</strong><span>Healthy</span></div>
        <div class="workspace-feed-stat"><strong>${counts.error}</strong><span>Errors</span></div>
        <div class="workspace-feed-stat"><strong>${idleCount}</strong><span>Idle</span></div>
      </div>
      <div class="workspace-feed-filters" role="tablist" aria-label="Feed filter">
        ${(
          [
            ["all", "All", counts.all],
            ["ok", "Healthy", counts.ok],
            ["error", "Errors", counts.error],
          ] as const
        ).map(
          ([value, label, count]) => html`
            <button
              class="workspace-feed-filter ${selectedFilter === value ? "is-active" : ""}"
              type="button"
              @click=${() => {
                state.workspaceMapFeedFilter = value;
              }}
            >
              <i class="workspace-feed-filter__dot ${value === "ok" ? "is-ok" : value === "error" ? "is-error" : ""}"></i>
              <span>${label}</span>
              <strong>${count}</strong>
            </button>
          `,
        )}
      </div>
      <div class="workspace-feed-list">
        ${
          filtered.length === 0
            ? html`
                <div class="workspace-org-empty">No matching cron activity.</div>
              `
            : filtered.map((cron) => {
                const agent = cron.agentId ? byId.get(cron.agentId) : null;
                const status = cron.state?.lastStatus ?? "idle";
                return html`
                  <button
                    class="workspace-feed-row"
                    type="button"
                    ?disabled=${!agent}
                    @click=${() => {
                      if (agent) {
                        selectAgentInMap(state, agent);
                      }
                    }}
                  >
                    <div class="workspace-feed-row__avatar">${agent ? agentEmoji(agent) : "⚙"}</div>
                    <div class="workspace-feed-row__main">
                      <div class="workspace-feed-row__title">
                        <span>${agent ? agentName(agent) : "Unknown agent"}</span>
                        <span class="workspace-feed-row__cron">${cron.name}</span>
                      </div>
                      <div class="workspace-feed-row__meta">
                        <span>${scheduleLabel(cron.schedule as Record<string, unknown>)}</span>
                        ${
                          cron.state?.lastRunAtMs
                            ? html`<span>&middot;</span><span>${relativeTimeFromMs(cron.state.lastRunAtMs)}</span>`
                            : nothing
                        }
                      </div>
                      ${
                        cron.state?.lastError && status === "error"
                          ? html`<div class="workspace-feed-row__error">${cron.state.lastError}</div>`
                          : nothing
                      }
                    </div>
                    <div class="workspace-feed-row__right">
                      <span class="workspace-feed-status ${status === "error" ? "is-error" : status === "ok" ? "is-ok" : ""}">
                        ${status === "ok" ? "healthy" : status}
                      </span>
                      <span class="workspace-feed-schedule">${scheduleLabel(cron.schedule as Record<string, unknown>)}</span>
                    </div>
                  </button>
                `;
              })
        }
      </div>
    </div>
  `;
}

export function renderWorkspaceMapPage(state: WorkspaceMapState) {
  const result = state.workspaceAgentsList;
  const selectedAgent =
    result?.agents.find((agent) => agent.id === state.workspaceSelectedAgentId) ?? null;
  const view = state.workspaceMapView ?? "map";
  const layoutMode = state.workspaceMapLayout ?? "hierarchy";
  const layout =
    result && result.agents.length > 0
      ? layoutMode === "teams"
        ? buildTeamsLayout(result)
        : buildHierarchyLayout(result)
      : null;
  return html`
    <section class="workspace-org-page">
      ${
        state.workspaceAgentsError
          ? html`<div class="workspace-org-page__alert">${state.workspaceAgentsError}</div>`
          : nothing
      }

      ${
        view === "map"
          ? html`
              <div class="workspace-org-canvas-shell workspace-org-canvas-shell--clawport">
                <div class="workspace-org-overlay workspace-org-overlay--top-left">
                  ${renderViewSwitcher(state)}
                </div>
                <div class="workspace-org-overlay workspace-org-overlay--top-right">
                  <div class="workspace-map-toolbar">${renderLegend()}</div>
                </div>

                ${
                  !layout || layout.nodes.length === 0
                    ? html`
                        <div class="workspace-org-empty">No workspace agents found.</div>
                      `
                    : html`
                        <workspace-map-react-host
                          class="workspace-map-react-host"
                          .props=${{
                            result: result!,
                            cronJobs: state.cronJobs,
                            selectedAgentId: state.workspaceSelectedAgentId,
                            layoutMode,
                            onSelectAgent: (agentId: string) => {
                              const agent = result!.agents.find((entry) => entry.id === agentId);
                              if (agent) {
                                selectAgentInMap(state, agent);
                              }
                            },
                            onLayoutChange: (mode: "teams" | "hierarchy") => {
                              state.workspaceMapLayout = mode;
                            },
                          }}
                        ></workspace-map-react-host>
                      `
                }
                ${
                  state.workspaceMapQuickViewOpen && selectedAgent
                    ? html`<div class="workspace-org-overlay workspace-org-overlay--quickview">
                        ${renderQuickAgentView(state, selectedAgent, result!)}
                      </div>`
                    : nothing
                }
              </div>
            `
          : nothing
      }
      ${
        view === "grid" && result
          ? html`
              <div class="workspace-subview-shell">
                <div class="workspace-org-overlay workspace-org-overlay--inline">
                  ${renderViewSwitcher(state)}
                </div>
                ${renderGridView(state, result)}
                ${
                  state.workspaceMapQuickViewOpen && selectedAgent
                    ? html`<div class="workspace-org-overlay workspace-org-overlay--quickview">
                        ${renderQuickAgentView(state, selectedAgent, result)}
                      </div>`
                    : nothing
                }
              </div>
            `
          : nothing
      }
      ${
        view === "feed" && result
          ? html`
              <div class="workspace-subview-shell">
                <div class="workspace-org-overlay workspace-org-overlay--inline">
                  ${renderViewSwitcher(state)}
                </div>
                ${renderFeedView(state, result)}
              </div>
            `
          : nothing
      }
      ${nothing}
    </section>
  `;
}
