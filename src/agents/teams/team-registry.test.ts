import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createTeam,
  getTeam,
  listActiveTeams,
  addTeammate,
  removeTeammate,
  updateTeammateStatus,
  isTeamLead,
  resolveCallerTeamContext,
  resetTeamRegistryForTests,
  notifyLeadIfTeamIdle,
  resetIdleNotification,
} from "./team-registry.js";

// Mock config and store to prevent real disk I/O
vi.mock("../../config/config.js", () => ({
  loadConfig: vi.fn().mockReturnValue({}),
}));

vi.mock("./team-registry.store.js", () => ({
  resolveTeamBasePath: vi.fn().mockReturnValue("/tmp/openclaw-test-noop"),
  saveTeamToDisk: vi.fn(),
  loadAllTeamsFromDisk: vi.fn().mockReturnValue(new Map()),
}));

// Mock agent events (used by ensureListener)
vi.mock("../../infra/agent-events.js", () => ({
  onAgentEvent: vi.fn().mockReturnValue(() => {}),
}));

// Mock mailbox so notifyLeadIfTeamIdle doesn't touch disk
const mockSendMessage = vi.fn();
vi.mock("./mailbox.js", () => ({
  sendMessage: (...args: unknown[]) => mockSendMessage(...args),
}));

// Mock task-list so notifyLeadIfTeamIdle can check task state
const mockListTasks = vi.fn();
vi.mock("./task-list.js", () => ({
  listTasks: (...args: unknown[]) => mockListTasks(...args),
}));

describe("team-registry", () => {
  beforeEach(() => {
    resetTeamRegistryForTests();
  });

  it("creates a team with UUID and persists it", () => {
    const team = createTeam({
      teamName: "test-team",
      leadSessionKey: "agent:main:main",
      config: { notifyOnUnblock: true },
    });
    expect(team.teamId).toBeTruthy();
    expect(team.teamName).toBe("test-team");
    expect(team.status).toBe("active");
    expect(team.teammates).toEqual({});
    expect(getTeam(team.teamId)).toEqual(team);
  });

  it("returns null for unknown teamId", () => {
    expect(getTeam("nonexistent")).toBeNull();
  });

  it("lists only active teams", () => {
    createTeam({
      teamName: "a",
      leadSessionKey: "k1",
      config: { notifyOnUnblock: true },
    });
    createTeam({
      teamName: "b",
      leadSessionKey: "k2",
      config: { notifyOnUnblock: true },
    });
    expect(listActiveTeams()).toHaveLength(2);
  });

  it("adds and removes teammates", () => {
    const team = createTeam({
      teamName: "t",
      leadSessionKey: "k",
      config: { notifyOnUnblock: true },
    });
    const teammate = {
      teammateId: "tm1",
      role: "reviewer",
      sessionKey: "agent:team-x:teammate:reviewer-tm1",
      status: "spawning" as const,
      requirePlanApproval: false,
      planApproved: false,
      claimedTasks: 0,
      completedTasks: 0,
      createdAt: Date.now(),
    };
    addTeammate(team.teamId, teammate);
    expect(getTeam(team.teamId)?.teammates["tm1"]).toBeTruthy();
    removeTeammate(team.teamId, "tm1");
    expect(getTeam(team.teamId)?.teammates["tm1"]).toBeUndefined();
  });

  it("throws when adding teammate to nonexistent team", () => {
    expect(() => {
      addTeammate("nonexistent", {
        teammateId: "tm1",
        role: "reviewer",
        sessionKey: "agent:team-x:teammate:reviewer-tm1",
        status: "spawning",
        requirePlanApproval: false,
        planApproved: false,
        claimedTasks: 0,
        completedTasks: 0,
        createdAt: Date.now(),
      });
    }).toThrow("not found");
  });

  it("updates teammate status", () => {
    const team = createTeam({
      teamName: "t",
      leadSessionKey: "k",
      config: { notifyOnUnblock: true },
    });
    const teammate = {
      teammateId: "tm1",
      role: "reviewer",
      sessionKey: "agent:team-x:teammate:reviewer-tm1",
      status: "spawning" as const,
      requirePlanApproval: false,
      planApproved: false,
      claimedTasks: 0,
      completedTasks: 0,
      createdAt: Date.now(),
    };
    addTeammate(team.teamId, teammate);
    updateTeammateStatus(team.teamId, "tm1", "active");
    expect(getTeam(team.teamId)?.teammates["tm1"].status).toBe("active");
  });

  it("identifies lead vs teammate", () => {
    const team = createTeam({
      teamName: "t",
      leadSessionKey: "agent:main:main",
      config: { notifyOnUnblock: true },
    });
    expect(isTeamLead(team.teamId, "agent:main:main")).toBe(true);
    expect(isTeamLead(team.teamId, "agent:team-x:teammate:reviewer-abc")).toBe(false);
  });

  it("returns false for isTeamLead on nonexistent team", () => {
    expect(isTeamLead("nonexistent", "agent:main:main")).toBe(false);
  });

  it("resolves caller team context for lead", () => {
    const team = createTeam({
      teamName: "t",
      leadSessionKey: "agent:main:main",
      config: { notifyOnUnblock: true },
    });
    const ctx = resolveCallerTeamContext("agent:main:main");
    expect(ctx?.isLead).toBe(true);
    expect(ctx?.team.teamId).toBe(team.teamId);
    expect(ctx?.teammate).toBeUndefined();
  });

  it("resolves caller team context for teammate", () => {
    const team = createTeam({
      teamName: "t",
      leadSessionKey: "agent:main:main",
      config: { notifyOnUnblock: true },
    });
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
    addTeammate(team.teamId, teammate);
    const ctx = resolveCallerTeamContext("agent:team-x:teammate:reviewer-tm1");
    expect(ctx?.isLead).toBe(false);
    expect(ctx?.team.teamId).toBe(team.teamId);
    expect(ctx?.teammate?.teammateId).toBe("tm1");
  });

  it("returns null for unknown session key", () => {
    const ctx = resolveCallerTeamContext("agent:main:unknown");
    expect(ctx).toBeNull();
  });

  // ---- notifyLeadIfTeamIdle tests ----

  describe("notifyLeadIfTeamIdle", () => {
    function makeTeamWithCompletedTeammate() {
      const team = createTeam({
        teamName: "idle-test",
        leadSessionKey: "agent:lead",
        config: { notifyOnUnblock: true },
      });
      addTeammate(team.teamId, {
        teammateId: "tm1",
        role: "worker",
        sessionKey: "agent:tm1",
        status: "completed",
        requirePlanApproval: false,
        planApproved: false,
        claimedTasks: 1,
        completedTasks: 1,
        createdAt: Date.now(),
      });
      // All tasks done
      mockListTasks.mockReturnValue({
        tasks: [],
        summary: { total: 1, pending: 0, blocked: 0, inProgress: 0, completed: 1, failed: 0 },
      });
      return team;
    }

    beforeEach(() => {
      mockSendMessage.mockClear();
      mockListTasks.mockReset();
    });

    it("sends a mailbox notification instead of transitioning team status", () => {
      const team = makeTeamWithCompletedTeammate();

      notifyLeadIfTeamIdle(team.teamId);

      // Team should still be active (not completed)
      expect(getTeam(team.teamId)?.status).toBe("active");

      // A notification should have been sent to the lead
      expect(mockSendMessage).toHaveBeenCalledOnce();
      expect(mockSendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          teamId: team.teamId,
          from: "system",
          to: "lead",
        }),
      );
    });

    it("only notifies once per idle window (idempotent)", () => {
      const team = makeTeamWithCompletedTeammate();

      notifyLeadIfTeamIdle(team.teamId);
      notifyLeadIfTeamIdle(team.teamId);
      notifyLeadIfTeamIdle(team.teamId);

      expect(mockSendMessage).toHaveBeenCalledOnce();
    });

    it("does not notify when teammates are still active", () => {
      const team = createTeam({
        teamName: "active-test",
        leadSessionKey: "agent:lead",
        config: { notifyOnUnblock: true },
      });
      addTeammate(team.teamId, {
        teammateId: "tm1",
        role: "worker",
        sessionKey: "agent:tm1",
        status: "active",
        requirePlanApproval: false,
        planApproved: false,
        claimedTasks: 0,
        completedTasks: 0,
        createdAt: Date.now(),
      });

      notifyLeadIfTeamIdle(team.teamId);

      expect(mockSendMessage).not.toHaveBeenCalled();
    });

    it("does not notify when incomplete tasks remain", () => {
      const team = createTeam({
        teamName: "pending-test",
        leadSessionKey: "agent:lead",
        config: { notifyOnUnblock: true },
      });
      addTeammate(team.teamId, {
        teammateId: "tm1",
        role: "worker",
        sessionKey: "agent:tm1",
        status: "completed",
        requirePlanApproval: false,
        planApproved: false,
        claimedTasks: 0,
        completedTasks: 0,
        createdAt: Date.now(),
      });
      mockListTasks.mockReturnValue({
        tasks: [],
        summary: { total: 2, pending: 1, blocked: 0, inProgress: 0, completed: 1, failed: 0 },
      });

      notifyLeadIfTeamIdle(team.teamId);

      expect(mockSendMessage).not.toHaveBeenCalled();
    });

    it("re-notifies after resetIdleNotification is called", () => {
      const team = makeTeamWithCompletedTeammate();

      notifyLeadIfTeamIdle(team.teamId);
      expect(mockSendMessage).toHaveBeenCalledOnce();

      // Reset the guard (simulates new teammate spawn or task add)
      resetIdleNotification(team.teamId);

      notifyLeadIfTeamIdle(team.teamId);
      expect(mockSendMessage).toHaveBeenCalledTimes(2);
    });

    it("resets idle notification when a new teammate is added", () => {
      const team = makeTeamWithCompletedTeammate();

      notifyLeadIfTeamIdle(team.teamId);
      expect(mockSendMessage).toHaveBeenCalledOnce();
      expect(getTeam(team.teamId)?.idleNotificationSent).toBe(true);

      // Adding a teammate should reset the flag
      addTeammate(team.teamId, {
        teammateId: "tm2",
        role: "analyst",
        sessionKey: "agent:tm2",
        status: "spawning",
        requirePlanApproval: false,
        planApproved: false,
        claimedTasks: 0,
        completedTasks: 0,
        createdAt: Date.now(),
      });
      expect(getTeam(team.teamId)?.idleNotificationSent).toBe(false);
    });
  });
});
