import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function createStorageMock(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, String(value));
    },
  };
}

describe("loadSettings default gateway URL derivation", () => {
  let previousGatewayUrl: string | undefined;
  let previousGatewayToken: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("navigator", { language: "en-US" } as Navigator);
    previousGatewayUrl = import.meta.env.VITE_OPENCLAW_GATEWAY_URL;
    previousGatewayToken = import.meta.env.VITE_OPENCLAW_GATEWAY_TOKEN;
    import.meta.env.VITE_OPENCLAW_GATEWAY_URL = "";
    import.meta.env.VITE_OPENCLAW_GATEWAY_TOKEN = "";
  });

  afterEach(() => {
    import.meta.env.VITE_OPENCLAW_GATEWAY_URL = previousGatewayUrl;
    import.meta.env.VITE_OPENCLAW_GATEWAY_TOKEN = previousGatewayToken;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("uses configured base path and normalizes trailing slash", async () => {
    vi.stubGlobal("location", {
      protocol: "https:",
      host: "gateway.example:8443",
      pathname: "/ignored/path",
    } as Location);
    vi.stubGlobal("window", { __OPENCLAW_CONTROL_UI_BASE_PATH__: " /openclaw/ " } as Window &
      typeof globalThis);

    const { loadSettings } = await import("./storage.ts");
    expect(loadSettings().gatewayUrl).toBe("wss://gateway.example:8443/openclaw");
  });

  it("infers base path from nested pathname when configured base path is not set", async () => {
    vi.stubGlobal("location", {
      protocol: "http:",
      host: "gateway.example:18789",
      pathname: "/apps/openclaw/chat",
    } as Location);
    vi.stubGlobal("window", {} as Window & typeof globalThis);

    const { loadSettings } = await import("./storage.ts");
    expect(loadSettings().gatewayUrl).toBe("ws://gateway.example:18789/apps/openclaw");
  });

  it("hydrates the workspace messages sidebar collapse preference", async () => {
    vi.stubGlobal("location", {
      protocol: "http:",
      host: "gateway.example:18789",
      pathname: "/apps/openclaw/chat",
    } as Location);
    vi.stubGlobal("window", {} as Window & typeof globalThis);
    localStorage.setItem(
      "openclaw.control.settings.v1",
      JSON.stringify({ workspaceMessagesSidebarCollapsed: true }),
    );

    const { loadSettings } = await import("./storage.ts");
    expect(loadSettings().workspaceMessagesSidebarCollapsed).toBe(true);
  });

  it("prefers Vite env defaults for gateway URL and token", async () => {
    vi.stubGlobal("location", {
      protocol: "http:",
      host: "gateway.example:18789",
      pathname: "/apps/openclaw/chat",
    } as Location);
    vi.stubGlobal("window", {} as Window & typeof globalThis);

    const storageModule = await import("./storage.ts");
    import.meta.env.VITE_OPENCLAW_GATEWAY_URL = "ws://127.0.0.1:18789";
    import.meta.env.VITE_OPENCLAW_GATEWAY_TOKEN = "env-token";

    const { loadSettings } = storageModule;
    const settings = loadSettings();
    expect(settings.gatewayUrl).toBe("ws://127.0.0.1:18789");
    expect(settings.token).toBe("env-token");
  });
});
