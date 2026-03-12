const CHAT_RUNTIME_KEY = "openclaw.control.chat-runtime.v1";
const CHAT_RUNTIME_MAX_AGE_MS = 30 * 60 * 1000;

type PersistedChatRuntimeState = {
  sessionKey: string;
  runId: string;
  stream: string;
  phase: "processing" | "thinking" | "typing" | "tool_running" | null;
  streamStartedAt: number | null;
  streamCommittedPrefixLength: number;
  updatedAt: number;
};

export type ChatRuntimeState = {
  runId: string;
  stream: string;
  phase: "processing" | "thinking" | "typing" | "tool_running" | null;
  streamStartedAt: number | null;
  streamCommittedPrefixLength: number;
};

function getStorage(): Storage | null {
  if (typeof window !== "undefined" && window.localStorage) {
    return window.localStorage;
  }
  if (typeof localStorage !== "undefined") {
    return localStorage;
  }
  return null;
}

export function loadChatRuntimeState(sessionKey: string): ChatRuntimeState | null {
  const storage = getStorage();
  if (!storage) {
    return null;
  }
  try {
    const raw = storage.getItem(CHAT_RUNTIME_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<PersistedChatRuntimeState>;
    if (
      typeof parsed.sessionKey !== "string" ||
      parsed.sessionKey !== sessionKey ||
      typeof parsed.runId !== "string" ||
      !parsed.runId.trim() ||
      typeof parsed.stream !== "string" ||
      typeof parsed.updatedAt !== "number"
    ) {
      return null;
    }
    if (Date.now() - parsed.updatedAt > CHAT_RUNTIME_MAX_AGE_MS) {
      storage.removeItem(CHAT_RUNTIME_KEY);
      return null;
    }
    return {
      runId: parsed.runId.trim(),
      stream: parsed.stream,
      phase:
        parsed.phase === "thinking" ||
        parsed.phase === "typing" ||
        parsed.phase === "tool_running" ||
        parsed.phase === "processing"
          ? parsed.phase
          : "processing",
      streamStartedAt: typeof parsed.streamStartedAt === "number" ? parsed.streamStartedAt : null,
      streamCommittedPrefixLength:
        typeof parsed.streamCommittedPrefixLength === "number" &&
        parsed.streamCommittedPrefixLength >= 0
          ? parsed.streamCommittedPrefixLength
          : 0,
    };
  } catch {
    return null;
  }
}

export function persistChatRuntimeState(params: {
  sessionKey: string;
  runId: string | null;
  stream: string | null;
  phase?: "processing" | "thinking" | "typing" | "tool_running" | null;
  streamStartedAt: number | null;
  streamCommittedPrefixLength?: number;
}) {
  const storage = getStorage();
  if (!storage) {
    return;
  }
  const runId = params.runId?.trim() ?? "";
  if (!runId) {
    storage.removeItem(CHAT_RUNTIME_KEY);
    return;
  }
  const payload: PersistedChatRuntimeState = {
    sessionKey: params.sessionKey,
    runId,
    stream: typeof params.stream === "string" ? params.stream : "",
    phase: params.phase ?? "processing",
    streamStartedAt: typeof params.streamStartedAt === "number" ? params.streamStartedAt : null,
    streamCommittedPrefixLength:
      typeof params.streamCommittedPrefixLength === "number"
        ? Math.max(0, params.streamCommittedPrefixLength)
        : 0,
    updatedAt: Date.now(),
  };
  storage.setItem(CHAT_RUNTIME_KEY, JSON.stringify(payload));
}
