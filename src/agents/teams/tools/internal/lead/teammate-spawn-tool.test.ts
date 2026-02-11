import { describe, it, expect, beforeEach, vi } from "vitest";
import { loadConfig } from "../../../../../config/config.js";
import {
  createTeam,
  resetTeamRegistryForTests,
  getTeam,
  initTeamRegistry,
} from "../../../team-registry.js";
import { createTeammateSpawnTool } from "./teammate-spawn-tool.js";

// Mock dependencies
vi.mock("../../../../../config/config.js", () => ({
  loadConfig: vi.fn(),
}));

vi.mock("../../../../../gateway/call.js", () => ({
  callGateway: vi.fn(),
}));

vi.mock("../../../system-prompt.js", () => ({
  buildTeammateSystemPrompt: vi.fn().mockReturnValue("mock system prompt"),
}));

// Mock store to prevent disk I/O
vi.mock("../../../team-registry.store.js", () => ({
  resolveTeamBasePath: vi.fn().mockReturnValue("/tmp/openclaw-test-noop"),
  saveTeamToDisk: vi.fn(),
  loadAllTeamsFromDisk: vi.fn().mockReturnValue(new Map()),
  deleteTeamFromDisk: vi.fn(),
}));

// Mock agent events - we need a real implementation for the regression test
// but we need to control it.
let eventHandler: ((evt: any) => void) | undefined;
vi.mock("../../../../../infra/agent-events.js", () => ({
  onAgentEvent: vi.fn().mockImplementation((handler) => {
    eventHandler = handler;
    return () => {
      eventHandler = undefined;
    };
  }),
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

describe("teammate-spawn-tool", () => {
  let teamId: string;

  beforeEach(() => {
    resetTeamRegistryForTests();
    vi.clearAllMocks();
    eventHandler = undefined;

    // Setup default mock config
    vi.mocked(loadConfig).mockReturnValue({
      gateway: {
        teams: {
          enabled: true,
          defaultModel: "claude-3-5-sonnet-20241022",
        },
      },
      agents: {
        list: [
          {
            id: "main",
            teams: {
              allowedModels: ["claude-3-5-sonnet-20241022", "gpt-4"],
              defaultModel: "claude-3-5-sonnet-20241022",
            },
          },
        ],
      },
    } as any);

    // Create a test team
    const team = createTeam({
      teamName: "Test Team",
      leadSessionKey: "agent:main:main",
      config: { notifyOnUnblock: true },
    });
    teamId = team.teamId;

    // Initialize registry to start the listener
    initTeamRegistry();
  });

  it("spawns a teammate via callGateway", async () => {
    const { callGateway } = await import("../../../../../gateway/call.js");
    vi.mocked(callGateway).mockResolvedValue({ runId: "mock-run-id" });

    const tool = createTeammateSpawnTool({ agentSessionKey: "agent:main:main" });

    const result = await tool.execute("call-1", {
      teamId,
      role: "reviewer",
      task: "Review the code",
    });

    const details = resultDetails(result);
    expect(details.status).toBe("spawned");
    expect(details.teammateId).toBeTruthy();
    expect(callGateway).toHaveBeenCalled();
  });

  it("handles race condition: lifecycle event arrives during spawn", async () => {
    const { callGateway } = await import("../../../../../gateway/call.js");

    // Mock gateway to emit "start" event immediately when called
    // This simulates the race condition where the process starts and reports back
    // before the tool execution completes.
    vi.mocked(callGateway).mockImplementation(async (opts) => {
      // Simulate the event arriving RIGHT NOW
      if (eventHandler) {
        // The ID used in the tool is childIdem unless gateway returns otherwise.
        // We'll capture the ID passed to gateway if possible, but the tool generates it.
        // We can inspect the args to find the idempotencyKey
        const params = opts.params as any;
        const runId = params.idempotencyKey; // The tool uses checking idempotencyKey as runId initially

        eventHandler({
          stream: "lifecycle",
          runId: runId, // Use the ID the tool generated
          data: { phase: "start" },
        });
      }
      return { runId: "mock-run-id-immediate" };
    });

    const tool = createTeammateSpawnTool({ agentSessionKey: "agent:main:main" });

    const result = await tool.execute("call-race", {
      teamId,
      role: "racer",
      task: "Win the race",
    });

    const details = resultDetails(result);
    const tmId = details.teammateId as string;
    const team = getTeam(teamId);
    const teammate = team?.teammates[tmId];

    expect(teammate).toBeTruthy();
    // Start event should be processed, and spawn flow then normalizes teammate to idle.
    expect(teammate?.status).toBe("idle");
  });

  it("removes teammate if gateway call fails", async () => {
    const { callGateway } = await import("../../../../../gateway/call.js");
    vi.mocked(callGateway).mockRejectedValue(new Error("Network fail"));

    const tool = createTeammateSpawnTool({ agentSessionKey: "agent:main:main" });

    const result = await tool.execute("call-fail", {
      teamId,
      role: "failure",
      task: "Fail this",
    });

    const text = resultText(result);
    // Should return error
    expect(text.toLowerCase()).toContain("error");

    // Check local registry - teammate should be gone
    const team = getTeam(teamId);
    // Depending on implementation, we might need to dig into how to verify removal based on ID.
    // The previous tests show checking teammates by ID.
    // We don't have the ID easily here as it was generated inside.
    // Spawn failure should not leave a dangling teammate entry.
    expect(Object.keys(team?.teammates || {})).toEqual(["chore"]);
  });

  it("rejects when called by a non-lead", async () => {
    const { callGateway } = await import("../../../../../gateway/call.js");
    vi.mocked(callGateway).mockResolvedValue({ runId: "mock-run-id" });
    const tool = createTeammateSpawnTool({ agentSessionKey: "agent:team-x:teammate:member" });

    const result = await tool.execute("call-1", {
      teamId,
      role: "reviewer",
      task: "Review the code",
    });

    const text = resultText(result);
    expect(text.toLowerCase()).toContain("error");
    expect(text.toLowerCase()).toContain("lead");
  });

  it("continues spawning teammates when no hard limit is configured", async () => {
    const { callGateway } = await import("../../../../../gateway/call.js");
    vi.mocked(callGateway).mockResolvedValue({ runId: "mock-run-id" });
    const tool = createTeammateSpawnTool({ agentSessionKey: "agent:main:main" });

    // Spawn 5 teammates
    for (let i = 0; i < 5; i++) {
      await tool.execute(`call-${i}`, {
        teamId,
        role: `reviewer-${i}`,
        task: "Review code",
      });
    }

    // Spawn a 6th teammate
    const result = await tool.execute("call-6", {
      teamId,
      role: "reviewer-6",
      task: "Review code",
    });

    const details = resultDetails(result);
    expect(details.status).toBe("spawned");
  });

  it("validates model against allowedModels", async () => {
    const tool = createTeammateSpawnTool({ agentSessionKey: "agent:main:main" });

    const result = await tool.execute("call-1", {
      teamId,
      role: "reviewer",
      task: "Review code",
      model: "invalid-model",
    });

    const text = resultText(result);
    expect(text.toLowerCase()).toContain("error");
    expect(text.toLowerCase()).toContain("not allowed");
  });

  it("accepts allowed models", async () => {
    const { callGateway } = await import("../../../../../gateway/call.js");
    vi.mocked(callGateway).mockResolvedValue({ runId: "mock-run-id" });
    const tool = createTeammateSpawnTool({ agentSessionKey: "agent:main:main" });

    const result = await tool.execute("call-1", {
      teamId,
      role: "reviewer",
      task: "Review code",
      model: "gpt-4",
    });

    const details = resultDetails(result);
    expect(details.status).toBe("spawned");
  });

  it("uses AGENT_LANE_TEAM lane", async () => {
    const { callGateway } = await import("../../../../../gateway/call.js");
    vi.mocked(callGateway).mockResolvedValue({ runId: "mock-run-id" });
    const { AGENT_LANE_TEAM } = await import("../../../../lanes.js");

    const tool = createTeammateSpawnTool({ agentSessionKey: "agent:main:main" });

    await tool.execute("call-1", {
      teamId,
      role: "reviewer",
      task: "Review code",
    });

    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          lane: AGENT_LANE_TEAM,
        }),
      }),
    );
  });

  it("registers teammate in registry", async () => {
    const { callGateway } = await import("../../../../../gateway/call.js");
    vi.mocked(callGateway).mockResolvedValue({ runId: "mock-run-id" });
    const tool = createTeammateSpawnTool({ agentSessionKey: "agent:main:main" });

    const result = await tool.execute("call-1", {
      teamId,
      role: "reviewer",
      task: "Review code",
    });

    const details = resultDetails(result);
    const team = getTeam(teamId);
    const tmId = details.teammateId as string;
    expect(team?.teammates[tmId]).toBeTruthy();
    expect(team?.teammates[tmId].role).toBe("reviewer");
    // Status starts as "init" and transitions to "working" via lifecycle event.
    // The mapping is registered synchronously before the gateway call, and since
    // runId = idempotencyKey, lifecycle events will find the mapping correctly.
    expect(team?.teammates[tmId].status).toBe("idle");
  });

  it("rejects when teams are disabled", async () => {
    vi.mocked(loadConfig).mockReturnValue({
      gateway: {
        teams: {
          enabled: false,
        },
      },
    } as any);

    const tool = createTeammateSpawnTool({ agentSessionKey: "agent:main:main" });

    const result = await tool.execute("call-1", {
      teamId,
      role: "reviewer",
      task: "Review code",
    });

    const text = resultText(result);
    expect(text.toLowerCase()).toContain("error");
    expect(text.toLowerCase()).toContain("not enabled");
  });

  it("rejects when team not found", async () => {
    const tool = createTeammateSpawnTool({ agentSessionKey: "agent:main:main" });

    const result = await tool.execute("call-1", {
      teamId: "invalid-team-id",
      role: "reviewer",
      task: "Review code",
    });

    const text = resultText(result);
    expect(text.toLowerCase()).toContain("error");
    expect(text.toLowerCase()).toContain("not found");
  });
});
