# Task 09: Task Tools

**Layer:** 2 (Tools)
**Dependencies:** Task 04 (team registry), Task 05 (task list)
**Can run in parallel with:** Task 08, Task 10, Task 11

## What to Do

Create four tools for shared task list management: `task_add`, `task_claim`, `task_complete`, `task_list`.

## Pattern to Follow

Same as all other tools -- see `src/agents/tools/sessions-spawn-tool.ts`. Export `createXxxTool(opts)` returning `AnyAgentTool`.

## Files to Create

### 1. `src/agents/tools/task-add-tool.ts`

Tool name: `task_add`
Who uses it: Lead + Teammates

```typescript
import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";
import { loadConfig } from "../../config/config.js";
import { addTask } from "../teams/task-list.js";

const TaskAddSchema = Type.Object({
  teamId: Type.String(),
  title: Type.String(),
  description: Type.Optional(Type.String()),
  dependsOn: Type.Optional(Type.Array(Type.String())),
  assignTo: Type.Optional(Type.String()),
  priority: Type.Optional(Type.String()), // "low" | "normal" | "high" | "critical"
  metadata: Type.Optional(Type.Unknown()),
});

export function createTaskAddTool(opts?: { agentSessionKey?: string }): AnyAgentTool {
  return {
    label: "Teams",
    name: "task_add",
    description:
      "Add a new task to the team's shared task list. Tasks can have dependencies on other tasks.",
    parameters: TaskAddSchema,
    execute: async (_toolCallId, args) => {
      // 1. Check teams enabled
      // 2. Parse params (title, description, dependsOn, assignTo, priority, metadata)
      // 3. Call addTask(teamId, params)
      //    - This handles cycle detection and initial status (pending/blocked)
      // 4. Return { taskId, status, position }
    },
  };
}
```

### 2. `src/agents/tools/task-claim-tool.ts`

Tool name: `task_claim`
Who uses it: Lead (Normal mode only) + Teammates

```typescript
const TaskClaimSchema = Type.Object({
  teamId: Type.String(),
  taskId: Type.Optional(Type.String()),
  filter: Type.Optional(
    Type.Object({
      priority: Type.Optional(Type.String()),
    }),
  ),
});

// execute:
// 1. Check teams enabled
// 2. Get team from registry
// 3. DELEGATE MODE CHECK: if caller is the lead AND coordinationMode === "delegate",
//    return error: "Lead cannot claim tasks in delegate mode."
// 4. Determine claimerId:
//    - If caller is lead: "lead"
//    - If caller is teammate: find teammateId from session key
// 5. Call claimTask(teamId, { taskId, claimerId, filter })
// 6. If success: update teammate's currentTask in registry
// 7. Return { success, taskId, task } or { success: false, reason }
```

The delegate mode check is the key enforcement point from RFC section 3.5.

### 3. `src/agents/tools/task-complete-tool.ts`

Tool name: `task_complete`
Who uses it: Lead + Teammates

```typescript
const TaskCompleteSchema = Type.Object({
  teamId: Type.String(),
  taskId: Type.String(),
  result: Type.Optional(Type.String()), // "success" | "failure"
  summary: Type.Optional(Type.String()),
  artifacts: Type.Optional(Type.Array(Type.String())),
});

// execute:
// 1. Check teams enabled
// 2. Call completeTask(teamId, params)
// 3. If unblockedTasks.length > 0:
//    - Optionally broadcast to all teammates: "Tasks unblocked: ..."
//    (use broadcastMessage from mailbox if team.config.notifyOnUnblock)
// 4. Update teammate's currentTask to undefined, increment completedTasks
// 5. Return { taskId, status, unblockedTasks }
```

### 4. `src/agents/tools/task-list-tool.ts`

Tool name: `task_list`
Who uses it: Lead + Teammates

```typescript
const TaskListSchema = Type.Object({
  teamId: Type.String(),
  filter: Type.Optional(
    Type.Object({
      status: Type.Optional(Type.Array(Type.String())),
      assignee: Type.Optional(Type.String()),
      priority: Type.Optional(Type.String()),
    }),
  ),
  includeCompleted: Type.Optional(Type.Boolean()),
});

// execute:
// 1. Check teams enabled
// 2. Call listTasks(teamId, filter)
// 3. Return { tasks: [...], summary: { total, byStatus } }
```

## Common Opts

All four tools accept:

```typescript
opts?: {
  agentSessionKey?: string;
}
```

The `agentSessionKey` is used to determine the caller's identity (lead vs teammate) and to enforce delegate mode restrictions.

## Reference Files

- `src/agents/teams/task-list.ts` (Task 05) -- `addTask`, `claimTask`, `completeTask`, `listTasks`
- `src/agents/teams/team-registry.ts` (Task 04) -- `getTeam`, `isTeamLead`, `resolveCallerTeamContext`
- `src/agents/teams/mailbox.ts` (Task 06) -- `broadcastMessage` for unblock notifications
- `src/agents/tools/common.js` -- `jsonResult`, `readStringParam`, `AnyAgentTool`

## Notes

- `task_claim` is the only tool with delegate mode enforcement. The lead cannot claim tasks when `coordinationMode === "delegate"`.
- `task_complete` should broadcast unblock notifications when configured. This creates a nice feedback loop: teammate completes task -> blocked tasks unblock -> other teammates get notified.
- Auto-select in `task_claim` (when no taskId given): pick highest-priority pending task, FIFO within same priority.
- The `filter` param on `task_claim` allows claiming by priority (e.g., "give me the next critical task").

## Acceptance Criteria

- [ ] `task_add` creates tasks with correct initial status (pending/blocked)
- [ ] `task_add` rejects circular dependencies with clear error message
- [ ] `task_claim` respects delegate mode (lead blocked in delegate mode)
- [ ] `task_claim` auto-selects highest priority pending task when no taskId given
- [ ] `task_claim` prevents double-claiming (returns error if already claimed)
- [ ] `task_complete` marks task done and auto-unblocks dependents
- [ ] `task_complete` broadcasts unblock notifications when configured
- [ ] `task_list` filters work correctly (by status, assignee, priority)
- [ ] All tools check teams enabled
- [ ] `pnpm build` passes
