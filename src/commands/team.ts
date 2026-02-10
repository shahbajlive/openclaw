import type { Team } from "../agents/teams/types.js";
import {
  attachTeamTmuxSession,
  isTmuxAvailable,
  resolveTeamTmuxSessionName,
} from "../agents/teams/display-tmux.js";
import { listTasks } from "../agents/teams/task-list.js";
import { initTeamRegistry, listActiveTeams } from "../agents/teams/team-registry.js";
import { loadConfig } from "../config/config.js";
import { renderTable, type TableColumn } from "../terminal/table.js";

/**
 * openclaw team status [--team <name>] [--json]
 * Shows team status, teammates, and task summary.
 */
export async function teamStatusCommand(options: { team?: string; json?: boolean }) {
  const cfg = loadConfig();
  if (!cfg.gateway?.teams?.enabled) {
    console.error("Teams are not enabled. Set gateway.teams.enabled: true in config.");
    process.exit(1);
  }

  initTeamRegistry();

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
      // Pretty-print using table
      printTeamStatus(team);
    }
  } else {
    // List all active teams
    const teams = listActiveTeams();
    if (teams.length === 0) {
      console.log("No active teams.");
      return;
    }
    if (options.json) {
      console.log(JSON.stringify(teams, null, 2));
    } else {
      for (const team of teams) {
        printTeamSummary(team);
      }
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

  initTeamRegistry();

  if (!(await isTmuxAvailable())) {
    console.error("tmux is not installed or not available in PATH.");
    process.exit(1);
  }

  // Find the team
  const teams = listActiveTeams();
  const team = teams.find((t) => t.teamName === options.team);
  if (!team) {
    console.error(`Team "${options.team}" not found.`);
    process.exit(1);
  }

  const prefix = cfg.gateway.teams.display?.tmux?.sessionPrefix ?? "openclaw-team";
  const sessionName = resolveTeamTmuxSessionName({
    teamName: options.team,
    prefix,
  });

  console.log(`Attaching to tmux session: ${sessionName}`);
  console.log("Press Ctrl+B then D to detach.");
  console.log();

  // Attach (this blocks the terminal)
  try {
    await attachTeamTmuxSession(sessionName);
  } catch (err) {
    console.error(`Failed to attach: ${String(err)}`);
    process.exit(1);
  }
}

function printTeamStatus(team: Team) {
  console.log(`Team: ${team.teamName} (${team.teamId})`);
  console.log(`Status: ${team.status}`);
  console.log();

  // Print teammates table
  const teammates = Object.values(team.teammates);
  if (teammates.length === 0) {
    console.log("Teammates: (none)");
  } else {
    console.log("Teammates:");
    const teammatesColumns: TableColumn[] = [
      { key: "role", header: "Role", align: "left", minWidth: 15 },
      { key: "status", header: "Status", align: "left", minWidth: 12 },
      { key: "currentTask", header: "Current Task", align: "left", minWidth: 15 },
      { key: "claimed", header: "Claimed", align: "right", minWidth: 8 },
      { key: "completed", header: "Completed", align: "right", minWidth: 10 },
    ];
    const teammatesRows = teammates.map((tm) => ({
      role: tm.role,
      status: tm.status,
      currentTask: tm.currentTask ?? "-",
      claimed: String(tm.claimedTasks),
      completed: String(tm.completedTasks),
    }));
    console.log(
      renderTable({
        columns: teammatesColumns,
        rows: teammatesRows,
        border: "unicode",
        padding: 1,
      }),
    );
  }
  console.log();

  // Print tasks table
  const { tasks, summary } = listTasks(team.teamId, { includeCompleted: true });
  console.log("Tasks:");
  console.log(
    `  Total: ${summary.total}, Pending: ${summary.pending}, In Progress: ${summary.inProgress}, Completed: ${summary.completed}, Failed: ${summary.failed}`,
  );
  console.log();

  if (tasks.length === 0) {
    console.log("  (no tasks)");
  } else {
    const tasksColumns: TableColumn[] = [
      { key: "id", header: "ID", align: "left", minWidth: 10 },
      { key: "title", header: "Title", align: "left", minWidth: 25 },
      { key: "status", header: "Status", align: "left", minWidth: 12 },
      { key: "assignee", header: "Assignee", align: "left", minWidth: 15 },
      { key: "priority", header: "Priority", align: "left", minWidth: 10 },
    ];
    const tasksRows = tasks.map((task) => ({
      id: task.taskId.slice(0, 8),
      title: task.title.length > 25 ? `${task.title.slice(0, 22)}...` : task.title,
      status: task.status,
      assignee: task.assignee ?? "-",
      priority: task.priority,
    }));
    console.log(
      renderTable({
        columns: tasksColumns,
        rows: tasksRows,
        border: "unicode",
        padding: 1,
      }),
    );
  }
}

function printTeamSummary(team: Team) {
  const teammateCount = Object.keys(team.teammates).length;
  const { summary } = listTasks(team.teamId, {});

  console.log();
}
