import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTeamStatusTool } from "./team-status-tool.js";

// ---- Mocks ----

vi.mock("../../../config/config.js", () => ({
  loadConfig: vi.fn().mockReturnValue({
    gateway: {
      teams: {
        enabled: true,
        storage: { mailboxTTLHours: 24 },
      },
    },
  }),
}));

const mockGetTeam = vi.fn();
const mockListActiveTeams = vi.fn().mockReturnValue([]);
vi.mock("../team-registry.js", () => ({
  getTeam: (...args: unknown[]) => mockGetTeam(...args),
  listActiveTeams: (...args: unknown[]) => mockListActiveTeams(...args),
}));

vi.mock("../task-list.js", () => ({
  listTasks: vi.fn().mockReturnValue({
    tasks: [],
    summary: { total: 0, pending: 0, blocked: 0, inProgress: 0, completed: 0, failed: 0 },
  }),
}));

const mockCleanupExpired = vi.fn();
vi.mock("../mailbox.js", () => ({
  cleanupExpiredMessages: (...args: unknown[]) => mockCleanupExpired(...args),
}));

// ---- Helpers ----

function fakeTeam(overrides?: Record<string, unknown>) {
  return {
    teamId: "test-team",
    teamName: "Test Team",
    description: "A test team",
    status: "active",
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
    mockCleanupExpired.mockClear();
  });

  it("performs cleanup of expired messages", async () => {
    const team = fakeTeam();
    mockGetTeam.mockReturnValue(team);

    const tool = createTeamStatusTool({ agentSessionKey: "agent:lead" });
    await tool.execute("call-1", { teamId: "test-team" });

    // Verify cleanup was called
    expect(mockCleanupExpired).toHaveBeenCalledOnce();
    expect(mockCleanupExpired).toHaveBeenCalledWith({
      teamId: "test-team",
      ttlHours: 24,
    });
  });
});
