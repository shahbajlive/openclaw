import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadChatRuntimeState, persistChatRuntimeState } from "./chat-runtime-state.ts";

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

describe("chat runtime state", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
  });

  it("persists and restores active chat runtime state", () => {
    persistChatRuntimeState({
      sessionKey: "main",
      runId: "run-1",
      stream: "partial",
      streamStartedAt: 123,
      streamCommittedPrefixLength: 4,
    });

    expect(loadChatRuntimeState("main")).toEqual({
      runId: "run-1",
      stream: "partial",
      streamStartedAt: 123,
      streamCommittedPrefixLength: 4,
    });
  });

  it("clears persisted runtime when runId is missing", () => {
    persistChatRuntimeState({
      sessionKey: "main",
      runId: "run-1",
      stream: "",
      streamStartedAt: null,
    });
    persistChatRuntimeState({
      sessionKey: "main",
      runId: null,
      stream: null,
      streamStartedAt: null,
    });

    expect(loadChatRuntimeState("main")).toBeNull();
  });
});
