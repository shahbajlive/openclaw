import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { SessionsListResult } from "../types.ts";
import { renderChat, type ChatProps } from "./chat.ts";

function createSessions(): SessionsListResult {
  return {
    ts: 0,
    path: "",
    count: 0,
    defaults: { model: null, contextTokens: null },
    sessions: [],
  };
}

function createProps(overrides: Partial<ChatProps> = {}): ChatProps {
  return {
    sessionKey: "main",
    chatRunId: null,
    onSessionKeyChange: () => undefined,
    thinkingLevel: null,
    showThinking: false,
    loading: false,
    sending: false,
    activeRun: false,
    canAbort: false,
    compactionStatus: null,
    fallbackStatus: null,
    messages: [],
    toolMessages: [],
    stream: null,
    streamStartedAt: null,
    runPhase: null,
    typingActive: false,
    assistantAvatarUrl: null,
    draft: "",
    queue: [],
    connected: true,
    canSend: true,
    disabledReason: null,
    error: null,
    sessions: createSessions(),
    focusMode: false,
    assistantName: "OpenClaw",
    assistantAvatar: null,
    onRefresh: () => undefined,
    onToggleFocusMode: () => undefined,
    onDraftChange: () => undefined,
    liveToolEventsEnabled: true,
    onToggleLiveToolEvents: () => undefined,
    shouldEmitToolResult: true,
    onToggleShouldEmitToolResult: () => undefined,
    shouldEmitToolOutput: true,
    onToggleShouldEmitToolOutput: () => undefined,
    onSend: () => undefined,
    onQueueRemove: () => undefined,
    onQueueEdit: () => undefined,
    onQueueSendNow: () => undefined,
    onNewSession: () => undefined,
    ...overrides,
  };
}

describe("chat view", () => {
  it("renders system messages in a dedicated system lane with a system avatar", () => {
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          messages: [
            {
              role: "system",
              content: [{ type: "text", text: "Bootstrap prompt" }],
              timestamp: 1000,
            },
          ],
        }),
      ),
      container,
    );

    const group = container.querySelector(".chat-group.system");
    expect(group).not.toBeNull();
    expect(group?.querySelector(".chat-sender-name")?.textContent).toContain("System");
    expect(group?.querySelector(".chat-avatar.system")?.textContent).toContain("S");
  });

  it("renders compacting indicator as a badge", () => {
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          compactionStatus: {
            active: true,
            startedAt: Date.now(),
            completedAt: null,
          },
        }),
      ),
      container,
    );

    const indicator = container.querySelector(".compaction-indicator--active");
    expect(indicator).not.toBeNull();
    expect(indicator?.textContent).toContain("Compacting context...");
  });

  it("renders completion indicator shortly after compaction", () => {
    const container = document.createElement("div");
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000);
    render(
      renderChat(
        createProps({
          compactionStatus: {
            active: false,
            startedAt: 900,
            completedAt: 900,
          },
        }),
      ),
      container,
    );

    const indicator = container.querySelector(".compaction-indicator--complete");
    expect(indicator).not.toBeNull();
    expect(indicator?.textContent).toContain("Context compacted");
    nowSpy.mockRestore();
  });

  it("hides stale compaction completion indicator", () => {
    const container = document.createElement("div");
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(10_000);
    render(
      renderChat(
        createProps({
          compactionStatus: {
            active: false,
            startedAt: 0,
            completedAt: 0,
          },
        }),
      ),
      container,
    );

    expect(container.querySelector(".compaction-indicator")).toBeNull();
    nowSpy.mockRestore();
  });

  it("renders fallback indicator shortly after fallback event", () => {
    const container = document.createElement("div");
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000);
    render(
      renderChat(
        createProps({
          fallbackStatus: {
            selected: "fireworks/minimax-m2p5",
            active: "deepinfra/moonshotai/Kimi-K2.5",
            attempts: ["fireworks/minimax-m2p5: rate limit"],
            occurredAt: 900,
          },
        }),
      ),
      container,
    );

    const indicator = container.querySelector(".compaction-indicator--fallback");
    expect(indicator).not.toBeNull();
    expect(indicator?.textContent).toContain("Fallback active: deepinfra/moonshotai/Kimi-K2.5");
    nowSpy.mockRestore();
  });

  it("hides stale fallback indicator", () => {
    const container = document.createElement("div");
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(20_000);
    render(
      renderChat(
        createProps({
          fallbackStatus: {
            selected: "fireworks/minimax-m2p5",
            active: "deepinfra/moonshotai/Kimi-K2.5",
            attempts: [],
            occurredAt: 0,
          },
        }),
      ),
      container,
    );

    expect(container.querySelector(".compaction-indicator--fallback")).toBeNull();
    nowSpy.mockRestore();
  });

  it("renders fallback-cleared indicator shortly after transition", () => {
    const container = document.createElement("div");
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000);
    render(
      renderChat(
        createProps({
          fallbackStatus: {
            phase: "cleared",
            selected: "fireworks/minimax-m2p5",
            active: "fireworks/minimax-m2p5",
            previous: "deepinfra/moonshotai/Kimi-K2.5",
            attempts: [],
            occurredAt: 900,
          },
        }),
      ),
      container,
    );

    const indicator = container.querySelector(".compaction-indicator--fallback-cleared");
    expect(indicator).not.toBeNull();
    expect(indicator?.textContent).toContain("Fallback cleared: fireworks/minimax-m2p5");
    nowSpy.mockRestore();
  });

  it("renders inter-session peer messages with workspace agent metadata", () => {
    const container = document.createElement("div");
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    render(
      renderChat(
        createProps({
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: "Can you review this?" }],
              provenance: {
                kind: "inter_session",
                sourceSessionKey: "agent:frontend-engineer:clawport",
                sourceTool: "sessions_send",
              },
              timestamp: 1_000_000 - 5 * 60_000,
            },
          ],
          agentDirectory: [
            {
              id: "frontend-engineer",
              name: "Frontend Engineer",
              color: "#22c55e",
              emoji: "🎨",
            },
          ],
        }),
      ),
      container,
    );

    expect(container.querySelector(".chat-sender-name")?.textContent).toContain(
      "Frontend Engineer",
    );
    expect(container.querySelector(".chat-group-timestamp")?.textContent).toContain("5m ago");
    expect(container.querySelector(".chat-group.is-peer")?.getAttribute("style")).toContain(
      "#22c55e",
    );
    expect(container.querySelector(".chat-avatar.assistant")?.textContent).toContain("🎨");
    nowSpy.mockRestore();
  });

  it("highlights @agent_id mentions using the agent color", () => {
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "Please sync with @frontend_engineer today." }],
              timestamp: 1_000,
            },
          ],
          agentDirectory: [
            {
              id: "frontend_engineer",
              name: "Frontend Engineer",
              color: "#22c55e",
              emoji: "🎨",
            },
          ],
        }),
      ),
      container,
    );

    const mention = container.querySelector(".chat-agent-mention");
    expect(mention?.textContent).toBe("@frontend_engineer");
    expect(mention?.style.getPropertyValue("--chat-agent-mention-accent")).toBe("#22c55e");
  });

  it("deduplicates repeated messages that share the same idempotency key", () => {
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          messages: [
            {
              role: "user",
              idempotencyKey: "idem-1",
              content: [{ type: "text", text: "Review this change" }],
              timestamp: 1_000,
            },
            {
              role: "user",
              idempotencyKey: "idem-1",
              content: [{ type: "text", text: "Review this change" }],
              timestamp: 1_001,
            },
          ],
        }),
      ),
      container,
    );

    expect(container.querySelectorAll(".chat-group.user .chat-bubble")).toHaveLength(1);
  });

  it("shows a stop button when aborting is available", () => {
    const container = document.createElement("div");
    const onAbort = vi.fn();
    render(
      renderChat(
        createProps({
          canAbort: true,
          onAbort,
        }),
      ),
      container,
    );

    const stopButton = container.querySelector('button[aria-label="Stop"]');
    expect(stopButton).not.toBeUndefined();
    stopButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onAbort).toHaveBeenCalledTimes(1);
    expect(container.querySelector('button[aria-label="New session"]')).toBeNull();
  });

  it("shows only processing dots while a run is active before stream text arrives", () => {
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          activeRun: true,
          stream: null,
        }),
      ),
      container,
    );

    expect(container.querySelector(".chat-reading-indicator")).not.toBeNull();
    expect(container.querySelector(".chat-group-status")).toBeNull();
    expect(container.querySelector('button[aria-label="Stop"]')).not.toBeNull();
  });

  it("shows typing status only while typing is active", () => {
    const active = document.createElement("div");
    render(
      renderChat(
        createProps({
          stream: "hello",
          streamStartedAt: 1000,
          runPhase: "typing",
          typingActive: true,
        }),
      ),
      active,
    );
    expect(active.querySelector(".chat-group-status")?.textContent).toContain("Typing...");

    const idle = document.createElement("div");
    render(
      renderChat(
        createProps({
          stream: "hello",
          streamStartedAt: 1000,
          typingActive: false,
        }),
      ),
      idle,
    );
    expect(idle.querySelector(".chat-group-status")).toBeNull();
  });

  it("shows thinking status for an active assistant run before text arrives", () => {
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          activeRun: true,
          runPhase: "thinking",
          stream: null,
          streamStartedAt: 1000,
        }),
      ),
      container,
    );

    expect(container.querySelector(".chat-reading-indicator")).not.toBeNull();
    expect(container.querySelector(".chat-group-status")?.textContent).toContain("Thinking...");
  });

  it("keeps the active processing bubble at the visible tail with transcript history", () => {
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: "/reset" }],
              timestamp: 10,
            },
            {
              role: "system",
              idempotencyKey: "run-1:effective-user-message",
              content: [{ type: "text", text: "Bootstrap prompt" }],
              timestamp: 20,
            },
            {
              role: "assistant",
              content: [{ type: "text", text: "Later history row" }],
              timestamp: 40,
            },
          ],
          activeRun: true,
          runPhase: "processing",
          stream: null,
          streamStartedAt: 30,
        }),
      ),
      container,
    );

    const groups = Array.from(container.querySelectorAll(".chat-group"));
    expect(groups).toHaveLength(4);
    expect(groups[0]?.textContent ?? "").toContain("/reset");
    expect(groups[1]?.textContent ?? "").toContain("Bootstrap prompt");
    expect(groups[2]?.textContent ?? "").toContain("Later history row");
    expect(groups[3]?.querySelector(".chat-reading-indicator")).not.toBeNull();
  });

  it("does not repeat the assistant avatar when active assistant work continues after an assistant group", () => {
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "First reply." }],
              timestamp: 1000,
            },
          ],
          activeRun: true,
          runPhase: "thinking",
          stream: null,
          streamStartedAt: 2000,
        }),
      ),
      container,
    );

    expect(container.querySelectorAll(".chat-avatar.assistant")).toHaveLength(1);
    expect(container.querySelector(".chat-group--continuation")).not.toBeNull();
  });

  it("renders mention suggestions and inserts the selected mention", () => {
    const container = document.createElement("div");
    const onDraftChange = vi.fn();
    render(
      renderChat(
        createProps({
          draft: "hey @front",
          mentionSuggestions: [
            {
              id: "frontend_engineer",
              mention: "@frontend_engineer",
              name: "Frontend Engineer",
              emoji: "🖥️",
              color: "#22c55e",
            },
          ],
          mentionSelectedIndex: 0,
          mentionRangeStart: 4,
          mentionRangeEnd: 10,
          onDraftChange,
        }),
      ),
      container,
    );

    expect(container.querySelector(".chat-mention-menu__mention")?.textContent).toContain(
      "@frontend_engineer",
    );
    container
      .querySelector<HTMLButtonElement>(".chat-mention-menu__item")
      ?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

    expect(onDraftChange).toHaveBeenCalledWith(
      "hey @frontend_engineer ",
      "hey @frontend_engineer ".length,
      "hey @frontend_engineer ".length,
    );
  });

  it("shows a new session button when aborting is unavailable", () => {
    const container = document.createElement("div");
    const onNewSession = vi.fn();
    render(
      renderChat(
        createProps({
          canAbort: false,
          onNewSession,
        }),
      ),
      container,
    );

    const newSessionButton = container.querySelector('button[aria-label="New session"]');
    expect(newSessionButton).not.toBeUndefined();
    newSessionButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onNewSession).toHaveBeenCalledTimes(1);
    expect(container.querySelector('button[aria-label="Stop"]')).toBeNull();
  });

  it("dedupes live tool card when assistant final embeds same tool card without top-level id", () => {
    const container = document.createElement("div");
    const ts = Date.now();
    render(
      renderChat(
        createProps({
          showThinking: true,
          shouldEmitToolResult: true,
          shouldEmitToolOutput: true,
          messages: [
            {
              role: "assistant",
              timestamp: ts,
              content: [
                { type: "text", text: "Done." },
                { type: "toolcall", name: "discover_teammates", arguments: {} },
                { type: "toolresult", name: "discover_teammates", text: "result text" },
              ],
            },
          ],
          toolMessages: [
            {
              role: "assistant",
              timestamp: ts,
              toolCallId: "live-tool-1",
              content: [
                { type: "toolcall", name: "discover_teammates", arguments: {} },
                { type: "toolresult", name: "discover_teammates", text: "result text" },
              ],
            },
          ],
        }),
      ),
      container,
    );
    expect(container.querySelectorAll(".chat-tool-card")).toHaveLength(1);
  });

  it("keeps a live tool card when history only has the pending tool call", () => {
    const container = document.createElement("div");
    const ts = Date.now();
    render(
      renderChat(
        createProps({
          showThinking: true,
          shouldEmitToolResult: true,
          shouldEmitToolOutput: true,
          messages: [
            {
              role: "assistant",
              timestamp: ts,
              toolCallId: "discover-pending-1",
              runId: "run-1",
              content: [{ type: "toolcall", name: "discover_teammates", arguments: {} }],
            },
          ],
          toolMessages: [
            {
              role: "assistant",
              timestamp: ts + 1000,
              toolCallId: "discover-pending-1",
              runId: "run-1",
              content: [
                { type: "toolcall", name: "discover_teammates", arguments: {} },
                { type: "toolresult", name: "discover_teammates", text: "Found 3 teammates." },
              ],
            },
          ],
        }),
      ),
      container,
    );

    const toolCards = container.querySelectorAll(".chat-tool-card");
    expect(toolCards).toHaveLength(1);
    expect(toolCards[0]?.textContent ?? "").toContain("Found 3 teammates.");
  });

  it("groups assistant text and assistant-owned tool rows from the same run under one avatar", () => {
    const container = document.createElement("div");
    const ts = Date.now();
    render(
      renderChat(
        createProps({
          messages: [
            {
              role: "assistant",
              runId: "run-group-1",
              timestamp: ts,
              content: [{ type: "text", text: "I am checking the files." }],
            },
            {
              role: "toolResult",
              runId: "run-group-1",
              timestamp: ts + 1000,
              toolCallId: "tool-group-1",
              toolName: "read",
              content: [{ type: "text", text: "content" }],
            },
          ],
        }),
      ),
      container,
    );

    expect(container.querySelectorAll(".chat-avatar.assistant")).toHaveLength(1);
    expect(container.querySelectorAll(".chat-group-footer")).toHaveLength(1);
  });

  it("keeps active processing attached to the same assistant run", () => {
    const container = document.createElement("div");
    const ts = Date.now();
    render(
      renderChat(
        createProps({
          chatRunId: "run-group-live-1",
          messages: [
            {
              role: "assistant",
              runId: "run-group-live-1",
              timestamp: ts,
              content: [{ type: "text", text: "I am checking the files." }],
            },
            {
              role: "toolResult",
              runId: "run-group-live-1",
              timestamp: ts + 1000,
              toolCallId: "tool-group-live-1",
              toolName: "read",
              content: [{ type: "text", text: "content" }],
            },
          ],
          activeRun: true,
          runPhase: "thinking",
          stream: null,
          streamStartedAt: ts + 2000,
        }),
      ),
      container,
    );

    expect(container.querySelectorAll(".chat-avatar.assistant")).toHaveLength(1);
    expect(container.querySelector(".chat-group--continuation")).not.toBeNull();
  });

  it("keeps tool-first active processing below the tool card even when the run started earlier", () => {
    const container = document.createElement("div");
    const ts = Date.now();
    render(
      renderChat(
        createProps({
          chatRunId: "run-tool-live-1",
          messages: [
            {
              role: "user",
              timestamp: ts,
              content: [{ type: "text", text: "Read the workspace files." }],
            },
          ],
          toolMessages: [
            {
              role: "assistant",
              runId: "run-tool-live-1",
              timestamp: ts + 1000,
              toolCallId: "tool-live-1",
              content: [
                { type: "toolcall", name: "read", arguments: { path: "SOUL.md" } },
                { type: "toolresult", name: "read", text: "content" },
              ],
            },
          ],
          activeRun: true,
          runPhase: "tool_running",
          stream: null,
          streamStartedAt: ts + 100,
        }),
      ),
      container,
    );

    const assistantGroups = Array.from(container.querySelectorAll(".chat-group.assistant"));
    expect(assistantGroups).toHaveLength(1);
    const toolCard = container.querySelector(".chat-tool-card");
    const processingDots = container.querySelector(".chat-reading-indicator");
    expect(toolCard).not.toBeNull();
    expect(processingDots).not.toBeNull();
    expect(
      toolCard?.compareDocumentPosition(processingDots as Node) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
    expect(container.querySelectorAll(".chat-avatar.assistant")).toHaveLength(1);
  });

  it("keeps live stream text below the latest tool card when text arrives after tool work starts", () => {
    const container = document.createElement("div");
    const ts = Date.now();
    render(
      renderChat(
        createProps({
          chatRunId: "run-tool-stream-1",
          messages: [
            {
              role: "user",
              timestamp: ts,
              content: [{ type: "text", text: "Check the docs and summarize." }],
            },
          ],
          toolMessages: [
            {
              role: "assistant",
              runId: "run-tool-stream-1",
              timestamp: ts + 1000,
              toolCallId: "tool-stream-1",
              content: [
                { type: "toolcall", name: "read", arguments: { path: "README.md" } },
                { type: "toolresult", name: "read", text: "summary source" },
              ],
            },
          ],
          stream: "Here is the summary.",
          streamStartedAt: ts + 100,
        }),
      ),
      container,
    );

    const assistantGroups = Array.from(container.querySelectorAll(".chat-group.assistant"));
    expect(assistantGroups).toHaveLength(1);
    const assistantGroupText = assistantGroups[0]?.textContent ?? "";
    const readIndex = assistantGroupText.indexOf("Read");
    const summaryIndex = assistantGroupText.indexOf("Here is the summary.");
    expect(readIndex).toBeGreaterThanOrEqual(0);
    expect(summaryIndex).toBeGreaterThan(readIndex);
    expect(container.querySelectorAll(".chat-avatar.assistant")).toHaveLength(1);
  });

  it("keeps abort partial assistant text inside the same tool thread for a run", () => {
    const container = document.createElement("div");
    const ts = Date.now();
    render(
      renderChat(
        createProps({
          messages: [
            {
              role: "assistant",
              runId: "run-abort-1",
              idempotencyKey: "run-abort-1:assistant",
              openclawAbort: { aborted: true, runId: "run-abort-1" },
              timestamp: ts + 1000,
              content: [{ type: "text", text: "Partial answer" }],
            },
          ],
          toolMessages: [
            {
              role: "assistant",
              runId: "run-abort-1",
              timestamp: ts,
              toolCallId: "tool-abort-1",
              content: [
                { type: "toolcall", name: "read", arguments: { path: "USER.md" } },
                { type: "toolresult", name: "read", text: "content" },
              ],
            },
          ],
        }),
      ),
      container,
    );

    expect(container.querySelectorAll(".chat-avatar.assistant")).toHaveLength(1);
    expect(container.querySelectorAll(".chat-group-footer")).toHaveLength(1);
    expect(container.textContent ?? "").toContain("Partial answer");
    expect(container.querySelectorAll(".chat-tool-card")).toHaveLength(1);
  });

  it("recovers run id from assistant transcript metadata when top-level runId is missing", () => {
    const container = document.createElement("div");
    const ts = Date.now();
    render(
      renderChat(
        createProps({
          chatRunId: "run-recovered-1",
          messages: [
            {
              role: "assistant",
              idempotencyKey: "run-recovered-1:assistant",
              timestamp: ts,
              content: [{ type: "text", text: "Recovered from transcript metadata." }],
            },
          ],
          activeRun: true,
          runPhase: "thinking",
          stream: null,
          streamStartedAt: ts + 1000,
        }),
      ),
      container,
    );

    expect(container.querySelectorAll(".chat-avatar.assistant")).toHaveLength(1);
    expect(container.querySelector(".chat-group--continuation")).not.toBeNull();
  });

  it("renders a single tool card when one message contains toolcall + toolresult", () => {
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          showThinking: true,
          shouldEmitToolResult: true,
          shouldEmitToolOutput: true,
          messages: [],
          toolMessages: [
            {
              role: "assistant",
              timestamp: Date.now(),
              toolCallId: "live-tool-paired",
              content: [
                { type: "toolcall", name: "discover_teammates", arguments: { team: "frontend" } },
                { type: "toolresult", name: "discover_teammates", text: "Found 3 teammates." },
              ],
            },
          ],
        }),
      ),
      container,
    );

    const toolCards = container.querySelectorAll(".chat-tool-card");
    expect(toolCards).toHaveLength(1);
    expect(toolCards[0]?.textContent ?? "").toContain("Found 3 teammates.");
  });

  it("renders live tool cards even when reasoning UI is disabled", () => {
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          showThinking: false,
          shouldEmitToolResult: true,
          shouldEmitToolOutput: true,
          messages: [],
          toolMessages: [
            {
              role: "assistant",
              timestamp: Date.now(),
              toolCallId: "live-tool-visible",
              content: [
                { type: "toolcall", name: "read", arguments: { file: "USER.md" } },
                { type: "toolresult", name: "read", text: "content" },
              ],
            },
          ],
        }),
      ),
      container,
    );

    expect(container.querySelectorAll(".chat-tool-card")).toHaveLength(1);
  });

  it("drops pending-only history tool row when same tool key later has output", () => {
    const container = document.createElement("div");
    const ts = Date.now();
    render(
      renderChat(
        createProps({
          showThinking: true,
          shouldEmitToolResult: true,
          shouldEmitToolOutput: true,
          messages: [
            {
              role: "assistant",
              timestamp: ts,
              toolCallId: "discover-1",
              runId: "run-1",
              content: [{ type: "toolcall", name: "discover_teammates", arguments: {} }],
            },
            {
              role: "assistant",
              timestamp: ts + 1000,
              toolCallId: "discover-1",
              runId: "run-1",
              content: [
                { type: "toolcall", name: "discover_teammates", arguments: {} },
                { type: "toolresult", name: "discover_teammates", text: "Found 3 teammates." },
              ],
            },
          ],
        }),
      ),
      container,
    );

    const toolCards = container.querySelectorAll(".chat-tool-card");
    expect(toolCards).toHaveLength(1);
    expect(toolCards[0]?.textContent ?? "").toContain("Found 3 teammates.");
  });

  it("normalizes history rows without tool ids so call/result map to one card", () => {
    const container = document.createElement("div");
    const ts = Date.now();
    render(
      renderChat(
        createProps({
          showThinking: true,
          shouldEmitToolResult: true,
          shouldEmitToolOutput: true,
          messages: [
            {
              role: "assistant",
              runId: "run-1",
              timestamp: ts,
              content: [{ type: "toolcall", name: "discover_teammates", arguments: {} }],
            },
            {
              role: "assistant",
              runId: "run-1",
              timestamp: ts + 1000,
              content: [
                { type: "toolcall", name: "discover_teammates", arguments: {} },
                { type: "toolresult", name: "discover_teammates", text: "Found 3 teammates." },
              ],
            },
          ],
        }),
      ),
      container,
    );

    const toolCards = container.querySelectorAll(".chat-tool-card");
    expect(toolCards).toHaveLength(1);
    expect(toolCards[0]?.textContent ?? "").toContain("Found 3 teammates.");
  });

  it("reuses pending history tool id when a later output row is missing id", () => {
    const container = document.createElement("div");
    const ts = Date.now();
    render(
      renderChat(
        createProps({
          showThinking: true,
          shouldEmitToolResult: true,
          shouldEmitToolOutput: true,
          messages: [
            {
              role: "assistant",
              runId: "run-1",
              timestamp: ts,
              toolCallId: "tool-live-id-1",
              content: [{ type: "toolcall", name: "discover_teammates", arguments: {} }],
            },
            {
              role: "assistant",
              runId: "run-1",
              timestamp: ts + 1000,
              content: [
                { type: "toolcall", name: "discover_teammates", arguments: {} },
                { type: "toolresult", name: "discover_teammates", text: "Found 3 teammates." },
              ],
            },
          ],
        }),
      ),
      container,
    );

    const toolCards = container.querySelectorAll(".chat-tool-card");
    expect(toolCards).toHaveLength(1);
    expect(toolCards[0]?.textContent ?? "").toContain("Found 3 teammates.");
  });

  it("links assistant toolCall content.id with toolResult toolCallId and renders one tool card", () => {
    const container = document.createElement("div");
    const ts = Date.now();
    render(
      renderChat(
        createProps({
          showThinking: true,
          shouldEmitToolResult: true,
          shouldEmitToolOutput: true,
          messages: [
            {
              role: "assistant",
              timestamp: ts,
              content: [
                { type: "toolCall", id: "952872387", name: "discover_teammates", arguments: {} },
              ],
            },
            {
              role: "toolResult",
              timestamp: ts + 1000,
              toolCallId: "952872387",
              toolName: "discover_teammates",
              content: [{ type: "text", text: "Found 3 teammates." }],
            },
          ],
        }),
      ),
      container,
    );

    expect(container.querySelectorAll(".chat-tool-card")).toHaveLength(1);
    expect(container.querySelectorAll(".chat-text")).toHaveLength(0);
  });

  it("prefers canonical tool invocations and strips embedded history tool blocks", () => {
    const container = document.createElement("div");
    const ts = Date.now();
    render(
      renderChat(
        createProps({
          showThinking: true,
          shouldEmitToolResult: true,
          shouldEmitToolOutput: true,
          messages: [
            {
              role: "assistant",
              timestamp: ts,
              content: [
                { type: "text", text: "Done." },
                { type: "toolcall", name: "discover_teammates", arguments: {} },
                { type: "toolresult", name: "discover_teammates", text: "Found 3 teammates." },
              ],
            },
          ],
          toolMessages: [
            {
              role: "assistant",
              timestamp: ts,
              toolCallId: "discover-1",
              __openclaw: { canonicalToolInvocation: true },
              content: [
                { type: "toolcall", name: "discover_teammates", arguments: {} },
                { type: "toolresult", name: "discover_teammates", text: "Found 3 teammates." },
              ],
            },
          ],
        }),
      ),
      container,
    );

    expect(container.querySelectorAll(".chat-tool-card")).toHaveLength(1);
    expect(container.textContent ?? "").toContain("Done.");
  });
});
