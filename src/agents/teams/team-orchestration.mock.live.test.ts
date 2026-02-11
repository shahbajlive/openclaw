import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.js";
import type { Task } from "./types.js";
import { isTruthyEnvValue } from "../../infra/env.js";

let addTask: typeof import("./task-list.js").addTask;
let listTasks: typeof import("./task-list.js").listTasks;
let claimTask: typeof import("./task-list.js").claimTask;
let updateTask: typeof import("./task-list.js").updateTask;
let addTeammate: typeof import("./team-registry.js").addTeammate;
let createTeam: typeof import("./team-registry.js").createTeam;
let getTeam: typeof import("./team-registry.js").getTeam;
let getTeammateBySessionKey: typeof import("./team-registry.js").getTeammateBySessionKey;
let resetTeamRegistryForTests: typeof import("./team-registry.js").resetTeamRegistryForTests;
let updateTeammateStatus: typeof import("./team-registry.js").updateTeammateStatus;
let createTaskAnswerTool: typeof import("./tools/index.js").createTaskAnswerTool;
let createTaskQuestionTool: typeof import("./tools/index.js").createTaskQuestionTool;

let tempRoot = "";
let graphPath = "";
let historyPath = "";
let testBasePath = "";
const previousEnv = {
  configPath: process.env.OPENCLAW_CONFIG_PATH,
  stateDir: process.env.OPENCLAW_STATE_DIR,
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
    "# Task Graph (Mock Live Test)",
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

function resultDetails(result: unknown): Record<string, unknown> {
  return (result as { details?: Record<string, unknown> }).details ?? {};
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

describeLive("team orchestration deterministic flow (mock model)", () => {
  beforeAll(async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-team-mock-"));
    const stateDir = path.join(tempRoot, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    testBasePath = path.join(stateDir, "teams");
    fs.mkdirSync(testBasePath, { recursive: true });
    graphPath = path.join(process.cwd(), "test-graph.md");
    historyPath = path.join(process.cwd(), "test-graph-history.md");
    await fsp.writeFile(graphPath, "# Task Graph (Mock Live Test)\n\n");
    await fsp.writeFile(historyPath, "# Task Graph History (Mock Live Test)\n\n");

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

    ({ addTask, listTasks, claimTask, updateTask } = await import("./task-list.js"));
    ({
      addTeammate,
      createTeam,
      getTeam,
      getTeammateBySessionKey,
      resetTeamRegistryForTests,
      updateTeammateStatus,
    } = await import("./team-registry.js"));
    ({ createTaskAnswerTool } = await import("./tools/index.js"));
    ({ createTaskQuestionTool } = await import("./tools/index.js"));

    resetTeamRegistryForTests();
  });

  afterAll(() => {
    process.env.OPENCLAW_CONFIG_PATH = previousEnv.configPath;
    process.env.OPENCLAW_STATE_DIR = previousEnv.stateDir;
    const keepArtifacts = isTruthyEnvValue(process.env.OPENCLAW_LIVE_TEAM_KEEP_ARTIFACTS);
    if (!keepArtifacts && tempRoot && fs.existsSync(tempRoot)) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("routes deterministic questions + lead review with correct state transitions", async () => {
    const team = createTeam({
      teamName: "deterministic-flow",
      leadSessionKey: "agent:team-deterministic-flow:lead",
      config: { notifyOnUnblock: false },
    });
    const teamId = team.teamId;
    const teamDir = path.join(testBasePath, teamId);
    fs.mkdirSync(teamDir, { recursive: true });

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
    const qnRequestId = String(resultDetails(qnRequest).questionTaskId ?? "");

    const afterBlock = getTeam(teamId);
    expect(afterBlock?.teammates.y.status).toBe("idle");
    writeGraphSnapshot({ graphPath, historyPath, teamId, label: "after-qn-request" });

    claimForX(qnRequestId);
    await answerToolX.execute("answer-qn-request", {
      teamId,
      taskId: qnRequestId,
      answer: "Answer: use plan v2",
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
    await answerToolT.execute("answer-review", {
      teamId,
      taskId: reviewQId,
      answer: "Explained",
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
  });
});
