import dagre from "@dagrejs/dagre";
import {
  ConnectionLineType,
  Controls,
  Handle,
  Panel,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import React, { useCallback, useMemo } from "react";
import { createRoot, type Root } from "react-dom/client";
import "@xyflow/react/dist/style.css";
import type { CronJob, WorkspaceAgentRow, WorkspaceAgentsListResult } from "../ui/types.ts";

type MapLayout = "teams" | "hierarchy";

type WorkspaceMapReactProps = {
  result: WorkspaceAgentsListResult;
  cronJobs: CronJob[];
  selectedAgentId: string | null;
  layoutMode: MapLayout;
  onSelectAgent: (agentId: string) => void;
  onLayoutChange: (mode: MapLayout) => void;
};

type AgentNodeData = WorkspaceAgentRow & {
  crons: CronJob[];
  accent: string;
  role: string;
  summary: string;
};

const NODE_W = 260;
const NODE_H = 112;
const COL_GAP = 80;
const GROUP_PAD_X = 30;
const GROUP_PAD_TOP = 36;
const GROUP_PAD_BOTTOM = 24;

function agentName(agent: WorkspaceAgentRow): string {
  return agent.name?.trim() || agent.id;
}

function agentEmoji(agent: WorkspaceAgentRow): string {
  return agent.emoji?.trim() || "🤖";
}

function agentSummary(agent: WorkspaceAgentRow): string {
  const description = agent.description?.replace(/\s+/g, " ").trim();
  if (description) {
    return description.length > 120 ? `${description.slice(0, 119).trimEnd()}…` : description;
  }
  const reportCount = agent.directReports?.length ?? 0;
  if (reportCount > 0) {
    return `${reportCount} direct report${reportCount === 1 ? "" : "s"}`;
  }
  return "Native OpenClaw workspace agent";
}

function agentAccent(agent: WorkspaceAgentRow): string {
  return agent.color?.trim() || "var(--workspace-border)";
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
  return manager ? `Reports to ${agentName(manager)}` : "OpenClaw agent";
}

function mergeAgentsWithCrons(result: WorkspaceAgentsListResult, cronJobs: CronJob[]) {
  const withCrons = result.agents.map((agent) => ({
    ...agent,
    accent: agentAccent(agent),
    role: agentRole(agent, result),
    summary: agentSummary(agent),
    crons: cronJobs.filter((cron) => cron.agentId === agent.id),
  }));
  return new Map(withCrons.map((agent) => [agent.id, agent]));
}

function buildEdges(result: WorkspaceAgentsListResult, selectedId: string | null): Edge[] {
  const agentMap = new Map(result.agents.map((agent) => [agent.id, agent]));
  const selectedAgentIds = new Set<string>();
  if (selectedId) {
    selectedAgentIds.add(selectedId);
    const selected = agentMap.get(selectedId);
    if (selected) {
      if (selected.reportsTo) {
        selectedAgentIds.add(selected.reportsTo);
      }
      for (const id of selected.directReports ?? []) {
        selectedAgentIds.add(id);
      }
    }
  }
  const edges: Edge[] = [];
  for (const agent of result.agents) {
    for (const childId of agent.directReports ?? []) {
      if (!agentMap.has(childId)) {
        continue;
      }
      const highlighted =
        Boolean(selectedId) && selectedAgentIds.has(agent.id) && selectedAgentIds.has(childId);
      edges.push({
        id: `${agent.id}-${childId}`,
        source: agent.id,
        target: childId,
        type: "smoothstep",
        style: {
          stroke: highlighted ? "var(--workspace-map-edge-active)" : "var(--workspace-map-edge)",
          strokeWidth: highlighted ? 2.5 : 1.5,
          opacity: highlighted ? 1 : 0.8,
        },
        animated: highlighted,
      });
    }
  }
  return edges;
}

function dagreLayout(
  nodeIds: string[],
  parentChildEdges: Array<[string, string]>,
  opts: { rankdir?: string; nodesep?: number; ranksep?: number } = {},
): Map<string, { x: number; y: number }> {
  const graph = new dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
  graph.setGraph({
    rankdir: opts.rankdir ?? "TB",
    nodesep: opts.nodesep ?? 60,
    ranksep: opts.ranksep ?? 140,
    marginx: 20,
    marginy: 20,
  });
  for (const id of nodeIds) {
    graph.setNode(id, { width: NODE_W, height: NODE_H });
  }
  for (const [source, target] of parentChildEdges) {
    graph.setEdge(source, target);
  }
  dagre.layout(graph);
  const positions = new Map<string, { x: number; y: number }>();
  for (const id of nodeIds) {
    const node = graph.node(id);
    positions.set(id, { x: node.x - NODE_W / 2, y: node.y - NODE_H / 2 });
  }
  return positions;
}

function buildTeamGroups(result: WorkspaceAgentsListResult) {
  const root =
    result.agents.find((agent) => (agent.reportsTo ?? null) === null) ?? result.agents[0] ?? null;
  if (!root) {
    return { root: null, teams: [], soloOps: [] };
  }
  const byId = new Map(result.agents.map((agent) => [agent.id, agent]));
  const teamManagers: WorkspaceAgentRow[] = [];
  const soloOps: WorkspaceAgentRow[] = [];
  for (const childId of root.directReports ?? []) {
    const child = byId.get(childId);
    if (!child) {
      continue;
    }
    if ((child.directReports?.length ?? 0) > 0) {
      teamManagers.push(child);
    } else {
      soloOps.push(child);
    }
  }
  const teams = teamManagers.map((manager) => {
    const members: WorkspaceAgentRow[] = [];
    const visited = new Set<string>([manager.id]);
    const queue = [...(manager.directReports ?? [])];
    while (queue.length > 0) {
      const id = queue.shift()!;
      if (visited.has(id)) {
        continue;
      }
      visited.add(id);
      const agent = byId.get(id);
      if (agent) {
        members.push(agent);
        queue.push(...(agent.directReports ?? []));
      }
    }
    return { manager, members };
  });
  return { root, teams, soloOps };
}

function buildHierarchyLayout(
  result: WorkspaceAgentsListResult,
  cronJobs: CronJob[],
  selectedId: string | null,
): { nodes: Node[]; edges: Edge[] } {
  const enriched = mergeAgentsWithCrons(result, cronJobs);
  const allIds = result.agents.map((agent) => agent.id);
  const allEdges: Array<[string, string]> = [];
  for (const agent of result.agents) {
    for (const childId of agent.directReports ?? []) {
      if (enriched.has(childId)) {
        allEdges.push([agent.id, childId]);
      }
    }
  }
  const positions = dagreLayout(allIds, allEdges, { nodesep: 64, ranksep: 150 });
  const nodes: Node[] = [];
  for (const agent of result.agents) {
    const data = enriched.get(agent.id);
    const position = positions.get(agent.id);
    if (!data || !position) {
      continue;
    }
    nodes.push({
      id: agent.id,
      type: "agentNode",
      data,
      position,
      style: { width: NODE_W },
      selected: agent.id === selectedId,
      draggable: false,
    });
  }
  return { nodes, edges: buildEdges(result, selectedId) };
}

function buildTeamLayout(
  result: WorkspaceAgentsListResult,
  cronJobs: CronJob[],
  selectedId: string | null,
): { nodes: Node[]; edges: Edge[] } {
  const enriched = mergeAgentsWithCrons(result, cronJobs);
  const { root, teams, soloOps } = buildTeamGroups(result);
  if (!root) {
    return { nodes: [], edges: [] };
  }
  const placedIds = new Set<string>([root.id]);
  for (const team of teams) {
    placedIds.add(team.manager.id);
    for (const member of team.members) {
      placedIds.add(member.id);
    }
  }
  for (const agent of soloOps) {
    placedIds.add(agent.id);
  }
  const disconnected = result.agents.filter((agent) => !placedIds.has(agent.id));

  type Column = {
    label: string;
    color?: string;
    agentIds: string[];
    edges: Array<[string, string]>;
  };
  const columns: Column[] = [];
  const byId = new Map(result.agents.map((agent) => [agent.id, agent]));
  for (const team of teams) {
    const ids = [team.manager.id, ...team.members.map((member) => member.id)];
    const edges: Array<[string, string]> = [];
    for (const id of ids) {
      const agent = byId.get(id);
      if (!agent) {
        continue;
      }
      for (const childId of agent.directReports ?? []) {
        if (ids.includes(childId)) {
          edges.push([id, childId]);
        }
      }
    }
    columns.push({
      label: `Team ${agentName(team.manager)}`,
      color: agentAccent(team.manager),
      agentIds: ids,
      edges,
    });
  }
  if (soloOps.length > 0) {
    columns.push({ label: "Solo Ops", agentIds: soloOps.map((agent) => agent.id), edges: [] });
  }
  if (disconnected.length > 0) {
    columns.push({ label: "Unlinked", agentIds: disconnected.map((agent) => agent.id), edges: [] });
  }

  const nodes: Node[] = [];
  let cursorX = 0;
  const ROOT_Y = 0;
  const COLUMNS_TOP = 200;
  const rootData = enriched.get(root.id);
  type ColumnResult = { groupNode: Node; childNodes: Node[]; width: number };
  const columnResults: ColumnResult[] = [];

  for (let index = 0; index < columns.length; index += 1) {
    const column = columns[index];
    const positions = dagreLayout(column.agentIds, column.edges, { nodesep: 40, ranksep: 90 });
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const position of positions.values()) {
      minX = Math.min(minX, position.x);
      maxX = Math.max(maxX, position.x + NODE_W);
      minY = Math.min(minY, position.y);
      maxY = Math.max(maxY, position.y + NODE_H);
    }
    const contentW = maxX - minX;
    const contentH = maxY - minY;
    const groupW = contentW + GROUP_PAD_X * 2;
    const groupH = GROUP_PAD_TOP + contentH + GROUP_PAD_BOTTOM;
    const groupId = `group-${index}`;
    const groupNode: Node = {
      id: groupId,
      type: "teamGroup",
      data: { label: column.label, color: column.color },
      className: "workspace-org-team-group",
      position: { x: cursorX, y: COLUMNS_TOP },
      style: {
        width: groupW,
        height: groupH,
        borderRadius: 20,
        "--workspace-team-accent": column.color ?? "var(--workspace-border)",
      } as React.CSSProperties,
      selectable: false,
      draggable: false,
    };
    const childNodes: Node[] = [];
    for (const id of column.agentIds) {
      const data = enriched.get(id);
      const position = positions.get(id);
      if (!data || !position) {
        continue;
      }
      childNodes.push({
        id,
        type: "agentNode",
        data,
        position: { x: position.x - minX + GROUP_PAD_X, y: position.y - minY + GROUP_PAD_TOP },
        parentId: groupId,
        extent: "parent",
        style: { width: NODE_W },
        selected: id === selectedId,
        draggable: false,
      });
    }
    columnResults.push({ groupNode, childNodes, width: groupW });
    cursorX += groupW + COL_GAP;
  }

  const totalWidth = cursorX - COL_GAP;
  if (rootData) {
    nodes.push({
      id: root.id,
      type: "agentNode",
      data: rootData,
      position: { x: totalWidth / 2 - NODE_W / 2, y: ROOT_Y },
      style: { width: NODE_W },
      selected: root.id === selectedId,
      draggable: false,
    });
  }
  for (const resultColumn of columnResults) {
    nodes.push(resultColumn.groupNode, ...resultColumn.childNodes);
  }
  return { nodes, edges: buildEdges(result, selectedId) };
}

function AgentNode({ data, selected }: NodeProps<Node<AgentNodeData>>) {
  const hasCrons = data.crons.length > 0;
  const hasErrors = data.crons.some((cron) => cron.state?.lastStatus === "error");
  const hasHealthy = data.crons.some((cron) => cron.state?.lastStatus === "ok");
  const reportCount = data.directReports?.length ?? 0;
  const toolCount = data.tools?.length ?? 0;
  const statusClass = hasErrors
    ? "is-errors"
    : hasHealthy
      ? "is-healthy"
      : hasCrons
        ? "is-idle"
        : "is-empty";
  return React.createElement(
    "div",
    {
      className: `workspace-org-node ${selected ? "is-selected" : ""} ${statusClass}`,
      style: { "--workspace-node-accent": data.accent } as React.CSSProperties,
      title: data.role,
    },
    React.createElement(
      "div",
      { className: "workspace-org-node__header" },
      React.createElement("div", { className: "workspace-org-node__avatar" }, agentEmoji(data)),
      React.createElement(
        "div",
        { className: "workspace-org-node__identity" },
        React.createElement(
          "div",
          { className: "workspace-org-node__name" },
          agentName(data),
          React.createElement("span", { className: `workspace-org-node__status ${statusClass}` }),
        ),
        React.createElement("div", { className: "workspace-org-node__role" }, data.role),
      ),
    ),
    React.createElement("div", { className: "workspace-org-node__summary" }, data.summary),
    React.createElement(
      "div",
      { className: "workspace-org-node__meta" },
      toolCount > 0
        ? React.createElement(
            "span",
            { className: "workspace-org-chip workspace-org-chip--danger" },
            `${toolCount} tools`,
          )
        : null,
      React.createElement(
        "span",
        { className: "workspace-org-chip" },
        reportCount > 0 ? `${reportCount} report${reportCount === 1 ? "" : "s"}` : "Individual",
      ),
    ),
    React.createElement(Handle, { type: "target", position: Position.Top, style: { opacity: 0 } }),
    React.createElement(Handle, {
      type: "source",
      position: Position.Bottom,
      style: { opacity: 0 },
    }),
  );
}

function TeamGroupNode({ data }: NodeProps<Node<{ label: string; color?: string }>>) {
  return React.createElement(
    "div",
    {
      className: "workspace-org-team-group__body",
      style: {
        width: "100%",
        height: "100%",
        position: "relative",
        "--workspace-team-accent": data.color ?? "var(--workspace-border)",
      } as React.CSSProperties,
    },
    React.createElement("div", { className: "workspace-org-team-group__label" }, data.label),
  );
}

const nodeTypes = {
  agentNode: AgentNode,
  teamGroup: TeamGroupNode,
};

function WorkspaceMapCanvas(props: WorkspaceMapReactProps) {
  const graph = useMemo(() => {
    const build = props.layoutMode === "teams" ? buildTeamLayout : buildHierarchyLayout;
    return build(props.result, props.cronJobs, props.selectedAgentId);
  }, [props.result, props.cronJobs, props.selectedAgentId, props.layoutMode]);

  const handleNodeClick = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      props.onSelectAgent(node.id);
    },
    [props],
  );

  return React.createElement(
    ReactFlow,
    {
      nodes: graph.nodes,
      edges: graph.edges,
      onNodeClick: handleNodeClick,
      nodeTypes,
      connectionLineType: ConnectionLineType.SmoothStep,
      fitView: true,
      fitViewOptions: { padding: 0.22 },
      minZoom: 0.2,
      maxZoom: 2,
      nodesDraggable: false,
      nodesConnectable: false,
      elementsSelectable: true,
      proOptions: { hideAttribution: true },
      className: "workspace-react-flow",
    },
    React.createElement(Controls, {
      position: "bottom-left",
      showInteractive: false,
      style: { left: 16, bottom: 16 },
    }),
    React.createElement(
      Panel,
      { position: "bottom-center" },
      React.createElement(
        "div",
        { className: "workspace-map-toggle", role: "tablist", "aria-label": "Map layout" },
        ...(["teams", "hierarchy"] as const).map((option) =>
          React.createElement(
            "button",
            {
              key: option,
              className: `workspace-map-toggle__btn ${props.layoutMode === option ? "is-active" : ""}`,
              type: "button",
              onClick: () => props.onLayoutChange(option),
            },
            option === "teams" ? "Teams" : "Hierarchy",
          ),
        ),
      ),
    ),
  );
}

class WorkspaceMapReactHost extends HTMLElement {
  private root: Root | null = null;
  private currentProps: WorkspaceMapReactProps | null = null;
  private mountEl: HTMLDivElement | null = null;

  set props(value: WorkspaceMapReactProps) {
    this.currentProps = value;
    this.renderReact();
  }

  connectedCallback() {
    if (!this.mountEl) {
      this.mountEl = document.createElement("div");
      this.mountEl.className = "workspace-map-react-host__mount";
      this.append(this.mountEl);
    }
    if (!this.root && this.mountEl) {
      this.root = createRoot(this.mountEl);
    }
    this.renderReact();
  }

  disconnectedCallback() {
    this.root?.unmount();
    this.root = null;
    this.mountEl?.remove();
    this.mountEl = null;
  }

  private renderReact() {
    if (!this.root || !this.currentProps) {
      return;
    }
    this.root.render(React.createElement(WorkspaceMapCanvas, this.currentProps));
  }
}

if (!customElements.get("workspace-map-react-host")) {
  customElements.define("workspace-map-react-host", WorkspaceMapReactHost);
}
