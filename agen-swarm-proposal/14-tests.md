# Task 14: Tests

**Layer:** 4 (Final)
**Dependencies:** All previous tasks (01-13)
**Can run in parallel with:** Nothing (should be last)

## What to Do

Write tests for all new modules. Use Vitest (matching existing test patterns). Tests are colocated with source files as `*.test.ts`.

## Test Files to Create

### 1. `src/agents/teams/team-registry.test.ts`

Test the team registry CRUD operations:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
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
} from "./team-registry.js";

describe("team-registry", () => {
  beforeEach(() => {
    resetTeamRegistryForTests();
  });

  it("creates a team with UUID and persists it", () => {
    const team = createTeam({
      teamName: "test-team",
      leadSessionKey: "agent:main:main",
      coordinationMode: "normal",
      maxTeammates: 5,
      config: { maxTeammates: 5, notifyOnUnblock: true },
    });
    expect(team.teamId).toBeTruthy();
    expect(team.teamName).toBe("test-team");
    expect(team.status).toBe("active");
    expect(getTeam(team.teamId)).toEqual(team);
  });

  it("lists only active teams", () => {
    createTeam({
      teamName: "a",
      leadSessionKey: "k1",
      coordinationMode: "normal",
      maxTeammates: 5,
      config: { maxTeammates: 5, notifyOnUnblock: true },
    });
    createTeam({
      teamName: "b",
      leadSessionKey: "k2",
      coordinationMode: "delegate",
      maxTeammates: 3,
      config: { maxTeammates: 3, notifyOnUnblock: true },
    });
    expect(listActiveTeams()).toHaveLength(2);
  });

  it("adds and removes teammates", () => {
    const team = createTeam({
      teamName: "t",
      leadSessionKey: "k",
      coordinationMode: "normal",
      maxTeammates: 5,
      config: { maxTeammates: 5, notifyOnUnblock: true },
    });
    const teammate = {
      teammateId: "tm1",
      role: "reviewer",
      sessionKey: "agent:main:team:x:reviewer-tm1",
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

  it("identifies lead vs teammate", () => {
    const team = createTeam({
      teamName: "t",
      leadSessionKey: "agent:main:main",
      coordinationMode: "normal",
      maxTeammates: 5,
      config: { maxTeammates: 5, notifyOnUnblock: true },
    });
    expect(isTeamLead(team.teamId, "agent:main:main")).toBe(true);
    expect(isTeamLead(team.teamId, "agent:main:team:x:reviewer-abc")).toBe(false);
  });

  it("resolves caller team context", () => {
    const team = createTeam({
      teamName: "t",
      leadSessionKey: "agent:main:main",
      coordinationMode: "normal",
      maxTeammates: 5,
      config: { maxTeammates: 5, notifyOnUnblock: true },
    });
    const ctx = resolveCallerTeamContext("agent:main:main");
    expect(ctx?.isLead).toBe(true);
    expect(ctx?.team.teamId).toBe(team.teamId);
  });
});
```

### 2. `src/agents/teams/task-list.test.ts`

Test task CRUD, dependencies, cycle detection, and auto-unblock:

```typescript
describe("task-list", () => {
  // Setup: create a temp team dir for each test

  it("adds a task with pending status", () => {
    /* ... */
  });

  it("adds a blocked task when dependencies are not met", () => {
    /* ... */
  });

  it("rejects circular dependencies", () => {
    // Add task-A depends on task-B, task-B depends on task-C
    // Try: task-C depends on task-A -- should fail with cycle error
  });

  it("claims a task atomically (first-claim-wins)", () => {
    // Add a pending task
    // Claim it -- should succeed
    // Try claiming again -- should fail
  });

  it("auto-selects highest priority task when no taskId given", () => {
    // Add normal and critical tasks
    // Claim without taskId -- should get the critical one
  });

  it("auto-unblocks tasks when dependencies complete", () => {
    // Add task-A (pending)
    // Add task-B depends on task-A (blocked)
    // Complete task-A
    // task-B should now be pending
  });

  it("computes blockedBy for tasks", () => {
    // Add task-A and task-B
    // Add task-C depends on [task-A, task-B]
    // Complete task-A
    // task-C.blockedBy should be [task-B]
  });

  it("filters tasks by status", () => {
    /* ... */
  });
  it("filters tasks by assignee", () => {
    /* ... */
  });
  it("filters tasks by priority", () => {
    /* ... */
  });
});
```

### 3. `src/agents/teams/mailbox.test.ts`

Test message send/broadcast/read/cleanup:

```typescript
describe("mailbox", () => {
  it("sends a message and writes to disk", () => {
    /* ... */
  });
  it("broadcasts to all teammates", () => {
    /* ... */
  });
  it("reads only unread messages for a recipient", () => {
    /* ... */
  });
  it("marks messages as read", () => {
    /* ... */
  });
  it("cleans up expired read messages", () => {
    /* ... */
  });
  it("broadcasts exclude sender when excludeSelf is true", () => {
    /* ... */
  });
});
```

### 4. `src/agents/tools/team-create-tool.test.ts`

Test the team_create tool:

```typescript
describe("team-create-tool", () => {
  it("creates a team and returns teamId", () => {
    /* ... */
  });
  it("rejects when teams are disabled", () => {
    /* ... */
  });
  it("enforces max active teams limit", () => {
    /* ... */
  });
  it("defaults to normal coordination mode", () => {
    /* ... */
  });
  it("accepts delegate coordination mode", () => {
    /* ... */
  });
});
```

### 5. `src/agents/tools/teammate-spawn-tool.test.ts`

Test the teammate_spawn tool:

```typescript
describe("teammate-spawn-tool", () => {
  it("spawns a teammate via callGateway", () => {
    /* mock callGateway */
  });
  it("rejects when called by a non-lead", () => {
    /* ... */
  });
  it("rejects when teammate limit is reached", () => {
    /* ... */
  });
  it("validates model against allowedModels", () => {
    /* ... */
  });
  it("uses AGENT_LANE_TEAM lane", () => {
    /* verify callGateway params */
  });
});
```

### 6. `src/agents/tools/task-claim-tool.test.ts`

Test delegate mode enforcement:

```typescript
describe("task-claim-tool", () => {
  it("allows lead to claim in normal mode", () => {
    /* ... */
  });
  it("rejects lead claim in delegate mode", () => {
    /* ... */
  });
  it("allows teammate to claim in delegate mode", () => {
    /* ... */
  });
  it("returns error when no pending tasks available", () => {
    /* ... */
  });
});
```

### 7. `src/agents/tools/plan-submit-tool.test.ts`

Test plan approval workflow:

```typescript
describe("plan-submit-tool", () => {
  it("saves plan to disk", () => {
    /* ... */
  });
  it("rejects when called by lead", () => {
    /* ... */
  });
  it("rejects when plan approval not required", () => {
    /* ... */
  });
  it("notifies lead via enqueueSystemEvent", () => {
    /* mock */
  });
});
```

### Additional Test: `src/routing/session-key.test.ts` (modify existing)

Add tests for the new team session key helpers:

```typescript
describe("team session keys", () => {
  it("isTeamSessionKey recognizes team keys", () => {
    expect(isTeamSessionKey("agent:main:team:abc:lead")).toBe(true);
    expect(isTeamSessionKey("agent:main:team:abc:reviewer-uuid")).toBe(true);
    expect(isTeamSessionKey("agent:main:subagent:xyz")).toBe(false);
    expect(isTeamSessionKey("agent:main:main")).toBe(false);
  });

  it("parseTeamSessionKey extracts components", () => {
    const parsed = parseTeamSessionKey("agent:main:team:abc123:security-reviewer-uuid");
    expect(parsed).toEqual({
      agentId: "main",
      teamId: "abc123",
      role: "security-reviewer-uuid",
      isLead: false,
    });
  });

  it("parseTeamSessionKey identifies lead", () => {
    const parsed = parseTeamSessionKey("agent:main:team:abc123:lead");
    expect(parsed?.isLead).toBe(true);
  });

  it("buildTeammateSessionKey produces correct format", () => {
    const key = buildTeammateSessionKey({ agentId: "main", teamId: "abc", role: "reviewer" });
    expect(key).toBe("agent:main:team:abc:reviewer");
  });
});
```

### Additional Test: `src/agents/tool-policy.test.ts` (modify existing)

Add tests for the new group and profile:

```typescript
it("includes team tools in group:teams", () => {
  const group = TOOL_GROUPS["group:teams"];
  expect(group).toContain("team_create");
  expect(group).toContain("task_claim");
  expect(group).toContain("plan_submit");
});

it("includes team tools in group:openclaw", () => {
  const group = TOOL_GROUPS["group:openclaw"];
  expect(group).toContain("team_create");
  expect(group).toContain("teammate_spawn");
});

it("teammate profile allows task tools and denies lead tools", () => {
  const profile = resolveToolProfilePolicy("teammate");
  expect(profile?.allow).toContain("task_claim");
  expect(profile?.deny).toContain("team_create");
  expect(profile?.deny).toContain("teammate_spawn");
});
```

## Mocking Strategy

For tool tests that call `callGateway`, use Vitest mocking:

```typescript
import { vi } from "vitest";
vi.mock("../../gateway/call.js", () => ({
  callGateway: vi.fn().mockResolvedValue({ runId: "mock-run-id" }),
}));
```

For tests that use `enqueueSystemEvent`:

```typescript
vi.mock("../../infra/system-events.js", () => ({
  enqueueSystemEvent: vi.fn(),
}));
```

For disk I/O tests, use a temp directory:

```typescript
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-teams-test-"));
// Set team base path to tmpDir for tests
```

## Reference Files

- `src/agents/subagent-registry.test.ts` -- pattern for registry tests (if exists)
- `src/agents/tool-policy.test.ts` -- existing tool policy tests to extend
- `src/routing/session-key.test.ts` -- existing session key tests to extend (if exists)
- Vitest config: `vitest.config.ts` at root

## Notes

- Run with `pnpm test` (vitest). Coverage thresholds: 70% lines/branches/functions/statements.
- Use `beforeEach` to reset state (e.g., `resetTeamRegistryForTests()`).
- Mock external calls (`callGateway`, `enqueueSystemEvent`) to keep tests fast and isolated.
- Use temp directories for file-based tests to avoid polluting the real `~/.openclaw/teams/`.

## Acceptance Criteria

- [ ] All 7+ test files exist and pass
- [ ] Team registry CRUD tested
- [ ] Task list: add, claim, complete, cycle detection, auto-unblock tested
- [ ] Mailbox: send, broadcast, read, cleanup tested
- [ ] Tool tests cover: teams disabled, delegate mode, plan approval
- [ ] Session key helpers tested
- [ ] Tool policy groups and profiles tested
- [ ] `pnpm test` passes
- [ ] No regressions in existing tests
