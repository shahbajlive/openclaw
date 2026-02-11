import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { loadConfig } from "../../../../config/config.js";
import { addTask, claimTask, getTask, listTasks } from "../../task-list.js";
import {
  addTeammate,
  createTeam,
  getTeam,
  resetTeamRegistryForTests,
} from "../../team-registry.js";
import { createTaskAnswerTool } from "./task-answer-tool.js";

let testBasePath = "";

vi.mock("../../../../config/config.js", () => ({
  loadConfig: vi.fn(),
}));

vi.mock("../../team-registry.store.js", () => ({
  resolveTeamBasePath: () => testBasePath,
  saveTeamToDisk: vi.fn(),
  loadAllTeamsFromDisk: vi.fn().mockReturnValue(new Map()),
}));

vi.mock("../../../../infra/agent-events.js", () => ({
  onAgentEvent: vi.fn().mockReturnValue(() => {}),
}));

function resultDetails(result: unknown): Record<string, unknown> {
  return (result as { details?: Record<string, unknown> }).details ?? {};
}

describe("task-answer-tool", () => {
  let teamId: string;

  beforeEach(() => {
    resetTeamRegistryForTests();
    vi.clearAllMocks();

    testBasePath = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-task-answer-test-"));

    vi.mocked(loadConfig).mockReturnValue({
      gateway: { teams: { enabled: true } },
    } as any);
  });

  afterEach(() => {
    if (testBasePath && fs.existsSync(testBasePath)) {
      fs.rmSync(testBasePath, { recursive: true, force: true });
    }
  });

  it("records answer, completes task, and idles teammate", async () => {
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
      status: "working",
      requirePlanApproval: false,
      planApproved: true,
      currentTask: "Work A",
      currentTaskId: "task-123",
      claimedTasks: 1,
      completedTasks: 0,
      createdAt: Date.now(),
    });

    const taskA = addTask(teamId, {
      title: "Work A",
      priority: "normal",
      assignTo: "tm1",
      metadata: { taskClass: "primary" },
    });
    claimTask(teamId, { taskId: taskA.taskId, claimerId: "tm1" });

    const tool = createTaskAnswerTool({ agentSessionKey: sessionKey });
    const result = await tool.execute("call-1", {
      teamId,
      taskId: taskA.taskId,
      answer: "done",
    });

    const details = resultDetails(result);
    expect(details.status).toBe("completed");

    const updatedTask = getTask(teamId, taskA.taskId);
    expect(updatedTask?.status).toBe("completed");
    expect(updatedTask?.summary).toBe("done");

    const updatedTeam = getTeam(teamId);
    expect(updatedTeam?.teammates.tm1.status).toBe("idle");
    expect(updatedTeam?.teammates.tm1.currentTask).toBeUndefined();
    expect(updatedTeam?.teammates.tm1.currentTaskId).toBeUndefined();
  });

  it("parses init_task answer and creates subtasks", async () => {
    const team = createTeam({
      teamName: "Init Team",
      leadSessionKey: "agent:main:lead",
      config: { notifyOnUnblock: true },
    });
    teamId = team.teamId;
    fs.mkdirSync(path.join(testBasePath, teamId), { recursive: true });

    addTeammate(teamId, {
      teammateId: "tm1",
      role: "builder",
      sessionKey: `agent:team-${teamId}:teammate:builder`,
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
      role: "reviewer",
      sessionKey: `agent:team-${teamId}:teammate:reviewer`,
      status: "idle",
      requirePlanApproval: false,
      planApproved: true,
      currentTask: undefined,
      claimedTasks: 0,
      completedTasks: 0,
      createdAt: Date.now(),
    });

    const initTask = addTask(teamId, { title: "init_task", assignTo: "lead" });
    const tool = createTaskAnswerTool({ agentSessionKey: team.leadSessionKey });
    const answer = [
      "```json",
      JSON.stringify(
        {
          tasks: [
            { id: "spec", title: "Spec work", assignee: "tm1" },
            {
              id: "review",
              title: "Review work",
              assignee: "reviewer",
              dependsOn: ["spec"],
            },
          ],
        },
        null,
        2,
      ),
      "```",
    ].join("\n");

    const result = await tool.execute("call-init", {
      teamId,
      taskId: initTask.taskId,
      answer,
    });

    const details = resultDetails(result);
    expect(details.status).toBe("completed");

    const tasks = listTasks(teamId, { includeCompleted: true }).tasks;
    const spec = tasks.find((task) => task.title === "Spec work");
    const review = tasks.find((task) => task.title === "Review work");
    expect(spec?.assignee).toBe("tm1");
    expect(review?.assignee).toBe("tm2");
    expect(spec?.taskClass).toBe("primary");
    expect(review?.taskClass).toBe("primary");
    expect(spec?.dependsOn).toContain(initTask.taskId);
    expect(review?.dependsOn).toContain(initTask.taskId);
    expect(review?.dependsOn).toContain(spec?.taskId);
  });
});
