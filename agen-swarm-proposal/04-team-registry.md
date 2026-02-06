# Task 04: Team Registry and Disk Persistence

**Layer:** 1 (Infrastructure)
**Dependencies:** Task 01 (types), Task 02 (lanes + session keys), Task 03 (config)
**Can run in parallel with:** Task 05, Task 06, Task 07

## What to Do

Create the team registry -- an in-memory tracker for active teams with disk persistence. This is the central data structure that all team tools read/write from.

## Pattern to Follow

Model directly after `src/agents/subagent-registry.ts` (430 lines) + `src/agents/subagent-registry.store.ts`. The subagent registry:

- Keeps an in-memory `Map<string, SubagentRunRecord>`
- Persists to disk on every mutation via `saveSubagentRegistryToDisk()`
- Restores from disk on startup via `loadSubagentRegistryFromDisk()`
- Listens to agent lifecycle events via `onAgentEvent()` to track when runs start/finish
- Has a sweeper interval for cleanup

## Files to Create

### 1. `src/agents/teams/team-registry.store.ts`

Disk I/O layer. Reads/writes team data from `~/.openclaw/teams/{teamId}/`.

```typescript
// Key functions:
export function saveTeamToDisk(team: Team): void;
// Write config.json to ~/.openclaw/teams/{teamId}/config.json
// Serialize Team object to JSON (convert teammates Record to JSON-safe format)

export function loadTeamFromDisk(teamId: string): Team | null;
// Read config.json, return null if missing/corrupt

export function loadAllTeamsFromDisk(): Map<string, Team>;
// Scan ~/.openclaw/teams/ directory for team dirs, load each config.json

export function deleteTeamFromDisk(teamId: string): void;
// Remove entire ~/.openclaw/teams/{teamId}/ directory

export function resolveTeamBasePath(cfg?: OpenClawConfig): string;
// Return cfg.gateway?.teams?.storage?.basePath or "~/.openclaw/teams"
// Expand ~ to homedir
```

Use `fs.mkdirSync(dir, { recursive: true })` for directory creation.
Use `JSON.stringify(data, null, 2)` for human-readable JSON.
Wrap all reads in try/catch -- return null/empty on corrupt files (same pattern as subagent-registry.store.ts).

### 2. `src/agents/teams/team-registry.ts`

In-memory registry + lifecycle management.

```typescript
// In-memory state:
const activeTeams = new Map<string, Team>();
let listenerStarted = false;
let restoreAttempted = false;

// Key functions:
export function createTeam(params: {
  teamName: string;
  description?: string;
  leadSessionKey: string;
  coordinationMode: CoordinationMode;
  maxTeammates: number;
  config: TeamConfig;
}): Team;
// Generate UUID teamId, build Team object, save to Map + disk
// Return created Team

export function getTeam(teamId: string): Team | null;
// Lookup from activeTeams map

export function listActiveTeams(): Team[];
// Return all teams with status === "active"

export function addTeammate(teamId: string, teammate: Teammate): void;
// Add to team's teammates record, persist

export function removeTeammate(teamId: string, teammateId: string): void;
// Remove from teammates record, persist

export function updateTeammateStatus(
  teamId: string,
  teammateId: string,
  status: TeammateStatus,
): void;
// Update teammate status, persist

export function updateTeamStatus(teamId: string, status: TeamStatus): void;
// Update team status, persist

export function getTeammateBySessionKey(teamId: string, sessionKey: string): Teammate | null;
// Find teammate in team by session key

export function isTeamLead(teamId: string, sessionKey: string): boolean;
// Check if sessionKey matches team.leadSessionKey

export function resolveCallerTeamContext(
  sessionKey: string,
): { team: Team; isLead: boolean; teammate?: Teammate } | null;
// Given any session key, find if it belongs to a team and what role it plays
// Scans all active teams

export function initTeamRegistry(): void;
// Call restoreTeamsOnce() -- load from disk, mark active teammates as "interrupted"
// Start lifecycle listener via ensureListener()

// Internal:
function persistTeam(team: Team): void;
// Save to disk via team-registry.store.ts

function ensureListener(): void;
// Subscribe to onAgentEvent() from src/infra/agent-events.ts
// On lifecycle "start": update teammate status to "active"
// On lifecycle "end"/"error": update teammate status to "completed"/"failed"
// Persist on each change

function restoreTeamsOnce(): void;
// Load all teams from disk
// For active teams, mark any teammate still in "spawning"/"active" as "interrupted"
// Matches graceful degradation per RFC section 7.4

export function resetTeamRegistryForTests(): void;
// Clear maps, reset flags (for test isolation)
```

## Reference Files

- `src/agents/subagent-registry.ts` -- the main pattern to follow (430 lines)
- `src/agents/subagent-registry.store.ts` -- disk I/O pattern
- `src/infra/agent-events.ts` -- `onAgentEvent()` for lifecycle listening
- `src/config/config.ts` -- `loadConfig()` for resolving config values

## How Lifecycle Events Work

From `src/infra/agent-events.ts`:

- `onAgentEvent(callback)` subscribes to all agent lifecycle events
- Events have `{ runId, stream, data }` where `stream === "lifecycle"` for lifecycle
- `data.phase === "start"` when an agent run starts
- `data.phase === "end"` or `"error"` when it finishes/fails
- The `runId` from the event matches the `runId` from `callGateway`

The team registry needs to maintain a mapping from `runId -> { teamId, teammateId }` so when lifecycle events fire, it can update the right teammate's status.

## Storage Structure

```
~/.openclaw/teams/
  {teamId}/
    config.json   -- Full Team object serialized as JSON
    teammates/
      {role}/
        meta.json  -- Teammate metadata (optional, for quick lookups)
```

The `tasks.json`, `mailbox/`, and `plans/` subdirectories are managed by Task 05, 06, and 11 respectively. The registry only manages `config.json` and `teammates/`.

## Acceptance Criteria

- [ ] `createTeam()` generates a UUID teamId and persists to `~/.openclaw/teams/{teamId}/config.json`
- [ ] `getTeam()` returns the team from memory (fast path)
- [ ] `addTeammate()` adds to the team's teammates and persists
- [ ] `updateTeammateStatus()` changes teammate status and persists
- [ ] `initTeamRegistry()` loads teams from disk on startup
- [ ] On gateway restart, active teammates are marked as "interrupted"
- [ ] Lifecycle events update teammate status (spawning -> active -> completed/failed)
- [ ] `resolveCallerTeamContext()` correctly identifies lead vs teammate
- [ ] `pnpm build` passes
