import fs from "node:fs";
import path from "node:path";

type GraphFrame = {
  label: string;
  mermaid: string;
};

type ParsedNode = {
  id: string;
  label: string;
  status: string | null;
};

type ParsedGraph = {
  nodes: ParsedNode[];
  edges: Array<{ from: string; to: string }>;
};

type StableLayout = {
  width: number;
  height: number;
  nodeWidth: number;
  nodeHeight: number;
  positions: Map<string, { x: number; y: number }>;
};

type RenderFrame = {
  label: string;
  nodes: Array<{ id: string; label: string; status: string | null; x: number; y: number }>;
  edges: Array<{ from: string; to: string }>;
};

type TeamTimeline = {
  teamId: string;
  frames: RenderFrame[];
  layout: { width: number; height: number; nodeWidth: number; nodeHeight: number };
};

function parseGraphFrames(historyRaw: string): GraphFrame[] {
  const frames: GraphFrame[] = [];
  const pattern = /##\s+([^\n]+)\n```mermaid\n([\s\S]*?)\n```/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(historyRaw)) !== null) {
    const label = (match[1] ?? "").trim();
    const mermaid = (match[2] ?? "").trim();
    if (!label || !mermaid) {
      continue;
    }
    frames.push({ label, mermaid });
  }
  return frames;
}

function splitLabelAndStatus(rawLabel: string): { label: string; status: string | null } {
  const match = rawLabel.match(/^(.*)\s+\(([^()]+)\)\s*$/);
  if (!match) {
    return { label: rawLabel.trim(), status: null };
  }
  return {
    label: (match[1] ?? "").trim(),
    status: (match[2] ?? "").trim().toLowerCase() || null,
  };
}

function parseMermaidGraph(mermaid: string): ParsedGraph {
  const nodeById = new Map<string, ParsedNode>();
  const edges: Array<{ from: string; to: string }> = [];
  const lines = mermaid
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("graph "));

  for (const line of lines) {
    const nodeMatch = line.match(/^([A-Za-z0-9_]+)\["([\s\S]+)"\]$/);
    if (nodeMatch) {
      const id = nodeMatch[1]!;
      const rawLabel = nodeMatch[2]!;
      const { label, status } = splitLabelAndStatus(rawLabel);
      nodeById.set(id, { id, label, status });
      continue;
    }

    const edgeMatch = line.match(/^([A-Za-z0-9_]+)\s*-->\s*([A-Za-z0-9_]+)$/);
    if (edgeMatch) {
      const from = edgeMatch[1]!;
      const to = edgeMatch[2]!;
      edges.push({ from, to });
      if (!nodeById.has(from)) {
        nodeById.set(from, { id: from, label: from, status: null });
      }
      if (!nodeById.has(to)) {
        nodeById.set(to, { id: to, label: to, status: null });
      }
    }
  }

  return { nodes: Array.from(nodeById.values()), edges };
}

function computeLevels(graph: ParsedGraph): Map<string, number> {
  const level = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  const indegree = new Map<string, number>();

  for (const node of graph.nodes) {
    level.set(node.id, 0);
    indegree.set(node.id, 0);
    outgoing.set(node.id, []);
  }
  for (const edge of graph.edges) {
    outgoing.get(edge.from)?.push(edge.to);
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  }

  const queue: string[] = [];
  for (const node of graph.nodes) {
    if ((indegree.get(node.id) ?? 0) === 0) {
      queue.push(node.id);
    }
  }

  while (queue.length > 0) {
    const current = queue.shift()!;
    const currLevel = level.get(current) ?? 0;
    for (const next of outgoing.get(current) ?? []) {
      level.set(next, Math.max(level.get(next) ?? 0, currLevel + 1));
      indegree.set(next, (indegree.get(next) ?? 0) - 1);
      if ((indegree.get(next) ?? 0) === 0) {
        queue.push(next);
      }
    }
  }

  return level;
}

function buildStableLayout(frameGraphs: ParsedGraph[]): StableLayout {
  const unionNodeById = new Map<string, ParsedNode>();
  const nodeFirstSeenOrder = new Map<string, number>();
  const edgeSet = new Set<string>();
  let seen = 0;

  for (const graph of frameGraphs) {
    for (const node of graph.nodes) {
      if (!unionNodeById.has(node.id)) {
        unionNodeById.set(node.id, { ...node });
      }
      if (!nodeFirstSeenOrder.has(node.id)) {
        nodeFirstSeenOrder.set(node.id, seen);
        seen += 1;
      }
    }
    for (const edge of graph.edges) {
      edgeSet.add(`${edge.from}->${edge.to}`);
    }
  }

  const unionGraph: ParsedGraph = {
    nodes: Array.from(unionNodeById.values()),
    edges: Array.from(edgeSet, (raw) => {
      const [from, to] = raw.split("->");
      return { from: from ?? "", to: to ?? "" };
    }).filter((edge) => edge.from && edge.to),
  };

  const nodeWidth = 250;
  const nodeHeight = 96;
  const horizontalGap = 70;
  const verticalGap = 130;
  const paddingX = 60;
  const paddingY = 120;

  const levels = computeLevels(unionGraph);
  const byLevel = new Map<number, ParsedNode[]>();
  for (const node of unionGraph.nodes) {
    const l = levels.get(node.id) ?? 0;
    const existing = byLevel.get(l);
    if (existing) {
      existing.push(node);
    } else {
      byLevel.set(l, [node]);
    }
  }

  const levelKeys = Array.from(byLevel.keys()).sort((a, b) => a - b);
  const maxCols = Math.max(1, ...Array.from(byLevel.values()).map((nodes) => nodes.length));
  const width = Math.max(
    1400,
    paddingX * 2 + maxCols * nodeWidth + Math.max(0, maxCols - 1) * horizontalGap,
  );
  const height = Math.max(
    900,
    paddingY * 2 + levelKeys.length * nodeHeight + Math.max(0, levelKeys.length - 1) * verticalGap,
  );

  const positions = new Map<string, { x: number; y: number }>();
  for (let row = 0; row < levelKeys.length; row += 1) {
    const levelKey = levelKeys[row]!;
    const nodes = (byLevel.get(levelKey) ?? []).slice().sort((a, b) => {
      const aOrder = nodeFirstSeenOrder.get(a.id) ?? Number.MAX_SAFE_INTEGER;
      const bOrder = nodeFirstSeenOrder.get(b.id) ?? Number.MAX_SAFE_INTEGER;
      if (aOrder !== bOrder) {
        return aOrder - bOrder;
      }
      return a.id.localeCompare(b.id);
    });
    const rowWidth = nodes.length * nodeWidth + Math.max(0, nodes.length - 1) * horizontalGap;
    const startX = Math.round((width - rowWidth) / 2);
    const y = paddingY + row * (nodeHeight + verticalGap);
    for (let col = 0; col < nodes.length; col += 1) {
      const node = nodes[col]!;
      const x = startX + col * (nodeWidth + horizontalGap);
      positions.set(node.id, { x, y });
    }
  }

  return { width, height, nodeWidth, nodeHeight, positions };
}

function buildRenderFrames(frames: GraphFrame[]): {
  renderFrames: RenderFrame[];
  layout: StableLayout;
} {
  const parsedGraphs = frames.map((frame) => parseMermaidGraph(frame.mermaid));
  const layout = buildStableLayout(parsedGraphs);
  const renderFrames: RenderFrame[] = frames.map((frame, index) => {
    const graph = parsedGraphs[index]!;
    const nodes = graph.nodes.map((node) => {
      const pos = layout.positions.get(node.id) ?? { x: 60, y: 120 };
      return {
        id: node.id,
        label: node.label,
        status: node.status,
        x: pos.x,
        y: pos.y,
      };
    });
    return {
      label: frame.label,
      nodes,
      edges: graph.edges,
    };
  });
  return { renderFrames, layout };
}

function renderDashboardHtml(params: { teams: TeamTimeline[] }): string {
  const maxWidth = Math.max(1400, ...params.teams.map((team) => team.layout.width));
  const maxHeight = Math.max(900, ...params.teams.map((team) => team.layout.height));
  const teamJson = JSON.stringify(params.teams);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Team Task Graph Timeline</title>
    <style>
      :root {
        --bg: #f8fafc;
        --card: #ffffff;
        --ink: #0f172a;
        --muted: #64748b;
        --line: #cbd5e1;
      }
      body {
        margin: 0;
        padding: 24px;
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        background: radial-gradient(circle at top, #eef2ff 0%, var(--bg) 45%);
        color: var(--ink);
      }
      .shell {
        max-width: 1480px;
        margin: 0 auto;
        background: var(--card);
        border: 1px solid var(--line);
        border-radius: 12px;
        box-shadow: 0 12px 34px rgba(15, 23, 42, 0.08);
        overflow: hidden;
      }
      .top {
        padding: 14px 20px;
        border-bottom: 1px solid var(--line);
        display: flex;
        gap: 12px;
        flex-wrap: wrap;
        align-items: center;
      }
      .title {
        font-size: 16px;
        font-weight: 700;
      }
      .controls {
        display: grid;
        grid-template-columns: 1fr;
        gap: 10px;
        padding: 10px 20px 14px;
        border-bottom: 1px solid var(--line);
      }
      .row {
        display: flex;
        gap: 10px;
        align-items: center;
        flex-wrap: wrap;
      }
      label {
        font-size: 13px;
        color: var(--muted);
      }
      select, button {
        border: 1px solid #94a3b8;
        background: #e2e8f0;
        color: #0f172a;
        border-radius: 8px;
        padding: 6px 10px;
        font: inherit;
      }
      select {
        min-width: 280px;
        max-width: 680px;
      }
      button:hover {
        background: #cbd5e1;
      }
      input[type="range"] {
        flex: 1;
        min-width: 260px;
      }
      .meta {
        font-size: 13px;
        color: var(--muted);
      }
      canvas {
        display: block;
        width: 100%;
        height: auto;
        background: #f8fafc;
      }
      .legend {
        display: flex;
        gap: 12px;
        align-items: center;
        flex-wrap: wrap;
        padding: 10px 20px 18px;
        font-size: 12px;
        color: var(--muted);
      }
      .pill {
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }
      .dot {
        width: 10px;
        height: 10px;
        border-radius: 50%;
        border: 1px solid #475569;
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <div class="top">
        <div class="title">Team Task Graph Timeline</div>
        <div class="meta" id="frameLabel">-</div>
      </div>
      <div class="controls">
        <div class="row">
          <label for="teamSelect">Team run</label>
          <select id="teamSelect"></select>
          <span class="meta" id="frameCounter">-</span>
        </div>
        <div class="row">
          <button id="prevBtn" type="button">Prev</button>
          <button id="playBtn" type="button">Play</button>
          <button id="nextBtn" type="button">Next</button>
          <input id="frameSlider" type="range" min="0" max="0" value="0" />
        </div>
      </div>
      <canvas id="graphCanvas" width="${maxWidth}" height="${maxHeight}"></canvas>
      <div class="legend">
        <span class="pill"><span class="dot" style="background:#d1fae5"></span>completed</span>
        <span class="pill"><span class="dot" style="background:#fef3c7"></span>in progress</span>
        <span class="pill"><span class="dot" style="background:#e5e7eb"></span>pending</span>
        <span class="pill"><span class="dot" style="background:#fecaca"></span>blocked</span>
        <span class="pill"><span class="dot" style="background:#dbeafe"></span>idle</span>
      </div>
    </div>
    <script>
      const teams = ${teamJson};
      const canvas = document.getElementById("graphCanvas");
      const ctx = canvas.getContext("2d");
      const frameLabel = document.getElementById("frameLabel");
      const frameCounter = document.getElementById("frameCounter");
      const teamSelect = document.getElementById("teamSelect");
      const slider = document.getElementById("frameSlider");
      const prevBtn = document.getElementById("prevBtn");
      const playBtn = document.getElementById("playBtn");
      const nextBtn = document.getElementById("nextBtn");

      let currentTeamIndex = 0;
      let currentFrameIndex = 0;
      let playing = false;
      let timer = null;

      function fillByStatus(status) {
        switch (status) {
          case "completed": return "#d1fae5";
          case "in_progress": return "#fef3c7";
          case "blocked": return "#fecaca";
          case "pending": return "#e5e7eb";
          case "idle": return "#dbeafe";
          default: return "#f8fafc";
        }
      }

      function textByStatus(status) {
        return (status || "unknown").replaceAll("_", " ");
      }

      function laneForEdge(from, to) {
        const key = from + "->" + to;
        let hash = 0;
        for (const ch of key) {
          hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
        }
        const lanes = [-18, 0, 18];
        return lanes[hash % lanes.length];
      }

      function drawRoundedRect(x, y, w, h, r, fill, stroke) {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + w - r, y);
        ctx.quadraticCurveTo(x + w, y, x + w, y + r);
        ctx.lineTo(x + w, y + h - r);
        ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
        ctx.lineTo(x + r, y + h);
        ctx.quadraticCurveTo(x, y + h, x, y + h - r);
        ctx.lineTo(x, y + r);
        ctx.quadraticCurveTo(x, y, x + r, y);
        ctx.closePath();
        ctx.fillStyle = fill;
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = stroke;
        ctx.stroke();
      }

      function bezierPoint(t, p0, p1, p2, p3) {
        const mt = 1 - t;
        const mt2 = mt * mt;
        const t2 = t * t;
        const x = mt2 * mt * p0.x + 3 * mt2 * t * p1.x + 3 * mt * t2 * p2.x + t2 * t * p3.x;
        const y = mt2 * mt * p0.y + 3 * mt2 * t * p1.y + 3 * mt * t2 * p2.y + t2 * t * p3.y;
        return { x, y };
      }

      function drawArrowPath(fromNode, toNode, nodeWidth, nodeHeight, lane) {
        const start = { x: fromNode.x + nodeWidth / 2 + lane, y: fromNode.y + nodeHeight - 4 };
        const end = { x: toNode.x + nodeWidth / 2 + lane, y: toNode.y + 4 };
        const controlOffset = Math.max(40, Math.abs(end.y - start.y) * 0.33);
        const c1 = { x: start.x, y: start.y + controlOffset };
        const c2 = { x: end.x, y: end.y - controlOffset };

        ctx.beginPath();
        ctx.moveTo(start.x, start.y);
        ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, end.x, end.y);
        ctx.lineWidth = 3.5;
        ctx.lineCap = "round";
        ctx.strokeStyle = "#475569";
        ctx.globalAlpha = 0.92;
        ctx.stroke();
        ctx.globalAlpha = 1;

        const tip = bezierPoint(1, start, c1, c2, end);
        const prev = bezierPoint(0.96, start, c1, c2, end);
        const angle = Math.atan2(tip.y - prev.y, tip.x - prev.x);
        const head = 12;

        ctx.beginPath();
        ctx.moveTo(tip.x, tip.y);
        ctx.lineTo(
          tip.x - head * Math.cos(angle - Math.PI / 6),
          tip.y - head * Math.sin(angle - Math.PI / 6),
        );
        ctx.lineTo(
          tip.x - head * Math.cos(angle + Math.PI / 6),
          tip.y - head * Math.sin(angle + Math.PI / 6),
        );
        ctx.closePath();
        ctx.fillStyle = "#475569";
        ctx.fill();
      }

      function team() {
        return teams[currentTeamIndex];
      }

      function drawFrame(frame, alpha = 1) {
        const activeTeam = team();
        const nodeWidth = activeTeam.layout.nodeWidth;
        const nodeHeight = activeTeam.layout.nodeHeight;

        ctx.save();
        ctx.globalAlpha = alpha;
        const nodeMap = new Map(frame.nodes.map((node) => [node.id, node]));

        for (const node of frame.nodes) {
          drawRoundedRect(node.x, node.y, nodeWidth, nodeHeight, 16, fillByStatus(node.status), "#334155");
          ctx.fillStyle = "#0f172a";
          ctx.font = "italic 20px Menlo, Monaco, monospace";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(node.label, node.x + nodeWidth / 2, node.y + 26);
          ctx.fillStyle = "#334155";
          ctx.font = "italic 16px Menlo, Monaco, monospace";
          ctx.fillText("[" + textByStatus(node.status) + "]", node.x + nodeWidth / 2, node.y + nodeHeight - 18);
        }

        for (const edge of frame.edges) {
          const from = nodeMap.get(edge.from);
          const to = nodeMap.get(edge.to);
          if (!from || !to) {
            continue;
          }
          drawArrowPath(from, to, nodeWidth, nodeHeight, laneForEdge(edge.from, edge.to));
        }

        ctx.restore();
      }

      function resizeForTeam(activeTeam) {
        canvas.width = activeTeam.layout.width;
        canvas.height = activeTeam.layout.height;
      }

      function updateFrameMeta(frameIndex) {
        const activeTeam = team();
        frameCounter.textContent = "frame " + String(frameIndex + 1) + " / " + String(activeTeam.frames.length);
      }

      function renderAt(index) {
        const activeTeam = team();
        const frame = activeTeam.frames[index];
        if (!frame) {
          return;
        }
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        drawFrame(frame, 1);
        frameLabel.textContent = activeTeam.teamId + " | " + frame.label;
        slider.value = String(index);
        updateFrameMeta(index);
      }

      function tweenTo(nextIndex) {
        const activeTeam = team();
        const fromFrame = activeTeam.frames[currentFrameIndex];
        const toFrame = activeTeam.frames[nextIndex];
        if (!fromFrame || !toFrame) {
          return;
        }
        const start = performance.now();
        const duration = 220;
        function step(now) {
          const t = Math.min(1, (now - start) / duration);
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          drawFrame(fromFrame, 1 - t);
          drawFrame(toFrame, t);
          frameLabel.textContent = activeTeam.teamId + " | " + toFrame.label;
          if (t < 1) {
            requestAnimationFrame(step);
            return;
          }
          currentFrameIndex = nextIndex;
          slider.value = String(currentFrameIndex);
          updateFrameMeta(currentFrameIndex);
        }
        requestAnimationFrame(step);
      }

      function stopPlayback() {
        if (timer) {
          clearInterval(timer);
          timer = null;
        }
        playing = false;
        playBtn.textContent = "Play";
      }

      function setTeam(index) {
        stopPlayback();
        currentTeamIndex = index;
        currentFrameIndex = 0;
        const activeTeam = team();
        slider.max = String(Math.max(0, activeTeam.frames.length - 1));
        slider.value = "0";
        resizeForTeam(activeTeam);
        renderAt(0);
      }

      prevBtn.addEventListener("click", () => {
        stopPlayback();
        const next = Math.max(0, currentFrameIndex - 1);
        if (next === currentFrameIndex) {
          return;
        }
        tweenTo(next);
      });

      nextBtn.addEventListener("click", () => {
        stopPlayback();
        const activeTeam = team();
        const next = Math.min(activeTeam.frames.length - 1, currentFrameIndex + 1);
        if (next === currentFrameIndex) {
          return;
        }
        tweenTo(next);
      });

      slider.addEventListener("input", () => {
        stopPlayback();
        currentFrameIndex = Number(slider.value);
        renderAt(currentFrameIndex);
      });

      playBtn.addEventListener("click", () => {
        if (playing) {
          stopPlayback();
          return;
        }
        playing = true;
        playBtn.textContent = "Pause";
        timer = setInterval(() => {
          const activeTeam = team();
          const next = currentFrameIndex + 1;
          if (next >= activeTeam.frames.length) {
            stopPlayback();
            return;
          }
          tweenTo(next);
        }, 900);
      });

      teamSelect.addEventListener("change", () => {
        setTeam(Number(teamSelect.value));
      });

      for (let i = 0; i < teams.length; i += 1) {
        const option = document.createElement("option");
        option.value = String(i);
        option.textContent = teams[i].teamId + " (" + String(teams[i].frames.length) + " frames)";
        teamSelect.appendChild(option);
      }
      teamSelect.value = "0";
      setTeam(0);
    </script>
  </body>
</html>`;
}

function buildTeamTimeline(teamId: string, historyPath: string): TeamTimeline {
  const historyRaw = fs.readFileSync(historyPath, "utf-8");
  const frames = parseGraphFrames(historyRaw);
  if (frames.length === 0) {
    throw new Error(`No mermaid graph frames found in ${historyPath}`);
  }
  const { renderFrames, layout } = buildRenderFrames(frames);
  return {
    teamId,
    frames: renderFrames,
    layout: {
      width: layout.width,
      height: layout.height,
      nodeWidth: layout.nodeWidth,
      nodeHeight: layout.nodeHeight,
    },
  };
}

export function generateTaskGraphHtmlFromHistory(params: {
  historyPath: string;
  htmlPath: string;
  teamId?: string;
}): { htmlPath: string; frameCount: number } {
  const teamId = params.teamId ?? path.basename(params.historyPath).replace(/-history\.md$/, "");
  const timeline = buildTeamTimeline(teamId, params.historyPath);
  fs.mkdirSync(path.dirname(params.htmlPath), { recursive: true });
  fs.writeFileSync(params.htmlPath, renderDashboardHtml({ teams: [timeline] }), "utf-8");
  return { htmlPath: params.htmlPath, frameCount: timeline.frames.length };
}

export function generateTaskGraphDashboardHtml(params: {
  histories: Array<{ teamId: string; historyPath: string }>;
  htmlPath: string;
}): { htmlPath: string; teamCount: number } {
  if (params.histories.length === 0) {
    throw new Error("No team histories provided for dashboard generation.");
  }
  const teams: TeamTimeline[] = [];
  for (const history of params.histories) {
    if (!fs.existsSync(history.historyPath)) {
      continue;
    }
    teams.push(buildTeamTimeline(history.teamId, history.historyPath));
  }
  if (teams.length === 0) {
    throw new Error("No readable team histories found for dashboard generation.");
  }
  fs.mkdirSync(path.dirname(params.htmlPath), { recursive: true });
  fs.writeFileSync(params.htmlPath, renderDashboardHtml({ teams }), "utf-8");
  return { htmlPath: params.htmlPath, teamCount: teams.length };
}
