import { describe, expect, it } from "vitest";
import { shouldReloadHistoryForRecovery } from "./chat-event-reload.ts";

describe("shouldReloadHistoryForRecovery", () => {
  it("returns true for reconnect recovery", () => {
    expect(shouldReloadHistoryForRecovery("reconnect")).toBe(true);
  });

  it("returns true for websocket sequence gap recovery", () => {
    expect(shouldReloadHistoryForRecovery("seq-gap")).toBe(true);
  });

  it("returns true for manual refresh", () => {
    expect(shouldReloadHistoryForRecovery("manual")).toBe(true);
  });

  it("returns true for session-change refresh", () => {
    expect(shouldReloadHistoryForRecovery("session-change")).toBe(true);
  });
});
