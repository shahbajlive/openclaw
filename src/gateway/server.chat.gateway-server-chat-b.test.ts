import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import type { GetReplyOptions } from "../auto-reply/types.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { __setMaxChatHistoryMessagesBytesForTest } from "./server-constants.js";
import {
  connectOk,
  getReplyFromConfig,
  installGatewayTestHooks,
  onceMessage,
  rpcReq,
  startServerWithClient,
  testState,
  writeSessionStore,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });
const FAST_WAIT_OPTS = { timeout: 250, interval: 2 } as const;

const sendReq = (
  ws: { send: (payload: string) => void },
  id: string,
  method: string,
  params: unknown,
) => {
  ws.send(
    JSON.stringify({
      type: "req",
      id,
      method,
      params,
    }),
  );
};

async function withGatewayChatHarness(
  run: (ctx: {
    ws: Awaited<ReturnType<typeof startServerWithClient>>["ws"];
    createSessionDir: () => Promise<string>;
  }) => Promise<void>,
) {
  const tempDirs: string[] = [];
  const { server, ws } = await startServerWithClient();
  const createSessionDir = async () => {
    const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-"));
    tempDirs.push(sessionDir);
    testState.sessionStorePath = path.join(sessionDir, "sessions.json");
    return sessionDir;
  };

  try {
    await run({ ws, createSessionDir });
  } finally {
    __setMaxChatHistoryMessagesBytesForTest();
    testState.sessionStorePath = undefined;
    ws.close();
    await server.close();
    await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
  }
}

async function writeMainSessionStore() {
  await writeSessionStore({
    entries: {
      main: { sessionId: "sess-main", updatedAt: Date.now() },
    },
  });
}

async function writeMainSessionTranscript(sessionDir: string, lines: string[]) {
  await fs.writeFile(path.join(sessionDir, "sess-main.jsonl"), `${lines.join("\n")}\n`, "utf-8");
}

async function fetchHistoryMessages(
  ws: Awaited<ReturnType<typeof startServerWithClient>>["ws"],
): Promise<unknown[]> {
  const historyRes = await rpcReq<{ messages?: unknown[] }>(ws, "chat.history", {
    sessionKey: "main",
    limit: 1000,
  });
  expect(historyRes.ok).toBe(true);
  return historyRes.payload?.messages ?? [];
}

describe("gateway server chat", () => {
  test("smoke: caps history payload and preserves routing metadata", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      const historyMaxBytes = 64 * 1024;
      __setMaxChatHistoryMessagesBytesForTest(historyMaxBytes);
      await connectOk(ws);

      const sessionDir = await createSessionDir();
      await writeMainSessionStore();

      const bigText = "x".repeat(2_000);
      const historyLines: string[] = [];
      for (let i = 0; i < 45; i += 1) {
        historyLines.push(
          JSON.stringify({
            message: {
              role: "user",
              content: [{ type: "text", text: `${i}:${bigText}` }],
              timestamp: Date.now() + i,
            },
          }),
        );
      }
      await writeMainSessionTranscript(sessionDir, historyLines);
      const messages = await fetchHistoryMessages(ws);
      const bytes = Buffer.byteLength(JSON.stringify(messages), "utf8");
      expect(bytes).toBeLessThanOrEqual(historyMaxBytes);
      expect(messages.length).toBeLessThan(45);

      await writeSessionStore({
        entries: {
          main: {
            sessionId: "sess-main",
            updatedAt: Date.now(),
            lastChannel: "whatsapp",
            lastTo: "+1555",
          },
        },
      });

      const sendRes = await rpcReq(ws, "chat.send", {
        sessionKey: "main",
        message: "hello",
        idempotencyKey: "idem-route",
      });
      expect(sendRes.ok).toBe(true);

      const sessionStorePath = testState.sessionStorePath;
      if (!sessionStorePath) {
        throw new Error("expected session store path");
      }
      const stored = JSON.parse(await fs.readFile(sessionStorePath, "utf-8")) as Record<
        string,
        { lastChannel?: string; lastTo?: string } | undefined
      >;
      expect(stored["agent:main:main"]?.lastChannel).toBe("whatsapp");
      expect(stored["agent:main:main"]?.lastTo).toBe("+1555");
    });
  });

  test("chat.send does not force-disable block streaming", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      const spy = getReplyFromConfig;
      await connectOk(ws);

      await createSessionDir();
      await writeMainSessionStore();
      testState.agentConfig = { blockStreamingDefault: "on" };
      try {
        spy.mockClear();
        let capturedOpts: GetReplyOptions | undefined;
        spy.mockImplementationOnce(async (_ctx: unknown, opts?: GetReplyOptions) => {
          capturedOpts = opts;
          return undefined;
        });

        const sendRes = await rpcReq(ws, "chat.send", {
          sessionKey: "main",
          message: "hello",
          idempotencyKey: "idem-block-streaming",
        });
        expect(sendRes.ok).toBe(true);

        await vi.waitFor(() => {
          expect(spy.mock.calls.length).toBeGreaterThan(0);
        }, FAST_WAIT_OPTS);

        expect(capturedOpts?.disableBlockStreaming).toBeUndefined();
      } finally {
        testState.agentConfig = undefined;
      }
    });
  });

  test("chat.history hard-caps single oversized nested payloads", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      const historyMaxBytes = 64 * 1024;
      __setMaxChatHistoryMessagesBytesForTest(historyMaxBytes);
      await connectOk(ws);

      const sessionDir = await createSessionDir();
      await writeMainSessionStore();

      const hugeNestedText = "n".repeat(120_000);
      const oversizedLine = JSON.stringify({
        message: {
          role: "assistant",
          timestamp: Date.now(),
          content: [
            {
              type: "tool_result",
              toolUseId: "tool-1",
              output: {
                nested: {
                  payload: hugeNestedText,
                },
              },
            },
          ],
        },
      });
      await writeMainSessionTranscript(sessionDir, [oversizedLine]);
      const messages = await fetchHistoryMessages(ws);
      expect(messages.length).toBe(1);

      const serialized = JSON.stringify(messages);
      const bytes = Buffer.byteLength(serialized, "utf8");
      expect(bytes).toBeLessThanOrEqual(historyMaxBytes);
      expect(serialized).toContain("[chat.history omitted: message too large]");
      expect(serialized.includes(hugeNestedText.slice(0, 256))).toBe(false);
    });
  });

  test("chat.history keeps recent small messages when latest message is oversized", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      const historyMaxBytes = 64 * 1024;
      __setMaxChatHistoryMessagesBytesForTest(historyMaxBytes);
      await connectOk(ws);

      const sessionDir = await createSessionDir();
      await writeMainSessionStore();

      const baseText = "s".repeat(1_200);
      const lines: string[] = [];
      for (let i = 0; i < 30; i += 1) {
        lines.push(
          JSON.stringify({
            message: {
              role: "user",
              timestamp: Date.now() + i,
              content: [{ type: "text", text: `small-${i}:${baseText}` }],
            },
          }),
        );
      }

      const hugeNestedText = "z".repeat(120_000);
      lines.push(
        JSON.stringify({
          message: {
            role: "assistant",
            timestamp: Date.now() + 1_000,
            content: [
              {
                type: "tool_result",
                toolUseId: "tool-1",
                output: {
                  nested: {
                    payload: hugeNestedText,
                  },
                },
              },
            ],
          },
        }),
      );

      await writeMainSessionTranscript(sessionDir, lines);
      const messages = await fetchHistoryMessages(ws);
      const serialized = JSON.stringify(messages);
      const bytes = Buffer.byteLength(serialized, "utf8");

      expect(bytes).toBeLessThanOrEqual(historyMaxBytes);
      expect(messages.length).toBeGreaterThan(1);
      expect(serialized).toContain("small-29:");
      expect(serialized).toContain("[chat.history omitted: message too large]");
      expect(serialized.includes(hugeNestedText.slice(0, 256))).toBe(false);
    });
  });

  test("chat.history strips inline directives from displayed message text", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      await connectOk(ws);

      const sessionDir = await createSessionDir();
      await writeMainSessionStore();

      const lines = [
        JSON.stringify({
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "Hello [[reply_to_current]] world [[audio_as_voice]]" },
            ],
            timestamp: Date.now(),
          },
        }),
        JSON.stringify({
          message: {
            role: "assistant",
            content: "A [[reply_to:abc-123]] B",
            timestamp: Date.now() + 1,
          },
        }),
        JSON.stringify({
          message: {
            role: "assistant",
            text: "[[ reply_to : 456 ]] C",
            timestamp: Date.now() + 2,
          },
        }),
        JSON.stringify({
          message: {
            role: "assistant",
            content: [{ type: "text", text: "  keep padded  " }],
            timestamp: Date.now() + 3,
          },
        }),
      ];
      await writeMainSessionTranscript(sessionDir, lines);
      const messages = await fetchHistoryMessages(ws);
      expect(messages.length).toBe(4);

      const serialized = JSON.stringify(messages);
      expect(serialized.includes("[[reply_to")).toBe(false);
      expect(serialized.includes("[[audio_as_voice]]")).toBe(false);

      const first = messages[0] as { content?: Array<{ text?: string }> };
      const second = messages[1] as { content?: string };
      const third = messages[2] as { text?: string };
      const fourth = messages[3] as { content?: Array<{ text?: string }> };

      expect(first.content?.[0]?.text?.replace(/\s+/g, " ").trim()).toBe("Hello world");
      expect(second.content?.replace(/\s+/g, " ").trim()).toBe("A B");
      expect(third.text?.replace(/\s+/g, " ").trim()).toBe("C");
      expect(fourth.content?.[0]?.text).toBe("  keep padded  ");
    });
  });

  test("chat.history returns canonical toolInvocations and activeRun snapshots", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      const spy = getReplyFromConfig;
      await connectOk(ws);

      const sessionDir = await createSessionDir();
      await writeMainSessionStore();
      const ts = Date.now();
      await writeMainSessionTranscript(sessionDir, [
        JSON.stringify({
          message: {
            role: "assistant",
            timestamp: ts,
            content: [
              { type: "toolCall", id: "call-1", name: "discover_teammates", arguments: {} },
            ],
          },
        }),
        JSON.stringify({
          message: {
            role: "toolResult",
            timestamp: ts + 1,
            toolCallId: "call-1",
            toolName: "discover_teammates",
            content: [{ type: "text", text: "Found 3 teammates." }],
          },
        }),
      ]);

      let releaseRun: () => void = () => {};
      const runGate = new Promise<void>((resolve) => {
        releaseRun = resolve;
      });
      spy.mockImplementationOnce(async () => {
        await runGate;
        return undefined;
      });

      const sendRes = await rpcReq(ws, "chat.send", {
        sessionKey: "main",
        message: "hello",
        idempotencyKey: "idem-active-run",
      });
      expect(sendRes.ok).toBe(true);

      const historyRes = await rpcReq<{
        toolInvocations?: Array<Record<string, unknown>>;
        activeRun?: { runId?: string; streamText?: string };
      }>(ws, "chat.history", {
        sessionKey: "main",
        limit: 200,
      });
      expect(historyRes.ok).toBe(true);

      const toolInvocations = historyRes.payload?.toolInvocations ?? [];
      expect(toolInvocations).toHaveLength(1);
      expect(toolInvocations[0]?.toolCallId).toBe("call-1");
      expect(toolInvocations[0]?.phase).toBe("result");
      expect(
        (toolInvocations[0]?.message as { __openclaw?: { canonicalToolInvocation?: boolean } })
          ?.__openclaw?.canonicalToolInvocation,
      ).toBe(true);
      expect(historyRes.payload?.activeRun?.runId).toBe("idem-active-run");
      expect(typeof historyRes.payload?.activeRun?.streamText).toBe("string");

      releaseRun();
    });
  });

  test("chat.send includes effectiveUserMessage for bare /reset", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      await connectOk(ws);
      await createSessionDir();
      await writeMainSessionStore();

      const sendRes = await rpcReq<{ status?: string; effectiveUserMessage?: string }>(
        ws,
        "chat.send",
        {
          sessionKey: "main",
          message: "/reset",
          idempotencyKey: "idem-reset-effective",
        },
      );
      expect(sendRes.ok).toBe(true);
      expect(sendRes.payload?.status).toBe("started");
      expect(sendRes.payload?.effectiveUserMessage ?? "").toContain(
        "A new session was started via /new or /reset.",
      );
    });
  });

  test("chat.history activeRun includes effectiveUserMessage for bare /reset while in-flight", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      const spy = getReplyFromConfig;
      await connectOk(ws);
      await createSessionDir();
      await writeMainSessionStore();

      let releaseRun: () => void = () => {};
      const runGate = new Promise<void>((resolve) => {
        releaseRun = resolve;
      });
      spy.mockImplementationOnce(async () => {
        await runGate;
        return undefined;
      });

      const sendRes = await rpcReq<{ status?: string; effectiveUserMessage?: string }>(
        ws,
        "chat.send",
        {
          sessionKey: "main",
          message: "/reset",
          idempotencyKey: "idem-reset-history-effective",
        },
      );
      expect(sendRes.ok).toBe(true);
      expect(sendRes.payload?.status).toBe("started");
      const effective = sendRes.payload?.effectiveUserMessage ?? "";
      expect(effective).toContain("A new session was started via /new or /reset.");

      const historyRes = await rpcReq<{
        activeRun?: { runId?: string; effectiveUserMessage?: string };
      }>(ws, "chat.history", {
        sessionKey: "main",
        limit: 200,
      });
      expect(historyRes.ok).toBe(true);
      expect(historyRes.payload?.activeRun?.runId).toBe("idem-reset-history-effective");
      expect(historyRes.payload?.activeRun?.effectiveUserMessage).toBe(effective);

      releaseRun();
    });
  });

  test("chat.history hydrates activeRun from an in-flight agent lifecycle run", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      await connectOk(ws);
      await createSessionDir();
      await writeSessionStore({
        entries: {
          "agent:frontend_engineer:clawport": {
            sessionId: "sess-frontend",
            updatedAt: Date.now(),
          },
        },
      });

      emitAgentEvent({
        runId: "run-a2a-active",
        sessionKey: "agent:frontend_engineer:clawport",
        stream: "lifecycle",
        data: {
          phase: "start",
          startedAt: 123,
          inputProvenance: {
            kind: "inter_session",
            sourceSessionKey: "agent:developer_lead:clawport",
            sourceTool: "mention_route",
          },
        },
      });

      const historyRes = await rpcReq<{
        activeRun?: { runId?: string; streamText?: string };
      }>(ws, "chat.history", {
        sessionKey: "agent:frontend_engineer:clawport",
        limit: 200,
      });
      expect(historyRes.ok).toBe(true);
      expect(historyRes.payload?.activeRun?.runId).toBe("run-a2a-active");
      expect(historyRes.payload?.activeRun?.streamText).toBe("");

      emitAgentEvent({
        runId: "run-a2a-active",
        sessionKey: "agent:frontend_engineer:clawport",
        stream: "lifecycle",
        data: { phase: "end", startedAt: 123, endedAt: 124 },
      });
    });
  });

  test("chat.history ignores hidden same-session background lifecycle runs", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      await connectOk(ws);
      await createSessionDir();
      await writeSessionStore({
        entries: {
          "agent:frontend_engineer:clawport": {
            sessionId: "sess-frontend",
            updatedAt: Date.now(),
          },
        },
      });

      emitAgentEvent({
        runId: "run-hidden",
        sessionKey: "agent:frontend_engineer:clawport",
        stream: "lifecycle",
        data: { phase: "start", startedAt: 123 },
      });

      const historyRes = await rpcReq<{ activeRun?: { runId?: string } }>(ws, "chat.history", {
        sessionKey: "agent:frontend_engineer:clawport",
        limit: 200,
      });
      expect(historyRes.ok).toBe(true);
      expect(historyRes.payload?.activeRun).toBeNull();

      emitAgentEvent({
        runId: "run-hidden",
        sessionKey: "agent:frontend_engineer:clawport",
        stream: "lifecycle",
        data: { phase: "end", startedAt: 123, endedAt: 124 },
      });
    });
  });

  test("smoke: supports abort and idempotent completion", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      const spy = getReplyFromConfig;
      let aborted = false;
      await connectOk(ws);

      await createSessionDir();
      await writeMainSessionStore();

      spy.mockClear();
      spy.mockImplementationOnce(async (_ctx, opts) => {
        opts?.onAgentRunStart?.(opts.runId ?? "idem-abort-1");
        const signal = opts?.abortSignal;
        await new Promise<void>((resolve) => {
          if (!signal || signal.aborted) {
            aborted = Boolean(signal?.aborted);
            resolve();
            return;
          }
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              resolve();
            },
            { once: true },
          );
        });
        return undefined;
      });

      const sendResP = onceMessage(ws, (o) => o.type === "res" && o.id === "send-abort-1", 2_000);
      sendReq(ws, "send-abort-1", "chat.send", {
        sessionKey: "main",
        message: "hello",
        idempotencyKey: "idem-abort-1",
        timeoutMs: 30_000,
      });

      const sendRes = await sendResP;
      expect(sendRes.ok).toBe(true);
      await vi.waitFor(() => {
        expect(spy.mock.calls.length).toBeGreaterThan(0);
      }, FAST_WAIT_OPTS);

      const inFlight = await rpcReq<{ status?: string }>(ws, "chat.send", {
        sessionKey: "main",
        message: "hello",
        idempotencyKey: "idem-abort-1",
      });
      expect(inFlight.ok).toBe(true);
      expect(["started", "in_flight", "ok"]).toContain(inFlight.payload?.status ?? "");

      const abortRes = await rpcReq<{ aborted?: boolean }>(ws, "chat.abort", {
        sessionKey: "main",
        runId: "idem-abort-1",
      });
      expect(abortRes.ok).toBe(true);
      expect(abortRes.payload?.aborted).toBe(true);
      await vi.waitFor(() => {
        expect(aborted).toBe(true);
      }, FAST_WAIT_OPTS);

      spy.mockClear();
      spy.mockResolvedValueOnce(undefined);

      const completeRes = await rpcReq<{ status?: string }>(ws, "chat.send", {
        sessionKey: "main",
        message: "hello",
        idempotencyKey: "idem-complete-1",
      });
      expect(completeRes.ok).toBe(true);

      await vi.waitFor(async () => {
        const again = await rpcReq<{ status?: string }>(ws, "chat.send", {
          sessionKey: "main",
          message: "hello",
          idempotencyKey: "idem-complete-1",
        });
        expect(again.ok).toBe(true);
        expect(again.payload?.status).toBe("ok");
      }, FAST_WAIT_OPTS);
    });
  });
});
