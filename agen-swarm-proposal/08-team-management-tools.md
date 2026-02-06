# Task 08: Team Management Tools

**Layer:** 2 (Tools)
**Dependencies:** Task 04 (team registry), Task 07 (system prompts)
**Can run in parallel with:** Task 09, Task 10, Task 11

## What to Do

Create four tools for team lifecycle management: `team_create`, `team_status`, `teammate_spawn`, `teammate_shutdown`.

## Pattern to Follow

Every tool follows the exact pattern of `src/agents/tools/sessions-spawn-tool.ts`:

- Export a `createXxxTool(opts)` function that returns `AnyAgentTool`
- Use `@sinclair/typebox` `Type.Object({...})` for parameter schema
- Import `jsonResult`, `readStringParam` from `./common.js`
- Check teams enabled before executing
- Return structured JSON results

## Files to Create

### 1. `src/agents/tools/team-create-tool.ts`

Tool name: `team_create`
Who uses it: Lead only

```typescript
import { Type } from "@sinclair/typebox";
import crypto from "node:crypto";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";
import { loadConfig } from "../../config/config.js";
import { createTeam as registryCreateTeam } from "../teams/team-registry.js";
import { resolveAgentConfig } from "../agent-scope.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";

const TeamCreateSchema = Type.Object({
  teamName: Type.String(),
  description: Type.Optional(Type.String()),
  maxTeammates: Type.Optional(Type.Number({ minimum: 1 })),
  coordinationMode: Type.Optional(Type.String()), // "normal" | "delegate"
});

export function createTeamCreateTool(opts?: { agentSessionKey?: string }): AnyAgentTool {
  return {
    label: "Teams",
    name: "team_create",
    description: "Create a new agent team with the calling session as Team Lead.",
    parameters: TeamCreateSchema,
    execute: async (_toolCallId, args) => {
      // 1. Check teams enabled
      const cfg = loadConfig();
      if (!cfg.gateway?.teams?.enabled) {
        return jsonResult({
          status: "error",
          error: "Teams are not enabled. Set gateway.teams.enabled: true.",
        });
      }

      // 2. Check max active teams
      // listActiveTeams().length < cfg.gateway.teams.maxActiveTeams

      // 3. Parse params
      const teamName = readStringParam(args, "teamName", { required: true });
      const coordinationMode =
        (args as any).coordinationMode === "delegate" ? "delegate" : "normal";
      const maxTeammates = (args as any).maxTeammates ?? cfg.gateway.teams.maxTeammatesPerTeam ?? 5;

      // 4. Create team in registry
      const team = registryCreateTeam({
        teamName,
        description: readStringParam(args, "description"),
        leadSessionKey: opts?.agentSessionKey ?? "",
        coordinationMode,
        maxTeammates,
        config: { maxTeammates, notifyOnUnblock: true },
      });

      // 5. Return result
      return jsonResult({
        status: "created",
        teamId: team.teamId,
        teamName: team.teamName,
        leadSessionKey: team.leadSessionKey,
        coordinationMode: team.coordinationMode,
      });
    },
  };
}
```

### 2. `src/agents/tools/team-status-tool.ts`

Tool name: `team_status`
Who uses it: Lead + Teammates

```typescript
const TeamStatusSchema = Type.Object({
  teamId: Type.String(),
  includeTaskList: Type.Optional(Type.Boolean()),
  includeMessages: Type.Optional(Type.Boolean()),
});

// execute:
// 1. Check teams enabled
// 2. Get team from registry
// 3. Build status response:
//    - team metadata (name, status, mode)
//    - lead status
//    - teammates list with { teammateId, role, status, currentTask, claimedTasks, completedTasks }
//    - task summary (total, pending, blocked, inProgress, completed, failed)
//    - unread message count (from mailbox)
// 4. If includeTaskList, include full task list
// 5. If includeMessages (default true), include unread messages
// 6. Return structured JSON
```

### 3. `src/agents/tools/teammate-spawn-tool.ts`

Tool name: `teammate_spawn`
Who uses it: Lead only

This is the most complex tool. It mirrors `sessions_spawn` but for team context.

```typescript
const TeammateSpawnSchema = Type.Object({
  teamId: Type.String(),
  role: Type.String(),
  task: Type.String(),
  model: Type.Optional(Type.String()),
  tools: Type.Optional(Type.Array(Type.String())),
  requirePlanApproval: Type.Optional(Type.Boolean()),
  timeout: Type.Optional(Type.Number({ minimum: 0 })),
});

// execute:
// 1. Check teams enabled
// 2. Get team from registry, verify caller is lead
// 3. Check teammate limit (team.teammates.size < team.maxTeammates)
// 4. Validate model against allowedModels config (if cross-model)
// 5. Build teammate session key:
//    const teammateId = crypto.randomUUID();
//    const sessionKey = `agent:${agentId}:team:${teamId}:${role}-${teammateId.slice(0,8)}`;
// 6. Create Teammate record, add to registry via addTeammate()
// 7. Build teammate system prompt via buildTeammateSystemPrompt()
// 8. Call gateway to spawn the run:
//    await callGateway({
//      method: "agent",
//      params: {
//        message: task,
//        sessionKey: teammateSessionKey,
//        lane: AGENT_LANE_TEAM,  // from src/agents/lanes.ts
//        extraSystemPrompt: childSystemPrompt,
//        model: resolvedModel,
//        deliver: false,
//        timeout: timeout > 0 ? timeout : undefined,
//        label: role,
//        spawnedBy: leadSessionKey,
//      },
//    });
// 9. Register run-to-teammate mapping for lifecycle tracking
// 10. Return { teammateId, sessionKey, role, status: "spawned" }
```

Key imports needed:

```typescript
import { callGateway } from "../../gateway/call.js";
import { AGENT_LANE_TEAM } from "../lanes.js";
import { buildTeammateSessionKey } from "../../routing/session-key.js";
import { buildTeammateSystemPrompt } from "../teams/system-prompt.js";
import { getTeam, addTeammate, isTeamLead } from "../teams/team-registry.js";
```

### 4. `src/agents/tools/teammate-shutdown-tool.ts`

Tool name: `teammate_shutdown`
Who uses it: Lead only

```typescript
const TeammateShutdownSchema = Type.Object({
  teamId: Type.String(),
  teammateId: Type.String(),
  reason: Type.Optional(Type.String()),
  force: Type.Optional(Type.Boolean()),
});

// execute:
// 1. Check teams enabled
// 2. Get team, verify caller is lead
// 3. Find teammate by teammateId
// 4. If force=true:
//    - Kill the run immediately via callGateway (or agent event)
//    - Update teammate status to "completed"
// 5. If force=false (graceful):
//    - Send a system event to the teammate's session asking it to finish up
//    - The teammate should complete its current task and stop
// 6. Return { acknowledged: true, status: "shutting-down" | "terminated" }
```

## Common Tool Options Pattern

All four tools accept the same `opts` shape for consistency:

```typescript
opts?: {
  agentSessionKey?: string;
  agentChannel?: GatewayMessageChannel;
  sandboxed?: boolean;
  config?: OpenClawConfig;
}
```

This matches how `createSessionsSpawnTool` receives its options in `src/agents/openclaw-tools.ts` lines 121-132.

## Reference Files

- `src/agents/tools/sessions-spawn-tool.ts` -- main pattern (277 lines)
- `src/agents/tools/common.js` -- `jsonResult`, `readStringParam`, `AnyAgentTool`
- `src/gateway/call.ts` -- `callGateway`
- `src/agents/lanes.ts` -- `AGENT_LANE_TEAM`
- `src/agents/teams/team-registry.ts` -- team CRUD (Task 04)
- `src/agents/teams/system-prompt.ts` -- prompt builder (Task 07)

## Notes

- `teammate_spawn` should NOT allow spawning from a teammate session (only lead can spawn). Check `isTeamLead()` from registry.
- `teammate_spawn` uses `AGENT_LANE_TEAM` (not `AGENT_LANE_SUBAGENT`), so teammates get their own concurrency lane.
- Cross-model: if `model` param is given, validate against `allowedModels` in per-agent config. If not in the list, return error.
- `requirePlanApproval`: if true, the teammate's system prompt says "submit a plan first" and implementation tools are denied until plan is approved. The denial is enforced in Task 12 (wiring).

## Acceptance Criteria

- [ ] `team_create` creates a team and returns teamId
- [ ] `team_create` enforces max active teams limit
- [ ] `team_create` rejects if teams are disabled
- [ ] `team_status` returns full team state with task summary
- [ ] `teammate_spawn` creates a teammate session via callGateway
- [ ] `teammate_spawn` uses AGENT_LANE_TEAM lane
- [ ] `teammate_spawn` validates cross-model against allowedModels
- [ ] `teammate_spawn` only works when called by the lead
- [ ] `teammate_shutdown` gracefully or forcefully stops a teammate
- [ ] All tools check teams enabled before executing
- [ ] `pnpm build` passes
