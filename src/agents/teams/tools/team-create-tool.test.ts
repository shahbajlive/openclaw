import { describe, it, expect, beforeEach, vi } from "vitest";
import { loadConfig } from "../../../config/config.js";
import { resetTeamRegistryForTests, listActiveTeams } from "../team-registry.js";
import { createTeamCreateTool } from "./team-create-tool.js";

// Mock config
vi.mock("../../../config/config.js", () => ({
  loadConfig: vi.fn(),
}));

// Mock store to prevent disk I/O
vi.mock("../team-registry.store.js", () => ({
  resolveTeamBasePath: vi.fn().mockReturnValue("/tmp/openclaw-test-noop"),
  saveTeamToDisk: vi.fn(),
  loadAllTeamsFromDisk: vi.fn().mockReturnValue(new Map()),
}));

// Mock agent events
vi.mock("../../../infra/agent-events.js", () => ({
  onAgentEvent: vi.fn().mockReturnValue(() => {}),
}));

vi.mock("../../../gateway/call.js", () => ({
  callGateway: vi.fn().mockResolvedValue({}),
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

describe("team-create-tool", () => {
  beforeEach(() => {
    resetTeamRegistryForTests();
    vi.clearAllMocks();

    // Setup default mock config
    vi.mocked(loadConfig).mockReturnValue({
      gateway: {
        teams: {
          enabled: true,
          maxActiveTeams: 3,
          bootstrapMode: "none",
        },
      },
    } as any);
  });

  it("creates a team and returns teamId", async () => {
    const tool = createTeamCreateTool({ agentSessionKey: "agent:main:main" });

    const result = await tool.execute("call-1", {
      teamName: "Test Team",
      description: "A test team",
      persistent: true,
    });

    const details = resultDetails(result);
    expect(details.status).toBe("created");
    expect(details.teamId).toBeTruthy();
    expect(details.teamName).toBe("Test Team");
  });

  it("rejects when teams are disabled", async () => {
    vi.mocked(loadConfig).mockReturnValue({
      gateway: {
        teams: {
          enabled: false,
          bootstrapMode: "none",
        },
      },
    } as any);

    const tool = createTeamCreateTool({ agentSessionKey: "agent:main:main" });

    const result = await tool.execute("call-1", {
      teamName: "Test Team",
    });

    const text = resultText(result);
    expect(text).toContain("error");
    expect(text).toContain("not enabled");
  });

  it("enforces max active teams limit", async () => {
    vi.mocked(loadConfig).mockReturnValue({
      gateway: {
        teams: {
          enabled: true,
          maxActiveTeams: 2,
          bootstrapMode: "none",
        },
      },
    } as any);

    const tool = createTeamCreateTool({ agentSessionKey: "agent:main:main" });

    // Create 2 teams (hitting the limit)
    await tool.execute("call-1", { teamName: "Team 1", persistent: true });
    await tool.execute("call-2", { teamName: "Team 2", persistent: true });

    // Try to create a 3rd team
    const result = await tool.execute("call-3", { teamName: "Team 3", persistent: true });

    const text = resultText(result);
    expect(text).toContain("error");
    expect(text.toLowerCase()).toContain("maximum");
  });

  it("stores team in registry", async () => {
    const tool = createTeamCreateTool({ agentSessionKey: "agent:main:main" });

    await tool.execute("call-1", {
      teamName: "Test Team",
      persistent: true,
    });

    const teams = listActiveTeams();
    expect(teams).toHaveLength(1);
    expect(teams[0].teamName).toBe("Test Team");
  });
});
