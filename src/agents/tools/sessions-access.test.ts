import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  createAgentToAgentPolicy,
  createSessionVisibilityGuard,
  resolveEffectiveSessionToolsVisibility,
  resolveSandboxSessionToolsVisibility,
  resolveSandboxedSessionToolContext,
  resolveSessionToolsVisibility,
} from "./sessions-access.js";

const tempDirs: string[] = [];

async function createWorkspaceRegistry(entries: unknown[]): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sessions-access-"));
  tempDirs.push(dir);
  await fs.mkdir(path.join(dir, "clawport"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "clawport", "agents.json"),
    JSON.stringify(entries, null, 2),
    "utf8",
  );
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("resolveSessionToolsVisibility", () => {
  it("defaults to tree when unset or invalid", () => {
    expect(resolveSessionToolsVisibility({} as unknown as OpenClawConfig)).toBe("tree");
    expect(
      resolveSessionToolsVisibility({
        tools: { sessions: { visibility: "invalid" } },
      } as unknown as OpenClawConfig),
    ).toBe("tree");
  });

  it("accepts known visibility values case-insensitively", () => {
    expect(
      resolveSessionToolsVisibility({
        tools: { sessions: { visibility: "ALL" } },
      } as unknown as OpenClawConfig),
    ).toBe("all");
  });
});

describe("resolveEffectiveSessionToolsVisibility", () => {
  it("clamps to tree in sandbox when sandbox visibility is spawned", () => {
    const cfg = {
      tools: { sessions: { visibility: "all" } },
      agents: { defaults: { sandbox: { sessionToolsVisibility: "spawned" } } },
    } as unknown as OpenClawConfig;
    expect(resolveEffectiveSessionToolsVisibility({ cfg, sandboxed: true })).toBe("tree");
  });

  it("preserves visibility when sandbox clamp is all", () => {
    const cfg = {
      tools: { sessions: { visibility: "all" } },
      agents: { defaults: { sandbox: { sessionToolsVisibility: "all" } } },
    } as unknown as OpenClawConfig;
    expect(resolveEffectiveSessionToolsVisibility({ cfg, sandboxed: true })).toBe("all");
  });
});

describe("sandbox session-tools context", () => {
  it("defaults sandbox visibility clamp to spawned", () => {
    expect(resolveSandboxSessionToolsVisibility({} as unknown as OpenClawConfig)).toBe("spawned");
  });

  it("restricts non-subagent sandboxed sessions to spawned visibility", () => {
    const cfg = {
      tools: { sessions: { visibility: "all" } },
      agents: { defaults: { sandbox: { sessionToolsVisibility: "spawned" } } },
    } as unknown as OpenClawConfig;
    const context = resolveSandboxedSessionToolContext({
      cfg,
      agentSessionKey: "agent:main:main",
      sandboxed: true,
    });

    expect(context.restrictToSpawned).toBe(true);
    expect(context.requesterInternalKey).toBe("agent:main:main");
    expect(context.effectiveRequesterKey).toBe("agent:main:main");
  });

  it("does not restrict subagent sessions in sandboxed mode", () => {
    const cfg = {
      tools: { sessions: { visibility: "all" } },
      agents: { defaults: { sandbox: { sessionToolsVisibility: "spawned" } } },
    } as unknown as OpenClawConfig;
    const context = resolveSandboxedSessionToolContext({
      cfg,
      agentSessionKey: "agent:main:subagent:abc",
      sandboxed: true,
    });

    expect(context.restrictToSpawned).toBe(false);
    expect(context.requesterInternalKey).toBe("agent:main:subagent:abc");
  });
});

describe("createAgentToAgentPolicy", () => {
  it("denies cross-agent access when disabled", () => {
    const policy = createAgentToAgentPolicy({} as unknown as OpenClawConfig);
    expect(policy.enabled).toBe(false);
    expect(policy.isAllowed("main", "main")).toBe(true);
    expect(policy.isAllowed("main", "ops")).toBe(false);
  });

  it("honors allow patterns when enabled", () => {
    const policy = createAgentToAgentPolicy({
      tools: {
        agentToAgent: {
          enabled: true,
          allow: ["ops-*", "main"],
        },
      },
    } as unknown as OpenClawConfig);

    expect(policy.isAllowed("ops-a", "ops-b")).toBe(true);
    expect(policy.isAllowed("main", "ops-a")).toBe(true);
    expect(policy.isAllowed("guest", "ops-a")).toBe(false);
  });

  it("treats @teammates as a relation selector instead of a static agent id", () => {
    const policy = createAgentToAgentPolicy({
      tools: {
        agentToAgent: {
          enabled: true,
          allow: ["@teammates"],
        },
      },
    } as unknown as OpenClawConfig);

    expect(policy.usesTeammatesAllow).toBe(true);
    expect(policy.matchesAllow("developer-lead")).toBe(false);
    expect(policy.isAllowed("developer-lead", "developer-lead-backend-engineer")).toBe(false);
  });
});

describe("createSessionVisibilityGuard", () => {
  it("blocks cross-agent send when agent-to-agent is disabled", async () => {
    const guard = await createSessionVisibilityGuard({
      action: "send",
      requesterSessionKey: "agent:main:main",
      visibility: "all",
      a2aPolicy: createAgentToAgentPolicy({} as unknown as OpenClawConfig),
    });

    expect(guard.check("agent:ops:main")).toEqual({
      allowed: false,
      status: "forbidden",
      error:
        "Agent-to-agent messaging is disabled. Set tools.agentToAgent.enabled=true to allow cross-agent sends.",
    });
  });

  it("enforces self visibility for same-agent sessions", async () => {
    const guard = await createSessionVisibilityGuard({
      action: "history",
      requesterSessionKey: "agent:main:main",
      visibility: "self",
      a2aPolicy: createAgentToAgentPolicy({} as unknown as OpenClawConfig),
    });

    expect(guard.check("agent:main:main")).toEqual({ allowed: true });
    expect(guard.check("agent:main:telegram:group:1")).toEqual({
      allowed: false,
      status: "forbidden",
      error:
        "Session history visibility is restricted to the current session (tools.sessions.visibility=self).",
    });
  });

  it("allows hierarchy-derived teammate access when @teammates is configured", async () => {
    const workspaceDir = await createWorkspaceRegistry([
      {
        id: "main",
        name: "Main",
        directReports: ["developer-lead"],
      },
      {
        id: "developer-lead",
        name: "Developer Lead",
        reportsTo: "main",
        directReports: ["developer-lead-backend-engineer", "developer-lead-frontend-engineer"],
      },
      {
        id: "developer-lead-backend-engineer",
        name: "Backend Engineer",
        reportsTo: "developer-lead",
      },
      {
        id: "developer-lead-frontend-engineer",
        name: "Frontend Engineer",
        reportsTo: "developer-lead",
      },
      {
        id: "ops-lead",
        name: "Ops Lead",
      },
    ]);
    const cfg = {
      tools: {
        agentToAgent: {
          enabled: true,
          allow: ["@teammates"],
        },
      },
    } as unknown as OpenClawConfig;
    const guard = await createSessionVisibilityGuard({
      action: "send",
      requesterSessionKey: "agent:developer-lead-backend-engineer:main",
      visibility: "all",
      a2aPolicy: createAgentToAgentPolicy(cfg),
      cfg,
      workspaceDir,
    });

    expect(guard.check("agent:developer-lead:main")).toEqual({ allowed: true });
    expect(guard.check("agent:developer-lead-frontend-engineer:main")).toEqual({
      allowed: true,
    });
    expect(guard.check("agent:ops-lead:main")).toEqual({
      allowed: false,
      status: "forbidden",
      error: "Agent-to-agent messaging denied by tools.agentToAgent.allow.",
    });
  });
});
