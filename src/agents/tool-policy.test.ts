import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { isToolAllowed, resolveSandboxToolPolicyForAgent } from "./sandbox/tool-policy.js";
import type { SandboxToolPolicy } from "./sandbox/types.js";
import { TOOL_POLICY_CONFORMANCE } from "./tool-policy.conformance.js";
import {
  applyOwnerOnlyToolPolicy,
  expandToolGroups,
  isOwnerOnlyToolName,
  normalizeToolName,
  resolveToolProfilePolicy,
  TOOL_GROUPS,
} from "./tool-policy.js";
import type { AnyAgentTool } from "./tools/common.js";

function createOwnerPolicyTools() {
  return [
    {
      name: "read",
      // oxlint-disable-next-line typescript/no-explicit-any
      execute: async () => ({ content: [], details: {} }) as any,
    },
    {
      name: "cron",
      ownerOnly: true,
      // oxlint-disable-next-line typescript/no-explicit-any
      execute: async () => ({ content: [], details: {} }) as any,
    },
    {
      name: "gateway",
      ownerOnly: true,
      // oxlint-disable-next-line typescript/no-explicit-any
      execute: async () => ({ content: [], details: {} }) as any,
    },
    {
      name: "whatsapp_login",
      // oxlint-disable-next-line typescript/no-explicit-any
      execute: async () => ({ content: [], details: {} }) as any,
    },
  ] as unknown as AnyAgentTool[];
}

describe("tool-policy", () => {
  it("expands groups and normalizes aliases", () => {
    const expanded = expandToolGroups(["group:runtime", "BASH", "apply-patch", "group:fs"]);
    const set = new Set(expanded);
    expect(set.has("exec")).toBe(true);
    expect(set.has("process")).toBe(true);
    expect(set.has("bash")).toBe(false);
    expect(set.has("apply_patch")).toBe(true);
    expect(set.has("read")).toBe(true);
    expect(set.has("write")).toBe(true);
    expect(set.has("edit")).toBe(true);
  });

  it("resolves known profiles and ignores unknown ones", () => {
    const coding = resolveToolProfilePolicy("coding");
    expect(coding?.allow).toContain("read");
    expect(coding?.allow).toContain("cron");
    expect(coding?.allow).not.toContain("gateway");
    expect(resolveToolProfilePolicy("nope")).toBeUndefined();
  });

  it("includes core tool groups in group:openclaw", () => {
    const group = TOOL_GROUPS["group:openclaw"];
    expect(group).toContain("browser");
    expect(group).toContain("message");
    expect(group).toContain("subagents");
    expect(group).toContain("session_status");
    expect(group).toContain("tts");
  });

  it("normalizes tool names and aliases", () => {
    expect(normalizeToolName(" BASH ")).toBe("exec");
    expect(normalizeToolName("apply-patch")).toBe("apply_patch");
    expect(normalizeToolName("READ")).toBe("read");
  });

  it("identifies owner-only tools", () => {
    expect(isOwnerOnlyToolName("whatsapp_login")).toBe(true);
    expect(isOwnerOnlyToolName("cron")).toBe(true);
    expect(isOwnerOnlyToolName("gateway")).toBe(true);
    expect(isOwnerOnlyToolName("read")).toBe(false);
  });

  it("strips owner-only tools for non-owner senders", async () => {
    const tools = createOwnerPolicyTools();
    const filtered = applyOwnerOnlyToolPolicy(tools, false);
    expect(filtered.map((t) => t.name)).toEqual(["read"]);
  });

  it("keeps owner-only tools for the owner sender", async () => {
    const tools = createOwnerPolicyTools();
    const filtered = applyOwnerOnlyToolPolicy(tools, true);
    expect(filtered.map((t) => t.name)).toEqual(["read", "cron", "gateway", "whatsapp_login"]);
  });

  it("honors ownerOnly metadata for custom tool names", async () => {
    const tools = [
      {
        name: "custom_admin_tool",
        ownerOnly: true,
        // oxlint-disable-next-line typescript/no-explicit-any
        execute: async () => ({ content: [], details: {} }) as any,
      },
    ] as unknown as AnyAgentTool[];
    expect(applyOwnerOnlyToolPolicy(tools, false)).toEqual([]);
    expect(applyOwnerOnlyToolPolicy(tools, true)).toHaveLength(1);
  });
});

describe("TOOL_POLICY_CONFORMANCE", () => {
  it("matches exported TOOL_GROUPS exactly", () => {
    expect(TOOL_POLICY_CONFORMANCE.toolGroups).toEqual(TOOL_GROUPS);
  });

  it("is JSON-serializable", () => {
    expect(() => JSON.stringify(TOOL_POLICY_CONFORMANCE)).not.toThrow();
  });
});

describe("sandbox tool policy", () => {
  it("allows all tools with * allow", () => {
    const policy: SandboxToolPolicy = { allow: ["*"], deny: [] };
    expect(isToolAllowed(policy, "browser")).toBe(true);
  });

  it("denies all tools with * deny", () => {
    const policy: SandboxToolPolicy = { allow: [], deny: ["*"] };
    expect(isToolAllowed(policy, "read")).toBe(false);
  });

  it("supports wildcard patterns", () => {
    const policy: SandboxToolPolicy = { allow: ["web_*"] };
    expect(isToolAllowed(policy, "web_fetch")).toBe(true);
    expect(isToolAllowed(policy, "read")).toBe(false);
  });

  it("applies deny before allow", () => {
    const policy: SandboxToolPolicy = { allow: ["*"], deny: ["web_*"] };
    expect(isToolAllowed(policy, "web_fetch")).toBe(false);
    expect(isToolAllowed(policy, "read")).toBe(true);
  });

  it("treats empty allowlist as allow-all (with deny exceptions)", () => {
    const policy: SandboxToolPolicy = { allow: [], deny: ["web_*"] };
    expect(isToolAllowed(policy, "web_fetch")).toBe(false);
    expect(isToolAllowed(policy, "read")).toBe(true);
  });

  it("expands tool groups + aliases in patterns", () => {
    const policy: SandboxToolPolicy = {
      allow: ["group:fs", "BASH"],
      deny: ["apply_*"],
    };
    expect(isToolAllowed(policy, "read")).toBe(true);
    expect(isToolAllowed(policy, "exec")).toBe(true);
    expect(isToolAllowed(policy, "apply_patch")).toBe(false);
  });

  it("normalizes whitespace + case", () => {
    const policy: SandboxToolPolicy = { allow: [" WEB_* "] };
    expect(isToolAllowed(policy, "WEB_FETCH")).toBe(true);
  });
});

describe("resolveSandboxToolPolicyForAgent", () => {
  it("keeps allow-all semantics when allow is []", () => {
    const cfg = {
      tools: { sandbox: { tools: { allow: [], deny: ["browser"] } } },
    } as unknown as OpenClawConfig;

    const resolved = resolveSandboxToolPolicyForAgent(cfg, undefined);
    expect(resolved.sources.allow).toEqual({
      source: "global",
      key: "tools.sandbox.tools.allow",
    });
    expect(resolved.allow).toEqual([]);
    expect(resolved.deny).toEqual(["browser"]);

    const policy: SandboxToolPolicy = { allow: resolved.allow, deny: resolved.deny };
    expect(isToolAllowed(policy, "read")).toBe(true);
    expect(isToolAllowed(policy, "browser")).toBe(false);
  });

  it("auto-adds image to explicit allowlists unless denied", () => {
    const cfg = {
      tools: { sandbox: { tools: { allow: ["read"], deny: ["browser"] } } },
    } as unknown as OpenClawConfig;

    const resolved = resolveSandboxToolPolicyForAgent(cfg, undefined);
    expect(resolved.allow).toEqual(["read", "image"]);
    expect(resolved.deny).toEqual(["browser"]);
  });

  it("does not auto-add image when explicitly denied", () => {
    const cfg = {
      tools: { sandbox: { tools: { allow: ["read"], deny: ["image"] } } },
    } as unknown as OpenClawConfig;

    const resolved = resolveSandboxToolPolicyForAgent(cfg, undefined);
    expect(resolved.allow).toEqual(["read"]);
    expect(resolved.deny).toEqual(["image"]);
  });

  it("includes team tools in group:teams", () => {
    const group = TOOL_GROUPS["group:teams"];
    expect(group).toContain("team_create");
    expect(group).toContain("task_plan");
    expect(group).toContain("task_submit");
    expect(group).toContain("ask_question");
    expect(group).toContain("taskSearch");
  });

  it("includes team tools in group:openclaw", () => {
    const group = TOOL_GROUPS["group:openclaw"];
    expect(group).toContain("team_create");
    expect(group).toContain("task_plan");
    expect(group).toContain("task_submit");
    expect(group).toContain("ask_question");
    expect(group).toContain("taskSearch");
  });

  it("teammate profile allows task tools and denies lead tools", () => {
    const profile = resolveToolProfilePolicy("teammate");
    expect(profile).toBeDefined();
    expect(profile?.allow).toContain("task_submit");
    expect(profile?.allow).toContain("ask_question");
    expect(profile?.allow).toContain("task_plan");
    expect(profile?.allow).toContain("taskSearch");
    expect(profile?.deny).toContain("team_create");
  });

  it("teammate profile denies automation and messaging", () => {
    const profile = resolveToolProfilePolicy("teammate");
    expect(profile?.deny).toContain("group:automation");
    expect(profile?.deny).toContain("group:messaging");
  });

  it("teammate profile allows file system and runtime tools", () => {
    const profile = resolveToolProfilePolicy("teammate");
    expect(profile?.allow).toContain("group:fs");
    expect(profile?.allow).toContain("group:runtime");
    expect(profile?.allow).toContain("group:memory");
    expect(profile?.allow).toContain("group:web");
  });

  it("expands group:teams correctly", () => {
    const expanded = expandToolGroups(["group:teams"]);
    const set = new Set(expanded);
    expect(set.has("team_create")).toBe(true);
    expect(set.has("task_plan")).toBe(true);
    expect(set.has("task_submit")).toBe(true);
    expect(set.has("ask_question")).toBe(true);
    expect(set.has("taskSearch")).toBe(true);
  });
});
