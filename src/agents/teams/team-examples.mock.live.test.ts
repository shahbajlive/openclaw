import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.js";
import type { Task } from "./types.js";
import { isTruthyEnvValue } from "../../infra/env.js";
import { generateTeamTaskGraphDashboard } from "./task-graph-trace.js";

let addTask: typeof import("./task-list.js").addTask;
let listTasks: typeof import("./task-list.js").listTasks;
let updateTask: typeof import("./task-list.js").updateTask;
let claimTask: typeof import("./task-list.js").claimTask;
let addTeammate: typeof import("./team-registry.js").addTeammate;
let createTeam: typeof import("./team-registry.js").createTeam;
let getTeammateBySessionKey: typeof import("./team-registry.js").getTeammateBySessionKey;
let resetTeamRegistryForTests: typeof import("./team-registry.js").resetTeamRegistryForTests;
let updateTeammateStatus: typeof import("./team-registry.js").updateTeammateStatus;
let updateTeamStatus: typeof import("./team-registry.js").updateTeamStatus;
let createTaskAnswerTool: typeof import("./tools/index.js").createTaskAnswerTool;
let createTaskQuestionTool: typeof import("./tools/index.js").createTaskQuestionTool;
let runChoreCheckNow: typeof import("./chore-watch.js").runChoreCheckNow;

let tempRoot = "";
let graphPath = "";
let historyPath = "";
let graphArtifactsDir = "";
let testBasePath = "";
const previousEnv = {
  configPath: process.env.OPENCLAW_CONFIG_PATH,
  stateDir: process.env.OPENCLAW_STATE_DIR,
  graphTrace: process.env.OPENCLAW_TEAM_GRAPH_TRACE,
  graphTraceDir: process.env.OPENCLAW_TEAM_GRAPH_TRACE_DIR,
};

vi.mock("./team-registry.store.js", () => ({
  resolveTeamBasePath: () => testBasePath,
  saveTeamToDisk: vi.fn(),
  loadAllTeamsFromDisk: vi.fn().mockReturnValue(new Map()),
}));

vi.mock("../../gateway/call.js", () => ({
  callGateway: vi.fn().mockResolvedValue({}),
}));

const LIVE =
  isTruthyEnvValue(process.env.OPENCLAW_LIVE_TEAM_DETERMINISTIC) ||
  isTruthyEnvValue(process.env.LIVE) ||
  isTruthyEnvValue(process.env.OPENCLAW_LIVE_TEST);
const describeLive = LIVE ? describe : describe.skip;

const RESERVED_ORCHESTRATION_TITLES = new Set([
  "init_task",
  "lead_review",
  "qn_request",
  "review_question",
  "spot_check",
  "pr_review",
  "pr_revision_request",
  "broadcast_answer",
]);

function isReservedOrchestrationTitle(title: string): boolean {
  return RESERVED_ORCHESTRATION_TITLES.has(title) || title.startsWith("qn_request_");
}

function addScenarioTask(teamId: string, params: Parameters<typeof addTask>[1]): Task {
  const metadata: Record<string, unknown> = { ...(params.metadata ?? {}) };
  const hasTaskClass = metadata.taskClass === "primary" || metadata.taskClass === "secondary";
  const dependencyCount = params.dependsOn?.length ?? 0;
  const shouldPromoteToPrimary = dependencyCount === 0 || dependencyCount > 1;
  if (!hasTaskClass && shouldPromoteToPrimary && !isReservedOrchestrationTitle(params.title)) {
    metadata.taskClass = "primary";
  }
  return addTask(teamId, {
    ...params,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
  });
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
    "# Task Graph (Mock Team Examples)",
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

function ensureTeamDir(teamId: string) {
  const teamDir = path.join(testBasePath, teamId);
  fs.mkdirSync(teamDir, { recursive: true });
}

function createTeamWithTeammates(params: { teamName: string; size: number }) {
  const team = createTeam({
    teamName: params.teamName,
    leadSessionKey: `agent:${params.teamName}:lead`,
    config: { notifyOnUnblock: false },
  });
  updateTeamStatus(team.teamId, "working");
  ensureTeamDir(team.teamId);
  const teammates: { id: string; sessionKey: string }[] = [];
  for (let i = 1; i <= params.size; i += 1) {
    const teammateId = `t${i}`;
    const sessionKey = `agent:team-${team.teamId}:teammate:worker-${i}`;
    addTeammate(team.teamId, {
      teammateId,
      role: `worker-${i}`,
      sessionKey,
      status: "idle",
      requirePlanApproval: false,
      planApproved: true,
      currentTask: undefined,
      claimedTasks: 0,
      completedTasks: 0,
      createdAt: Date.now(),
    });
    teammates.push({ id: teammateId, sessionKey });
  }
  return { team, teammates };
}

async function claimAndComplete(params: {
  teamId: string;
  task: Task;
  sessionKey: string;
  summary?: string;
}) {
  const answerTool = createTaskAnswerTool({ agentSessionKey: params.sessionKey });
  const teammate = getTeammateBySessionKey(params.teamId, params.sessionKey);
  if (!teammate) {
    throw new Error("Teammate not found for session key");
  }
  let claimedTask = params.task;
  const existing = listTasks(params.teamId, { includeCompleted: true }).tasks.find(
    (task) => task.taskId === params.task.taskId,
  );
  if (existing?.status === "claimed" && existing.assignee === teammate.teammateId) {
    claimedTask = existing;
  } else {
    const claimResult = claimTask(params.teamId, {
      taskId: params.task.taskId,
      claimerId: teammate.teammateId,
    });
    if (!claimResult.success || !claimResult.task) {
      const fallback = listTasks(params.teamId, { includeCompleted: true }).tasks.find(
        (task) => task.taskId === params.task.taskId,
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
  teammate.currentTask = claimedTask.title;
  teammate.currentTaskId = claimedTask.taskId;
  teammate.claimedTasks++;
  updateTeammateStatus(params.teamId, teammate.teammateId, "working");
  await answerTool.execute("answer", {
    teamId: params.teamId,
    taskId: claimedTask.taskId,
    answer: params.summary ?? "done",
  });
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

function resultTaskId(result: unknown): string {
  const details = (result as { details?: Record<string, unknown> }).details ?? {};
  const taskId = details.taskId as string | undefined;
  const questionId = details.questionTaskId as string | undefined;
  return String(taskId ?? questionId ?? "");
}

function expectPendingOrClaimed(status?: string): void {
  expect(["pending", "claimed"]).toContain(status);
}

describeLive("team examples (mock live)", () => {
  beforeAll(async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-team-examples-"));
    const stateDir = path.join(tempRoot, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    testBasePath = path.join(stateDir, "teams");
    fs.mkdirSync(testBasePath, { recursive: true });
    graphArtifactsDir = path.join(
      process.cwd(),
      ".artifacts",
      "team-graphs",
      "team-examples-mock-live",
    );
    fs.rmSync(graphArtifactsDir, { recursive: true, force: true });
    fs.mkdirSync(graphArtifactsDir, { recursive: true });
    graphPath = path.join(graphArtifactsDir, "test-graph-team-examples-mock.md");
    historyPath = path.join(graphArtifactsDir, "test-graph-history-team-examples-mock.md");
    await fsp.writeFile(graphPath, "# Task Graph (Mock Team Examples)\n\n");
    await fsp.writeFile(historyPath, "# Task Graph History (Mock Team Examples)\n\n");

    const { loadConfig } = await import("../../config/config.js");
    const cfg = loadConfig();
    const nextCfg: OpenClawConfig = {
      ...cfg,
      gateway: {
        ...cfg.gateway,
        teams: {
          ...cfg.gateway?.teams,
          enabled: true,
          storage: { basePath: testBasePath },
        },
      },
    };

    const configPath = path.join(tempRoot, "openclaw.json");
    await fsp.writeFile(configPath, `${JSON.stringify(nextCfg, null, 2)}\n`);
    process.env.OPENCLAW_CONFIG_PATH = configPath;
    process.env.OPENCLAW_TEAM_GRAPH_TRACE = "1";
    process.env.OPENCLAW_TEAM_GRAPH_TRACE_DIR = graphArtifactsDir;

    ({ addTask, listTasks, updateTask, claimTask } = await import("./task-list.js"));
    ({
      addTeammate,
      createTeam,
      getTeammateBySessionKey,
      resetTeamRegistryForTests,
      updateTeammateStatus,
      updateTeamStatus,
    } = await import("./team-registry.js"));
    ({ createTaskAnswerTool } = await import("./tools/index.js"));
    ({ createTaskQuestionTool } = await import("./tools/index.js"));
    ({ runChoreCheckNow } = await import("./chore-watch.js"));

    resetTeamRegistryForTests();
  });

  afterAll(() => {
    generateTeamTaskGraphDashboard();
    process.env.OPENCLAW_CONFIG_PATH = previousEnv.configPath;
    process.env.OPENCLAW_STATE_DIR = previousEnv.stateDir;
    process.env.OPENCLAW_TEAM_GRAPH_TRACE = previousEnv.graphTrace;
    process.env.OPENCLAW_TEAM_GRAPH_TRACE_DIR = previousEnv.graphTraceDir;
    const keepArtifacts = isTruthyEnvValue(process.env.OPENCLAW_LIVE_TEAM_KEEP_ARTIFACTS);
    if (!keepArtifacts && tempRoot && fs.existsSync(tempRoot)) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }, 300_000);

  it("covers sequential headcount", async () => {
    const { team, teammates } = createTeamWithTeammates({ teamName: "seq-headcount", size: 10 });
    const tasks: Task[] = [];
    let prev: string | undefined;
    for (let i = 1; i <= 10; i += 1) {
      const task = addScenarioTask(team.teamId, {
        title: `count-${i}`,
        description: `headcount ${i}`,
        assignTo: teammates[i - 1]?.id,
        dependsOn: prev ? [prev] : [],
      });
      tasks.push(task);
      prev = task.taskId;
    }
    const summaryTeammate = teammates[teammates.length - 1]!;
    const summary = addScenarioTask(team.teamId, {
      title: "headcount-summary",
      description: "Report total count",
      assignTo: summaryTeammate.id,
      dependsOn: [tasks[tasks.length - 1]!.taskId],
    });

    writeGraphSnapshot({ graphPath, historyPath, teamId: team.teamId, label: "seq-initial" });

    for (let i = 0; i < tasks.length; i += 1) {
      const task = tasks[i]!;
      await claimAndComplete({
        teamId: team.teamId,
        task,
        sessionKey: teammates[i]!.sessionKey,
        summary: String(i + 1),
      });
      if (i + 1 < tasks.length) {
        const next = listTasks(team.teamId, { includeCompleted: true }).tasks.find(
          (t) => t.taskId === tasks[i + 1]!.taskId,
        );
        expectPendingOrClaimed(next?.status);
      }
    }

    const summaryTask = listTasks(team.teamId, { includeCompleted: true }).tasks.find(
      (t) => t.taskId === summary.taskId,
    );
    expectPendingOrClaimed(summaryTask?.status);
    await claimAndComplete({
      teamId: team.teamId,
      task: summary,
      sessionKey: summaryTeammate.sessionKey,
      summary: "10",
    });

    writeGraphSnapshot({ graphPath, historyPath, teamId: team.teamId, label: "seq-complete" });
  });

  it("covers ring passing", async () => {
    const { team, teammates } = createTeamWithTeammates({ teamName: "ring-pass", size: 5 });
    const tasks: Task[] = [];
    let prev: string | undefined;
    for (let i = 1; i <= 10; i += 1) {
      const teammate = teammates[(i - 1) % teammates.length]!;
      const task = addScenarioTask(team.teamId, {
        title: `ring-${i}`,
        description: `pass ${i}`,
        assignTo: teammate.id,
        dependsOn: prev ? [prev] : [],
      });
      tasks.push(task);
      prev = task.taskId;
    }
    const summaryTeammate = teammates[0]!;
    const summary = addScenarioTask(team.teamId, {
      title: "ring-summary",
      description: "final ring pass",
      assignTo: summaryTeammate.id,
      dependsOn: [tasks[tasks.length - 1]!.taskId],
    });

    writeGraphSnapshot({ graphPath, historyPath, teamId: team.teamId, label: "ring-initial" });

    for (let i = 0; i < tasks.length; i += 1) {
      const task = tasks[i]!;
      const teammate = teammates[i % teammates.length]!;
      await claimAndComplete({
        teamId: team.teamId,
        task,
        sessionKey: teammate.sessionKey,
        summary: `hop-${i + 1}`,
      });
    }

    await claimAndComplete({
      teamId: team.teamId,
      task: summary,
      sessionKey: summaryTeammate.sessionKey,
      summary: "ring-pass-complete",
    });

    writeGraphSnapshot({ graphPath, historyPath, teamId: team.teamId, label: "ring-complete" });
  });

  it("covers fan out and fan in", async () => {
    const { team, teammates } = createTeamWithTeammates({ teamName: "fan-out", size: 4 });
    const tasks = teammates.map((teammate, index) =>
      addScenarioTask(team.teamId, {
        title: `fan-task-${index + 1}`,
        description: "subtask",
        assignTo: teammate.id,
      }),
    );
    const summaryTeammate = teammates[0]!;
    const summary = addScenarioTask(team.teamId, {
      title: "fan-in-summary",
      description: "aggregate",
      assignTo: summaryTeammate.id,
      dependsOn: tasks.map((task) => task.taskId),
    });

    writeGraphSnapshot({ graphPath, historyPath, teamId: team.teamId, label: "fan-initial" });

    await claimAndComplete({
      teamId: team.teamId,
      task: tasks[1]!,
      sessionKey: teammates[1]!.sessionKey,
      summary: "done-2",
    });
    await claimAndComplete({
      teamId: team.teamId,
      task: tasks[3]!,
      sessionKey: teammates[3]!.sessionKey,
      summary: "done-4",
    });
    await claimAndComplete({
      teamId: team.teamId,
      task: tasks[0]!,
      sessionKey: teammates[0]!.sessionKey,
      summary: "done-1",
    });

    const midSummary = listTasks(team.teamId, { includeCompleted: true }).tasks.find(
      (t) => t.taskId === summary.taskId,
    );
    expect(midSummary?.status).toBe("blocked");

    await claimAndComplete({
      teamId: team.teamId,
      task: tasks[2]!,
      sessionKey: teammates[2]!.sessionKey,
      summary: "done-3",
    });

    const unblockedSummary = listTasks(team.teamId, { includeCompleted: true }).tasks.find(
      (t) => t.taskId === summary.taskId,
    );
    expectPendingOrClaimed(unblockedSummary?.status);

    await claimAndComplete({
      teamId: team.teamId,
      task: summary,
      sessionKey: summaryTeammate.sessionKey,
      summary: "fan-in-complete",
    });

    writeGraphSnapshot({ graphPath, historyPath, teamId: team.teamId, label: "fan-complete" });
  });

  it("covers pipeline", async () => {
    const { team, teammates } = createTeamWithTeammates({ teamName: "pipeline", size: 3 });
    const stage1 = addScenarioTask(team.teamId, {
      title: "pipeline-stage-1",
      description: "draft input",
      assignTo: teammates[0]!.id,
    });
    const stage2 = addScenarioTask(team.teamId, {
      title: "pipeline-stage-2",
      description: "transform",
      assignTo: teammates[1]!.id,
      dependsOn: [stage1.taskId],
    });
    const stage3 = addScenarioTask(team.teamId, {
      title: "pipeline-stage-3",
      description: "validate",
      assignTo: teammates[2]!.id,
      dependsOn: [stage2.taskId],
    });

    writeGraphSnapshot({ graphPath, historyPath, teamId: team.teamId, label: "pipeline-initial" });

    await claimAndComplete({
      teamId: team.teamId,
      task: stage1,
      sessionKey: teammates[0]!.sessionKey,
      summary: "draft",
    });
    await claimAndComplete({
      teamId: team.teamId,
      task: stage2,
      sessionKey: teammates[1]!.sessionKey,
      summary: "clean",
    });
    await claimAndComplete({
      teamId: team.teamId,
      task: stage3,
      sessionKey: teammates[2]!.sessionKey,
      summary: "validated",
    });

    writeGraphSnapshot({ graphPath, historyPath, teamId: team.teamId, label: "pipeline-complete" });
  });

  it("covers debate then judge", async () => {
    const { team, teammates } = createTeamWithTeammates({ teamName: "debate-judge", size: 3 });
    const argA = addScenarioTask(team.teamId, {
      title: "argument-a",
      description: "argue A",
      assignTo: teammates[0]!.id,
    });
    const argB = addScenarioTask(team.teamId, {
      title: "argument-b",
      description: "argue B",
      assignTo: teammates[1]!.id,
    });
    const judge = addScenarioTask(team.teamId, {
      title: "judge",
      description: "decide with reasons",
      assignTo: teammates[2]!.id,
      dependsOn: [argA.taskId, argB.taskId],
    });

    writeGraphSnapshot({ graphPath, historyPath, teamId: team.teamId, label: "debate-initial" });

    await claimAndComplete({
      teamId: team.teamId,
      task: argB,
      sessionKey: teammates[1]!.sessionKey,
      summary: "B",
    });
    await claimAndComplete({
      teamId: team.teamId,
      task: argA,
      sessionKey: teammates[0]!.sessionKey,
      summary: "A",
    });

    const judgeTask = listTasks(team.teamId, { includeCompleted: true }).tasks.find(
      (t) => t.taskId === judge.taskId,
    );
    expectPendingOrClaimed(judgeTask?.status);

    await claimAndComplete({
      teamId: team.teamId,
      task: judge,
      sessionKey: teammates[2]!.sessionKey,
      summary: "Judge: A wins (2 reasons)",
    });

    writeGraphSnapshot({ graphPath, historyPath, teamId: team.teamId, label: "debate-complete" });
  });

  it("covers timed relay headcount", async () => {
    const { team, teammates } = createTeamWithTeammates({ teamName: "timed-relay", size: 5 });
    const tasks: Task[] = [];
    let prev: string | undefined;
    for (let i = 1; i <= 5; i += 1) {
      const task = addScenarioTask(team.teamId, {
        title: `relay-${i}`,
        description: "timed relay",
        assignTo: teammates[i - 1]!.id,
        dependsOn: prev ? [prev] : [],
      });
      tasks.push(task);
      prev = task.taskId;
    }

    writeGraphSnapshot({ graphPath, historyPath, teamId: team.teamId, label: "relay-initial" });

    for (let i = 0; i < tasks.length; i += 1) {
      const timestamp = new Date().toISOString();
      await claimAndComplete({
        teamId: team.teamId,
        task: tasks[i]!,
        sessionKey: teammates[i]!.sessionKey,
        summary: `${i + 1} @${timestamp}`,
      });
    }

    const completed = listTasks(team.teamId, { includeCompleted: true }).tasks.filter((t) =>
      t.title.startsWith("relay-"),
    );
    for (const task of completed) {
      expect(task.summary).toContain("@");
    }

    writeGraphSnapshot({ graphPath, historyPath, teamId: team.teamId, label: "relay-complete" });
  });

  it("covers chore teammate always runs", async () => {
    const { team, teammates } = createTeamWithTeammates({ teamName: "chore-always", size: 2 });
    const userTask = addScenarioTask(team.teamId, {
      title: "user-task",
      description: "requested work",
      assignTo: teammates[0]!.id,
    });
    const blocker = addScenarioTask(team.teamId, {
      title: "blocker-task",
      description: "dependency",
      assignTo: teammates[1]!.id,
    });

    claimForSession({
      teamId: team.teamId,
      taskId: userTask.taskId,
      sessionKey: teammates[0]!.sessionKey,
    });

    updateTask(team.teamId, userTask.taskId, { dependsOn: [blocker.taskId] });

    writeGraphSnapshot({ graphPath, historyPath, teamId: team.teamId, label: "chore-initial" });

    const choreResult = runChoreCheckNow(team.teamId);
    expect(choreResult.violations.length).toBeGreaterThan(0);

    const tasks = listTasks(team.teamId, { includeCompleted: true }).tasks;
    const leadReview = tasks.find(
      (task) => task.title === "lead_review" && task.metadata?.source === "chore",
    );
    expect(leadReview).toBeTruthy();
    const updatedUser = tasks.find((task) => task.taskId === userTask.taskId);
    expect(updatedUser?.dependsOn).toContain(leadReview?.taskId);

    writeGraphSnapshot({ graphPath, historyPath, teamId: team.teamId, label: "chore-complete" });
  });

  it("covers node asks question on prev task", async () => {
    const { team, teammates } = createTeamWithTeammates({ teamName: "qn-prev", size: 2 });
    const questionToolY = createTaskQuestionTool({ agentSessionKey: teammates[1]!.sessionKey });

    const prevTask = addScenarioTask(team.teamId, {
      title: "prev_task",
      description: "upstream decision",
      assignTo: teammates[0]!.id,
    });
    const currTask = addScenarioTask(team.teamId, {
      title: "curr_task",
      description: "needs upstream detail",
      assignTo: teammates[1]!.id,
      dependsOn: [prevTask.taskId],
    });

    writeGraphSnapshot({ graphPath, historyPath, teamId: team.teamId, label: "node-prev-initial" });

    await claimAndComplete({
      teamId: team.teamId,
      task: prevTask,
      sessionKey: teammates[0]!.sessionKey,
      summary: "prev-done",
    });

    claimForSession({
      teamId: team.teamId,
      taskId: currTask.taskId,
      sessionKey: teammates[1]!.sessionKey,
    });

    const qnRequest = await questionToolY.execute("ask-qn", {
      teamId: team.teamId,
      taskId: currTask.taskId,
      dependencyTaskId: prevTask.taskId,
      questionText: "What did you decide in prev_task?",
    });
    const qnRequestId = resultTaskId(qnRequest);

    writeGraphSnapshot({
      graphPath,
      historyPath,
      teamId: team.teamId,
      label: "node-prev-question-created",
    });

    await claimAndComplete({
      teamId: team.teamId,
      task: listTasks(team.teamId, { includeCompleted: true }).tasks.find(
        (t) => t.taskId === qnRequestId,
      )!,
      sessionKey: teammates[0]!.sessionKey,
      summary: "Answer: use plan v2",
    });
    await claimAndComplete({
      teamId: team.teamId,
      task: listTasks(team.teamId, { includeCompleted: true }).tasks.find(
        (t) => t.taskId === currTask.taskId,
      )!,
      sessionKey: teammates[1]!.sessionKey,
      summary: "curr-done",
    });

    writeGraphSnapshot({
      graphPath,
      historyPath,
      teamId: team.teamId,
      label: "node-prev-complete",
    });
  });

  it("covers upstream question chain", async () => {
    const { team, teammates } = createTeamWithTeammates({ teamName: "qn-upstream", size: 3 });
    const questionToolY = createTaskQuestionTool({ agentSessionKey: teammates[1]!.sessionKey });
    const questionToolX = createTaskQuestionTool({ agentSessionKey: teammates[0]!.sessionKey });

    const upstreamTask = addScenarioTask(team.teamId, {
      title: "upstream_task",
      description: "earlier decision",
      assignTo: teammates[2]!.id,
    });
    const prevTask = addScenarioTask(team.teamId, {
      title: "prev_task",
      description: "downstream decision",
      assignTo: teammates[0]!.id,
      dependsOn: [upstreamTask.taskId],
    });
    const currTask = addScenarioTask(team.teamId, {
      title: "curr_task",
      description: "needs upstream detail",
      assignTo: teammates[1]!.id,
      dependsOn: [prevTask.taskId],
    });

    writeGraphSnapshot({
      graphPath,
      historyPath,
      teamId: team.teamId,
      label: "qn-upstream-initial",
    });

    await claimAndComplete({
      teamId: team.teamId,
      task: upstreamTask,
      sessionKey: teammates[2]!.sessionKey,
      summary: "upstream-done",
    });
    await claimAndComplete({
      teamId: team.teamId,
      task: prevTask,
      sessionKey: teammates[0]!.sessionKey,
      summary: "prev-done",
    });

    claimForSession({
      teamId: team.teamId,
      taskId: currTask.taskId,
      sessionKey: teammates[1]!.sessionKey,
    });

    const qnRequest = await questionToolY.execute("ask-qn", {
      teamId: team.teamId,
      taskId: currTask.taskId,
      dependencyTaskId: prevTask.taskId,
      questionText: "What did you decide in prev_task?",
    });
    const qnRequestId = resultTaskId(qnRequest);

    claimForSession({
      teamId: team.teamId,
      taskId: qnRequestId,
      sessionKey: teammates[0]!.sessionKey,
    });

    const qnRequestUp = await questionToolX.execute("ask-upstream", {
      teamId: team.teamId,
      taskId: qnRequestId,
      dependencyTaskId: upstreamTask.taskId,
      questionText: "What changed in upstream_task?",
    });
    const qnRequestUpId = resultTaskId(qnRequestUp);

    writeGraphSnapshot({
      graphPath,
      historyPath,
      teamId: team.teamId,
      label: "qn-upstream-question-chain",
    });

    await claimAndComplete({
      teamId: team.teamId,
      task: listTasks(team.teamId, { includeCompleted: true }).tasks.find(
        (t) => t.taskId === qnRequestUpId,
      )!,
      sessionKey: teammates[2]!.sessionKey,
      summary: "upstream-answer",
    });
    await claimAndComplete({
      teamId: team.teamId,
      task: listTasks(team.teamId, { includeCompleted: true }).tasks.find(
        (t) => t.taskId === qnRequestId,
      )!,
      sessionKey: teammates[0]!.sessionKey,
      summary: "answer-from-x",
    });
    await claimAndComplete({
      teamId: team.teamId,
      task: listTasks(team.teamId, { includeCompleted: true }).tasks.find(
        (t) => t.taskId === currTask.taskId,
      )!,
      sessionKey: teammates[1]!.sessionKey,
      summary: "curr-done",
    });

    writeGraphSnapshot({
      graphPath,
      historyPath,
      teamId: team.teamId,
      label: "qn-upstream-complete",
    });
  });

  it("covers chore flags lead review", async () => {
    const { team, teammates } = createTeamWithTeammates({
      teamName: "chore-flags-review",
      size: 3,
    });

    const delivery = addScenarioTask(team.teamId, {
      title: "blocked-delivery",
      description: "waiting on chore review",
      assignTo: teammates[0]!.id,
    });

    updateTask(team.teamId, delivery.taskId, { status: "blocked" });
    updateTeammateStatus(team.teamId, teammates[0]!.id, "working");

    writeGraphSnapshot({
      graphPath,
      historyPath,
      teamId: team.teamId,
      label: "chore-flags-initial",
    });

    const choreResult = runChoreCheckNow(team.teamId);
    expect(choreResult.violations.length).toBeGreaterThan(0);

    const tasks = listTasks(team.teamId, { includeCompleted: true }).tasks;
    const leadReview = tasks.find(
      (task) => task.title === "lead_review" && task.metadata?.source === "chore",
    );
    const reviewQuestion = tasks.find(
      (task) => task.title === "review_question" && task.metadata?.source === "chore",
    );
    expect(leadReview).toBeTruthy();
    expect(reviewQuestion).toBeTruthy();
    expect(leadReview?.dependsOn).toContain(reviewQuestion?.taskId);
    const updatedDelivery = tasks.find((task) => task.taskId === delivery.taskId);
    expect(updatedDelivery?.dependsOn).toContain(leadReview?.taskId);

    writeGraphSnapshot({
      graphPath,
      historyPath,
      teamId: team.teamId,
      label: "chore-flags-escalated",
    });

    await claimAndComplete({
      teamId: team.teamId,
      task: reviewQuestion!,
      sessionKey: teammates[0]!.sessionKey,
      summary: "review response",
    });

    const leadAnswer = createTaskAnswerTool({ agentSessionKey: team.leadSessionKey });
    await leadAnswer.execute("answer-lead-review", {
      teamId: team.teamId,
      taskId: leadReview!.taskId,
      answer: "approved",
    });

    const deliveryAfterReview = listTasks(team.teamId, { includeCompleted: true }).tasks.find(
      (t) => t.taskId === delivery.taskId,
    );
    expectPendingOrClaimed(deliveryAfterReview?.status);

    await claimAndComplete({
      teamId: team.teamId,
      task: delivery,
      sessionKey: teammates[0]!.sessionKey,
      summary: "delivered",
    });

    writeGraphSnapshot({
      graphPath,
      historyPath,
      teamId: team.teamId,
      label: "chore-flags-complete",
    });
  });

  it("covers backlog overflow audit", async () => {
    const previousLimit = process.env.OPENCLAW_TEAM_CHORE_BACKLOG_LIMIT;
    process.env.OPENCLAW_TEAM_CHORE_BACKLOG_LIMIT = "2";
    try {
      const { team, teammates } = createTeamWithTeammates({
        teamName: "backlog-overflow",
        size: 4,
      });
      const leadAnswer = createTaskAnswerTool({ agentSessionKey: team.leadSessionKey });
      const tasks = [0, 1, 2].map((index) =>
        addScenarioTask(team.teamId, {
          title: `backlog-${index + 1}`,
          description: "queued work",
          assignTo: teammates[index]!.id,
        }),
      );

      writeGraphSnapshot({ graphPath, historyPath, teamId: team.teamId, label: "backlog-initial" });

      const choreResult = runChoreCheckNow(team.teamId);
      expect(
        choreResult.violations.some((violation) => violation.type === "backlog_overflow"),
      ).toBe(true);

      const tasksAfter = listTasks(team.teamId, { includeCompleted: true }).tasks;
      const leadReview = tasksAfter.find(
        (task) => task.title === "lead_review" && task.metadata?.source === "chore",
      );
      expect(leadReview?.metadata?.violationType).toBe("backlog_overflow");
      const blockedAfterReview = tasksAfter.find((task) => task.taskId === tasks[0]!.taskId);
      expect(blockedAfterReview?.status).toBe("blocked");

      writeGraphSnapshot({
        graphPath,
        historyPath,
        teamId: team.teamId,
        label: "backlog-flagged",
      });

      await leadAnswer.execute("answer-lead-review", {
        teamId: team.teamId,
        taskId: leadReview!.taskId,
        answer: "backlog cleared",
      });

      for (const task of tasks) {
        await claimAndComplete({
          teamId: team.teamId,
          task,
          sessionKey: teammates.find((tm) => tm.id === task.assignee)!.sessionKey,
          summary: "cleared",
        });
      }

      writeGraphSnapshot({
        graphPath,
        historyPath,
        teamId: team.teamId,
        label: "backlog-cleared",
      });
    } finally {
      if (previousLimit === undefined) {
        delete process.env.OPENCLAW_TEAM_CHORE_BACKLOG_LIMIT;
      } else {
        process.env.OPENCLAW_TEAM_CHORE_BACKLOG_LIMIT = previousLimit;
      }
    }
  });

  it("covers complex stress scenario", async () => {
    const { team, teammates } = createTeamWithTeammates({ teamName: "complex-stress", size: 6 });
    const questionToolY = createTaskQuestionTool({ agentSessionKey: teammates[1]!.sessionKey });

    const fanTasks = [0, 1, 2].map((index) =>
      addScenarioTask(team.teamId, {
        title: `fan-task-${index + 1}`,
        description: "parallel work",
        assignTo: teammates[index]!.id,
      }),
    );
    const pipeline1 = addScenarioTask(team.teamId, {
      title: "pipe-1",
      description: "draft",
      assignTo: teammates[3]!.id,
      dependsOn: [fanTasks[0]!.taskId],
    });
    const pipeline2 = addScenarioTask(team.teamId, {
      title: "pipe-2",
      description: "transform",
      assignTo: teammates[4]!.id,
      dependsOn: [pipeline1.taskId],
    });
    const pipeline3 = addScenarioTask(team.teamId, {
      title: "pipe-3",
      description: "validate",
      assignTo: teammates[5]!.id,
      dependsOn: [pipeline2.taskId],
    });

    const integration = addScenarioTask(team.teamId, {
      title: "integration",
      description: "combine fan work",
      assignTo: teammates[1]!.id,
      dependsOn: [fanTasks[0]!.taskId, fanTasks[1]!.taskId, fanTasks[2]!.taskId],
    });

    const choreTask = addScenarioTask(team.teamId, {
      title: "chore-ops",
      description: "maintenance",
      assignTo: teammates[4]!.id,
      priority: "high",
    });

    const leadReview = addScenarioTask(team.teamId, {
      title: "lead_review",
      description: "final check",
      assignTo: "lead",
      metadata: {
        target: teammates[5]!.id,
        reason: "risk check",
        context_task_id: choreTask.taskId,
      },
    });
    const leadReviewId = leadReview.taskId;
    const reviewQuestion = addScenarioTask(team.teamId, {
      title: "review_question",
      description: "Explain validation",
      assignTo: teammates[5]!.id,
      metadata: {
        questionText: "Explain validation",
        context_task_id: choreTask.taskId,
      },
    });
    const reviewQuestionId = reviewQuestion.taskId;
    updateTask(team.teamId, leadReviewId, { dependsOn: [reviewQuestionId] });
    updateTask(team.teamId, reviewQuestionId, { dependsOn: [choreTask.taskId] });

    const finalTask = addScenarioTask(team.teamId, {
      title: "finalize",
      description: "final delivery",
      assignTo: teammates[5]!.id,
      dependsOn: [pipeline3.taskId, integration.taskId, leadReviewId],
    });

    writeGraphSnapshot({ graphPath, historyPath, teamId: team.teamId, label: "complex-initial" });

    await claimAndComplete({
      teamId: team.teamId,
      task: fanTasks[0]!,
      sessionKey: teammates[0]!.sessionKey,
      summary: "fan-1",
    });
    await claimAndComplete({
      teamId: team.teamId,
      task: fanTasks[1]!,
      sessionKey: teammates[1]!.sessionKey,
      summary: "fan-2",
    });
    await claimAndComplete({
      teamId: team.teamId,
      task: fanTasks[2]!,
      sessionKey: teammates[2]!.sessionKey,
      summary: "fan-3",
    });
    await claimAndComplete({
      teamId: team.teamId,
      task: pipeline1,
      sessionKey: teammates[3]!.sessionKey,
      summary: "pipe-1",
    });
    await claimAndComplete({
      teamId: team.teamId,
      task: pipeline2,
      sessionKey: teammates[4]!.sessionKey,
      summary: "pipe-2",
    });
    await claimAndComplete({
      teamId: team.teamId,
      task: pipeline3,
      sessionKey: teammates[5]!.sessionKey,
      summary: "pipe-3",
    });

    claimForSession({
      teamId: team.teamId,
      taskId: integration.taskId,
      sessionKey: teammates[1]!.sessionKey,
    });
    const qnRequest = await questionToolY.execute("ask-qn", {
      teamId: team.teamId,
      taskId: integration.taskId,
      dependencyTaskId: fanTasks[0]!.taskId,
      questionText: "Clarify fan-1 output",
    });
    const qnRequestId = resultTaskId(qnRequest);

    await claimAndComplete({
      teamId: team.teamId,
      task: listTasks(team.teamId, { includeCompleted: true }).tasks.find(
        (t) => t.taskId === qnRequestId,
      )!,
      sessionKey: teammates[0]!.sessionKey,
      summary: "clarified",
    });
    await claimAndComplete({
      teamId: team.teamId,
      task: listTasks(team.teamId, { includeCompleted: true }).tasks.find(
        (t) => t.taskId === integration.taskId,
      )!,
      sessionKey: teammates[1]!.sessionKey,
      summary: "integration-done",
    });

    await claimAndComplete({
      teamId: team.teamId,
      task: choreTask,
      sessionKey: teammates[4]!.sessionKey,
      summary: "chore-done",
    });
    await claimAndComplete({
      teamId: team.teamId,
      task: listTasks(team.teamId, { includeCompleted: true }).tasks.find(
        (t) => t.taskId === reviewQuestionId,
      )!,
      sessionKey: teammates[5]!.sessionKey,
      summary: "review-answer",
    });
    const leadAnswer = createTaskAnswerTool({ agentSessionKey: team.leadSessionKey });
    await leadAnswer.execute("answer-lead-review", {
      teamId: team.teamId,
      taskId: leadReviewId,
      answer: "approved",
    });

    const finalPending = listTasks(team.teamId, { includeCompleted: true }).tasks.find(
      (t) => t.taskId === finalTask.taskId,
    );
    expectPendingOrClaimed(finalPending?.status);
    await claimAndComplete({
      teamId: team.teamId,
      task: finalTask,
      sessionKey: teammates[5]!.sessionKey,
      summary: "final-delivery",
    });

    writeGraphSnapshot({ graphPath, historyPath, teamId: team.teamId, label: "complex-complete" });
  });

  it("covers break point stress mix", async () => {
    const { team, teammates } = createTeamWithTeammates({ teamName: "breakpoint-mix", size: 7 });
    const questionToolY = createTaskQuestionTool({ agentSessionKey: teammates[1]!.sessionKey });
    const answerLead = createTaskAnswerTool({ agentSessionKey: team.leadSessionKey });

    const fanTasks = [0, 1, 2].map((index) =>
      addScenarioTask(team.teamId, {
        title: `fan-task-${index + 1}`,
        description: "fan-out work",
        assignTo: teammates[index]!.id,
      }),
    );
    const pipeline1 = addScenarioTask(team.teamId, {
      title: "pipe-1",
      description: "draft",
      assignTo: teammates[3]!.id,
      dependsOn: [fanTasks[0]!.taskId],
    });
    const pipeline2 = addScenarioTask(team.teamId, {
      title: "pipe-2",
      description: "transform",
      assignTo: teammates[4]!.id,
      dependsOn: [pipeline1.taskId],
    });
    const pipeline3 = addScenarioTask(team.teamId, {
      title: "pipe-3",
      description: "validate",
      assignTo: teammates[5]!.id,
      dependsOn: [pipeline2.taskId],
    });

    const integration = addScenarioTask(team.teamId, {
      title: "integration",
      description: "combine fan work",
      assignTo: teammates[1]!.id,
      dependsOn: [fanTasks[0]!.taskId, fanTasks[1]!.taskId, fanTasks[2]!.taskId],
    });
    const finalTask = addScenarioTask(team.teamId, {
      title: "final-delivery",
      description: "final delivery",
      assignTo: teammates[6]!.id,
      dependsOn: [pipeline3.taskId, integration.taskId],
    });

    const riskyTask = addScenarioTask(team.teamId, {
      title: "risky-task",
      description: "chore flagged risk",
      assignTo: teammates[0]!.id,
    });
    updateTask(team.teamId, riskyTask.taskId, { status: "blocked" });
    updateTeammateStatus(team.teamId, teammates[0]!.id, "working");

    writeGraphSnapshot({
      graphPath,
      historyPath,
      teamId: team.teamId,
      label: "breakpoint-initial",
    });

    const choreResult = runChoreCheckNow(team.teamId);
    expect(choreResult.violations.length).toBeGreaterThan(0);
    const tasksAfterChore = listTasks(team.teamId, { includeCompleted: true }).tasks;
    const leadReview = tasksAfterChore.find(
      (task) => task.title === "lead_review" && task.metadata?.source === "chore",
    );
    const reviewQuestion = tasksAfterChore.find(
      (task) => task.title === "review_question" && task.metadata?.source === "chore",
    );
    expect(leadReview).toBeTruthy();
    expect(reviewQuestion).toBeTruthy();
    updateTask(team.teamId, finalTask.taskId, {
      dependsOn: [pipeline3.taskId, integration.taskId, leadReview!.taskId],
    });

    await claimAndComplete({
      teamId: team.teamId,
      task: fanTasks[0]!,
      sessionKey: teammates[0]!.sessionKey,
      summary: "fan-1",
    });
    await claimAndComplete({
      teamId: team.teamId,
      task: fanTasks[1]!,
      sessionKey: teammates[1]!.sessionKey,
      summary: "fan-2",
    });
    await claimAndComplete({
      teamId: team.teamId,
      task: fanTasks[2]!,
      sessionKey: teammates[2]!.sessionKey,
      summary: "fan-3",
    });
    await claimAndComplete({
      teamId: team.teamId,
      task: pipeline1,
      sessionKey: teammates[3]!.sessionKey,
      summary: "pipe-1",
    });
    await claimAndComplete({
      teamId: team.teamId,
      task: pipeline2,
      sessionKey: teammates[4]!.sessionKey,
      summary: "pipe-2",
    });
    await claimAndComplete({
      teamId: team.teamId,
      task: pipeline3,
      sessionKey: teammates[5]!.sessionKey,
      summary: "pipe-3",
    });

    claimForSession({
      teamId: team.teamId,
      taskId: integration.taskId,
      sessionKey: teammates[1]!.sessionKey,
    });

    const qnRequest = await questionToolY.execute("ask-qn", {
      teamId: team.teamId,
      taskId: integration.taskId,
      dependencyTaskId: fanTasks[0]!.taskId,
      questionText: "Clarify fan-1 output",
    });
    const qnRequestId = resultTaskId(qnRequest);

    await claimAndComplete({
      teamId: team.teamId,
      task: listTasks(team.teamId, { includeCompleted: true }).tasks.find(
        (t) => t.taskId === qnRequestId,
      )!,
      sessionKey: teammates[0]!.sessionKey,
      summary: "clarified",
    });

    claimForSession({
      teamId: team.teamId,
      taskId: integration.taskId,
      sessionKey: teammates[1]!.sessionKey,
    });

    const qnRequest2 = await questionToolY.execute("ask-qn-2", {
      teamId: team.teamId,
      taskId: integration.taskId,
      dependencyTaskId: fanTasks[0]!.taskId,
      questionText: "Re-check fan-1 output details",
    });
    const qnRequest2Id = resultTaskId(qnRequest2);

    writeGraphSnapshot({
      graphPath,
      historyPath,
      teamId: team.teamId,
      label: "breakpoint-question-2",
    });

    await claimAndComplete({
      teamId: team.teamId,
      task: listTasks(team.teamId, { includeCompleted: true }).tasks.find(
        (t) => t.taskId === qnRequest2Id,
      )!,
      sessionKey: teammates[0]!.sessionKey,
      summary: "clarified-again",
    });
    await claimAndComplete({
      teamId: team.teamId,
      task: listTasks(team.teamId, { includeCompleted: true }).tasks.find(
        (t) => t.taskId === integration.taskId,
      )!,
      sessionKey: teammates[1]!.sessionKey,
      summary: "integration-done",
    });

    await claimAndComplete({
      teamId: team.teamId,
      task: reviewQuestion!,
      sessionKey: teammates[0]!.sessionKey,
      summary: "review response",
    });
    await answerLead.execute("answer-lead-review", {
      teamId: team.teamId,
      taskId: leadReview!.taskId,
      answer: "approved",
    });

    const finalPending = listTasks(team.teamId, { includeCompleted: true }).tasks.find(
      (t) => t.taskId === finalTask.taskId,
    );
    expectPendingOrClaimed(finalPending?.status);
    await claimAndComplete({
      teamId: team.teamId,
      task: finalTask,
      sessionKey: teammates[6]!.sessionKey,
      summary: "final-delivery",
    });

    writeGraphSnapshot({
      graphPath,
      historyPath,
      teamId: team.teamId,
      label: "breakpoint-complete",
    });
  });

  it("covers mega parallel review loop", async () => {
    const { team, teammates } = createTeamWithTeammates({ teamName: "mega-parallel", size: 8 });
    const leadAnswer = createTaskAnswerTool({ agentSessionKey: team.leadSessionKey });
    const questionToolIntegrator = createTaskQuestionTool({
      agentSessionKey: teammates[2]!.sessionKey,
    });
    const questionToolOwner = createTaskQuestionTool({
      agentSessionKey: teammates[1]!.sessionKey,
    });

    const foundation = addScenarioTask(team.teamId, {
      title: "foundation",
      description: "base decision",
      assignTo: teammates[0]!.id,
    });
    const analysis = addScenarioTask(team.teamId, {
      title: "analysis",
      description: "depends on foundation",
      assignTo: teammates[1]!.id,
      dependsOn: [foundation.taskId],
    });
    const fan2 = addScenarioTask(team.teamId, {
      title: "fan-2",
      description: "parallel stream",
      assignTo: teammates[3]!.id,
    });
    const fan3 = addScenarioTask(team.teamId, {
      title: "fan-3",
      description: "parallel stream",
      assignTo: teammates[4]!.id,
    });
    const pipeline1 = addScenarioTask(team.teamId, {
      title: "pipeline-1",
      description: "stage 1",
      assignTo: teammates[5]!.id,
      dependsOn: [foundation.taskId],
    });
    const pipeline2 = addScenarioTask(team.teamId, {
      title: "pipeline-2",
      description: "stage 2",
      assignTo: teammates[6]!.id,
      dependsOn: [pipeline1.taskId],
    });
    const integrationPrep = addScenarioTask(team.teamId, {
      title: "integration-prep",
      description: "needs analysis details",
      assignTo: teammates[2]!.id,
      dependsOn: [analysis.taskId],
    });
    const integration = addScenarioTask(team.teamId, {
      title: "integration",
      description: "merge all streams",
      assignTo: teammates[2]!.id,
      dependsOn: [integrationPrep.taskId, fan2.taskId, fan3.taskId, pipeline2.taskId],
    });
    const spotCheck = addScenarioTask(team.teamId, {
      title: "spot_check",
      description: "self correction check",
      assignTo: teammates[6]!.id,
      dependsOn: [pipeline2.taskId],
      metadata: { source: "chore" },
    });
    const risky = addScenarioTask(team.teamId, {
      title: "risky-track",
      description: "force chore escalation",
      assignTo: teammates[6]!.id,
    });
    const submission = addScenarioTask(team.teamId, {
      title: "submission",
      description: "prepare PR submission",
      assignTo: teammates[7]!.id,
      dependsOn: [integration.taskId, spotCheck.taskId],
    });
    const prReview = addScenarioTask(team.teamId, {
      title: "pr_review",
      description: "review submitted branch",
      assignTo: teammates[5]!.id,
      dependsOn: [submission.taskId],
      metadata: { source: "pr" },
    });
    const finalDelivery = addScenarioTask(team.teamId, {
      title: "final-delivery",
      description: "deliver after review approval",
      assignTo: teammates[7]!.id,
      dependsOn: [prReview.taskId],
    });

    writeGraphSnapshot({ graphPath, historyPath, teamId: team.teamId, label: "mega-initial" });

    await claimAndComplete({
      teamId: team.teamId,
      task: foundation,
      sessionKey: teammates[0]!.sessionKey,
      summary: "foundation-complete",
    });
    await claimAndComplete({
      teamId: team.teamId,
      task: analysis,
      sessionKey: teammates[1]!.sessionKey,
      summary: "analysis-complete",
    });
    await claimAndComplete({
      teamId: team.teamId,
      task: fan2,
      sessionKey: teammates[3]!.sessionKey,
      summary: "fan2-complete",
    });
    await claimAndComplete({
      teamId: team.teamId,
      task: fan3,
      sessionKey: teammates[4]!.sessionKey,
      summary: "fan3-complete",
    });
    await claimAndComplete({
      teamId: team.teamId,
      task: pipeline1,
      sessionKey: teammates[5]!.sessionKey,
      summary: "pipeline1-complete",
    });
    await claimAndComplete({
      teamId: team.teamId,
      task: pipeline2,
      sessionKey: teammates[6]!.sessionKey,
      summary: "pipeline2-complete",
    });

    claimForSession({
      teamId: team.teamId,
      taskId: integrationPrep.taskId,
      sessionKey: teammates[2]!.sessionKey,
    });
    const qnRequest = await questionToolIntegrator.execute("ask-analysis", {
      teamId: team.teamId,
      taskId: integrationPrep.taskId,
      dependencyTaskId: analysis.taskId,
      questionText: "Clarify analysis conclusion",
    });
    const qnRequestId = resultTaskId(qnRequest);

    claimForSession({
      teamId: team.teamId,
      taskId: qnRequestId,
      sessionKey: teammates[1]!.sessionKey,
    });
    const qnRequestUp = await questionToolOwner.execute("ask-foundation", {
      teamId: team.teamId,
      taskId: qnRequestId,
      dependencyTaskId: foundation.taskId,
      questionText: "Need upstream detail from foundation",
    });
    const qnRequestUpId = resultTaskId(qnRequestUp);

    writeGraphSnapshot({
      graphPath,
      historyPath,
      teamId: team.teamId,
      label: "mega-qn-chain-created",
    });

    await claimAndComplete({
      teamId: team.teamId,
      task: listTasks(team.teamId, { includeCompleted: true }).tasks.find(
        (task) => task.taskId === qnRequestUpId,
      )!,
      sessionKey: teammates[0]!.sessionKey,
      summary: "upstream-answer",
    });
    await claimAndComplete({
      teamId: team.teamId,
      task: listTasks(team.teamId, { includeCompleted: true }).tasks.find(
        (task) => task.taskId === qnRequestId,
      )!,
      sessionKey: teammates[1]!.sessionKey,
      summary: "dependency-answer",
    });
    await claimAndComplete({
      teamId: team.teamId,
      task: listTasks(team.teamId, { includeCompleted: true }).tasks.find(
        (task) => task.taskId === integrationPrep.taskId,
      )!,
      sessionKey: teammates[2]!.sessionKey,
      summary: "integration-prep-complete",
    });

    updateTask(team.teamId, risky.taskId, { status: "blocked" });
    updateTeammateStatus(team.teamId, teammates[6]!.id, "working");
    const choreResult = runChoreCheckNow(team.teamId);
    expect(choreResult.violations.length).toBeGreaterThan(0);

    const escalated = listTasks(team.teamId, { includeCompleted: true }).tasks;
    const leadReview = escalated.find(
      (task) => task.title === "lead_review" && task.metadata?.source === "chore",
    );
    const reviewQuestion = escalated.find(
      (task) => task.title === "review_question" && task.metadata?.source === "chore",
    );
    expect(leadReview).toBeTruthy();
    expect(reviewQuestion).toBeTruthy();
    updateTask(team.teamId, submission.taskId, {
      dependsOn: [integration.taskId, spotCheck.taskId, leadReview!.taskId],
    });

    await claimAndComplete({
      teamId: team.teamId,
      task: reviewQuestion!,
      sessionKey: teammates[6]!.sessionKey,
      summary: "review-question-answered",
    });
    await leadAnswer.execute("answer-lead-review", {
      teamId: team.teamId,
      taskId: leadReview!.taskId,
      answer: "approved",
    });

    await claimAndComplete({
      teamId: team.teamId,
      task: integration,
      sessionKey: teammates[2]!.sessionKey,
      summary: "integration-complete",
    });
    await claimAndComplete({
      teamId: team.teamId,
      task: spotCheck,
      sessionKey: teammates[6]!.sessionKey,
      summary: "spot-check-complete",
    });
    await claimAndComplete({
      teamId: team.teamId,
      task: submission,
      sessionKey: teammates[7]!.sessionKey,
      summary: "submission-complete",
    });

    const prRevision = addScenarioTask(team.teamId, {
      title: "pr_revision_request",
      description: "review requested one revision",
      assignTo: teammates[7]!.id,
      dependsOn: [submission.taskId],
      metadata: { source: "pr_review", context_task_id: submission.taskId },
    });
    updateTask(team.teamId, prReview.taskId, {
      dependsOn: [submission.taskId, prRevision.taskId],
    });

    const blockedPrReview = listTasks(team.teamId, { includeCompleted: true }).tasks.find(
      (task) => task.taskId === prReview.taskId,
    );
    expect(blockedPrReview?.status).toBe("blocked");

    writeGraphSnapshot({
      graphPath,
      historyPath,
      teamId: team.teamId,
      label: "mega-pr-revision-loop",
    });

    await claimAndComplete({
      teamId: team.teamId,
      task: prRevision,
      sessionKey: teammates[7]!.sessionKey,
      summary: "revision-complete",
    });
    await claimAndComplete({
      teamId: team.teamId,
      task: prReview,
      sessionKey: teammates[5]!.sessionKey,
      summary: "review-approved",
    });

    const finalPending = listTasks(team.teamId, { includeCompleted: true }).tasks.find(
      (task) => task.taskId === finalDelivery.taskId,
    );
    expectPendingOrClaimed(finalPending?.status);
    await claimAndComplete({
      teamId: team.teamId,
      task: finalDelivery,
      sessionKey: teammates[7]!.sessionKey,
      summary: "final-delivered",
    });

    const finalTasks = listTasks(team.teamId, { includeCompleted: true }).tasks;
    expect(finalTasks.find((task) => task.taskId === finalDelivery.taskId)?.status).toBe(
      "completed",
    );
    expect(finalTasks.find((task) => task.taskId === prReview.taskId)?.status).toBe("completed");
    expect(finalTasks.find((task) => task.taskId === prRevision.taskId)?.status).toBe("completed");

    writeGraphSnapshot({ graphPath, historyPath, teamId: team.teamId, label: "mega-complete" });
  });

  it("covers chore watcher violation escalation", async () => {
    const { team } = createTeamWithTeammates({ teamName: "chore-watch", size: 1 });
    updateTeamStatus(team.teamId, "working");
    const ghostTask = addScenarioTask(team.teamId, {
      title: "ghost-task",
      description: "assigned to missing teammate",
      assignTo: "ghost",
      metadata: { taskClass: "primary" },
    });

    const result = runChoreCheckNow(team.teamId);
    expect(result.violations.length).toBeGreaterThan(0);

    const tasks = listTasks(team.teamId, { includeCompleted: true }).tasks;
    const leadReview = tasks.find(
      (task) => task.title === "lead_review" && task.metadata?.source === "chore",
    );
    expect(leadReview).toBeTruthy();

    const updatedGhost = tasks.find((task) => task.taskId === ghostTask.taskId);
    expect(updatedGhost?.dependsOn).toContain(leadReview?.taskId);

    writeGraphSnapshot({
      graphPath,
      historyPath,
      teamId: team.teamId,
      label: "chore-watch-escalated",
    });
  });
});
