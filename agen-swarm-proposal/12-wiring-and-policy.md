# Task 12: Tool Wiring, Tool Policy, and Delegate Mode

**Layer:** 3 (Integration)
**Dependencies:** Task 08, 09, 10, 11 (all tools must exist)
**Can run in parallel with:** Task 13

## What to Do

1. Register all 14 team tools in `openclaw-tools.ts`
2. Add `group:teams` and `teammate` profile to `tool-policy.ts`
3. Implement delegate mode and plan approval tool restrictions in `pi-tools.ts`

## Files to Modify

### 1. `src/agents/openclaw-tools.ts`

Add imports for all 14 team tools and register them in the `createOpenClawTools` function.

Current structure (line 56-161): the function creates an array of tools and returns them. Add team tools after the `createSessionStatusTool` call (around line 133).

```typescript
// Add these imports at the top:
import { createTeamCreateTool } from "./tools/team-create-tool.js";
import { createTeamStatusTool } from "./tools/team-status-tool.js";
import { createTeammateSpawnTool } from "./tools/teammate-spawn-tool.js";
import { createTeammateMessageTool } from "./tools/teammate-message-tool.js";
import { createTeammateBroadcastTool } from "./tools/teammate-broadcast-tool.js";
import { createTeammateShutdownTool } from "./tools/teammate-shutdown-tool.js";
import { createTaskAddTool } from "./tools/task-add-tool.js";
import { createTaskClaimTool } from "./tools/task-claim-tool.js";
import { createTaskCompleteTool } from "./tools/task-complete-tool.js";
import { createTaskListTool } from "./tools/task-list-tool.js";
import { createPlanSubmitTool } from "./tools/plan-submit-tool.js";
import { createPlanReviewTool } from "./tools/plan-review-tool.js";

// Inside createOpenClawTools, after line ~139 (after imageTool spread):
// Add team tools
const teamToolOpts = {
  agentSessionKey: options?.agentSessionKey,
  agentChannel: options?.agentChannel,
  sandboxed: options?.sandboxed,
  config: options?.config,
};

const teamTools: AnyAgentTool[] = [
  createTeamCreateTool(teamToolOpts),
  createTeamStatusTool(teamToolOpts),
  createTeammateSpawnTool(teamToolOpts),
  createTeammateMessageTool(teamToolOpts),
  createTeammateBroadcastTool(teamToolOpts),
  createTeammateShutdownTool(teamToolOpts),
  createTaskAddTool(teamToolOpts),
  createTaskClaimTool(teamToolOpts),
  createTaskCompleteTool(teamToolOpts),
  createTaskListTool(teamToolOpts),
  createPlanSubmitTool(teamToolOpts),
  createPlanReviewTool(teamToolOpts),
];

// Spread into the tools array before pluginTools:
return [...tools, ...teamTools, ...pluginTools];
```

### 2. `src/agents/tool-policy.ts`

Add `group:teams` and update `group:openclaw`. Modify `TOOL_GROUPS` (line 13):

```typescript
export const TOOL_GROUPS: Record<string, string[]> = {
  // ... existing groups unchanged ...

  // Team coordination tools (NEW)
  "group:teams": [
    "team_create",
    "team_status",
    "teammate_spawn",
    "teammate_message",
    "teammate_broadcast",
    "teammate_shutdown",
    "task_add",
    "task_claim",
    "task_complete",
    "task_list",
    "plan_submit",
    "plan_review",
  ],

  // Update group:openclaw to include team tools:
  "group:openclaw": [
    // ... existing entries ...
    "team_create",
    "team_status",
    "teammate_spawn",
    "teammate_message",
    "teammate_broadcast",
    "teammate_shutdown",
    "task_add",
    "task_claim",
    "task_complete",
    "task_list",
    "plan_submit",
    "plan_review",
  ],
};
```

Add a `teammate` profile to `TOOL_PROFILES` (line 59):

```typescript
const TOOL_PROFILES: Record<ToolProfileId, ToolProfilePolicy> = {
  // ... existing profiles ...

  // Teammate profile: focused worker tools only (NEW)
  teammate: {
    allow: [
      "group:fs", // read, write, edit, apply_patch
      "group:runtime", // exec, process
      "group:memory", // memory_search, memory_get
      "group:web", // web_search, web_fetch
      "task_claim",
      "task_complete",
      "task_list",
      "task_add",
      "teammate_message",
      "teammate_broadcast",
      "team_status",
      "plan_submit",
      "image",
    ],
    deny: [
      "team_create", // only lead can create teams
      "teammate_spawn", // only lead can spawn teammates
      "teammate_shutdown", // only lead can shut down teammates
      "plan_review", // only lead can review plans
      "group:automation", // no cron, no gateway tool
      "group:messaging", // no direct user messaging (message tool)
      "sessions_spawn", // no spawning subagents from teammates
    ],
  },
};
```

Also add `"teammate"` to the `ToolProfileId` type (find it near the profiles).

### 3. `src/agents/pi-tools.ts` -- Delegate Mode + Plan Approval Enforcement

In `createOpenClawCodingTools` (line 113), after all existing policy resolution (around line 394-395), add two new conditional deny policies:

```typescript
// After subagentPolicyExpanded (around line 394):

// ---- DELEGATE MODE ENFORCEMENT ----
// If the current session is a team lead in delegate mode, deny implementation tools.
let delegateModeDenyPolicy: SandboxToolPolicy | undefined;
if (options?.sessionKey) {
  const teamContext = resolveCallerTeamContext(options.sessionKey);
  if (teamContext && teamContext.isLead && teamContext.team.coordinationMode === "delegate") {
    delegateModeDenyPolicy = {
      deny: [...expandToolGroups(["group:fs", "group:runtime"])],
    };
  }
}

// ---- PLAN APPROVAL ENFORCEMENT ----
// If the current session is a teammate waiting for plan approval, deny implementation tools.
let planApprovalDenyPolicy: SandboxToolPolicy | undefined;
if (options?.sessionKey) {
  const teamContext = resolveCallerTeamContext(options.sessionKey);
  if (teamContext && !teamContext.isLead && teamContext.teammate) {
    const tm = teamContext.teammate;
    if (tm.requirePlanApproval && !tm.planApproved) {
      planApprovalDenyPolicy = {
        deny: [...expandToolGroups(["group:fs", "group:runtime"])],
      };
    }
  }
}

// Apply these additional deny policies in filterToolsByPolicy chain:
// delegateModeDenyPolicy and planApprovalDenyPolicy
// Add them to the existing chain of policy filters.
```

The existing `filterToolsByPolicy` function (around line 396) takes a tools array and a policy and returns filtered tools. Apply the new deny policies after the existing ones.

Import needed:

```typescript
import { resolveCallerTeamContext } from "./teams/team-registry.js";
import { expandToolGroups } from "./tool-policy.js";
```

## How Delegate Mode Works

When coordinationMode is "delegate":

- `task_claim` tool (Task 09) rejects if caller is lead (checked inside the tool itself)
- `pi-tools.ts` applies a deny policy for `group:fs` + `group:runtime` to the lead session
- This means the lead cannot use: read, write, edit, apply_patch, exec, process
- The lead CAN still use: team tools, session tools, web tools, memory tools

When coordinationMode is "normal":

- No deny policies applied
- Lead has full access to everything

## How Plan Approval Works

When teammate has `requirePlanApproval: true` and `planApproved: false`:

- `pi-tools.ts` applies a deny policy for `group:fs` + `group:runtime`
- Teammate can ONLY use: plan_submit, task tools, messaging tools, team_status
- After lead calls `plan_review` with action "approve":
  - `teammate.planApproved` is set to `true` in registry
  - On the teammate's next turn, `createOpenClawCodingTools` resolves again
  - The deny policy is no longer applied (planApproved is true)
  - Implementation tools become available

## Reference Files

- `src/agents/openclaw-tools.ts` -- where tools are registered (162 lines)
- `src/agents/tool-policy.ts` -- TOOL_GROUPS, TOOL_PROFILES (88+ lines)
- `src/agents/pi-tools.ts` -- createOpenClawCodingTools + filterToolsByPolicy (434 lines)
- `src/agents/sandbox/tool-policy.ts` -- isToolAllowed, SandboxToolPolicy type
- `src/agents/teams/team-registry.ts` (Task 04) -- resolveCallerTeamContext

## Notes

- The `teammate` profile is like the `coding` profile but with team tools added and lead-only tools + automation denied.
- Delegate mode denial is dynamic -- it's resolved each time tools are built for a turn. If the team is disbanded or mode changes, it takes effect immediately.
- Plan approval denial works the same way -- it's resolved per turn, so approval takes effect on the next turn.
- `expandToolGroups` (from tool-policy.ts) expands group names into individual tool names for the deny list.

## Acceptance Criteria

- [ ] All 14 team tools are registered in `createOpenClawTools`
- [ ] `group:teams` contains all 14 team tool names
- [ ] `group:openclaw` includes all team tools
- [ ] `teammate` profile allows: fs, runtime, memory, web, task tools, messaging tools, plan_submit
- [ ] `teammate` profile denies: team_create, teammate_spawn, teammate_shutdown, plan_review, automation, messaging
- [ ] Delegate mode denies `group:fs` + `group:runtime` for the lead
- [ ] Plan approval denies `group:fs` + `group:runtime` for unapproved teammates
- [ ] After plan approval, implementation tools become available
- [ ] `pnpm build` passes
- [ ] Existing tool-policy tests still pass
