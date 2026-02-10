import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { loadConfig } from "../../../config/config.js";
import { createTeam, addTeammate, resetTeamRegistryForTests } from "../team-registry.js";
import { createPlanSubmitTool } from "./plan-submit-tool.js";

// Must be declared before vi.mock so the closure captures the reference
let testBasePath = "";

// Mock dependencies
vi.mock("../../../config/config.js", () => ({
  loadConfig: vi.fn(),
}));

// Mock store to redirect disk I/O to temp dir
vi.mock("../team-registry.store.js", () => ({
  resolveTeamBasePath: () => testBasePath,
  saveTeamToDisk: vi.fn(),
  loadAllTeamsFromDisk: vi.fn().mockReturnValue(new Map()),
}));

vi.mock("../../../infra/system-events.js", () => ({
  enqueueSystemEvent: vi.fn(),
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

describe("plan-submit-tool", () => {
  let teamId: string;

  beforeEach(() => {
    resetTeamRegistryForTests();
    vi.clearAllMocks();

    // Create temp dir for plan data
    testBasePath = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-plan-test-"));

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

  it("saves plan to disk", async () => {
    // Create a team
    const team = createTeam({
      teamName: "Test Team",
      leadSessionKey: "agent:main:main",
      config: { notifyOnUnblock: true },
    });
    teamId = team.teamId;

    // Create team and plans directories
    fs.mkdirSync(path.join(testBasePath, teamId, "plans"), { recursive: true });

    // Add a teammate with plan approval required
    const teammate = {
      teammateId: "tm1",
      role: "reviewer",
      sessionKey: "agent:team-x:teammate:reviewer-tm1",
      status: "active" as const,
      requirePlanApproval: true,
      planApproved: false,
      claimedTasks: 0,
      completedTasks: 0,
      createdAt: Date.now(),
    };
    addTeammate(teamId, teammate);

    const tool = createPlanSubmitTool({ agentSessionKey: teammate.sessionKey });

    const result = await tool.execute("call-1", {
      teamId,
      plan: {
        summary: "Implement feature X",
        steps: [
          {
            description: "Step 1: Research",
            estimatedTokens: 1000,
          },
          {
            description: "Step 2: Implement",
            estimatedTokens: 5000,
            tools: ["edit", "bash"],
          },
        ],
        risks: ["Potential security issue"],
      },
    });

    const details = resultDetails(result);
    expect(details.status).toBe("submitted");
    expect(details.planStatus).toBe("pending");

    // Verify plan file was written to temp dir
    const planPath = path.join(testBasePath, teamId, "plans", "tm1.json");
    expect(fs.existsSync(planPath)).toBe(true);
  });

  it("rejects when called by lead", async () => {
    const team = createTeam({
      teamName: "Test Team",
      leadSessionKey: "agent:main:main",
      config: { notifyOnUnblock: true },
    });
    teamId = team.teamId;

    const tool = createPlanSubmitTool({ agentSessionKey: "agent:main:main" });

    const result = await tool.execute("call-1", {
      teamId,
      plan: {
        summary: "Test plan",
        steps: [{ description: "Step 1" }],
      },
    });

    const text = resultText(result);
    expect(text.toLowerCase()).toContain("error");
    expect(text.toLowerCase()).toContain("teammate");
  });

  it("rejects when plan approval not required", async () => {
    const team = createTeam({
      teamName: "Test Team",
      leadSessionKey: "agent:main:main",
      config: { notifyOnUnblock: true },
    });
    teamId = team.teamId;

    // Add a teammate WITHOUT plan approval required
    const teammate = {
      teammateId: "tm1",
      role: "reviewer",
      sessionKey: "agent:team-x:teammate:reviewer-tm1",
      status: "active" as const,
      requirePlanApproval: false, // No plan approval required
      planApproved: false,
      claimedTasks: 0,
      completedTasks: 0,
      createdAt: Date.now(),
    };
    addTeammate(teamId, teammate);

    const tool = createPlanSubmitTool({ agentSessionKey: teammate.sessionKey });

    const result = await tool.execute("call-1", {
      teamId,
      plan: {
        summary: "Test plan",
        steps: [{ description: "Step 1" }],
      },
    });

    const text = resultText(result);
    expect(text.toLowerCase()).toContain("error");
    expect(text.toLowerCase()).toContain("not required");
  });

  it("notifies lead via enqueueSystemEvent", async () => {
    const { enqueueSystemEvent } = await import("../../../infra/system-events.js");

    const team = createTeam({
      teamName: "Test Team",
      leadSessionKey: "agent:main:main",
      config: { notifyOnUnblock: true },
    });
    teamId = team.teamId;
    fs.mkdirSync(path.join(testBasePath, teamId, "plans"), { recursive: true });

    const teammate = {
      teammateId: "tm1",
      role: "Security Reviewer",
      sessionKey: "agent:team-x:teammate:reviewer-tm1",
      status: "active" as const,
      requirePlanApproval: true,
      planApproved: false,
      claimedTasks: 0,
      completedTasks: 0,
      createdAt: Date.now(),
    };
    addTeammate(teamId, teammate);

    const tool = createPlanSubmitTool({ agentSessionKey: teammate.sessionKey });

    await tool.execute("call-1", {
      teamId,
      plan: {
        summary: "Review security vulnerabilities",
        steps: [{ description: "Audit code" }, { description: "Write report" }],
      },
    });

    expect(enqueueSystemEvent).toHaveBeenCalled();
    expect(enqueueSystemEvent).toHaveBeenCalledWith(
      expect.stringContaining("Security Reviewer"),
      expect.objectContaining({
        sessionKey: "agent:main:main",
      }),
    );
  });

  it("includes plan details in notification", async () => {
    const { enqueueSystemEvent } = await import("../../../infra/system-events.js");

    const team = createTeam({
      teamName: "Test Team",
      leadSessionKey: "agent:main:main",
      config: { notifyOnUnblock: true },
    });
    teamId = team.teamId;
    fs.mkdirSync(path.join(testBasePath, teamId, "plans"), { recursive: true });

    const teammate = {
      teammateId: "tm1",
      role: "reviewer",
      sessionKey: "agent:team-x:teammate:reviewer-tm1",
      status: "active" as const,
      requirePlanApproval: true,
      planApproved: false,
      claimedTasks: 0,
      completedTasks: 0,
      createdAt: Date.now(),
    };
    addTeammate(teamId, teammate);

    const tool = createPlanSubmitTool({ agentSessionKey: teammate.sessionKey });

    await tool.execute("call-1", {
      teamId,
      plan: {
        summary: "Implement feature X",
        steps: [{ description: "Step 1" }, { description: "Step 2" }],
      },
    });

    expect(enqueueSystemEvent).toHaveBeenCalledWith(
      expect.stringContaining("Implement feature X"),
      expect.any(Object),
    );
  });

  it("rejects when teams are disabled", async () => {
    vi.mocked(loadConfig).mockReturnValue({
      gateway: {
        teams: {
          enabled: false,
        },
      },
    } as any);

    const tool = createPlanSubmitTool({ agentSessionKey: "agent:team-x:teammate:tm1" });

    const result = await tool.execute("call-1", {
      teamId: "any-team",
      plan: {
        summary: "Test",
        steps: [{ description: "Step" }],
      },
    });

    const text = resultText(result);
    expect(text.toLowerCase()).toContain("error");
    expect(text.toLowerCase()).toContain("not enabled");
  });
});
