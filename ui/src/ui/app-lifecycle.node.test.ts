import { describe, expect, it, vi } from "vitest";
import { handleDisconnected } from "./app-lifecycle.ts";

const traceUiWsMock = vi.hoisted(() => vi.fn());

vi.mock("./ws-trace.ts", () => ({
  traceUiWs: traceUiWsMock,
}));

vi.hoisted(() => {
  Object.defineProperty(globalThis, "window", {
    value: {
      removeEventListener: vi.fn(),
    },
    configurable: true,
  });
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    },
    configurable: true,
  });
});

function createHost() {
  return {
    basePath: "",
    client: { stop: vi.fn() },
    connectGeneration: 0,
    connected: true,
    tab: "chat",
    assistantName: "OpenClaw",
    assistantAvatar: null,
    assistantAgentId: null,
    chatHasAutoScrolled: false,
    chatManualRefreshInFlight: false,
    chatLoading: false,
    chatMessages: [],
    chatToolMessages: [],
    chatStream: null,
    logsAutoFollow: false,
    logsAtBottom: true,
    logsEntries: [],
    popStateHandler: vi.fn(),
    topbarObserver: { disconnect: vi.fn() } as unknown as ResizeObserver,
  };
}

describe("handleDisconnected", () => {
  it("stops and clears gateway client on teardown", () => {
    const removeSpy = vi.spyOn(window, "removeEventListener").mockImplementation(() => undefined);
    const host = createHost();
    const disconnectSpy = (
      host.topbarObserver as unknown as { disconnect: ReturnType<typeof vi.fn> }
    ).disconnect;

    handleDisconnected(host as unknown as Parameters<typeof handleDisconnected>[0]);

    expect(removeSpy).toHaveBeenCalledWith("popstate", host.popStateHandler);
    expect(host.connectGeneration).toBe(1);
    expect(host.client).toBeNull();
    expect(host.connected).toBe(false);
    expect(disconnectSpy).toHaveBeenCalledTimes(1);
    expect(host.topbarObserver).toBeNull();
    expect(traceUiWsMock).toHaveBeenCalledWith(
      expect.objectContaining({ event: "app.handleDisconnected" }),
    );
    removeSpy.mockRestore();
  });
});
