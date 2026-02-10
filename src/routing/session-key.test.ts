import { describe, expect, it } from "vitest";
import {
  isTeamSessionKey,
  parseTeamSessionKey,
  buildTeammateSessionKey,
  buildTeamLeadSessionKey,
} from "./session-key.js";

describe("session-key", () => {
  describe("team session keys", () => {
    it("isTeamSessionKey recognizes team keys", () => {
      expect(isTeamSessionKey("agent:team-abc:lead")).toBe(true);
      expect(isTeamSessionKey("agent:team-abc:teammate:reviewer-uuid")).toBe(true);
      expect(isTeamSessionKey("agent:main:subagent:xyz")).toBe(false);
      expect(isTeamSessionKey("agent:main:main")).toBe(false);
    });

    it("parseTeamSessionKey extracts components", () => {
      const parsed = parseTeamSessionKey("agent:team-abc123:teammate:security-reviewer-uuid");
      expect(parsed).toEqual({
        agentId: "team-abc123",
        teamId: "abc123",
        role: "security-reviewer-uuid",
        isLead: false,
        teammateId: "security-reviewer-uuid",
      });
    });

    it("parseTeamSessionKey identifies lead", () => {
      const parsed = parseTeamSessionKey("agent:team-abc123:lead");
      expect(parsed?.isLead).toBe(true);
      expect(parsed?.role).toBe("lead");
    });

    it("parseTeamSessionKey returns null for non-team keys", () => {
      expect(parseTeamSessionKey("agent:main:main")).toBeNull();
      expect(parseTeamSessionKey("agent:main:subagent:xyz")).toBeNull();
      expect(parseTeamSessionKey("invalid")).toBeNull();
    });

    it("buildTeammateSessionKey produces correct format", () => {
      const key = buildTeammateSessionKey({
        teamAgentId: "team-abc",
        role: "reviewer",
      });
      expect(key).toBe("agent:team-abc:teammate:reviewer");
    });

    it("buildTeammateSessionKey sanitizes role", () => {
      const key = buildTeammateSessionKey({
        teamAgentId: "team-abc",
        role: "Security Reviewer!",
      });
      expect(key).toBe("agent:team-abc:teammate:security-reviewer-");
    });

    it("buildTeammateSessionKey normalizes agentId", () => {
      const key = buildTeammateSessionKey({
        teamAgentId: "MyAgent",
        role: "reviewer",
      });
      expect(key).toBe("agent:myagent:teammate:reviewer");
    });

    it("buildTeamLeadSessionKey produces correct format", () => {
      const key = buildTeamLeadSessionKey({
        teamAgentId: "team-abc123",
      });
      expect(key).toBe("agent:team-abc123:lead");
    });

    it("buildTeamLeadSessionKey normalizes inputs", () => {
      const key = buildTeamLeadSessionKey({
        teamAgentId: "MyAgent",
      });
      expect(key).toBe("agent:myagent:lead");
    });

    it("parseTeamSessionKey handles mixed case", () => {
      const parsed = parseTeamSessionKey("AGENT:TEAM-ABC:LEAD");
      expect(parsed).toEqual({
        agentId: "team-abc",
        teamId: "abc",
        role: "lead",
        isLead: true,
      });
    });

    it("isTeamSessionKey handles null and undefined", () => {
      expect(isTeamSessionKey(null)).toBe(false);
      expect(isTeamSessionKey(undefined)).toBe(false);
      expect(isTeamSessionKey("")).toBe(false);
    });

    it("parseTeamSessionKey extracts complex role", () => {
      const parsed = parseTeamSessionKey(
        "agent:team-xyz789:teammate:backend-security-reviewer-a1b2c3",
      );
      expect(parsed).toEqual({
        agentId: "team-xyz789",
        teamId: "xyz789",
        role: "backend-security-reviewer-a1b2c3",
        isLead: false,
        teammateId: "backend-security-reviewer-a1b2c3",
      });
    });
  });
});
