import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

function createStorageMock() {
  const data = new Map<string, string>();
  return {
    clear() {
      data.clear();
    },
    getItem(key: string) {
      return data.has(key) ? data.get(key)! : null;
    },
    key(index: number) {
      return Array.from(data.keys())[index] ?? null;
    },
    removeItem(key: string) {
      data.delete(key);
    },
    setItem(key: string, value: string) {
      data.set(key, value);
    },
    get length() {
      return data.size;
    },
  } as Storage;
}

vi.stubGlobal("localStorage", createStorageMock());

vi.mock("../ui/src/ui/controllers/chat.ts", () => ({
  abortChatRun: vi.fn(),
  enqueueChatMessage: vi.fn(),
  loadChatHistory: vi.fn(),
  popQueuedChatMessageForEdit: vi.fn(),
  removeQueuedChatMessage: vi.fn(),
  sendChatMessage: vi.fn(),
  sendQueuedChatMessageNow: vi.fn(),
}));

vi.mock("../ui/src/ui/controllers/sessions.ts", () => ({
  loadSessions: vi.fn(),
}));

vi.mock("../ui/src/ui/app-scroll.ts", () => ({
  scheduleChatScroll: vi.fn(),
}));

vi.mock("../ui/src/ui/app-settings.ts", () => ({
  setLastActiveSessionKey: vi.fn(),
}));

vi.mock("../ui/src/ui/app-tool-stream.ts", () => ({
  resetToolStream: vi.fn(),
}));

import { enqueueChatMessage, sendChatMessage } from "../ui/src/ui/controllers/chat.ts";

type ChatHost = import("../ui/src/ui/app-chat.ts").ChatHost;
let handleSendChat: typeof import("../ui/src/ui/app-chat.ts").handleSendChat;

beforeAll(async () => {
  ({ handleSendChat } = await import("../ui/src/ui/app-chat.ts"));
});

function createHost(overrides: Partial<ChatHost> = {}): ChatHost {
  return {
    client: { request: vi.fn() } as unknown as ChatHost["client"],
    connected: true,
    chatMessage: "",
    chatDraftSelectionStart: null,
    chatDraftSelectionEnd: null,
    chatMentionQuery: null,
    chatMentionStart: null,
    chatMentionEnd: null,
    chatMentionSelectedIndex: 0,
    chatAttachments: [],
    chatQueue: [],
    chatQueueRequestInFlight: false,
    chatRunId: null,
    chatResetInFlight: false,
    chatLastTerminalRunId: null,
    chatLastTerminalAt: null,
    chatSending: false,
    sessionKey: "main",
    basePath: "",
    hello: null,
    chatAvatarUrl: null,
    lastError: null,
    refreshSessionsAfterChat: new Set<string>(),
    ...overrides,
  };
}

describe("handleSendChat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("preserves a specific enqueue error instead of replacing it with the generic banner", async () => {
    vi.mocked(enqueueChatMessage).mockImplementation(async (state) => {
      state.lastError = "TypeError: backend failed";
      return false;
    });

    const host = createHost({
      chatRunId: "run-1",
      chatSending: true,
      chatMessage: "retry",
    });

    await handleSendChat(host);

    expect(host.lastError).toBe("TypeError: backend failed");
  });

  it("keeps the backend queue item visible after busy enqueue succeeds", async () => {
    vi.mocked(enqueueChatMessage).mockImplementation(async (state, message, opts) => {
      state.chatQueue = [
        {
          id: opts?.idempotencyKey ?? "queued-1",
          text: message,
          createdAt: 123,
          source: "backend",
          editable: true,
          sendable: true,
        },
      ];
      return true;
    });

    const host = createHost({
      chatRunId: "run-1",
      chatSending: true,
      chatMessage: "retry",
    });

    await handleSendChat(host);

    expect(host.chatQueue).toEqual([
      expect.objectContaining({
        id: expect.any(String),
        text: "retry",
        source: "backend",
      }),
    ]);
  });

  it("queues a follow-up send while still waiting for the first started event", async () => {
    vi.mocked(sendChatMessage).mockImplementation(async (state) => {
      state.chatSending = true;
      return "run-1";
    });
    vi.mocked(enqueueChatMessage).mockImplementation(async (state, message, opts) => {
      state.chatQueue = [
        {
          id: opts?.idempotencyKey ?? "queued-1",
          text: message,
          createdAt: 123,
          source: "backend",
          editable: true,
          sendable: true,
        },
      ];
      return true;
    });

    const host = createHost({
      chatMessage: "find your mates",
    });

    await handleSendChat(host);
    host.chatMessage = "retry";
    await handleSendChat(host);

    expect(sendChatMessage).toHaveBeenCalledTimes(1);
    expect(enqueueChatMessage).toHaveBeenCalledTimes(1);
    expect(host.chatQueue).toEqual([
      expect.objectContaining({
        text: "retry",
        source: "backend",
      }),
    ]);
  });
});
