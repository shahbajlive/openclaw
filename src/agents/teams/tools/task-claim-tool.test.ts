import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { loadConfig } from "../../../config/config.js";
import { addTask } from "../task-list.js";
import { createTeam, addTeammate, resetTeamRegistryForTests, getTeam } from "../team-registry.js";
import { createTaskClaimTool } from "./task-claim-tool.js";

// Must be declared before vi.mock so the closure captures the reference
let testBasePath = "";

// Mock config
vi.mock("../../../config/config.js", () => ({
  loadConfig: vi.fn(),
}));

// Mock store to redirect disk I/O to temp dir
vi.mock("../team-registry.store.js", () => ({
  resolveTeamBasePath: () => testBasePath,
  saveTeamToDisk: vi.fn(),
  loadAllTeamsFromDisk: vi.fn().mockReturnValue(new Map()),
}));

// Mock agent events
vi.mock("../../../infra/agent-events.js", () => ({
  onAgentEvent: vi.fn().mockReturnValue(() => {}),
}));

/** Extract the JSON text from an AgentToolResult. */
function resultText(result: unknown): string {
  const r = result as { content?: Array<{ text?: string }> };
  return r?.content?.[0]?.text ?? JSON.stringify(result);
}

/** Extract the details object from an AgentToolResult. */
function resultDetails(result: unknown): Record<string, unknown> {
  return (result as { details?: Record<string, unknown> }).details ?? {};
}

describe("task-claim-tool", () => {
  let teamId: string;

  beforeEach(() => {
    resetTeamRegistryForTests();
    vi.clearAllMocks();

    // Create temp dir for task data
    testBasePath = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-task-claim-test-"));

    // Setup default mock config
    vi.mocked(loadConfig).mockReturnValue({
      gateway: {
        teams: {
          enabled: true,
        },
      },
    } as any);
  });

  afterEach(() => {
    if (testBasePath && fs.existsSync(testBasePath)) {
      fs.rmSync(testBasePath, { recursive: true, force: true });
    }
  });

  it("allows lead to claim in normal mode", async () => {
    // Create a team in normal mode
    const team = createTeam({
      teamName: "Test Team",
      leadSessionKey: "agent:main:main",
      config: { notifyOnUnblock: true },
    });
    teamId = team.teamId;
    fs.mkdirSync(path.join(testBasePath, teamId), { recursive: true });

    // Add a task
    const task = addTask(teamId, {
      title: "Implement feature",
      priority: "normal",
    });

    const tool = createTaskClaimTool({ agentSessionKey: "agent:main:main" });

    const result = await tool.execute("call-1", {
      teamId,
      taskId: task.taskId,
    });

    const details = resultDetails(result);
    expect(details.success).toBe(true);
    expect(details.taskId).toBe(task.taskId);
  });

  it("rejects lead claim", async () => {
    // Create a team
    const team = createTeam({
      teamName: "Test Team",
      leadSessionKey: "agent:main:main",
      config: { notifyOnUnblock: true },
    });
    teamId = team.teamId;
    fs.mkdirSync(path.join(testBasePath, teamId), { recursive: true });

    // Add a task
    const task = addTask(teamId, {
      title: "Implement feature",
      priority: "normal",
    });

    const tool = createTaskClaimTool({ agentSessionKey: "agent:main:main" });

    const result = await tool.execute("call-1", {
      teamId,
      taskId: task.taskId,
    });

    const text = resultText(result);
    expect(text.toLowerCase()).toContain("error");
    expect(text.toLowerCase()).toContain("lead");
  });

  it("allows teammate to claim", async () => {
    // Create a team
    const team = createTeam({
      teamName: "Test Team",
      leadSessionKey: "agent:main:main",
      config: { notifyOnUnblock: true },
    });
    teamId = team.teamId;
    fs.mkdirSync(path.join(testBasePath, teamId), { recursive: true });

    // Add a teammate
    const teammate = {
      teammateId: "tm1",
      role: "reviewer",
      sessionKey: "agent:team-x:teammate:reviewer-tm1",
      status: "active" as const,
      requirePlanApproval: false,
      planApproved: false,
      claimedTasks: 0,
      completedTasks: 0,
      createdAt: Date.now(),
    };
    addTeammate(teamId, teammate);

    // Add a task
    const task = addTask(teamId, {
      title: "Implement feature",
      priority: "normal",
    });

    const tool = createTaskClaimTool({ agentSessionKey: teammate.sessionKey });

    const result = await tool.execute("call-1", {
      teamId,
      taskId: task.taskId,
    });

    const details = resultDetails(result);
    expect(details.success).toBe(true);
    expect(details.taskId).toBe(task.taskId);
  });

  it("returns error when no pending tasks available", async () => {
    const team = createTeam({
      teamName: "Test Team",
      leadSessionKey: "agent:main:main",
      config: { notifyOnUnblock: true },
    });
    teamId = team.teamId;
    fs.mkdirSync(path.join(testBasePath, teamId), { recursive: true });

    const tool = createTaskClaimTool({ agentSessionKey: "agent:main:main" });

    // Try to claim without any tasks
    const result = await tool.execute("call-1", {
      teamId,
    });

    const text = resultText(result);
    expect(text.toLowerCase()).toContain("error");
    expect(text.toLowerCase()).toContain("no");
  });

  it("auto-selects highest priority task when taskId not provided", async () => {
    const team = createTeam({
      teamName: "Test Team",
      leadSessionKey: "agent:main:main",
      config: { notifyOnUnblock: true },
    });
    teamId = team.teamId;
    fs.mkdirSync(path.join(testBasePath, teamId), { recursive: true });

    // Add tasks with different priorities
    addTask(teamId, { title: "Normal task", priority: "normal" });
    const criticalTask = addTask(teamId, { title: "Critical task", priority: "critical" });

    const tool = createTaskClaimTool({ agentSessionKey: "agent:main:main" });

    // Claim without specifying taskId
    const result = await tool.execute("call-1", {
      teamId,
    });

    const details = resultDetails(result);
    expect(details.success).toBe(true);
    expect(details.taskId).toBe(criticalTask.taskId);
  });

  it("rejects when teams are disabled", async () => {
    vi.mocked(loadConfig).mockReturnValue({
      gateway: {
        teams: {
          enabled: false,
        },
      },
    } as any);

    const tool = createTaskClaimTool({ agentSessionKey: "agent:main:main" });

    const result = await tool.execute("call-1", {
      teamId: "any-team",
    });

    const text = resultText(result);
    expect(text.toLowerCase()).toContain("error");
    expect(text.toLowerCase()).toContain("not enabled");
  });

  it("increments teammate claimedTasks counter", async () => {
    const team = createTeam({
      teamName: "Test Team",
      leadSessionKey: "agent:main:main",
      config: { notifyOnUnblock: true },
    });
    teamId = team.teamId;
    fs.mkdirSync(path.join(testBasePath, teamId), { recursive: true });

    const teammate = {
      teammateId: "tm1",
      role: "reviewer",
      sessionKey: "agent:team-x:teammate:reviewer-tm1",
      status: "active" as const,
      requirePlanApproval: false,
      planApproved: false,
      claimedTasks: 0,
      completedTasks: 0,
      createdAt: Date.now(),
    };
    addTeammate(teamId, teammate);

    const task = addTask(teamId, {
      title: "Task",
      priority: "normal",
    });

    const tool = createTaskClaimTool({ agentSessionKey: teammate.sessionKey });

    await tool.execute("call-1", {
      teamId,
      taskId: task.taskId,
    });

    // Verify counter was incremented
    const updatedTeam = getTeam(teamId);
    expect(updatedTeam?.teammates[teammate.teammateId].claimedTasks).toBe(1);
  });
});
