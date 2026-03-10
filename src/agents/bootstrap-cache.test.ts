import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearAllBootstrapSnapshots,
  clearBootstrapSnapshot,
  getOrLoadBootstrapFiles,
} from "./bootstrap-cache.js";
import type { WorkspaceBootstrapFile } from "./workspace.js";

vi.mock("./workspace.js", () => ({
  loadWorkspaceBootstrapFiles: vi.fn(),
}));

import { loadWorkspaceBootstrapFiles } from "./workspace.js";

const mockLoad = vi.mocked(loadWorkspaceBootstrapFiles);

function makeFile(name: string, content: string): WorkspaceBootstrapFile {
  return {
    name: name as WorkspaceBootstrapFile["name"],
    path: `/ws/${name}`,
    content,
    missing: false,
  };
}

describe("getOrLoadBootstrapFiles", () => {
  const files = [makeFile("AGENTS.md", "# Agent"), makeFile("SOUL.md", "# Soul")];

  beforeEach(() => {
    clearAllBootstrapSnapshots();
    mockLoad.mockResolvedValue(files);
  });

  afterEach(() => {
    clearAllBootstrapSnapshots();
    vi.clearAllMocks();
  });

  it("loads from disk on first call and caches", async () => {
    const result = await getOrLoadBootstrapFiles({
      workspaceDir: "/ws",
      sessionKey: "session-1",
    });

    expect(result).toBe(files);
    expect(mockLoad).toHaveBeenCalledTimes(1);
  });

  it("returns cached result on second call", async () => {
    await getOrLoadBootstrapFiles({ workspaceDir: "/ws", sessionKey: "session-1" });
    const result = await getOrLoadBootstrapFiles({ workspaceDir: "/ws", sessionKey: "session-1" });

    expect(result).toBe(files);
    expect(mockLoad).toHaveBeenCalledTimes(1);
  });

  it("different session keys get independent caches", async () => {
    const files2 = [makeFile("AGENTS.md", "# Agent v2")];
    mockLoad.mockResolvedValueOnce(files).mockResolvedValueOnce(files2);

    const r1 = await getOrLoadBootstrapFiles({ workspaceDir: "/ws", sessionKey: "session-1" });
    const r2 = await getOrLoadBootstrapFiles({ workspaceDir: "/ws", sessionKey: "session-2" });

    expect(r1).toBe(files);
    expect(r2).toBe(files2);
    expect(mockLoad).toHaveBeenCalledTimes(2);
  });
});

describe("clearBootstrapSnapshot", () => {
  beforeEach(() => {
    clearAllBootstrapSnapshots();
    mockLoad.mockResolvedValue([makeFile("AGENTS.md", "content")]);
  });

  afterEach(() => {
    clearAllBootstrapSnapshots();
    vi.clearAllMocks();
  });

  it("clears a single session entry", async () => {
    await getOrLoadBootstrapFiles({ workspaceDir: "/ws", sessionKey: "sk" });
    clearBootstrapSnapshot("sk");

    // Next call should hit disk again.
    await getOrLoadBootstrapFiles({ workspaceDir: "/ws", sessionKey: "sk" });
    expect(mockLoad).toHaveBeenCalledTimes(2);
  });

  it("does not affect other sessions", async () => {
    await getOrLoadBootstrapFiles({ workspaceDir: "/ws", sessionKey: "sk1" });
    await getOrLoadBootstrapFiles({ workspaceDir: "/ws", sessionKey: "sk2" });

    clearBootstrapSnapshot("sk1");

    // sk2 should still be cached.
    await getOrLoadBootstrapFiles({ workspaceDir: "/ws", sessionKey: "sk2" });
    expect(mockLoad).toHaveBeenCalledTimes(2); // sk1 x1, sk2 x1
  });

  it("reloads workspace-root identity files after reset clears the snapshot", async () => {
    const workspaceOneFiles = [makeFile("SOUL.md", "# Workspace One")];
    const workspaceTwoFiles = [makeFile("SOUL.md", "# Workspace Two")];
    mockLoad.mockResolvedValueOnce(workspaceOneFiles).mockResolvedValueOnce(workspaceTwoFiles);

    const first = await getOrLoadBootstrapFiles({ workspaceDir: "/ws-one", sessionKey: "sk" });
    clearBootstrapSnapshot("sk");
    const second = await getOrLoadBootstrapFiles({ workspaceDir: "/ws-two", sessionKey: "sk" });

    expect(first).toBe(workspaceOneFiles);
    expect(second).toBe(workspaceTwoFiles);
    expect(mockLoad).toHaveBeenNthCalledWith(1, "/ws-one");
    expect(mockLoad).toHaveBeenNthCalledWith(2, "/ws-two");
  });
});
