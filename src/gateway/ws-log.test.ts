import { describe, expect, test } from "vitest";
import { formatForLog, shortId, summarizeAgentEventForWsLog } from "./ws-log.js";

describe("gateway ws log helpers", () => {
  test("shortId compacts uuids and long strings", () => {
    expect(shortId("12345678-1234-1234-1234-123456789abc")).toBe("12345678…9abc");
    expect(shortId("a".repeat(30))).toBe("aaaaaaaaaaaa…aaaa");
    expect(shortId("short")).toBe("short");
  });

  test("formatForLog formats errors and messages", () => {
    const err = new Error("boom");
    err.name = "TestError";
    expect(formatForLog(err)).toContain("TestError");
    expect(formatForLog(err)).toContain("boom");

    const obj = { name: "Oops", message: "failed", code: "E1" };
    expect(formatForLog(obj)).toBe("Oops: failed: code=E1");
  });

  test("formatForLog redacts obvious secrets", () => {
    const token = "sk-abcdefghijklmnopqrstuvwxyz123456";
    const out = formatForLog({ token });
    expect(out).toContain("token");
    expect(out).not.toContain(token);
    expect(out).toContain("…");
  });

  test("summarizeAgentEventForWsLog extracts useful fields", () => {
    const summary = summarizeAgentEventForWsLog({
      runId: "12345678-1234-1234-1234-123456789abc",
      sessionKey: "agent:main:main",
      eventType: "activity.output",
      kind: "assistant_message",
      seq: 2,
      output: { text: "hello world", mediaUrls: ["a", "b"] },
    });
    expect(summary).toMatchObject({
      agent: "main",
      run: "12345678…9abc",
      session: "main",
      stream: "assistant_message",
      aseq: 2,
      text: "hello world",
      media: 2,
    });

    const tool = summarizeAgentEventForWsLog({
      runId: "run-1",
      eventType: "activity.started",
      kind: "tool_call",
      activityId: "call-1",
      input: { name: "fetch" },
    });
    expect(tool).toMatchObject({
      stream: "tool_call",
      tool: "activity.started:fetch",
      call: "call-1",
    });
  });
});
