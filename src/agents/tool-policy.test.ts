import { describe, expect, it } from "vitest";
import { expandToolGroups, resolveToolProfilePolicy, TOOL_GROUPS } from "./tool-policy.js";

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
    expect(coding?.allow).toContain("group:fs");
    expect(resolveToolProfilePolicy("nope")).toBeUndefined();
  });

  it("includes core tool groups in group:openclaw", () => {
    const group = TOOL_GROUPS["group:openclaw"];
    expect(group).toContain("browser");
    expect(group).toContain("message");
    expect(group).toContain("session_status");
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
