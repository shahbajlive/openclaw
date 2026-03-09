import { describe, expect, it } from "vitest";
import { extractToolCards } from "./tool-cards.ts";

describe("extractToolCards", () => {
  it("collapses toolcall + toolresult into one result card", () => {
    const cards = extractToolCards({
      role: "assistant",
      content: [
        { type: "toolcall", name: "discover_teammates", arguments: { team: "frontend" } },
        { type: "toolresult", name: "discover_teammates", text: "done" },
      ],
    });

    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      kind: "result",
      name: "discover_teammates",
      args: { team: "frontend" },
      text: "done",
    });
  });

  it("keeps unmatched call cards as pending", () => {
    const cards = extractToolCards({
      role: "assistant",
      content: [{ type: "toolcall", name: "discover_teammates", arguments: { team: "frontend" } }],
    });

    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      kind: "call",
      name: "discover_teammates",
      args: { team: "frontend" },
    });
  });
});
