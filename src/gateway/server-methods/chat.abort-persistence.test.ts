import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CURRENT_SESSION_VERSION } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerAgentRunContext, resetAgentRunContextForTest } from "../../infra/agent-events.js";

type TranscriptLine = {
  message?: Record<string, unknown>;
};

const sessionEntryState = vi.hoisted(() => ({
  transcriptPath: "",
  sessionId: "",
}));
const piEmbeddedMocks = vi.hoisted(() => ({
  abortEmbeddedPiRun: vi.fn(() => true),
}));

vi.mock("../session-utils.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../session-utils.js")>();
  return {
    ...original,
    loadSessionEntry: () => ({
      cfg: {},
      storePath: path.join(path.dirname(sessionEntryState.transcriptPath), "sessions.json"),
      entry: {
        sessionId: sessionEntryState.sessionId,
        sessionFile: sessionEntryState.transcriptPath,
      },
      canonicalKey: "main",
    }),
  };
});

vi.mock("../../agents/pi-embedded.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../agents/pi-embedded.js")>();
  return {
    ...original,
    abortEmbeddedPiRun: (...args: unknown[]) => piEmbeddedMocks.abortEmbeddedPiRun(...args),
  };
});

const { chatHandlers } = await import("./chat.js");

function createActiveRun(sessionKey: string, sessionId: string) {
  const now = Date.now();
  return {
    controller: new AbortController(),
    sessionId,
    sessionKey,
    startedAtMs: now,
    expiresAtMs: now + 30_000,
  };
}

async function writeTranscriptHeader(transcriptPath: string, sessionId: string) {
  const header = {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: sessionId,
    timestamp: new Date(0).toISOString(),
    cwd: "/tmp",
  };
  await fs.writeFile(transcriptPath, `${JSON.stringify(header)}\n`, "utf-8");
}

async function appendTranscriptMessage(
  transcriptPath: string,
  id: string,
  parentId: string | null,
  message: Record<string, unknown>,
) {
  const line = {
    type: "message",
    id,
    parentId,
    timestamp: new Date(0).toISOString(),
    message,
  };
  await fs.appendFile(transcriptPath, `${JSON.stringify(line)}\n`, "utf-8");
}

async function readTranscriptLines(transcriptPath: string): Promise<TranscriptLine[]> {
  const raw = await fs.readFile(transcriptPath, "utf-8");
  return raw
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line) as TranscriptLine;
      } catch {
        return {};
      }
    });
}

function setMockSessionEntry(transcriptPath: string, sessionId: string) {
  sessionEntryState.transcriptPath = transcriptPath;
  sessionEntryState.sessionId = sessionId;
}

async function createTranscriptFixture(prefix: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const sessionId = "sess-main";
  const transcriptPath = path.join(dir, `${sessionId}.jsonl`);
  await writeTranscriptHeader(transcriptPath, sessionId);
  setMockSessionEntry(transcriptPath, sessionId);
  return { transcriptPath, sessionId };
}

function createChatAbortContext(overrides: Record<string, unknown> = {}): {
  chatAbortControllers: Map<string, ReturnType<typeof createActiveRun>>;
  chatRunBuffers: Map<string, string>;
  chatDeltaSentAt: Map<string, number>;
  chatAbortedRuns: Map<string, number>;
  removeChatRun: ReturnType<typeof vi.fn>;
  agentRunSeq: Map<string, number>;
  broadcast: ReturnType<typeof vi.fn>;
  nodeSendToSession: ReturnType<typeof vi.fn>;
  logGateway: { warn: ReturnType<typeof vi.fn> };
  dedupe?: { get: ReturnType<typeof vi.fn> };
} {
  return {
    chatAbortControllers: new Map(),
    chatRunBuffers: new Map(),
    chatCommittedVisibleText: new Map<string, string>(),
    chatRunPhases: new Map<string, "processing" | "thinking" | "typing" | "tool_running">(),
    chatDeltaSentAt: new Map(),
    chatAbortedRuns: new Map<string, number>(),
    removeChatRun: vi
      .fn()
      .mockImplementation((run: string) => ({ sessionKey: "main", clientRunId: run })),
    agentRunSeq: new Map<string, number>(),
    broadcast: vi.fn(),
    nodeSendToSession: vi.fn(),
    logGateway: { warn: vi.fn() },
    ...overrides,
  };
}

async function invokeChatAbort(
  context: ReturnType<typeof createChatAbortContext>,
  params: { sessionKey: string; runId?: string },
  respond: ReturnType<typeof vi.fn>,
) {
  await chatHandlers["chat.abort"]({
    params,
    respond: respond as never,
    context: context as never,
    req: {} as never,
    client: null,
    isWebchatConnect: () => false,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  piEmbeddedMocks.abortEmbeddedPiRun.mockClear().mockReturnValue(true);
  resetAgentRunContextForTest();
});

describe("chat abort transcript persistence", () => {
  it("persists run-scoped abort partial with rpc metadata and idempotency", async () => {
    const { transcriptPath, sessionId } = await createTranscriptFixture("openclaw-chat-abort-run-");
    const runId = "idem-abort-run-1";
    const respond = vi.fn();
    const context = createChatAbortContext({
      chatAbortControllers: new Map([[runId, createActiveRun("main", sessionId)]]),
      chatRunBuffers: new Map([[runId, "Partial from run abort"]]),
      chatDeltaSentAt: new Map([[runId, Date.now()]]),
      removeChatRun: vi
        .fn()
        .mockReturnValue({ sessionKey: "main", clientRunId: "client-idem-abort-run-1" }),
      agentRunSeq: new Map<string, number>([
        [runId, 2],
        ["client-idem-abort-run-1", 3],
      ]),
      broadcast: vi.fn(),
      nodeSendToSession: vi.fn(),
      logGateway: { warn: vi.fn() },
    });

    await invokeChatAbort(context, { sessionKey: "main", runId }, respond);

    const [ok1, payload1] = respond.mock.calls.at(-1) ?? [];
    expect(ok1).toBe(true);
    expect(payload1).toMatchObject({ aborted: true, runIds: [runId] });

    context.chatAbortControllers.set(runId, createActiveRun("main", sessionId));
    context.chatRunBuffers.set(runId, "Partial from run abort");
    context.chatDeltaSentAt.set(runId, Date.now());

    await invokeChatAbort(context, { sessionKey: "main", runId }, respond);

    const lines = await readTranscriptLines(transcriptPath);
    const persisted = lines
      .map((line) => line.message)
      .filter(
        (message): message is Record<string, unknown> =>
          Boolean(message) && message?.idempotencyKey === `${runId}:assistant`,
      );

    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      runId,
      stopReason: "stop",
      idempotencyKey: `${runId}:assistant`,
      openclawAbort: {
        aborted: true,
        origin: "rpc",
        runId,
      },
    });
  });

  it("persists run-context abort partials before broadcasting aborted", async () => {
    const { transcriptPath, sessionId } = await createTranscriptFixture(
      "openclaw-chat-abort-run-context-",
    );
    const runId = "idem-run-context-abort";
    registerAgentRunContext(runId, {
      sessionKey: "main",
      sessionId,
      queuedChatItemId: "queued-1",
    });
    const respond = vi.fn();
    const context = createChatAbortContext({
      chatAbortControllers: new Map(),
      chatRunBuffers: new Map([[runId, "Last visible partial"]]),
      dedupe: {
        get: vi.fn().mockReturnValue(undefined),
      },
      broadcast: vi.fn(),
      nodeSendToSession: vi.fn(),
      logGateway: { warn: vi.fn() },
    });

    await chatHandlers["chat.abort"]({
      params: { sessionKey: "main", runId },
      respond: respond as never,
      context: context as never,
      req: {} as never,
      client: null,
      isWebchatConnect: () => false,
    });

    const [ok, payload] = respond.mock.calls.at(-1) ?? [];
    expect(ok).toBe(true);
    expect(payload).toMatchObject({ aborted: true, runIds: [runId] });

    const lines = await readTranscriptLines(transcriptPath);
    const persisted = lines
      .map((line) => line.message)
      .find((message) => message?.idempotencyKey === `${runId}:assistant`);

    expect(piEmbeddedMocks.abortEmbeddedPiRun).toHaveBeenCalledWith(sessionId);
    expect(persisted).toMatchObject({
      runId,
      idempotencyKey: `${runId}:assistant`,
      content: [{ type: "text", text: "Last visible partial" }],
      openclawAbort: {
        aborted: true,
        origin: "rpc",
        runId,
      },
    });
  });

  it("persists session-scoped abort partials with rpc metadata", async () => {
    const { transcriptPath, sessionId } = await createTranscriptFixture(
      "openclaw-chat-abort-session-",
    );
    const respond = vi.fn();
    const context = createChatAbortContext({
      chatAbortControllers: new Map([
        ["run-a", createActiveRun("main", sessionId)],
        ["run-b", createActiveRun("main", sessionId)],
      ]),
      chatRunBuffers: new Map([
        ["run-a", "Session abort partial"],
        ["run-b", "   "],
      ]),
      chatDeltaSentAt: new Map([
        ["run-a", Date.now()],
        ["run-b", Date.now()],
      ]),
    });

    await invokeChatAbort(context, { sessionKey: "main" }, respond);

    const [ok, payload] = respond.mock.calls.at(-1) ?? [];
    expect(ok).toBe(true);
    expect(payload).toMatchObject({ aborted: true });
    expect(payload.runIds).toEqual(expect.arrayContaining(["run-a", "run-b"]));

    const lines = await readTranscriptLines(transcriptPath);
    const runAPersisted = lines
      .map((line) => line.message)
      .find((message) => message?.idempotencyKey === "run-a:assistant");
    const runBPersisted = lines
      .map((line) => line.message)
      .find((message) => message?.idempotencyKey === "run-b:assistant");

    expect(runAPersisted).toMatchObject({
      runId: "run-a",
      idempotencyKey: "run-a:assistant",
      openclawAbort: {
        aborted: true,
        origin: "rpc",
        runId: "run-a",
      },
    });
    expect(runBPersisted).toBeUndefined();
  });

  it("persists /stop partials with stop-command metadata", async () => {
    const { transcriptPath, sessionId } = await createTranscriptFixture("openclaw-chat-stop-");
    const respond = vi.fn();
    const context = createChatAbortContext({
      chatAbortControllers: new Map([["run-stop-1", createActiveRun("main", sessionId)]]),
      chatRunBuffers: new Map([["run-stop-1", "Partial from /stop"]]),
      chatDeltaSentAt: new Map([["run-stop-1", Date.now()]]),
      removeChatRun: vi.fn().mockReturnValue({ sessionKey: "main", clientRunId: "client-stop-1" }),
      agentRunSeq: new Map<string, number>([["run-stop-1", 1]]),
      dedupe: {
        get: vi.fn(),
      },
    });

    await chatHandlers["chat.send"]({
      params: {
        sessionKey: "main",
        message: "/stop",
        idempotencyKey: "idem-stop-req",
      },
      respond,
      context: context as never,
      req: {} as never,
      client: null,
      isWebchatConnect: () => false,
    });

    const [ok, payload] = respond.mock.calls.at(-1) ?? [];
    expect(ok).toBe(true);
    expect(payload).toMatchObject({ aborted: true, runIds: ["run-stop-1"] });

    const lines = await readTranscriptLines(transcriptPath);
    const persisted = lines
      .map((line) => line.message)
      .find((message) => message?.idempotencyKey === "run-stop-1:assistant");

    expect(persisted).toMatchObject({
      runId: "run-stop-1",
      idempotencyKey: "run-stop-1:assistant",
      openclawAbort: {
        aborted: true,
        origin: "stop-command",
        runId: "run-stop-1",
      },
    });
  });

  it("skips run-scoped transcript persistence when partial text is blank", async () => {
    const { transcriptPath, sessionId } = await createTranscriptFixture(
      "openclaw-chat-abort-run-blank-",
    );
    const runId = "idem-abort-run-blank";
    const respond = vi.fn();
    const context = createChatAbortContext({
      chatAbortControllers: new Map([[runId, createActiveRun("main", sessionId)]]),
      chatRunBuffers: new Map([[runId, "  \n\t  "]]),
      chatDeltaSentAt: new Map([[runId, Date.now()]]),
    });

    await invokeChatAbort(context, { sessionKey: "main", runId }, respond);

    const [ok, payload] = respond.mock.calls.at(-1) ?? [];
    expect(ok).toBe(true);
    expect(payload).toMatchObject({ aborted: true, runIds: [runId] });

    const lines = await readTranscriptLines(transcriptPath);
    const persisted = lines
      .map((line) => line.message)
      .find((message) => message?.idempotencyKey === `${runId}:assistant`);
    expect(persisted).toBeUndefined();
  });

  it("aborts the embedded Pi run for active chat runs", async () => {
    const { sessionId } = await createTranscriptFixture("openclaw-chat-abort-embedded-");
    const runId = "idem-abort-embedded";
    const respond = vi.fn();
    const context = createChatAbortContext({
      chatAbortControllers: new Map([[runId, createActiveRun("main", sessionId)]]),
      chatRunBuffers: new Map([[runId, "Partial from run abort"]]),
      chatDeltaSentAt: new Map([[runId, Date.now()]]),
    });

    await invokeChatAbort(context, { sessionKey: "main", runId }, respond);

    expect(piEmbeddedMocks.abortEmbeddedPiRun).toHaveBeenCalledWith(sessionId);
    const [ok, payload] = respond.mock.calls.at(-1) ?? [];
    expect(ok).toBe(true);
    expect(payload).toMatchObject({ aborted: true, runIds: [runId] });
  });

  it("does not persist an abort partial that only duplicates already-persisted assistant text", async () => {
    const { transcriptPath, sessionId } = await createTranscriptFixture(
      "openclaw-chat-abort-dedupe-",
    );
    const runId = "idem-abort-run-dedupe";
    await appendTranscriptMessage(transcriptPath, "assistant-prefix", null, {
      role: "assistant",
      runId,
      timestamp: 1,
      content: [
        {
          type: "text",
          text: "I'm ready to help! Let me check what files are available in the workspace and then respond.\n\n",
        },
        { type: "toolCall", id: "call_1", name: "read", arguments: { path: "SOUL.md" } },
      ],
    });

    const respond = vi.fn();
    const context = createChatAbortContext({
      chatAbortControllers: new Map([[runId, createActiveRun("main", sessionId)]]),
      chatRunBuffers: new Map([
        [
          runId,
          "I'm ready to help! Let me check what files are available in the workspace and then respond.",
        ],
      ]),
      chatDeltaSentAt: new Map([[runId, Date.now()]]),
    });

    await invokeChatAbort(context, { sessionKey: "main", runId }, respond);

    const lines = await readTranscriptLines(transcriptPath);
    const persisted = lines
      .map((line) => line.message)
      .find((message) => message?.idempotencyKey === `${runId}:assistant`);
    expect(persisted).toBeUndefined();
  });

  it("does not persist a boundary assistant row when the mixed tool-use message already contains that text", async () => {
    const { transcriptPath, sessionId } = await createTranscriptFixture(
      "openclaw-chat-abort-boundary-dedupe-",
    );
    const runId = "idem-abort-run-boundary-dedupe";
    await appendTranscriptMessage(transcriptPath, "assistant-prefix", null, {
      role: "assistant",
      runId,
      timestamp: 1,
      content: [
        {
          type: "text",
          text: "I'm ready to help! Let me check the current session context and memory files.\n\n",
        },
        { type: "toolCall", id: "call_1", name: "memory_get", arguments: { path: "MEMORY.md" } },
      ],
    });
    await appendTranscriptMessage(transcriptPath, "tool-result", "assistant-prefix", {
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "memory_get",
      timestamp: 2,
      content: [{ type: "text", text: '{"text":""}' }],
      runId,
    });

    const respond = vi.fn();
    const context = createChatAbortContext({
      chatAbortControllers: new Map([[runId, createActiveRun("main", sessionId)]]),
      chatRunBuffers: new Map([
        [runId, "I'm ready to help! Let me check the current session context and memory files."],
      ]),
      chatCommittedVisibleText: new Map([
        [runId, "I'm ready to help! Let me check the current session context and memory files."],
      ]),
      chatDeltaSentAt: new Map([[runId, Date.now()]]),
    });

    await invokeChatAbort(context, { sessionKey: "main", runId }, respond);

    const lines = await readTranscriptLines(transcriptPath);
    const boundaryPersisted = lines
      .map((line) => line.message)
      .find((message) => message?.idempotencyKey === `${runId}:assistant-boundary`);
    expect(boundaryPersisted).toBeUndefined();
  });

  it("persists only the abort suffix after a tool split using committed visible text", async () => {
    const { transcriptPath, sessionId } = await createTranscriptFixture(
      "openclaw-chat-abort-suffix-split-",
    );
    const runId = "idem-abort-run-suffix-split";
    await appendTranscriptMessage(transcriptPath, "assistant-prefix", null, {
      role: "assistant",
      runId,
      timestamp: 1,
      content: [
        {
          type: "text",
          text: "I'm ready to help! Let me check what files are available in the workspace and then",
        },
        { type: "toolCall", id: "call_1", name: "read", arguments: { path: "SOUL.md" } },
      ],
    });

    const respond = vi.fn();
    const context = createChatAbortContext({
      chatAbortControllers: new Map([[runId, createActiveRun("main", sessionId)]]),
      chatRunBuffers: new Map([
        [
          runId,
          "I'm ready to help! Let me check what files are available in the workspace and then respond.",
        ],
      ]),
      chatCommittedVisibleText: new Map([
        [
          runId,
          "I'm ready to help! Let me check what files are available in the workspace and then",
        ],
      ]),
      chatDeltaSentAt: new Map([[runId, Date.now()]]),
    });

    await invokeChatAbort(context, { sessionKey: "main", runId }, respond);

    const lines = await readTranscriptLines(transcriptPath);
    const persisted = lines
      .map((line) => line.message)
      .find((message) => message?.idempotencyKey === `${runId}:assistant`);
    expect(persisted).toMatchObject({
      content: [{ type: "text", text: "respond." }],
      openclawAbort: {
        aborted: true,
        runId,
      },
    });
  });
});
