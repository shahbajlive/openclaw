import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.js";
import { loadConfig } from "../../config/config.js";
import { GatewayClient } from "../../gateway/client.js";
import { startGatewayServer } from "../../gateway/server.js";
import { getFreePort } from "../../gateway/test-helpers.server.js";
import { isTruthyEnvValue } from "../../infra/env.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../utils/message-channel.js";
import { listTasks } from "./task-list.js";
import { getTeam, listCreatorTeams } from "./team-registry.js";
import { createTeamCleanupTool } from "./tools/index.js";

type TeamExample = {
  name: string;
  prompt: string;
};

const LIVE =
  isTruthyEnvValue(process.env.OPENCLAW_LIVE_TEAM_TEST) ||
  isTruthyEnvValue(process.env.LIVE) ||
  isTruthyEnvValue(process.env.OPENCLAW_LIVE_TEST);
const describeLive = LIVE ? describe : describe.skip;
const DEFAULT_TIMEOUT_MS = (() => {
  const raw = Number(process.env.OPENCLAW_LIVE_TEAM_TIMEOUT_MS);
  return Number.isFinite(raw) ? raw : 180_000;
})();

async function connectClient(params: { url: string; token: string }) {
  return await new Promise<GatewayClient>((resolve, reject) => {
    let settled = false;
    const stop = (err?: Error, client?: GatewayClient) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (err) {
        reject(err);
      } else {
        resolve(client as GatewayClient);
      }
    };
    const client = new GatewayClient({
      url: params.url,
      token: params.token,
      clientName: GATEWAY_CLIENT_NAMES.TEST,
      clientVersion: "dev",
      mode: GATEWAY_CLIENT_MODES.TEST,
      onHelloOk: () => stop(undefined, client),
      onConnectError: (err) => stop(err),
      onClose: (code, reason) =>
        stop(new Error(`gateway closed during connect (${code}): ${reason}`)),
    });
    const timer = setTimeout(() => stop(new Error("gateway connect timeout")), 10_000);
    timer.unref();
    client.start();
  });
}

function parseTeamExamples(text: string): TeamExample[] {
  const sections = text.split(/\n## /);
  const examples: TeamExample[] = [];
  for (let i = 1; i < sections.length; i += 1) {
    const chunk = sections[i] ?? "";
    const [titleLine, ...rest] = chunk.split("\n");
    const name = (titleLine ?? "").trim();
    if (!name) {
      continue;
    }
    const body = rest.join("\n");
    const match = body.match(/Prompt:\s*```([\s\S]*?)```/);
    if (!match) {
      continue;
    }
    const prompt = match[1]?.trim();
    if (!prompt) {
      continue;
    }
    examples.push({ name, prompt });
  }
  return examples;
}

async function loadTeamExamples(): Promise<TeamExample[]> {
  const filePath = path.join(process.cwd(), "team-examples.md");
  const raw = await fsp.readFile(filePath, "utf-8");
  return parseTeamExamples(raw);
}

function filterExamples(examples: TeamExample[]): TeamExample[] {
  const raw = process.env.OPENCLAW_LIVE_TEAM_CASES?.trim();
  if (!raw) {
    return examples;
  }
  const allow = new Set(
    raw
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  );
  return examples.filter((example) => allow.has(example.name.toLowerCase()));
}

async function waitForTeamCreated(params: {
  creatorSessionKey: string;
  sinceMs: number;
  timeoutMs: number;
}) {
  const deadline = Date.now() + params.timeoutMs;
  while (Date.now() < deadline) {
    const teams = listCreatorTeams(params.creatorSessionKey).filter(
      (team) => team.createdAt >= params.sinceMs,
    );
    if (teams.length > 0) {
      return teams[0];
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

async function waitForTeamIdle(params: { teamId: string; timeoutMs: number }) {
  const deadline = Date.now() + params.timeoutMs;
  while (Date.now() < deadline) {
    const team = getTeam(params.teamId);
    if (!team) {
      return { ok: false, reason: "team missing" };
    }
    let summary;
    try {
      ({ summary } = listTasks(params.teamId, { includeCompleted: true }));
    } catch {
      return { ok: false, reason: "task list unavailable" };
    }
    const busy = Object.values(team.teammates).filter(
      (tm) => tm.status === "working" || tm.status === "init",
    );
    const hasIncomplete = summary.pending > 0 || summary.blocked > 0 || summary.inProgress > 0;
    if (busy.length === 0 && !hasIncomplete) {
      return { ok: true };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return { ok: false, reason: "timeout" };
}

const examplesAtLoad = (() => {
  try {
    const fileUrl = new URL("../../../team-examples.md", import.meta.url);
    const raw = fs.readFileSync(fileUrl, "utf-8");
    return parseTeamExamples(raw);
  } catch {
    return [] as TeamExample[];
  }
})();

const examplesAtLoadFiltered = filterExamples(examplesAtLoad);
const describeCases = examplesAtLoadFiltered.length > 0 ? describeLive : describe.skip;

describeCases("team orchestration (live)", () => {
  let client: GatewayClient | undefined;
  let server: Awaited<ReturnType<typeof startGatewayServer>> | undefined;
  let examples: TeamExample[] = [];
  const previousEnv = {
    configPath: process.env.OPENCLAW_CONFIG_PATH,
    stateDir: process.env.OPENCLAW_STATE_DIR,
    skipChannels: process.env.OPENCLAW_SKIP_CHANNELS,
    skipGmail: process.env.OPENCLAW_SKIP_GMAIL_WATCHER,
    skipCron: process.env.OPENCLAW_SKIP_CRON,
    skipCanvas: process.env.OPENCLAW_SKIP_CANVAS_HOST,
    skipBrowser: process.env.OPENCLAW_SKIP_BROWSER_CONTROL_SERVER,
  };

  beforeAll(async () => {
    examples =
      examplesAtLoadFiltered.length > 0 ? examplesAtLoadFiltered : await loadTeamExamples();
    if (examples.length === 0) {
      throw new Error("No team examples found to run.");
    }

    process.env.OPENCLAW_SKIP_CHANNELS = "1";
    process.env.OPENCLAW_SKIP_GMAIL_WATCHER = "1";
    process.env.OPENCLAW_SKIP_CRON = "1";
    process.env.OPENCLAW_SKIP_CANVAS_HOST = "1";
    process.env.OPENCLAW_SKIP_BROWSER_CONTROL_SERVER = "1";

    const cfg = loadConfig();
    const nextCfg: OpenClawConfig = {
      ...cfg,
      gateway: {
        ...cfg.gateway,
        teams: {
          ...cfg.gateway?.teams,
          enabled: true,
          display: { mode: "inline" },
          bootstrapMode: "minimal",
          heartbeatMode: "none",
        },
      },
      tools: {
        ...cfg.tools,
        agentToAgent: { enabled: true, allow: ["*"] },
      },
    };

    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-live-team-"));
    const tempConfigPath = path.join(tempDir, "openclaw.json");
    await fsp.writeFile(tempConfigPath, `${JSON.stringify(nextCfg, null, 2)}\n`);
    process.env.OPENCLAW_CONFIG_PATH = tempConfigPath;

    const port = await getFreePort();
    const token = `live-team-${randomUUID()}`;
    server = await startGatewayServer(port, {
      bind: "loopback",
      auth: { mode: "token", token },
      controlUiEnabled: false,
    });
    client = await connectClient({ url: `ws://127.0.0.1:${port}`, token });
  }, 60_000);

  afterAll(async () => {
    client?.stop();
    await server?.close();
    process.env.OPENCLAW_CONFIG_PATH = previousEnv.configPath;
    process.env.OPENCLAW_STATE_DIR = previousEnv.stateDir;
    process.env.OPENCLAW_SKIP_CHANNELS = previousEnv.skipChannels;
    process.env.OPENCLAW_SKIP_GMAIL_WATCHER = previousEnv.skipGmail;
    process.env.OPENCLAW_SKIP_CRON = previousEnv.skipCron;
    process.env.OPENCLAW_SKIP_CANVAS_HOST = previousEnv.skipCanvas;
    process.env.OPENCLAW_SKIP_BROWSER_CONTROL_SERVER = previousEnv.skipBrowser;
  });

  for (const example of examplesAtLoadFiltered) {
    it(
      example.name,
      async () => {
        if (!client) {
          throw new Error("gateway client not initialized");
        }
        const sessionKey = `agent:main:live-team-${randomUUID().slice(0, 8)}`;
        const startedAt = Date.now();
        const runId = randomUUID();
        const payload = await client.request(
          "agent",
          {
            sessionKey,
            idempotencyKey: `idem-${runId}`,
            message: example.prompt,
            deliver: false,
          },
          { expectFinal: true },
        );
        if (payload?.status !== "ok") {
          throw new Error(`agent status=${String(payload?.status)}`);
        }

        const team = await waitForTeamCreated({
          creatorSessionKey: sessionKey,
          sinceMs: startedAt,
          timeoutMs: 20_000,
        });
        expect(team).toBeTruthy();
        if (!team) {
          return;
        }

        const idleResult = await waitForTeamIdle({
          teamId: team.teamId,
          timeoutMs: DEFAULT_TIMEOUT_MS,
        });
        if (!idleResult.ok) {
          const { summary } = listTasks(team.teamId, { includeCompleted: true });
          throw new Error(
            `team did not reach idle (${idleResult.reason}) pending=${summary.pending} blocked=${summary.blocked} inProgress=${summary.inProgress}`,
          );
        }

        const cleanupTool = createTeamCleanupTool({ agentSessionKey: sessionKey });
        await cleanupTool.execute("live-cleanup", {
          teamId: team.teamId,
          confirm: true,
        });
      },
      DEFAULT_TIMEOUT_MS + 60_000,
    );
  }
});
