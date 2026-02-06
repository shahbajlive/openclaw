# Task 13: Display Modes and CLI Commands

**Layer:** 3 (Integration)
**Dependencies:** Task 04 (team registry)
**Can run in parallel with:** Task 12

## What to Do

1. Create the tmux split-pane display mode for real-time team observation.
2. Add `openclaw team attach` and `openclaw team status` CLI commands.

## Files to Create

### 1. `src/agents/teams/display-tmux.ts`

Handles tmux session creation and pane management for teams.

```typescript
import { execSync, exec } from "node:child_process";
import type { Team, Teammate } from "./types.js";

/**
 * Check if tmux is installed and available.
 */
export function isTmuxAvailable(): boolean {
  try {
    execSync("tmux -V", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Create or get the tmux session for a team.
 * Session name: {prefix}-{teamName}
 */
export function ensureTeamTmuxSession(params: {
  teamName: string;
  sessionPrefix: string; // default: "openclaw-team"
}): string {
  const sessionName = `${params.sessionPrefix}-${params.teamName}`;
  // Check if session exists: tmux has-session -t {sessionName}
  // If not: tmux new-session -d -s {sessionName} -n "lead"
  return sessionName;
}

/**
 * Add a pane for a teammate in the team's tmux session.
 * Runs: openclaw agent --session-key {sessionKey} --message "{task}"
 */
export function addTeammateTmuxPane(params: {
  sessionName: string;
  role: string;
  sessionKey: string;
  task: string;
  layout: "tiled" | "even-horizontal" | "even-vertical";
}): void {
  // tmux split-window -t {sessionName} -h "openclaw agent --session-key {sessionKey} --message \"{task}\""
  // tmux select-layout -t {sessionName} {layout}
  // tmux rename-window -t {sessionName} {role} (or use pane title)
}

/**
 * Attach to a team's tmux session.
 */
export function attachTeamTmuxSession(sessionName: string): void {
  // tmux attach-session -t {sessionName}
  // This is a blocking call -- it takes over the terminal
}

/**
 * Kill a team's tmux session.
 */
export function killTeamTmuxSession(sessionName: string): void {
  // tmux kill-session -t {sessionName}
}

/**
 * List all team tmux sessions.
 */
export function listTeamTmuxSessions(prefix: string): string[] {
  // tmux list-sessions -F "#{session_name}" | grep {prefix}
  return [];
}
```

### 2. `src/commands/team.ts`

CLI command implementations for `openclaw team attach` and `openclaw team status`.

```typescript
import { loadConfig } from "../config/config.js";
import { listActiveTeams, getTeam } from "../agents/teams/team-registry.js";
import { listTasks } from "../agents/teams/task-list.js";
import { attachTeamTmuxSession, ensureTeamTmuxSession } from "../agents/teams/display-tmux.js";
// Use src/terminal/table.ts for formatted output

/**
 * openclaw team status [--team <name>] [--json]
 * Shows team status, teammates, and task summary.
 */
export async function teamStatusCommand(options: { team?: string; json?: boolean }) {
  const cfg = loadConfig();
  if (!cfg.gateway?.teams?.enabled) {
    console.error("Teams are not enabled. Set gateway.teams.enabled: true.");
    process.exit(1);
  }

  if (options.team) {
    // Show specific team status
    const teams = listActiveTeams();
    const team = teams.find((t) => t.teamName === options.team);
    if (!team) {
      console.error(`Team "${options.team}" not found.`);
      process.exit(1);
    }
    if (options.json) {
      console.log(JSON.stringify(team, null, 2));
    } else {
      // Pretty-print using table from src/terminal/table.ts
      printTeamStatus(team);
    }
  } else {
    // List all active teams
    const teams = listActiveTeams();
    if (teams.length === 0) {
      console.log("No active teams.");
      return;
    }
    for (const team of teams) {
      printTeamSummary(team);
    }
  }
}

/**
 * openclaw team attach --team <name>
 * Attaches to the team's tmux session for split-pane viewing.
 */
export async function teamAttachCommand(options: { team: string }) {
  const cfg = loadConfig();
  if (!cfg.gateway?.teams?.enabled) {
    console.error("Teams are not enabled.");
    process.exit(1);
  }

  const prefix = cfg.gateway.teams.display?.tmux?.sessionPrefix ?? "openclaw-team";
  const sessionName = `${prefix}-${options.team}`;

  // Attach (this blocks the terminal)
  attachTeamTmuxSession(sessionName);
}

function printTeamStatus(team: Team) {
  // Use terminal/table.ts to print:
  // Team: {name} ({id})
  // Mode: {coordinationMode}
  // Status: {status}
  //
  // Teammates:
  //   Role             Status    Current Task    Claimed  Completed
  //   security-reviewer active   task-001        2        1
  //   perf-analyst      idle     -               1        1
  //
  // Tasks:
  //   ID        Title                  Status     Assignee           Priority
  //   task-001  Analyze auth flow      completed  security-reviewer  high
  //   task-002  Check N+1 queries      in-progress perf-analyst      normal
}

function printTeamSummary(team: Team) {
  // One-line summary per team
}
```

### 3. `src/cli/team-cli.ts`

Register the CLI commands.

```typescript
import type { Command } from "commander";

export function registerTeamCli(program: Command) {
  const teamCmd = program.command("team").description("Agent team management");

  teamCmd
    .command("status")
    .description("Show team status and task summary")
    .option("--team <name>", "Show specific team")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
      const { teamStatusCommand } = await import("../commands/team.js");
      await teamStatusCommand(opts);
    });

  teamCmd
    .command("attach")
    .description("Attach to a team's tmux session")
    .requiredOption("--team <name>", "Team name to attach to")
    .action(async (opts) => {
      const { teamAttachCommand } = await import("../commands/team.js");
      await teamAttachCommand(opts);
    });
}
```

### 4. Register in `src/cli/program/register.subclis.ts`

Add a new entry to the `entries` array (around line 34):

```typescript
{
  name: "team",
  description: "Agent team management",
  register: async (program) => {
    const mod = await import("../team-cli.js");
    mod.registerTeamCli(program);
  },
},
```

## Integration with teammate_spawn (Task 08)

When display mode is "tmux", the `teammate_spawn` tool should call `addTeammateTmuxPane` after spawning the gateway agent run. The flow:

```
teammate_spawn is called
  -> callGateway (spawn the agent run)
  -> if display mode is "tmux":
       -> ensureTeamTmuxSession (create session if first teammate)
       -> addTeammateTmuxPane (add pane for this teammate)
```

This integration happens inside the `teammate_spawn` tool (Task 08). The display module just provides the tmux helpers.

## Reference Files

- `src/cli/program/register.subclis.ts` -- how to register a sub-CLI (lazy loaded)
- `src/cli/program/command-registry.ts` -- how main commands are registered
- `src/terminal/table.ts` -- table formatting for CLI output
- `src/commands/status.ts` -- example of a status command with JSON output
- RFC section 3.6: `agen-swarm-proposal/initial-rought-design.md` lines 589-638

## Notes

- tmux is optional -- if not installed, fall back to in-process mode with a warning.
- `tmux attach-session` takes over the terminal, so `openclaw team attach` is a blocking command.
- The `--json` flag on `openclaw team status` makes it scriptable/pasteable.
- Use `src/terminal/table.ts` for ANSI-safe table rendering in the status command.
- tmux session cleanup: when all teammates finish and the team is completed, kill the tmux session.

## Acceptance Criteria

- [ ] `openclaw team status` shows all active teams with task summaries
- [ ] `openclaw team status --team X` shows detailed team info
- [ ] `openclaw team status --json` outputs JSON
- [ ] `openclaw team attach --team X` attaches to tmux session
- [ ] tmux mode creates panes for each teammate
- [ ] tmux layout is configurable (tiled, even-horizontal, even-vertical)
- [ ] Falls back gracefully when tmux is not installed
- [ ] CLI command is lazy-loaded via register.subclis.ts
- [ ] `pnpm build` passes
