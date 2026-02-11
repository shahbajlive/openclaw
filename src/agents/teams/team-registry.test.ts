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
  updateTeamStatus,
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

// Mock task-list so notifyLeadIfTeamIdle can check task state
const mockListTasks = vi.fn();
const mockAddTask = vi.fn();
vi.mock("./task-list.js", () => ({
  listTasks: (...args: unknown[]) => mockListTasks(...args),
  addTask: (...args: unknown[]) => mockAddTask(...args),
  claimTask: vi.fn(),
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
    expect(team.status).toBe("init");
    expect(team.teammates.chore).toMatchObject({
      teammateId: "chore",
      role: "chore",
      status: "idle",
      isChore: true,
    });
    expect(team.teammates.pr_reviewer).toMatchObject({
      teammateId: "pr_reviewer",
      role: "pr_reviewer",
      status: "idle",
    });
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
      status: "init" as const,
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
        status: "init",
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
      status: "init" as const,
      requirePlanApproval: false,
      planApproved: false,
      claimedTasks: 0,
      completedTasks: 0,
      createdAt: Date.now(),
    };
    addTeammate(team.teamId, teammate);
    updateTeammateStatus(team.teamId, "tm1", "working");
    expect(getTeam(team.teamId)?.teammates["tm1"].status).toBe("working");
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
      status: "working" as const,
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
    function makeTeamWithIdleTeammate() {
      const team = createTeam({
        teamName: "idle-test",
        leadSessionKey: "agent:lead",
        config: { notifyOnUnblock: true },
      });
      updateTeamStatus(team.teamId, "working");
      addTeammate(team.teamId, {
        teammateId: "tm1",
        role: "worker",
        sessionKey: "agent:tm1",
        status: "idle",
        requirePlanApproval: false,
        planApproved: false,
        claimedTasks: 1,
        completedTasks: 1,
        createdAt: Date.now(),
      });
      return team;
    }

    beforeEach(() => {
      mockListTasks.mockReset();
      mockAddTask.mockReset();
    });

    it("creates a terminal broadcast_answer task when all non-terminal work is done", () => {
      const team = makeTeamWithIdleTeammate();
      mockListTasks.mockReturnValue({
        tasks: [
          {
            taskId: "task-1",
            title: "work",
            status: "completed",
            assignee: "tm1",
          },
        ],
      });

      notifyLeadIfTeamIdle(team.teamId);

      expect(mockAddTask).toHaveBeenCalledOnce();
      expect(mockAddTask).toHaveBeenCalledWith(
        team.teamId,
        expect.objectContaining({
          title: "broadcast_answer",
          assignTo: "lead",
        }),
      );
    });

    it("does not create terminal task when teammates are still working", () => {
      const team = createTeam({
        teamName: "active-test",
        leadSessionKey: "agent:lead",
        config: { notifyOnUnblock: true },
      });
      updateTeamStatus(team.teamId, "working");
      addTeammate(team.teamId, {
        teammateId: "tm1",
        role: "worker",
        sessionKey: "agent:tm1",
        status: "working",
        requirePlanApproval: false,
        planApproved: false,
        claimedTasks: 0,
        completedTasks: 0,
        createdAt: Date.now(),
      });
      mockListTasks.mockReturnValue({ tasks: [] });

      notifyLeadIfTeamIdle(team.teamId);
      expect(mockAddTask).not.toHaveBeenCalled();
    });

    it("does not create terminal task when incomplete non-terminal tasks remain", () => {
      const team = createTeam({
        teamName: "pending-test",
        leadSessionKey: "agent:lead",
        config: { notifyOnUnblock: true },
      });
      updateTeamStatus(team.teamId, "working");
      addTeammate(team.teamId, {
        teammateId: "tm1",
        role: "worker",
        sessionKey: "agent:tm1",
        status: "idle",
        requirePlanApproval: false,
        planApproved: false,
        claimedTasks: 0,
        completedTasks: 0,
        createdAt: Date.now(),
      });
      mockListTasks.mockReturnValue({
        tasks: [
          {
            taskId: "task-1",
            title: "work",
            status: "pending",
            assignee: "tm1",
          },
        ],
      });

      notifyLeadIfTeamIdle(team.teamId);

      expect(mockAddTask).not.toHaveBeenCalled();
    });

    it("does not create duplicate terminal tasks when one is already open", () => {
      const team = makeTeamWithIdleTeammate();
      mockListTasks.mockReturnValue({
        tasks: [
          {
            taskId: "terminal-1",
            title: "broadcast_answer",
            status: "pending",
            assignee: "lead",
          },
        ],
      });

      notifyLeadIfTeamIdle(team.teamId);
      expect(mockAddTask).not.toHaveBeenCalled();
    });
  });
});
