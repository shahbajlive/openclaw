import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { loadConfig } from "../../../../../config/config.js";
import { addTask, listTasks, claimTask } from "../../../task-list.js";
import {
  addTeammate,
  createTeam,
  getTeammateBySessionKey,
  getTeam,
  resetTeamRegistryForTests,
  updateTeammateStatus,
} from "../../../team-registry.js";
import { createTaskAnswerTool } from "../task-answer-tool.js";
import { createTaskQuestionTool } from "./task-question-tool.js";

let testBasePath = "";

vi.mock("../../../../../config/config.js", () => ({
  loadConfig: vi.fn(),
}));

vi.mock("../../../../../gateway/call.js", () => ({
  callGateway: vi.fn().mockResolvedValue({}),
}));

vi.mock("../../../team-registry.store.js", () => ({
  resolveTeamBasePath: () => testBasePath,
  saveTeamToDisk: vi.fn(),
  loadAllTeamsFromDisk: vi.fn().mockReturnValue(new Map()),
}));

vi.mock("../../../../../infra/agent-events.js", () => ({
  onAgentEvent: vi.fn().mockReturnValue(() => {}),
}));

function resultDetails(result: unknown): Record<string, unknown> {
  return (result as { details?: Record<string, unknown> }).details ?? {};
}

function claimForSession(params: { teamId: string; taskId: string; sessionKey: string }): void {
  const teammate = getTeammateBySessionKey(params.teamId, params.sessionKey);
  if (!teammate) {
    throw new Error("Teammate not found for session key");
  }
  const claimResult = claimTask(params.teamId, {
    taskId: params.taskId,
    claimerId: teammate.teammateId,
  });
  if (!claimResult.success || !claimResult.task) {
    throw new Error(`Failed to claim task: ${claimResult.reason ?? "unknown"}`);
  }
  teammate.currentTask = claimResult.task.title;
  teammate.currentTaskId = claimResult.task.taskId;
  teammate.claimedTasks++;
  updateTeammateStatus(params.teamId, teammate.teammateId, "working");
}

describe("task-question-tool", () => {
  let teamId: string;

  beforeEach(() => {
    resetTeamRegistryForTests();
    vi.clearAllMocks();

    testBasePath = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-task-question-test-"));

    vi.mocked(loadConfig).mockReturnValue({
      gateway: { teams: { enabled: true } },
    } as any);
  });

  afterEach(() => {
    if (testBasePath && fs.existsSync(testBasePath)) {
      fs.rmSync(testBasePath, { recursive: true, force: true });
    }
  });

  it("creates qn_request, blocks task, and idles teammate", async () => {
    const team = createTeam({
      teamName: "Test Team",
      leadSessionKey: "agent:main:lead",
      config: { notifyOnUnblock: true },
    });
    teamId = team.teamId;
    fs.mkdirSync(path.join(testBasePath, teamId), { recursive: true });

    const askerSessionKey = `agent:team-${teamId}:teammate:asker-tm1`;
    const ownerSessionKey = `agent:team-${teamId}:teammate:owner-tm2`;

    addTeammate(teamId, {
      teammateId: "tm1",
      role: "asker",
      sessionKey: askerSessionKey,
      status: "idle",
      requirePlanApproval: false,
      planApproved: true,
      currentTask: undefined,
      claimedTasks: 0,
      completedTasks: 0,
      createdAt: Date.now(),
    });

    addTeammate(teamId, {
      teammateId: "tm2",
      role: "owner",
      sessionKey: ownerSessionKey,
      status: "idle",
      requirePlanApproval: false,
      planApproved: true,
      currentTask: undefined,
      claimedTasks: 0,
      completedTasks: 0,
      createdAt: Date.now(),
    });

    const prevTask = addTask(teamId, {
      title: "prev_task",
      description: "Upstream decision",
      assignTo: "tm2",
      metadata: { taskClass: "primary" },
    });
    const currTask = addTask(teamId, {
      title: "curr_task",
      description: "Needs upstream info",
      assignTo: "tm1",
      dependsOn: [prevTask.taskId],
      metadata: { taskClass: "secondary" },
    });

    const answerPrev = createTaskAnswerTool({ agentSessionKey: ownerSessionKey });
    claimForSession({ teamId, taskId: prevTask.taskId, sessionKey: ownerSessionKey });
    await answerPrev.execute("answer-prev", {
      teamId,
      taskId: prevTask.taskId,
      answer: "done",
    });

    claimForSession({ teamId, taskId: currTask.taskId, sessionKey: askerSessionKey });

    const questionTool = createTaskQuestionTool({ agentSessionKey: askerSessionKey });
    const result = await questionTool.execute("ask", {
      teamId,
      taskId: currTask.taskId,
      dependencyTaskId: prevTask.taskId,
      questionText: "What did you decide?",
    });

    const details = resultDetails(result);
    expect(details.status).toBe("queued");
    const qnRequestId = String(details.questionTaskId ?? "");
    expect(qnRequestId).not.toBe("");

    const tasks = listTasks(teamId, { includeCompleted: true }).tasks;
    const qnRequest = tasks.find((task) => task.taskId === qnRequestId);
    expect(qnRequest?.title).toBe("qn_request");
    expect(qnRequest?.assignee).toBe("tm2");
    expect(qnRequest?.priority).toBe("high");
    expect(qnRequest?.dependsOn).toContain(prevTask.taskId);

    const updatedCurr = tasks.find((task) => task.taskId === currTask.taskId);
    expect(updatedCurr?.status).toBe("blocked");
    expect(updatedCurr?.dependsOn).toContain(prevTask.taskId);
    expect(updatedCurr?.dependsOn).toContain(qnRequestId);

    const updatedTeam = getTeam(teamId);
    expect(updatedTeam?.teammates.tm1.status).toBe("idle");
    expect(updatedTeam?.teammates.tm1.currentTask).toBeUndefined();
    expect(updatedTeam?.teammates.tm1.currentTaskId).toBeUndefined();
  });

  it("rejects when dependency is not in dependsOn", async () => {
    const team = createTeam({
      teamName: "Test Team",
      leadSessionKey: "agent:main:lead",
      config: { notifyOnUnblock: true },
    });
    teamId = team.teamId;
    fs.mkdirSync(path.join(testBasePath, teamId), { recursive: true });

    const sessionKey = `agent:team-${teamId}:teammate:worker-tm1`;
    addTeammate(teamId, {
      teammateId: "tm1",
      role: "worker",
      sessionKey,
      status: "idle",
      requirePlanApproval: false,
      planApproved: true,
      currentTask: undefined,
      claimedTasks: 0,
      completedTasks: 0,
      createdAt: Date.now(),
    });

    const prevTask = addTask(teamId, {
      title: "prev_task",
      description: "Upstream decision",
      assignTo: "tm1",
      metadata: { taskClass: "primary" },
    });
    const currTask = addTask(teamId, {
      title: "curr_task",
      description: "Needs upstream info",
      assignTo: "tm1",
      metadata: { taskClass: "secondary", context_task_id: prevTask.taskId },
    });

    claimForSession({ teamId, taskId: currTask.taskId, sessionKey });

    const questionTool = createTaskQuestionTool({ agentSessionKey: sessionKey });
    const result = await questionTool.execute("ask", {
      teamId,
      taskId: currTask.taskId,
      dependencyTaskId: prevTask.taskId,
      questionText: "What did you decide?",
    });

    const details = resultDetails(result);
    expect(details.status).toBe("error");
    expect(String(details.error ?? "")).toContain("dependency");
  });
});
