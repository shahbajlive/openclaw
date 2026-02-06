# Task 02: Lanes and Session Keys

**Layer:** 0 (Foundation)
**Dependencies:** None
**Can run in parallel with:** Task 01, Task 03

## What to Do

1. Add a `Team` lane to the `CommandLane` enum so teammate runs get their own concurrency lane.
2. Add team session key helpers to the routing module.

## Files to Modify

### 1. `src/process/lanes.ts`

Add `Team = "team"` to the enum:

```typescript
export const enum CommandLane {
  Main = "main",
  Cron = "cron",
  Subagent = "subagent",
  Nested = "nested",
  Team = "team", // NEW
}
```

### 2. `src/agents/lanes.ts`

Export the new lane constant:

```typescript
import { CommandLane } from "../process/lanes.js";

export const AGENT_LANE_NESTED = CommandLane.Nested;
export const AGENT_LANE_SUBAGENT = CommandLane.Subagent;
export const AGENT_LANE_TEAM = CommandLane.Team; // NEW
```

### 3. `src/routing/session-key.ts`

Add three helper functions. Place them after the existing `resolveThreadSessionKeys` function (end of file, around line 249):

```typescript
// ---- Team session key helpers ----

const TEAM_KEY_RE = /^agent:([^:]+):team:([^:]+):(.+)$/;
const TEAM_LEAD_SUFFIX = "lead";

export type ParsedTeamSessionKey = {
  agentId: string;
  teamId: string;
  role: string;
  isLead: boolean;
};

/**
 * Returns true if the session key contains `:team:` segment.
 */
export function isTeamSessionKey(key: string | undefined | null): boolean {
  if (!key) return false;
  return key.includes(":team:");
}

/**
 * Parse a team session key into its components.
 * Returns null if the key is not a team session key.
 *
 * Format: agent:{agentId}:team:{teamId}:{role}
 * Lead:   agent:{agentId}:team:{teamId}:lead
 */
export function parseTeamSessionKey(key: string | undefined | null): ParsedTeamSessionKey | null {
  if (!key) return null;
  const match = TEAM_KEY_RE.exec(key.trim().toLowerCase());
  if (!match) return null;
  const [, agentId, teamId, role] = match;
  return {
    agentId,
    teamId,
    role,
    isLead: role === TEAM_LEAD_SUFFIX,
  };
}

/**
 * Build a teammate session key.
 * Format: agent:{agentId}:team:{teamId}:{role}-{uuid}
 */
export function buildTeammateSessionKey(params: {
  agentId: string;
  teamId: string;
  role: string;
}): string {
  const agentId = normalizeAgentId(params.agentId);
  const teamId = params.teamId.trim().toLowerCase();
  const roleSafe = params.role
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-");
  // Caller appends UUID to make it unique. E.g.: agent:main:team:abc123:security-reviewer-550e8400
  return `agent:${agentId}:team:${teamId}:${roleSafe}`;
}

/**
 * Build the lead session key for a team.
 * Format: agent:{agentId}:team:{teamId}:lead
 */
export function buildTeamLeadSessionKey(params: { agentId: string; teamId: string }): string {
  const agentId = normalizeAgentId(params.agentId);
  const teamId = params.teamId.trim().toLowerCase();
  return `agent:${agentId}:team:${teamId}:lead`;
}
```

Also add the new exports to the re-export block at the top of the file (line 3-8):

```typescript
export {
  isAcpSessionKey,
  isSubagentSessionKey,
  parseAgentSessionKey,
  type ParsedAgentSessionKey,
} from "../sessions/session-key-utils.js";
```

Add `isTeamSessionKey`, `parseTeamSessionKey`, `buildTeammateSessionKey`, `buildTeamLeadSessionKey` to the file's own exports (they're already top-level, so just make sure they're exported with `export function`).

## Reference Files

- Current lanes: `src/process/lanes.ts` (7 lines)
- Current lane exports: `src/agents/lanes.ts` (4 lines)
- Session key utils: `src/routing/session-key.ts` (250 lines)
- How subagent session keys work: in `sessions-spawn-tool.ts` line 168: `agent:${targetAgentId}:subagent:${crypto.randomUUID()}`

## Notes

- The `Team` lane lets teammate runs execute in parallel without blocking the main agent queue or the subagent lane. The gateway command queue already respects lanes (see `src/process/command-queue.ts`).
- Session key format for teammates: `agent:{agentId}:team:{teamId}:{role}-{uuid}`. The UUID part will be appended by the `teammate_spawn` tool (Task 08) using `crypto.randomUUID()`.
- The `buildTeammateSessionKey` returns the base key without UUID -- the caller appends `-{uuid}` to make it unique.

## Acceptance Criteria

- [ ] `CommandLane.Team` resolves to `"team"`
- [ ] `AGENT_LANE_TEAM` is exported from `src/agents/lanes.ts`
- [ ] `isTeamSessionKey("agent:main:team:abc:lead")` returns `true`
- [ ] `isTeamSessionKey("agent:main:subagent:xyz")` returns `false`
- [ ] `parseTeamSessionKey("agent:main:team:abc:lead")` returns `{ agentId: "main", teamId: "abc", role: "lead", isLead: true }`
- [ ] `parseTeamSessionKey("agent:main:team:abc:reviewer-uuid")` returns `{ agentId: "main", teamId: "abc", role: "reviewer-uuid", isLead: false }`
- [ ] `buildTeammateSessionKey({ agentId: "main", teamId: "abc", role: "security-reviewer" })` returns `"agent:main:team:abc:security-reviewer"`
- [ ] `pnpm build` passes
- [ ] Existing tests in `src/routing/` still pass
