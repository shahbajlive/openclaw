import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  installGatewayTestHooks,
  startGatewayServer,
  getFreePort,
} from "../../gateway/test-helpers.js";
import { resolveTeamTmuxSessionName } from "./display-tmux.js";
import { getTeam } from "./team-registry.js";
import { createTeamBroadcastAnswerTool } from "./tools/team-broadcast-answer-tool.js";
import { createTeamCleanupTool } from "./tools/team-cleanup-tool.js";
import { createTeamCreateTool } from "./tools/team-create-tool.js";
import { createTeammateShutdownTool } from "./tools/teammate-shutdown-tool.js";
import { createTeammateSpawnTool } from "./tools/teammate-spawn-tool.js";

const execFileAsync = promisify(execFile);

async function tmuxExists(): Promise<boolean> {
  try {
    await execFileAsync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function tmux(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("tmux", args, { encoding: "utf-8" });
  return stdout.trim();
}

async function hasTmuxSession(session: string): Promise<boolean> {
  try {
    await tmux(["has-session", "-t", session]);
    return true;
  } catch {
    return false;
  }
}

async function listPaneIds(session: string): Promise<string[]> {
  const out = await tmux(["list-panes", "-t", session, "-F", "#{pane_id}"]);
  return out.split("\n").filter(Boolean);
}

installGatewayTestHooks({ scope: "suite" });

describe("teams tmux e2e", () => {
  it("creates team, spawns tmux panes, broadcasts answer, cleans up", async () => {
    if (!(await tmuxExists())) {
      return;
    }

    const { writeConfigFile } = await import("../../config/config.js");
    await writeConfigFile({
      gateway: {
        teams: {
          enabled: true,
          display: {
            mode: "tmux",
            tmux: { sessionPrefix: "openclaw-team-e2e" },
          },
          bootstrapMode: "minimal",
          heartbeatMode: "none",
        },
      },
      tools: {
        agentToAgent: { enabled: true, allow: ["*"] },
      },
    });

    const port = await getFreePort();
    const server = await startGatewayServer(port);
    const cliPath = path.join(process.cwd(), "openclaw.mjs");
    const sessionPrefix = "openclaw-team-e2e";
    let sessionName: string | undefined;

    try {
      process.env.OPENCLAW_GATEWAY_PORT = String(port);
      process.env.OPENCLAW_CLI_PATH = cliPath;

      await tmux(["set-environment", "-g", "OPENCLAW_GATEWAY_PORT", String(port)]);
      await tmux(["set-environment", "-g", "OPENCLAW_CLI_PATH", cliPath]);

      const teamCreate = createTeamCreateTool({ agentSessionKey: "agent:main:main" });
      const created = await teamCreate.execute("call-e2e", {
        teamName: "e2e-team",
        tasks: ["first task"],
        persistent: false,
        waitFor: "none",
      });

      const createdDetails = (created as { details?: Record<string, unknown> }).details ?? {};
      if (createdDetails.status !== "created") {
        const error = typeof createdDetails.error === "string" ? createdDetails.error : "unknown";
        throw new Error(`team_create failed: ${error}`);
      }
      const teamId = String(createdDetails.teamId ?? "");
      expect(teamId).toBeTruthy();

      const team = getTeam(teamId);
      expect(team).toBeTruthy();
      const leadSessionKey = team?.leadSessionKey ?? "";
      expect(leadSessionKey).toContain("agent:team-");

      const spawn = createTeammateSpawnTool({ agentSessionKey: leadSessionKey });
      const spawnResult = await spawn.execute("call-e2e-spawn", {
        teamId,
        role: "reviewer",
        task: "Review e2e",
      });
      const spawnDetails = (spawnResult as { details?: Record<string, unknown> }).details ?? {};
      expect(spawnDetails.status).toBe("spawned");
      const teammateId = typeof spawnDetails.teammateId === "string" ? spawnDetails.teammateId : "";
      expect(teammateId).toBeTruthy();

      const resolvedSessionName = resolveTeamTmuxSessionName({
        teamName: team?.teamName ?? "e2e-team",
        prefix: sessionPrefix,
      });
      sessionName = resolvedSessionName;

      const paneDeadline = Date.now() + 15_000;
      let paneIds: string[] = [];
      while (Date.now() < paneDeadline) {
        if (await hasTmuxSession(resolvedSessionName)) {
          try {
            paneIds = await listPaneIds(resolvedSessionName);
            if (paneIds.length >= 2) {
              break;
            }
          } catch {
            // keep waiting
          }
        }
        await new Promise((r) => setTimeout(r, 250));
      }

      expect(paneIds.length).toBeGreaterThanOrEqual(2);

      const broadcast = createTeamBroadcastAnswerTool({ agentSessionKey: leadSessionKey });
      const broadcastResult = await broadcast.execute("call-e2e-broadcast", {
        teamId,
        message: "All done",
      });
      const broadcastDetails =
        (broadcastResult as { details?: Record<string, unknown> }).details ?? {};
      expect(broadcastDetails.status).toBe("broadcasted");

      const shutdown = createTeammateShutdownTool({ agentSessionKey: leadSessionKey });
      const shutdownResult = await shutdown.execute("call-e2e-shutdown", {
        teamId,
        teammateId,
        reason: "e2e cleanup",
        force: true,
      });
      const shutdownDetails =
        (shutdownResult as { details?: Record<string, unknown> }).details ?? {};
      expect(shutdownDetails.status).toBe("terminated");

      const cleanup = createTeamCleanupTool({ agentSessionKey: leadSessionKey });
      const cleanupResult = await cleanup.execute("call-e2e-cleanup", {
        teamId,
        confirm: true,
      });
      const cleanupDetails = (cleanupResult as { details?: Record<string, unknown> }).details ?? {};
      expect(cleanupDetails.status).toBe("cleaned");

      const goneDeadline = Date.now() + 5_000;
      let exists = true;
      while (Date.now() < goneDeadline) {
        exists = await hasTmuxSession(resolvedSessionName);
        if (!exists) {
          break;
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(exists).toBe(false);
    } finally {
      if (sessionName) {
        try {
          await tmux(["kill-session", "-t", sessionName]);
        } catch {
          // ignore
        }
      }
      await server.close();
    }
  }, 90_000);
});
