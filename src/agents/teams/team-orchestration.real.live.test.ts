import { completeSimple, getModel } from "@mariozechner/pi-ai";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.js";
import type { Task } from "./types.js";
import { loadConfig } from "../../config/config.js";
import { resolveStateDir } from "../../config/paths.js";
import { isTruthyEnvValue } from "../../infra/env.js";
import { getApiKeyForModel, requireApiKey } from "../model-auth.js";
import { generateTeamTaskGraphDashboard } from "./task-graph-trace.js";
import { addTask, listTasks, claimTask, updateTask } from "./task-list.js";
import {
  addTeammate,
  createTeam,
  getTeam,
  getTeammateBySessionKey,
  resetTeamRegistryForTests,
  updateTeammateStatus,
} from "./team-registry.js";
import { createTaskAnswerTool, createTaskQuestionTool } from "./tools/index.js";

const LIVE =
  isTruthyEnvValue(process.env.OPENCLAW_LIVE_TEAM_REAL) ||
  isTruthyEnvValue(process.env.OPENCLAW_LIVE_TEST) ||
  isTruthyEnvValue(process.env.LIVE);
const DEFAULT_MODEL = "zai/glm-4.5";
const MODEL = process.env.OPENCLAW_LIVE_TEAM_REAL_MODEL?.trim() || DEFAULT_MODEL;
const describeLive = LIVE ? describe : describe.skip;

vi.mock("../../gateway/call.js", () => ({
  callGateway: vi.fn().mockResolvedValue({}),
}));

let tempRoot = "";
let graphPath = "";
let historyPath = "";
let graphArtifactsDir = "";
let testBasePath = "";
let tempAgentDir = "";
const previousEnv = {
  configPath: process.env.OPENCLAW_CONFIG_PATH,
  stateDir: process.env.OPENCLAW_STATE_DIR,
  agentDir: process.env.OPENCLAW_AGENT_DIR,
  piAgentDir: process.env.PI_CODING_AGENT_DIR,
  graphTrace: process.env.OPENCLAW_TEAM_GRAPH_TRACE,
  graphTraceDir: process.env.OPENCLAW_TEAM_GRAPH_TRACE_DIR,
};

type ParsedModelRef = { provider: string; id: string };

function parseModelRef(raw: string): ParsedModelRef {
  const parts = raw
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 2) {
    throw new Error(`OPENCLAW_LIVE_TEAM_REAL_MODEL must be provider/id (got: ${raw})`);
  }
  return { provider: parts[0], id: parts.slice(1).join("/") };
}

function renderTaskGraph(tasks: Task[]): string[] {
  const lines: string[] = [];
  lines.push("```mermaid");
  lines.push("graph TD");
  for (const task of tasks) {
    const shortId = task.taskId.slice(0, 8);
    const safeTitle = task.title.replace(/\"/g, "'");
    lines.push(`  t_${shortId}[\"${safeTitle} (${task.status})\"]`);
  }
  for (const task of tasks) {
    const shortId = task.taskId.slice(0, 8);
    for (const dep of task.dependsOn) {
      lines.push(`  t_${dep.slice(0, 8)} --> t_${shortId}`);
    }
  }
  lines.push("```");
  return lines;
}

function writeGraphSnapshot(params: {
  graphPath: string;
  historyPath: string;
  teamId: string;
  label: string;
}) {
  const { tasks } = listTasks(params.teamId, { includeCompleted: true });
  const graphLines = renderTaskGraph(tasks);
  const now = new Date().toISOString();
  const liveLines = [
    "# Task Graph (Real Live Test)",
    "",
    `Last updated: ${now}`,
    `Snapshot: ${params.label}`,
    "",
    ...graphLines,
    "",
  ];
  fs.writeFileSync(params.graphPath, `${liveLines.join("\n")}\n`);

  const historyLines = [`## ${params.label} (${now})`, ...graphLines, ""];
  fs.appendFileSync(params.historyPath, `${historyLines.join("\n")}\n`);
  console.log(historyLines.join("\n"));
}

function claimForSession(params: { teamId: string; taskId: string; sessionKey: string }): void {
  const teammate = getTeammateBySessionKey(params.teamId, params.sessionKey);
  if (!teammate) {
    throw new Error("Teammate not found for session key");
  }
  let claimedTask = listTasks(params.teamId, { includeCompleted: true }).tasks.find(
    (task) => task.taskId === params.taskId,
  );
  if (!(claimedTask?.status === "claimed" && claimedTask.assignee === teammate.teammateId)) {
    const claimResult = claimTask(params.teamId, {
      taskId: params.taskId,
      claimerId: teammate.teammateId,
    });
    if (!claimResult.success || !claimResult.task) {
      const fallback = listTasks(params.teamId, { includeCompleted: true }).tasks.find(
        (task) => task.taskId === params.taskId,
      );
      if (fallback?.status === "claimed" && fallback.assignee === teammate.teammateId) {
        claimedTask = fallback;
      } else {
        throw new Error(`Failed to claim task: ${claimResult.reason ?? "unknown"}`);
      }
    } else {
      claimedTask = claimResult.task;
    }
  }
  if (!claimedTask) {
    throw new Error("Task not found to claim");
  }
  teammate.currentTask = claimedTask.title;
  teammate.currentTaskId = claimedTask.taskId;
  teammate.claimedTasks++;
  updateTeammateStatus(params.teamId, teammate.teammateId, "working");
}

async function copyAuthStore(params: { tempDir: string; workspaceDir: string }) {
  const mainStateDir = resolveStateDir(
    {
      ...process.env,
      OPENCLAW_STATE_DIR: previousEnv.stateDir,
      CLAWDBOT_STATE_DIR: undefined,
    },
    () => os.homedir(),
  );
  const realHome = os.userInfo().homedir;
  const realStateDir = resolveStateDir(
    {
      ...process.env,
      OPENCLAW_STATE_DIR: undefined,
      CLAWDBOT_STATE_DIR: undefined,
    },
    () => realHome,
  );
  const mainAuth = path.join(mainStateDir, "agents", "main", "agent", "auth-profiles.json");
  const realHomeAuth = path.join(realStateDir, "agents", "main", "agent", "auth-profiles.json");
  const fallbackAuth = path.join(
    os.homedir(),
    ".openclaw",
    "agents",
    "main",
    "agent",
    "auth-profiles.json",
  );
  const envAgentDirs = [previousEnv.agentDir, previousEnv.piAgentDir]
    .map((dir) => dir?.trim())
    .filter(Boolean) as string[];
  const envAuthCandidates = envAgentDirs.map((dir) => path.join(dir, "auth-profiles.json"));
  const tempStateDir = path.join(params.tempDir, "state");
  const stateAgentDir = path.join(tempStateDir, "agents", "main", "agent");
  const workspaceAgentDir = path.join(params.workspaceDir, ".openclaw", "agents", "main", "agent");
  tempAgentDir = workspaceAgentDir;
  const tempAuth = path.join(workspaceAgentDir, "auth-profiles.json");
  const stateAuth = path.join(stateAgentDir, "auth-profiles.json");
  await fsp.mkdir(workspaceAgentDir, { recursive: true });
  await fsp.mkdir(stateAgentDir, { recursive: true });

  const candidates = [...envAuthCandidates, mainAuth, realHomeAuth, fallbackAuth].filter(
    (value, index, arr) => arr.indexOf(value) === index,
  );
  for (const candidate of candidates) {
    try {
      await fsp.copyFile(candidate, tempAuth);
      await fsp.copyFile(candidate, stateAuth);
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code && code !== "ENOENT") {
        throw err;
      }
    }
  }

  if (!fs.existsSync(tempAuth)) {
    throw new Error(
      `Missing auth-profiles.json in temp agent dir (tried ${candidates.join(", ")}).`,
    );
  }
  const authRaw = await fsp.readFile(tempAuth, "utf-8");
  const authParsed = JSON.parse(authRaw) as { profiles?: Record<string, { provider?: string }> };
  const hasZai = Object.values(authParsed.profiles ?? {}).some(
    (profile) => (profile.provider ?? "").toLowerCase() === "zai",
  );
  if (!hasZai) {
    throw new Error("Missing zai auth profile in temp auth store.");
  }
}

async function generateModelAnswer(params: {
  modelRef: ParsedModelRef;
  prompt: string;
  cfg: OpenClawConfig;
  agentDir: string;
}) {
  const model = getModel(params.modelRef.provider, params.modelRef.id);
  const apiKeyInfo = await getApiKeyForModel({ model, cfg: params.cfg, agentDir: params.agentDir });
  const apiKey = requireApiKey(apiKeyInfo, params.modelRef.provider);
  const res = await completeSimple(
    model,
    {
      messages: [
        {
          role: "user",
          content: params.prompt,
          timestamp: Date.now(),
        },
      ],
    },
    { apiKey, maxTokens: 96 },
  );
  const text = res.content
    .filter((block) => block.type === "text")
    .map((block) => block.text.trim())
    .join(" ")
    .trim();
  return text || "ok";
}

describeLive("team orchestration real model (live)", () => {
  beforeAll(async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-team-real-"));
    const stateDir = path.join(tempRoot, "state");
    const workspaceDir = path.join(tempRoot, "workspace");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });
    await fsp.writeFile(path.join(workspaceDir, "MEMORY.md"), "# Memory\n\nFresh workspace.\n");

    const agentTeamPath = path.join(process.cwd(), "AGENT.team.md");
    if (fs.existsSync(agentTeamPath)) {
      await fsp.copyFile(agentTeamPath, path.join(workspaceDir, "AGENT.team.md"));
    }

    graphArtifactsDir = path.join(
      process.cwd(),
      ".artifacts",
      "team-graphs",
      "team-orchestration-real-live",
    );
    fs.rmSync(graphArtifactsDir, { recursive: true, force: true });
    fs.mkdirSync(graphArtifactsDir, { recursive: true });
    graphPath = path.join(graphArtifactsDir, "test-graph-team-orchestration-real.md");
    historyPath = path.join(graphArtifactsDir, "test-graph-history-team-orchestration-real.md");
    await fsp.writeFile(graphPath, "# Task Graph (Real Live Test)\n\n");
    await fsp.writeFile(historyPath, "# Task Graph History (Real Live Test)\n\n");

    await copyAuthStore({ tempDir: tempRoot, workspaceDir });

    testBasePath = path.join(stateDir, "teams");
    fs.mkdirSync(testBasePath, { recursive: true });

    const cfg = loadConfig();
    const nextCfg: OpenClawConfig = {
      ...cfg,
      agents: {
        ...cfg.agents,
        defaults: {
          ...cfg.agents?.defaults,
          workspace: workspaceDir,
          model: { primary: MODEL },
        },
      },
      gateway: {
        ...cfg.gateway,
        teams: {
          ...cfg.gateway?.teams,
          enabled: true,
          storage: { basePath: testBasePath },
        },
      },
      tools: {
        ...cfg.tools,
        agentToAgent: { enabled: true, allow: ["*"] },
      },
    };

    const configPath = path.join(tempRoot, "openclaw.json");
    await fsp.writeFile(configPath, `${JSON.stringify(nextCfg, null, 2)}\n`);
    process.env.OPENCLAW_CONFIG_PATH = configPath;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    process.env.OPENCLAW_AGENT_DIR = tempAgentDir;
    process.env.PI_CODING_AGENT_DIR = tempAgentDir;
    process.env.OPENCLAW_TEAM_GRAPH_TRACE = "1";
    process.env.OPENCLAW_TEAM_GRAPH_TRACE_DIR = graphArtifactsDir;

    resetTeamRegistryForTests();
  });

  afterAll(() => {
    generateTeamTaskGraphDashboard();
    process.env.OPENCLAW_CONFIG_PATH = previousEnv.configPath;
    process.env.OPENCLAW_STATE_DIR = previousEnv.stateDir;
    process.env.OPENCLAW_AGENT_DIR = previousEnv.agentDir;
    process.env.PI_CODING_AGENT_DIR = previousEnv.piAgentDir;
    process.env.OPENCLAW_TEAM_GRAPH_TRACE = previousEnv.graphTrace;
    process.env.OPENCLAW_TEAM_GRAPH_TRACE_DIR = previousEnv.graphTraceDir;
    const keepArtifacts = isTruthyEnvValue(process.env.OPENCLAW_LIVE_TEAM_KEEP_ARTIFACTS);
    if (!keepArtifacts && tempRoot && fs.existsSync(tempRoot)) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }, 180_000);

  it("runs deterministic question/review flow with real model answers", async () => {
    const modelRef = parseModelRef(MODEL as string);
    const cfg = loadConfig();

    const team = createTeam({
      teamName: "real-model-flow",
      leadSessionKey: "agent:team-real-model-flow:lead",
      config: { notifyOnUnblock: false },
    });
    const teamId = team.teamId;

    const leadSessionKey = team.leadSessionKey;
    const ySessionKey = `agent:team-${teamId}:teammate:worker-y`;
    const xSessionKey = `agent:team-${teamId}:teammate:worker-x`;
    const tSessionKey = `agent:team-${teamId}:teammate:worker-t`;

    addTeammate(teamId, {
      teammateId: "y",
      role: "worker-y",
      sessionKey: ySessionKey,
      status: "idle",
      requirePlanApproval: false,
      planApproved: true,
      currentTask: undefined,
      claimedTasks: 0,
      completedTasks: 0,
      createdAt: Date.now(),
    });
    addTeammate(teamId, {
      teammateId: "x",
      role: "worker-x",
      sessionKey: xSessionKey,
      status: "idle",
      requirePlanApproval: false,
      planApproved: true,
      currentTask: undefined,
      claimedTasks: 0,
      completedTasks: 0,
      createdAt: Date.now(),
    });
    addTeammate(teamId, {
      teammateId: "t",
      role: "worker-t",
      sessionKey: tSessionKey,
      status: "idle",
      requirePlanApproval: false,
      planApproved: true,
      currentTask: undefined,
      claimedTasks: 0,
      completedTasks: 0,
      createdAt: Date.now(),
    });

    const claimForY = (taskId: string) =>
      claimForSession({ teamId, taskId, sessionKey: ySessionKey });
    const claimForX = (taskId: string) =>
      claimForSession({ teamId, taskId, sessionKey: xSessionKey });
    const claimForT = (taskId: string) =>
      claimForSession({ teamId, taskId, sessionKey: tSessionKey });
    const questionToolY = createTaskQuestionTool({ agentSessionKey: ySessionKey });
    const answerToolY = createTaskAnswerTool({ agentSessionKey: ySessionKey });
    const answerToolX = createTaskAnswerTool({ agentSessionKey: xSessionKey });
    const answerToolT = createTaskAnswerTool({ agentSessionKey: tSessionKey });
    const answerToolLead = createTaskAnswerTool({ agentSessionKey: leadSessionKey });

    const prevTask = addTask(teamId, {
      title: "prev_task",
      description: "Upstream work",
      priority: "normal",
      assignTo: "x",
    });

    const currTask = addTask(teamId, {
      title: "curr_task",
      description: "Needs upstream info",
      priority: "normal",
      assignTo: "y",
      dependsOn: [prevTask.taskId],
    });

    writeGraphSnapshot({ graphPath, historyPath, teamId, label: "initial" });

    claimForX(prevTask.taskId);
    await answerToolX.execute("answer-prev", {
      teamId,
      taskId: prevTask.taskId,
      answer: "done",
    });

    claimForY(currTask.taskId);
    const qnRequest = await questionToolY.execute("ask-qn", {
      teamId,
      taskId: currTask.taskId,
      dependencyTaskId: prevTask.taskId,
      questionText: "What did you decide in prev_task?",
    });
    const qnRequestId = String(
      (qnRequest as { details?: { questionTaskId?: string } }).details?.questionTaskId ?? "",
    );

    writeGraphSnapshot({ graphPath, historyPath, teamId, label: "after-qn-request" });

    claimForX(qnRequestId);
    const qnAnswerText = await generateModelAnswer({
      modelRef,
      prompt: "Provide a one-sentence answer to: What did you decide in prev_task?",
      cfg,
      agentDir: tempAgentDir,
    });
    await answerToolX.execute("answer-qn-request", {
      teamId,
      taskId: qnRequestId,
      answer: qnAnswerText,
    });

    const afterAnswer = listTasks(teamId, { includeCompleted: true });
    const answer = afterAnswer.tasks.find((t) => t.taskId === qnRequestId);
    const curr = afterAnswer.tasks.find((t) => t.taskId === currTask.taskId);
    expect(answer?.status).toBe("completed");
    expect(curr?.dependsOn).toEqual([prevTask.taskId, qnRequestId]);
    expect(["pending", "claimed"]).toContain(curr?.status);
    writeGraphSnapshot({ graphPath, historyPath, teamId, label: "after-answer" });

    claimForY(currTask.taskId);
    await answerToolY.execute("answer-curr", {
      teamId,
      taskId: currTask.taskId,
      answer: "done",
    });

    const leadReview = addTask(teamId, {
      title: "lead_review",
      description: "Chore halt",
      assignTo: "lead",
      metadata: { target: "t", reason: "check output" },
    });
    const leadReviewId = leadReview.taskId;

    const tOpen = addTask(teamId, {
      title: "t_open_task",
      description: "Work item",
      priority: "normal",
      assignTo: "t",
    });
    updateTask(teamId, tOpen.taskId, { dependsOn: [leadReviewId] });

    const reviewQ = addTask(teamId, {
      title: "review_question",
      description: "Explain approach",
      assignTo: "t",
      metadata: { questionText: "Explain approach" },
    });
    const reviewQId = reviewQ.taskId;
    updateTask(teamId, leadReviewId, { dependsOn: [reviewQId] });

    writeGraphSnapshot({ graphPath, historyPath, teamId, label: "after-lead-review-block" });

    claimForT(reviewQId);
    const reviewAnswer = await generateModelAnswer({
      modelRef,
      prompt: "Explain your approach in one sentence.",
      cfg,
      agentDir: tempAgentDir,
    });
    await answerToolT.execute("answer-review", {
      teamId,
      taskId: reviewQId,
      answer: reviewAnswer,
    });
    await answerToolLead.execute("answer-lead-review", {
      teamId,
      taskId: leadReviewId,
      answer: "approved",
    });

    writeGraphSnapshot({ graphPath, historyPath, teamId, label: "after-review-complete" });

    const final = listTasks(teamId, { includeCompleted: true });
    const tTask = final.tasks.find((t) => t.taskId === tOpen.taskId);
    expect(["pending", "claimed"]).toContain(tTask?.status);
    expect(getTeam(teamId)).toBeTruthy();
  }, 120_000);
});
