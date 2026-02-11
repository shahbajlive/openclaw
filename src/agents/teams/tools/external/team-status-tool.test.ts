import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTeamStatusTool } from "./team-status-tool.js";

// ---- Mocks ----

vi.mock("../../../../config/config.js", () => ({
  loadConfig: vi.fn().mockReturnValue({
    gateway: {
      teams: {
        enabled: true,
      },
    },
  }),
}));

const mockGetTeam = vi.fn();
const mockListActiveTeams = vi.fn().mockReturnValue([]);
const mockResolveCallerTeamContext = vi.fn().mockReturnValue({
  isLead: true,
  team: { teamId: "test-team" },
});
vi.mock("../../team-registry.js", () => ({
  getTeam: (...args: unknown[]) => mockGetTeam(...args),
  listActiveTeams: (...args: unknown[]) => mockListActiveTeams(...args),
  resolveCallerTeamContext: (...args: unknown[]) => mockResolveCallerTeamContext(...args),
}));

vi.mock("../../task-list.js", () => ({
  listTasks: vi.fn().mockReturnValue({
    tasks: [],
    summary: { total: 0, pending: 0, blocked: 0, inProgress: 0, completed: 0, failed: 0 },
  }),
}));

// ---- Helpers ----

function fakeTeam(overrides?: Record<string, unknown>) {
  return {
    teamId: "test-team",
    teamName: "Test Team",
    description: "A test team",
    status: "init",
    persistent: false,
    createdAt: 1000,
    updatedAt: 2000,
    leadSessionKey: "agent:lead",
    teammates: {},
    config: { notifyOnUnblock: true },
    ...overrides,
  };
}

// ---- Tests ----

describe("team-status-tool", () => {
  beforeEach(() => {
    mockGetTeam.mockReset();
  });

  it("returns team status details for the lead", async () => {
    const team = fakeTeam();
    mockGetTeam.mockReturnValue(team);

    const tool = createTeamStatusTool({ agentSessionKey: "agent:lead" });
    const result = await tool.execute("call-1", { teamId: "test-team" });
    const details = (result as { details?: Record<string, unknown> }).details ?? {};
    expect(details.teamId).toBe("test-team");
    expect(details.teamName).toBe("Test Team");
  });
});
