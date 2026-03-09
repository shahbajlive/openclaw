import { describe, expect, it } from "vitest";
import {
  shouldReloadHistoryForFinalEvent,
  shouldReloadHistoryForRecovery,
} from "./chat-event-reload.ts";

describe("shouldReloadHistoryForFinalEvent", () => {
  it("returns false for non-final events", () => {
    expect(
      shouldReloadHistoryForFinalEvent({
        runId: "run-1",
        sessionKey: "main",
        state: "delta",
        message: { role: "assistant", content: [{ type: "text", text: "x" }] },
      }),
    ).toBe(false);
  });

  it("returns true when final event has no message payload", () => {
    expect(
      shouldReloadHistoryForFinalEvent({
        runId: "run-1",
        sessionKey: "main",
        state: "final",
      }),
    ).toBe(true);
  });

  it("returns true for final events without payloads regardless of session key", () => {
    expect(
      shouldReloadHistoryForFinalEvent({
        runId: "run-external",
        sessionKey: "agent:other:main",
        state: "final",
      }),
    ).toBe(true);
  });
});

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
