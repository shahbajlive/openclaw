# Agent Teams -- Implementation Plan Overview

Based on `agen-swarm-proposal/initial-rought-design.md` (RFC-0001).

## Task Dependency Graph

```
Layer 0 (Foundation -- no deps, fully parallel):
  01-types
  02-lanes-and-session-keys
  03-config

Layer 1 (Infrastructure -- depends on Layer 0, parallel with each other):
  04-team-registry         (needs 01, 02, 03)
  05-task-list             (needs 01)
  06-mailbox               (needs 01)
  07-system-prompts        (needs 01)

Layer 2 (Tools -- depends on Layer 1, parallel with each other):
  08-team-management-tools (needs 04, 07)
  09-task-tools            (needs 04, 05)
  10-messaging-tools       (needs 04, 06)
  11-plan-approval-tools   (needs 04)

Layer 3 (Integration -- needs all tools):
  12-wiring-and-policy     (needs 08, 09, 10, 11)
  13-display-and-cli       (needs 04)

Layer 4 (Tests -- needs everything):
  14-tests                 (needs all above)
```

## Parallel Execution Strategy

- **3 agents** can work on Layer 0 simultaneously (tasks 01, 02, 03).
- **4 agents** can work on Layer 1 simultaneously (tasks 04, 05, 06, 07).
- **4 agents** can work on Layer 2 simultaneously (tasks 08, 09, 10, 11).
- **2 agents** can work on Layer 3 simultaneously (tasks 12, 13).
- **1 agent** handles Layer 4 (tests).

Agents working on later layers should wait for their dependencies to merge first.

## Key Patterns to Follow

Every new tool follows the pattern in `src/agents/tools/sessions-spawn-tool.ts`:

- Export a `createXxxTool(opts)` function returning `AnyAgentTool`
- Use `@sinclair/typebox` for parameter schema
- Import `jsonResult`, `readStringParam` from `./common.js`
- Check `loadConfig()` for teams enabled before executing

Team registry follows the pattern in `src/agents/subagent-registry.ts`:

- In-memory `Map` + disk persistence
- Listen to lifecycle events via `onAgentEvent`
- Restore from disk on startup

Session keys follow the pattern in `src/routing/session-key.ts`:

- Format: `agent:{agentId}:team:{teamId}:{role}-{uuid}` for teammates
- Parse via regex, expose helpers

CLI commands follow the pattern in `src/cli/program/register.subclis.ts`:

- Lazy-loaded sub-CLI entry
- Commander-based command registration

## Storage Layout

```
~/.openclaw/teams/
  {teamId}/
    config.json           -- Team metadata + teammates + coordinationMode
    tasks.json            -- Task[]
    mailbox/
      {messageId}.json    -- TeamMessage
    teammates/
      {role}/
        meta.json         -- Teammate record
    plans/
      {teammateId}.json   -- TeammatePlan (plan approval)
```

## Files Summary

### New files (21):

| Path                                          | Purpose                             | Task |
| --------------------------------------------- | ----------------------------------- | ---- |
| `src/agents/teams/types.ts`                   | All shared types                    | 01   |
| `src/agents/teams/team-registry.ts`           | In-memory team tracking + lifecycle | 04   |
| `src/agents/teams/team-registry.store.ts`     | Disk persistence for teams          | 04   |
| `src/agents/teams/task-list.ts`               | Task CRUD + deps + locking          | 05   |
| `src/agents/teams/mailbox.ts`                 | Inter-teammate messaging            | 06   |
| `src/agents/teams/system-prompt.ts`           | Lead + teammate prompts             | 07   |
| `src/agents/teams/display-tmux.ts`            | tmux pane management                | 13   |
| `src/agents/tools/team-create-tool.ts`        | team_create                         | 08   |
| `src/agents/tools/team-status-tool.ts`        | team_status                         | 08   |
| `src/agents/tools/teammate-spawn-tool.ts`     | teammate_spawn                      | 08   |
| `src/agents/tools/teammate-shutdown-tool.ts`  | teammate_shutdown                   | 08   |
| `src/agents/tools/teammate-message-tool.ts`   | teammate_message                    | 10   |
| `src/agents/tools/teammate-broadcast-tool.ts` | teammate_broadcast                  | 10   |
| `src/agents/tools/task-add-tool.ts`           | task_add                            | 09   |
| `src/agents/tools/task-claim-tool.ts`         | task_claim                          | 09   |
| `src/agents/tools/task-complete-tool.ts`      | task_complete                       | 09   |
| `src/agents/tools/task-list-tool.ts`          | task_list                           | 09   |
| `src/agents/tools/plan-submit-tool.ts`        | plan_submit                         | 11   |
| `src/agents/tools/plan-review-tool.ts`        | plan_review                         | 11   |
| `src/commands/team.ts`                        | CLI: openclaw team attach/status    | 13   |
| `src/cli/team-cli.ts`                         | CLI registration                    | 13   |

### Modified files (8):

| Path                                     | Change                              | Task |
| ---------------------------------------- | ----------------------------------- | ---- |
| `src/process/lanes.ts`                   | Add `Team = "team"`                 | 02   |
| `src/agents/lanes.ts`                    | Export `AGENT_LANE_TEAM`            | 02   |
| `src/routing/session-key.ts`             | Add team session key helpers        | 02   |
| `src/config/types.gateway.ts`            | Add `TeamsGatewayConfig` type       | 03   |
| `src/config/types.agents.ts`             | Add `teams` field on `AgentConfig`  | 03   |
| `src/config/zod-schema.agent-runtime.ts` | Zod schema for teams config         | 03   |
| `src/agents/openclaw-tools.ts`           | Register all 14 team tools          | 12   |
| `src/agents/tool-policy.ts`              | Add `group:teams`, teammate profile | 12   |

### Test files (7):

| Path                                           | Task |
| ---------------------------------------------- | ---- |
| `src/agents/teams/team-registry.test.ts`       | 14   |
| `src/agents/teams/task-list.test.ts`           | 14   |
| `src/agents/teams/mailbox.test.ts`             | 14   |
| `src/agents/tools/team-create-tool.test.ts`    | 14   |
| `src/agents/tools/teammate-spawn-tool.test.ts` | 14   |
| `src/agents/tools/task-claim-tool.test.ts`     | 14   |
| `src/agents/tools/plan-submit-tool.test.ts`    | 14   |
