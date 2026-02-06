# Task 01: Types and Data Structures

**Layer:** 0 (Foundation)
**Dependencies:** None
**Can run in parallel with:** Task 02, Task 03

## What to Do

Create `src/agents/teams/types.ts` with all shared TypeScript types used across the teams feature.

## File to Create

### `src/agents/teams/types.ts`

All types match the RFC interfaces from `agen-swarm-proposal/initial-rought-design.md` sections 3.1-3.5.

```typescript
// src/agents/teams/types.ts

// ---- Coordination Mode ----

export type CoordinationMode = "normal" | "delegate";

// ---- Team ----

export type TeamConfig = {
  maxTeammates: number;
  notifyOnUnblock: boolean;
};

export type TeamStatus = "active" | "completed" | "failed" | "interrupted";

export type Team = {
  teamId: string; // UUID
  teamName: string; // human-readable
  description?: string;
  leadSessionKey: string;
  coordinationMode: CoordinationMode;
  status: TeamStatus;
  maxTeammates: number;
  createdAt: number;
  updatedAt: number;
  teammates: Record<string, Teammate>; // keyed by teammateId
  config: TeamConfig;
};

// ---- Teammate ----

export type TeammateStatus = "spawning" | "active" | "idle" | "completed" | "failed";

export type Teammate = {
  teammateId: string; // UUID
  role: string;
  sessionKey: string;
  status: TeammateStatus;
  model?: string; // cross-model support
  requirePlanApproval: boolean;
  planApproved: boolean; // false until lead approves
  currentTask?: string;
  claimedTasks: number;
  completedTasks: number;
  createdAt: number;
  timeout?: number; // seconds before auto-termination
};

// ---- Task ----

export type TaskStatus = "pending" | "blocked" | "claimed" | "in-progress" | "completed" | "failed";
export type TaskPriority = "low" | "normal" | "high" | "critical";

export type Task = {
  taskId: string;
  title: string;
  description?: string;
  status: TaskStatus;
  assignee?: string; // teammateId
  dependsOn: string[]; // task IDs
  priority: TaskPriority;
  metadata?: Record<string, unknown>;
  result?: "success" | "failure";
  summary?: string;
  artifacts?: string[];
  createdAt: number;
  claimedAt?: number;
  completedAt?: number;
};

// ---- Team Message ----

export type MessagePriority = "normal" | "urgent";

export type TeamMessage = {
  messageId: string;
  teamId: string;
  from: string; // teammateId or "lead"
  to: string | "all"; // teammateId or broadcast
  message: string;
  priority: MessagePriority;
  read: boolean;
  createdAt: number;
};

// ---- Plan (for plan approval workflow) ----

export type PlanStatus = "pending" | "approved" | "rejected" | "revision-requested";

export type PlanStep = {
  description: string;
  estimatedTokens?: number;
  tools?: string[];
};

export type TeammatePlan = {
  teammateId: string;
  teamId: string;
  status: PlanStatus;
  plan: {
    summary: string;
    steps: PlanStep[];
    risks?: string[];
    alternatives?: string[];
  };
  feedback?: string;
  submittedAt: number;
  reviewedAt?: number;
};

// ---- Task Summary (used by team_status) ----

export type TaskSummary = {
  total: number;
  pending: number;
  blocked: number;
  inProgress: number;
  completed: number;
  failed: number;
};
```

## Notes

- Use `Record<string, Teammate>` instead of `Map` because it serializes to JSON cleanly for disk persistence. The registry (Task 04) can use a `Map` in memory and convert.
- All timestamp fields are epoch milliseconds (`number`), matching the existing pattern in `src/agents/subagent-registry.ts` line 21.
- `teammates` on the `Team` type is keyed by `teammateId` (UUID).
- This file has zero runtime dependencies -- it is pure types.

## Acceptance Criteria

- [ ] File compiles with `pnpm build`
- [ ] All types from RFC sections 3.1-3.5 are represented
- [ ] No runtime code, only type definitions
- [ ] Exports all types needed by tasks 04-14
