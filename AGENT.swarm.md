# Agent Swarm (Teams) - Complete Developer Guide

## Overview

Multi-agent orchestration enabling parallel task execution with shared state and inter-agent messaging. This guide consolidates all design specs, implementation details, and patterns from the `agen-swarm-proposal/` directory.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                         Team Lead                            │
│  (coordinates, spawns teammates, synthesizes results)        │
└────────────────────┬────────────────────────────────────────┘
                     │
        ┌────────────┼────────────┐
        ▼            ▼            ▼
┌──────────┐  ┌──────────┐  ┌──────────┐
│Teammate 1│  │Teammate 2│  │Teammate N│
│(role: A) │  │(role: B) │  │(role: X) │
└────┬─────┘  └────┬─────┘  └────┬─────┘
     │             │             │
     └─────────────┴─────────────┘
                   │
        ┌──────────┴──────────┐
        ▼                     ▼
┌──────────────┐     ┌──────────────┐
│  Task List   │     │   Mailbox    │
│(shared state)│     │(messaging)   │
└──────────────┘     └──────────────┘
```

## Layered Implementation (Dependency Graph)

```
Layer 0 (Foundation - no deps):
  ├─ 01-types (types.ts)
  ├─ 02-lanes-and-session-keys (lanes.ts, session-key.ts)
  └─ 03-config (types.gateway.ts, types.agents.ts, zod-schema)

Layer 1 (Infrastructure - needs Layer 0):
  ├─ 04-team-registry (team-registry.ts, team-registry.store.ts)
  ├─ 05-task-list (task-list.ts)
  ├─ 06-mailbox (mailbox.ts)
  └─ 07-system-prompts (prompts/*.md, system-prompt.ts)

Layer 2 (Tools - needs Layer 1):
  ├─ 08-team-management-tools (team-*, teammate-* tools)
  ├─ 09-task-tools (task-* tools)
  ├─ 10-messaging-tools (teammate-message, broadcast)
  └─ 11-plan-approval-tools (plan-submit, plan-review)

Layer 3 (Integration - needs all tools):
  ├─ 12-wiring-and-policy (openclaw-tools.ts, tool-policy.ts, pi-tools.ts)
  └─ 13-display-and-cli (display-tmux.ts, team-cli.ts)

Layer 4 (Tests):
  └─ 14-tests (*.test.ts files)
```

---

## Layer 0: Foundation

### 01-types: Core Data Structures

**File:** `src/agents/teams/types.ts`

**Key Types:**
- `TeamStatus`: `"active" | "completed" | "failed" | "interrupted"`
- `TeammateStatus`: `"spawning" | "active" | "idle" | "completed" | "failed" | "interrupted"`
- `TaskStatus`: `"pending" | "blocked" | "claimed" | "in-progress" | "completed" | "failed"`
- `PlanStatus`: `"pending" | "approved" | "rejected" | "revision-requested"`

**Team Structure:**
```typescript
export type Team = {
  teamId: string;                    // UUID
  teamName: string;                  // human-readable
  leadSessionKey: string;
  status: TeamStatus;
  lifecycle: TeamLifecycle;          // "ephemeral" | "persistent"
  boundSessionKey?: string;
  teammates: Record<string, Teammate>;
  config: TeamConfig;
  boundSession?: { type: string; id: string };  // Session tracking
  idleNotificationSent?: boolean;
  leadStatus?: "working" | "idle";
};
```

**Teammate Structure:**
```typescript
export type Teammate = {
  teammateId: string;
  role: string;
  sessionKey: string;
  status: TeammateStatus;
  model?: string;
  requirePlanApproval: boolean;
  planApproved: boolean;
  currentTask?: string;
  claimedTasks: number;
  completedTasks: number;
  timeout?: number;
};
```

**Task Structure:**
```typescript
export type Task = {
  taskId: string;
  title: string;
  status: TaskStatus;
  assignee?: string;                 // teammateId
  dependsOn: string[];               // task IDs
  priority: TaskPriority;
  metadata?: Record<string, unknown>;
  result?: "success" | "failure";
  summary?: string;
  artifacts?: string[];
  createdAt: number;
  claimedAt?: number;
  completedAt?: number;
};
```

### 02-lanes-and-session-keys

**Files:**
- `src/process/lanes.ts` - Add `Team = "team"` to `CommandLane` enum
- `src/agents/lanes.ts` - Export `AGENT_LANE_TEAM = CommandLane.Team`
- `src/routing/session-key.ts` - Team session key helpers

**Session Key Format:**
- Lead: `agent:team-{teamId}:lead`
- Teammate: `agent:team-{teamId}:teammate:{role}-{uuid}`

**Key Functions:**
```typescript
export function isTeamSessionKey(key: string): boolean;
export function parseTeamSessionKey(key: string): ParsedTeamSessionKey | null;
export function buildTeammateSessionKey(params: { agentId; teamId; role }): string;
export function buildTeamLeadSessionKey(params: { agentId; teamId }): string;
```

**Team Lane Concurrency (Important):**
- All team runs (lead + teammates) should use `CommandLane.Team`.
- **Concurrency must equal total team members** across active teams: `lead + teammates`.
- This avoids serialized teammate spawns and ensures full parallelism.
- When teams are created/teammates added or removed, recompute and update the lane concurrency.

### 03-config: Configuration Schema

**Gateway Config** (`src/config/types.gateway.ts`):
```typescript
export type TeamsGatewayConfig = {
  enabled?: boolean;                 // default: false
  maxActiveTeams?: number;           // default: 3
  defaultModel?: string;
  retentionDays?: number;            // default: 7
  storage?: {
    basePath?: string;               // default: "~/.openclaw/teams"
    taskListFormat?: "json" | "jsonl";
    mailboxTTLHours?: number;        // default: 24
  };
  display?: {
    mode?: "auto" | "inline" | "tmux";    // default: "auto"
    tmux?: {
      layout?: "tiled" | "even-horizontal" | "even-vertical";
      sessionPrefix?: string;        // default: "openclaw-team"
    };
  };
};
```

**Agent Config** (`src/config/types.agents.ts`):
```typescript
export type AgentTeamsConfig = {
  enabled?: boolean;
  defaultModel?: string;
  allowedModels?: string[];
  teammateTools?: {
    allow?: string[];
    deny?: string[];
  };
};
```

---

## Layer 1: Infrastructure

### 04-team-registry

**Files:**
- `src/agents/teams/team-registry.ts` - In-memory registry + lifecycle
- `src/agents/teams/team-registry.store.ts` - Disk persistence

**Key Functions:**
```typescript
export function createTeam(params): Team;
export function getTeam(teamId): Team | null;
export function listActiveTeams(): Team[];
export function addTeammate(teamId, teammate): void;
export function removeTeammate(teamId, teammateId): void;
export function updateTeammateStatus(teamId, teammateId, status): void;
export function isTeamLead(teamId, sessionKey): boolean;
export function resolveCallerTeamContext(sessionKey): TeamContext | null;
export function registerTeammateRun(runId, teamId, teammateId): void;
export function initTeamRegistry(): void;
export function resetTeamRegistryForTests(): void;
```

**Lifecycle Event Listener:**
```typescript
// team-registry.ts:482-518
listenerStop = onAgentEvent((evt) => {
  if (evt.stream !== "lifecycle") return;
  const mapping = runIdToTeammate.get(evt.runId);
  if (!mapping) return;
  
  const { teamId, teammateId } = mapping;
  const phase = evt.data.phase;
  
  if (phase === "start") {
    updateTeammateStatus(teamId, teammateId, "active");
  } else if (phase === "end") {
    const incompleteTasks = listAssignedIncompleteTasks(teamId, teammateId);
    if (incompleteTasks.length > 0) {
      updateTeammateStatus(teamId, teammateId, "interrupted");
      notifyLeadOfTeammateInterrupted(teamId, teammateId, incompleteTasks);
    } else {
      updateTeammateStatus(teamId, teammateId, "idle");
    }
    notifyLeadIfTeamIdle(teamId);
  } else if (phase === "error") {
    updateTeammateStatus(teamId, teammateId, "failed");
    notifyLeadOfTeammateFinish(teamId, teammateId, "failed");
    notifyLeadIfTeamIdle(teamId);
  }
});
```

**Idle Notification Mechanism:**
- `notifyLeadIfTeamIdle()` sends a notification to the lead when all teammates are idle and no incomplete tasks remain
- Uses `idleNotificationSent` flag to prevent duplicate notifications (only one notification per idle window)
- **Why `resetIdleNotification()` is needed:** When new work is added (via `task_add` or `teammate_spawn`) after the team was already notified as idle, the flag must be reset. Otherwise, when the new work completes and the team becomes idle again, `notifyLeadIfTeamIdle()` would see the flag is still `true` and skip notification. The reset ensures the lead gets notified each time a new batch of work completes.

**Example flow:**
```
1. Team completes all tasks → lead notified (idleNotificationSent = true)
2. Lead adds a new task → resetIdleNotification() → idleNotificationSent = false
3. Team completes the new task → lead can be notified again ✓
```

**Storage Layout:**
```
~/.openclaw/teams/
├── {teamId}/
│   ├── config.json              # Team metadata + teammates
│   ├── tasks.json               # Task[]
│   ├── mailbox/
│   │   └── {messageId}.json     # TeamMessage
│   └── plans/
│       └── {teammateId}.json    # TeammatePlan
```

### 05-task-list

**File:** `src/agents/teams/task-list.ts`

**Key Functions:**
```typescript
export function addTask(teamId, params): Task;
export function claimTask(teamId, params): ClaimResult;
export function completeTask(teamId, params): CompleteResult;
export function listTasks(teamId, filter): { tasks; summary };
export function getTask(teamId, taskId): Task | null;
export function removeTask(teamId, taskId): boolean;
```

**Dependency Logic:**
- Task is `blocked` if any dependency is not `completed`
- Auto-unblock when dependencies complete
- Cycle detection via DFS in `wouldCreateCycle()`
- **Task Execution Order:** Tasks are executed strictly in dependency order - a task can only be claimed after all its dependencies are completed. This means teammates can only work on tasks that are ready, and their communication is always about upcoming tasks (tasks they're about to work on or will work on next).

**File Locking:**
```typescript
async function withTaskLock<T>(teamId, fn): Promise<T> {
  // Acquire lock via lockfile
  // Execute fn
  // Release lock
}
```

### 06-mailbox

**File:** `src/agents/teams/mailbox.ts`

**Key Functions:**
```typescript
export function sendMessage(params): TeamMessage;
export function broadcastMessage(params): { messageId; deliveredTo };
export function readMessages(params): TeamMessage[];
export function markRead(params): void;
export function cleanupExpiredMessages(params): number;
```

**Message Delivery:**
```typescript
// Messages are delivered immediately via system events with full content
// Uses enqueueSystemEvent to inject into recipient's context
function deliverMessage(recipientSessionKey: string, msg: TeamMessage): void {
  const text = `${prefix}From ${fromLabel}: ${msg.message}`;
  enqueueSystemEvent(text, { sessionKey: recipientSessionKey });
}
```

**Important:** Messages are delivered immediately with full content via system events. The recipient sees the message in their context as `"System: From {sender}: {message}"`. There is no need for a separate read tool - messages are already visible in the agent's prompt.

### 07-system-prompts

**Files:**
- `src/agents/teams/prompts/team-lead.md` - Lead system prompt template
- `src/agents/teams/prompts/teammate.md` - Teammate system prompt template
- `src/agents/teams/system-prompt.ts` - Template loader with Handlebars

**Template Variables:**
- Teammate: `{{teammateId}}`, `{{role}}`, `{{requirePlanApproval}}`, `{{#each otherTeammates}}`

---

## Layer 2: Tools

### 08-team-management-tools

**Files:**
- `src/agents/tools/team-create-tool.ts` - `team_create`
- `src/agents/tools/team-status-tool.ts` - `team_status`
- `src/agents/tools/teammate-spawn-tool.ts` - `teammate_spawn`
- `src/agents/tools/teammate-shutdown-tool.ts` - `teammate_shutdown`

**Team Create:**
- Who: Lead only
- Creates team with lead as owner

**Teammate Spawn:** ⚠️ See [Bug Fix](#bug-fix-teammate-stuck-in-spawning)
- Who: Lead only
- Validates model against `allowedModels`
- Uses `AGENT_LANE_TEAM` lane
- Calls gateway: `callGateway({ method: "agent", params: { sessionKey, extraSystemPrompt, ... } })`
- **Critical:** Registers both idempotency key AND actual runId mappings

### 09-task-tools

**Files:**
- `src/agents/tools/task-add-tool.ts` - `task_add`
- `src/agents/tools/task-claim-tool.ts` - `task_claim`
- `src/agents/tools/task-complete-tool.ts` - `task_complete`
- `src/agents/tools/task-list-tool.ts` - `task_list`
- `src/agents/tools/task-get-tool.ts` - `task_get` (bonus)
- `src/agents/tools/task-update-tool.ts` - `task_update` (bonus)

**Delegate Mode Enforcement:**
```typescript
// In task_claim:
  return jsonResult({
    status: "error",
    error: "Lead cannot claim tasks."
  });
}
```

### 10-messaging-tools

**Files:**
- `src/agents/tools/teammate-message-tool.ts` - `teammate_message`
- `src/agents/tools/teammate-broadcast-tool.ts` - `teammate_broadcast`

### 11-plan-approval-tools

**Files:**
- `src/agents/tools/plan-submit-tool.ts` - `plan_submit` (teammate only)
- `src/agents/tools/plan-review-tool.ts` - `plan_review` (lead only)

**Plan Storage:** `~/.openclaw/teams/{teamId}/plans/{teammateId}.json`

---

## Layer 3: Integration

### 12-wiring-and-policy

**Files:**
- `src/agents/openclaw-tools.ts` - Register all 14 team tools
- `src/agents/tool-policy.ts` - Add `group:teams`, `teammate` profile
- `src/agents/pi-tools.ts` - Delegate mode + plan approval enforcement

**Tool Groups:**
```typescript
export const TOOL_GROUPS = {
  "group:teams": [
    "team_create", "team_status", "teammate_spawn", "teammate_shutdown",
    "teammate_message", "teammate_broadcast",
    "task_add", "task_claim", "task_complete", "task_list",
    "plan_submit", "plan_review"
  ],
  // ... other groups
};
```

**Teammate Profile:**
```typescript
teammate: {
  allow: ["group:fs", "group:runtime", "group:memory", "group:web",
          "task_claim", "task_complete", "task_list", "teammate_message", 
          "teammate_broadcast", "plan_submit"],
  deny: ["team_create", "teammate_spawn", "teammate_shutdown", "plan_review",
         "group:automation", "group:messaging", "sessions_spawn"]
}
```

**Lead Coordination Enforcement** (pi-tools.ts):
```typescript
  delegateModeDenyPolicy = {
    deny: [...expandToolGroups(["group:fs", "group:runtime"])]
  };
}
```

**Plan Approval Enforcement:**
```typescript
if (teammate?.requirePlanApproval && !teammate.planApproved) {
  planApprovalDenyPolicy = {
    deny: [...expandToolGroups(["group:fs", "group:runtime"])]
  };
}
```

### 13-display-and-cli

**Files:**
- `src/agents/teams/display-tmux.ts` - tmux session/pane management
- `src/commands/team.ts` - CLI commands
- `src/cli/team-cli.ts` - CLI registration

**tmux Layout:**
```
┌──────────────┬──────────────┐
│              │  Teammate 1  │
│              ├──────────────┤
│   Lead       │  Teammate 2  │
│   (left 50%) ├──────────────┤
│              │  Teammate 3  │
│              ├──────────────┤
│              │  Teammate 4  │
└──────────────┴──────────────┘
```

**CLI Commands:**
- `openclaw team status [--team <name>] [--json]`
- `openclaw team attach --team <name>`

---

## Design: runId = IdempotencyKey (No Race Condition)

**Key Insight:** The gateway **always uses the idempotency key as the runId** (`gateway/server-methods/agent.ts:299`):
```typescript
const runId = idem;  // idempotencyKey becomes runId
```

**This eliminates the race condition entirely.**

### Before (Had Race Condition)
```
1. Generate UUID (childIdem) 
2. Register mapping: childIdem -> teammate
3. Call gateway (async)
4. Gateway MAY return different runId
5. Events fire with different runId -> DROPPED ❌
6. Register different runId too late
7. OPTIMISTIC: Set "active" immediately (masked the bug)
```

### After (No Race Condition)
```
1. Generate UUID (childIdem) = runId  
2. Register mapping: runId -> teammate (SYNCHRONOUS)
3. Call gateway with idempotencyKey = runId
4. Gateway: runId = idempotencyKey (line 299)
5. Events fire with runId -> FOUND ✓
6. Status: "spawning" -> "active" via lifecycle event
7. No optimistic transition needed
```

### Changes Made
- **Removed:** Defensive check for different `response.runId` (teammate-spawn-tool.ts)
- **Removed:** Optimistic status transition to "active" 
- **Status transitions:** Lifecycle start/end + task tools (`task_complete` -> idle, `teammate_shutdown` -> completed)
- **Added:** `transitionTeammateToIdle()` function for when teammates have no tasks

**Benefits:**
- Simpler, more correct code
- Status reflects actual agent state
- No race conditions
- Teammates transition to "idle" when no work available

---

## Teammate Lifecycle

```
                          lifecycle
┌──────────┐   spawn    ┌──────────┐   "start"    ┌──────────┐
│   init   │ ──────────▶│ spawning │ ───────────▶│  active  │
└──────────┘            └──────────┘             └────┬─────┘
                                                      │
                    ┌─────────────────────────────────┤
                    │                                 │
                    │ claim task                      │ complete task
                    │ (has work)                      │ (no more tasks)
                    ▼                                 ▼
             ┌──────────┐                     ┌──────────┐
             │  active  │                     │   idle   │
             │(working) │                     │(waiting) │
             └────┬─────┘                     └────┬─────┘
                  │                                │
                  │ complete task                  │ claim task
                  │ (more tasks)                   │ (task available)
                  └────────────────┐               │
                                   ▼               │
                            ┌──────────┐          │
                            │  active  │◄─────────┘
                            │(next task│
                            └────┬─────┘
                                 │
                                 │ lifecycle "end" (no incomplete tasks)
                                 ▼
                          ┌───────────┐
                          │   idle    │ (waiting)
                          └─────┬─────┘
                                │ teammate_shutdown
                                ▼
                          ┌───────────┐
                          │ completed │ (terminal)
                          └───────────┘
                                ▲
                                │ lifecycle "end" (incomplete tasks)
                                │
                          ┌─────┴─────┐
                          │interrupted│ (recovery)
                          └─────┬─────┘
                                ▲
                                │ lifecycle "error"
                                │
                          ┌─────┴─────┐
                          │   failed  │ (terminal)
                          └───────────┘
```

### State Transitions

| From | To | Trigger | Description |
|------|-----|---------|-------------|
| `init` | `spawning` | `teammate_spawn` tool called | Teammate record created, gateway spawn initiated |
| `spawning` | `active` | Lifecycle "start" event | Agent run started, teammate ready to work |
| `active` | `active` | Task claimed | Teammate working on task (same state) |
| `active` | `idle` | Task completed (no more tasks) | No pending tasks, teammate waiting |
| `idle` | `active` | Task claimed | Task available, teammate resumes work |
| `active` | `idle` | Lifecycle "end" event (no assigned tasks) | Session ended with no incomplete tasks |
| `active` | `interrupted` | Lifecycle "end" event (incomplete tasks) | Teammate ended before finishing tasks |
| `idle` | `completed` | `teammate_shutdown` | Lead retires the teammate |
| `active` | `failed` | Lifecycle "error" event | Teammate encountered error (terminal) |
| `spawning`/`active` | `interrupted` | Gateway restart | Unclean shutdown, recovery state |

**Terminal states:** `completed`, `failed` - teammate won't work again
**Active states:** `spawning`, `active`, `idle` - teammate can still work
**Recovery state:** `interrupted` - requires lead action (retry/reassign)

---

### Workspace Isolation

**Each team has a DEDICATED workspace isolated from the main agent.**

```
Lead Session (Main): agent:main:main
  └─ Workspace: ~/.openclaw/workspace/ (default)

Team "Research" (ID: 123)
  ├─ Workspace: ~/.openclaw/agents/team-123/workspace/
  ├─ Teammate 1: agent:team-123:teammate:reviewer-xxx
  └─ Teammate 2: agent:team-123:teammate:architect-yyy
```

**How workspace is determined:**
```typescript
// From agent-scope.ts
export function resolveAgentWorkspaceDir(cfg, agentId) {
  if (agentId.startsWith("team-")) {
    return `~/.openclaw/agents/${agentId}/workspace`;
  }
  // fallback to default agent workspace
}
```

**Team Bootstrap Modes (Speed)**

Team workspaces can skip most bootstrap files for speed. Configure via `gateway.teams.bootstrapMode`:
- `none`: do not create any bootstrap files
- `minimal` (recommended): only `MEMORY.md` + `TOOLS.md`
- `full`: create standard bootstrap files + optional `HEARTBEAT.md`

Heartbeat policy is controlled by `gateway.teams.heartbeatMode`:
- `none` (default)
- `lead`
- `all`

**Key characteristics:**
- **Team Isolation**: File changes made by a team do NOT pollute the main agent's workspace.
- **Shared Team State**: All teammates within the same team share the team's workspace.
- **Bootstrapping**: Team workspaces default to `MEMORY.md` + `TOOLS.md` only (fast startup).
- **SOUL Override**: Teams use `SOUL.team.md` if present, overriding the standard `SOUL.md`.

### Teammates vs. Subagents

| Feature | Teammates (`teammate_spawn`) | Subagents (`sessions_spawn`) |
|---------|----------------------------|------------------------------|
| **Longevity** | Persistent (stay alive until team disbands) | Ephemeral (finish after Lead session ends) |
| **Workspace** | Dedicated Team Workspace (isolated) | Parent Agent's Workspace (shared) |
| **Visibility** | Split panes (tmux), collaborative | Background/System-managed |
| **Messaging** | Direct (`teammate_message`), Broadcast | Return value of tool call |
| **Context** | Full teammate role-play, shared memory | Minimal "sub-task" focus |

### Workspace Reuse & Optimization

- **Identity Filtering**: To reduce prompt noise, `USER.md`, `IDENTITY.md`, and `HEARTBEAT.md` are excluded from teammate prompts.
- **Read-only Context**: If present, use `BOOTSTRAP.md` in the team workspace for team-specific global instructions.
- **Shared Memory**: `MEMORY.md` in the team workspace is shared by all teammates.
- **Tools Reference**: `TOOLS.md` in the team workspace is the shared tool quick-reference.

### Session Keys & Isolation

While workspaces are shared, sessions are isolated:

| Session Key | Type | Workspace | Context |
|-------------|------|-----------|---------|
| `agent:team-abc:lead` | Lead | `~/.openclaw/agents/team-abc/workspace/` | Independent |
| `agent:team-abc:teammate:reviewer-xxx` | Teammate | `~/.openclaw/agents/team-abc/workspace/` | Independent |
| `agent:team-abc:teammate:arch-xxx` | Teammate | `~/.openclaw/agents/team-abc/workspace/` | Independent |

**Session isolation means:**
- Each has separate conversation history
- Each has separate tool call context
- Each has separate memory/state
- But they all see the same files

### Team View (Automatic)

Team view is automatic now. Use **Shift+Up/Down** to cycle between the caller session and each team lead.

Display behavior is controlled by `gateway.teams.display.mode`:
- `auto` (default): tmux split view if inside tmux, otherwise inline feed
- `tmux`: always split view in tmux (requires tmux)
- `inline`: single-log feed in the current TUI

**Inline Feed Notes:**
- Team messages are indented with a `│` prefix so they read as team traffic, not caller chat.
- Caller session logs remain visible; inline feed is additive (team traffic + caller chat).

**Split View Layout (tmux):**

```
┌──────────────────────────────┬──────────────────────────────┐
│                              │  Teammate 1: @reviewer       │
│   Lead Session (You)         │  ─────────────────────────   │
│   • Current context          │  Teammate 2: @architect      │
│   • Your tool calls          │  ─────────────────────────   │
│   • Your messages            │  Teammate 3: @tester         │
│                              │  ─────────────────────────   │
│   (left 50%)                 │  Teammate 4: @designer       │
│                              │  (scrollable vertically)     │
└──────────────────────────────┴──────────────────────────────┘
```

**Layout:**
- **Left side (50%)**: Lead session only - shows your current context, tool calls, and messages
- **Right side (50%)**: All teammates stacked vertically - each teammate pane shows their live activity, progress, and messages
- **Separators**: Vertical separator (`│`) between left/right; horizontal separators (`─`) between teammates on the right
- **Scrolling**: Right side is scrollable vertically to view all teammates
- **Minimum height**: Each teammate pane maintains a minimum height for readability

**Controls:**
- `Tab` - Switch between panes (cycles through lead and teammates)
- `Escape` - Exit split view
- All teammates are shown (no limit)

### Communication Patterns

Since teammates share workspace but have isolated sessions:

| Method | Tool | Data Location | Use Case |
|--------|------|---------------|----------|
| **Task Assignment** | `task_add`, `task_claim` | `~/.openclaw/teams/{teamId}/tasks.json` | Work distribution |
| **Direct Message** | `teammate_message` | `~/.openclaw/teams/{teamId}/mailbox/` | Private communication |
| **Broadcast** | `teammate_broadcast` | `~/.openclaw/teams/{teamId}/mailbox/` | Team-wide updates |
| **File Sharing** | `read`, `write` | `~/.openclaw/workspace/` | Code, artifacts, results |
| **Plan Review** | `plan_submit`, `plan_review` | `~/.openclaw/teams/{teamId}/plans/` | Approval workflow |

**Important:** All teammates can modify files in the shared workspace. Use task locking and messaging to coordinate file access.

**Task Execution Order & Communication:**
- Tasks are executed strictly in dependency order - a task can only be claimed after all its dependencies are completed.
- **Preferred workflow:** create tasks first → spawn teammates → teammates claim tasks.
- **Teammate Communication:** Since teammates can only work on tasks that are ready (dependencies completed), their communication is always about upcoming tasks - tasks they're about to work on, will work on next, or need coordination for.
- **Lead Communication:** The lead receives messages via the same immediate system event delivery mechanism. However, the lead's role is coordination-focused:
  - Receives automatic notifications when teammates finish/fail (via `notifyLeadOfTeammateFinish`)
  - Receives system notifications when the team is idle and all tasks are complete
  - Receives direct messages from teammates about status, blockers, or coordination needs
  - Receives broadcast messages for team-wide updates
  - Messages to the lead are typically about: status updates, coordination needs, results/synthesis, and team lifecycle management

**Lead Status (Caller-Facing):**
- Mission teams (auto-cleanup): `leadStatus` stays `working` until cleanup.
- Standing teams (persistent): `leadStatus` is `working` if any task is pending/blocked/in-progress, otherwise `idle`.
- Lead session lifecycle does not change `leadStatus`.

**Team Failure (Lead-Decided):**
- Teammate failures are reported to the lead.
- The lead decides whether to recover (adjust tasks) or abort.
- Use `team_complete` with `result: "failed"` to mark the team failed, notify the caller with failed task context, and clean up.

**Accessing Completed Dependency Tasks:**
Even though teammates work in isolated sessions, they can access context from completed dependency tasks through multiple mechanisms:

1. **Task Details via `task_get`:**
   - Use `task_get({ taskId: "..." })` to retrieve full details of any completed task
   - Returns `summary` (text summary of work done), `artifacts` (file paths), `result` (success/failure), and all task metadata
   - Example: When working on task B that depends on task A, call `task_get({ taskId: "task-a-id" })` to see what was accomplished

2. **Task List via `task_list`:**
   - Use `task_list({ teamId: "...", includeCompleted: true })` to see all completed tasks
   - Filter by status, assignee, or priority to find relevant completed work
   - Review `summary` and `artifacts` fields for each completed task

3. **Shared Workspace Files:**
   - All teammates share the same workspace directory: `~/.openclaw/agents/team-{teamId}/workspace/`
   - Files written by one teammate are immediately visible to others via standard file operations (`read`, `write`, `list`)
   - When completing a task, include file paths in the `artifacts` array so dependent teammates know where to look

4. **Direct Messaging:**
   - Use `teammate_message` to send context directly to teammates working on dependent tasks
   - Example: "I completed task A. Key findings in `analysis.md`. Task B should focus on X based on my results."

**Enriching Context for Upcoming Tasks:**
Teammates can enrich context for future teammates working on dependent tasks:

1. **Task Completion Summary:**
   - When calling `task_complete`, always include:
     - `summary`: Concise text summary of what was accomplished, key findings, decisions made, and important notes
     - `artifacts`: Array of file paths or references to work products (e.g., `["analysis.md", "design.json", "test-results.log"]`)
     - `result`: "success" or "failure" to indicate outcome

2. **Workspace Files as Artifacts:**
   - Write detailed documentation, analysis, or results to files in the shared workspace
   - Reference these files in the `artifacts` array when completing tasks
   - Dependent teammates can then read these files directly using standard file operations

3. **Shared Memory:**
   - Use `MEMORY.md` in the team workspace for persistent team knowledge
   - All teammates can read/write to this shared memory file
   - Store important discoveries, patterns, or decisions that affect multiple tasks

4. **Proactive Messaging:**
   - When completing a task, send `teammate_message` to teammates who will work on dependent tasks
   - Highlight critical information, gotchas, or recommendations
   - Example: "Task A complete. Note: API endpoint changed - see `api-changes.md`. Task B needs to update client code accordingly."

5. **Broadcast Important Context:**
   - Use `teammate_broadcast` for team-wide important information
   - Reserve for critical changes that affect multiple teammates or the overall approach

**Best Practices:**
- **Always include summaries**: Even if artifacts exist, a text summary helps teammates quickly understand what was done
- **Reference files explicitly**: List file paths in `artifacts` so dependent teammates know where to look
- **Document decisions**: Include rationale and decisions in summaries so future teammates understand the "why"
- **Update shared memory**: For recurring patterns or team-wide knowledge, update `MEMORY.md`
- **Message proactively**: Don't wait for questions - send context when completing tasks that others depend on

---

## Testing

```bash
# Run team-related tests
pnpm vitest run src/agents/teams/team-registry.test.ts
pnpm vitest run src/agents/teams/task-list.test.ts
pnpm vitest run src/agents/teams/mailbox.test.ts
pnpm vitest run src/agents/tools/teammate-spawn-tool.test.ts
pnpm vitest run src/agents/tools/task-claim-tool.test.ts
pnpm vitest run src/agents/tools/plan-submit-tool.test.ts

# All team tests
pnpm vitest run --testNamePattern="team|teammate|task"
```

---

## Key Patterns

1. **Always check teams enabled:** Every tool checks `cfg.gateway?.teams?.enabled`
2. **Lead-only operations:** Use `isTeamLead()` to restrict sensitive operations
3. **Status updates persist:** Every status change calls `persistTeam()`
4. **Lifecycle tracking:** Registry listens to `onAgentEvent()` for run start/end
5. **File locking:** Task operations use `withTaskLock()` for concurrent access
6. **Message delivery:** Mailbox uses `enqueueSystemEvent()` to inject context
7. **Delegate mode:** Enforced in both tool logic AND tool policy

---

## Future Enhancements (from future-direction.md)

### P0 - Wire Existing (Quick Wins)
- Ctrl+T → task list overlay (when team active)
- Auto-idle notification to lead

### P1 - TUI Team Awareness
- Teammate status bar in footer
- `/team` slash command
- Teammate activity in lead's chat log

### P2 - tmux Display Polish
- Pane titles with colored role badges
- Status bar with teammate names
- Per-pane hint bar

### P3 - Advanced Features
- Inline display mode (no tmux required)
- Elapsed time + token tracking per teammate
- Fun animated status verbs

### P4 - Future
- iTerm2 split pane support
- Teammate selection with Shift+Up/Down
- `/resume` and `/rewind` for team sessions
- Permission inheritance system
- Team proposal logic (auto-suggest teams)

---

## Complete File Map

### New Files (29):
| Path | Purpose |
|------|---------|
| `src/agents/teams/types.ts` | All shared types |
| `src/agents/teams/team-registry.ts` | In-memory team tracking + lifecycle |
| `src/agents/teams/team-registry.store.ts` | Disk persistence |
| `src/agents/teams/task-list.ts` | Task CRUD + deps + locking |
| `src/agents/teams/mailbox.ts` | Inter-teammate messaging |
| `src/agents/teams/system-prompt.ts` | Prompt template loader (Handlebars) |
| `src/agents/teams/prompts/team-lead.md` | Lead system prompt template |
| `src/agents/teams/prompts/teammate.md` | Teammate system prompt template |
| `src/agents/teams/display-tmux.ts` | tmux pane management |
| `src/agents/tools/team-create-tool.ts` | team_create tool |
| `src/agents/tools/team-status-tool.ts` | team_status tool |
| `src/agents/tools/team-cleanup-tool.ts` | team_cleanup tool |
| `src/agents/tools/team-discover-tool.ts` | team_discover tool |
| `src/agents/tools/teammate-spawn-tool.ts` | teammate_spawn tool |
| `src/agents/tools/teammate-shutdown-tool.ts` | teammate_shutdown tool |
| `src/agents/tools/teammate-join-request-tool.ts` | teammate_join_request |
| `src/agents/tools/teammate-join-approve-tool.ts` | teammate_join_approve |
| `src/agents/tools/teammate-join-reject-tool.ts` | teammate_join_reject |
| `src/agents/tools/teammate-message-tool.ts` | teammate_message tool |
| `src/agents/tools/teammate-broadcast-tool.ts` | teammate_broadcast tool |
| `src/agents/tools/task-add-tool.ts` | task_add tool |
| `src/agents/tools/task-claim-tool.ts` | task_claim tool |
| `src/agents/tools/task-complete-tool.ts` | task_complete tool |
| `src/agents/tools/task-list-tool.ts` | task_list tool |
| `src/agents/tools/task-get-tool.ts` | task_get tool |
| `src/agents/tools/task-update-tool.ts` | task_update tool |
| `src/agents/tools/plan-submit-tool.ts` | plan_submit tool |
| `src/agents/tools/plan-review-tool.ts` | plan_review tool |
| `src/commands/team.ts` | CLI: openclaw team attach/status |
| `src/cli/team-cli.ts` | CLI registration |

### Modified Files (12):
| Path | Change |
|------|--------|
| `src/process/lanes.ts` | Add `Team = "team"` |
| `src/agents/lanes.ts` | Export `AGENT_LANE_TEAM` |
| `src/routing/session-key.ts` | Add team session key helpers |
| `src/config/types.gateway.ts` | Add `TeamsGatewayConfig` |
| `src/config/types.agents.ts` | Add `teams` field on `AgentConfig` |
| `src/config/zod-schema.agent-runtime.ts` | Zod schema for teams config |
| `src/agents/openclaw-tools.ts` | Register all 20+ team tools |
| `src/agents/tool-policy.ts` | Add `group:teams`, teammate profile |
| `src/agents/pi-tools.ts` | Delegate mode + plan approval enforcement |
| `package.json` | Add `handlebars` dependency |
| `src/cli/program/register.subclis.ts` | Register team CLI |

---

## Design References

- **RFC:** `agen-swarm-proposal/initial-rought-design.md`
- **Overview:** `agen-swarm-proposal/00-overview.md`
- **Task Specs:** `agen-swarm-proposal/01-types.md` through `14-tests.md`
- **Future Roadmap:** `agen-swarm-proposal/future-direction.md`
