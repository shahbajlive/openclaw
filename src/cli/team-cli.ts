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
