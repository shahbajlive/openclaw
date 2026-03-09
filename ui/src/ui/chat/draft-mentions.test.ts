import { describe, expect, it } from "vitest";
import {
  applyDraftMentionSuggestion,
  buildMentionSuggestions,
  findDraftMentionAtSelection,
} from "./draft-mentions.ts";

describe("draft mentions", () => {
  it("finds a mention query in the middle of a sentence", () => {
    const text = "please ask @front about this";
    const match = findDraftMentionAtSelection(text, "please ask @front".length);
    expect(match).toEqual({
      query: "front",
      start: "please ask ".length,
      end: "please ask @front".length,
    });
  });

  it("replaces the active mention token with the chosen agent id", () => {
    const next = applyDraftMentionSuggestion(
      "please ask @front about this",
      {
        start: "please ask ".length,
        end: "please ask @front".length,
      },
      "@frontend_engineer",
    );
    expect(next.text).toBe("please ask @frontend_engineer about this");
    expect(next.caret).toBe("please ask @frontend_engineer".length);
  });

  it("limits suggestions to the current agent's reachable teammates", () => {
    const suggestions = buildMentionSuggestions({
      sessionKey: "agent:developer_lead:clawport",
      query: "eng",
      agents: [
        {
          id: "developer_lead",
          name: "Developer Lead",
          directReports: ["frontend_engineer", "backend_engineer"],
        },
        { id: "frontend_engineer", name: "Frontend Engineer" },
        { id: "backend_engineer", name: "Backend Engineer" },
        { id: "security_engineer", name: "Security Engineer" },
      ],
    });
    expect(suggestions.map((entry) => entry.mention)).toEqual([
      "@backend_engineer",
      "@frontend_engineer",
    ]);
  });
});
