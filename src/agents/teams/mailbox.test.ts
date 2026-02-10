import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { sendMessage, broadcastMessage, readMessages, cleanupExpiredMessages } from "./mailbox.js";
import { createTeam, addTeammate, resetTeamRegistryForTests } from "./team-registry.js";

// Must be declared before vi.mock so the closure captures the reference
let testBasePath = "";

vi.mock("./team-registry.store.js", () => ({
  resolveTeamBasePath: () => testBasePath,
  saveTeamToDisk: vi.fn(),
  loadAllTeamsFromDisk: vi.fn().mockReturnValue(new Map()),
}));

// Mock config (used by team-registry's persistTeam)
vi.mock("../../config/config.js", () => ({
  loadConfig: vi.fn().mockReturnValue({}),
}));

// Mock system events (used by mailbox's deliverMessage)
vi.mock("../../infra/system-events.js", () => ({
  enqueueSystemEvent: vi.fn(),
}));

// Mock agent events (used by team-registry's ensureListener)
vi.mock("../../infra/agent-events.js", () => ({
  onAgentEvent: vi.fn().mockReturnValue(() => {}),
}));

describe("mailbox", () => {
  let teamId: string;

  beforeEach(() => {
    resetTeamRegistryForTests();

    // Create a temp directory for test data
    testBasePath = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-mailbox-test-"));

    // Create a test team
    const team = createTeam({
      teamName: "test-team",
      leadSessionKey: "agent:main:main",
      config: { notifyOnUnblock: true },
    });
    teamId = team.teamId;

    // Create mailbox directory for the team
    fs.mkdirSync(path.join(testBasePath, teamId, "mailbox"), { recursive: true });

    // Add a teammate
    addTeammate(teamId, {
      teammateId: "tm1",
      role: "reviewer",
      sessionKey: "agent:team-x:teammate:reviewer-tm1",
      status: "active",
      requirePlanApproval: false,
      planApproved: false,
      claimedTasks: 0,
      completedTasks: 0,
      createdAt: Date.now(),
    });
  });

  afterEach(() => {
    if (testBasePath && fs.existsSync(testBasePath)) {
      fs.rmSync(testBasePath, { recursive: true, force: true });
    }
  });

  it("sends a message and writes to disk", () => {
    const message = sendMessage({
      teamId,
      from: "lead",
      to: "tm1",
      message: "Hello teammate!",
      priority: "normal",
    });

    expect(message.messageId).toBeTruthy();
    expect(message.from).toBe("lead");
    expect(message.to).toBe("tm1");
    expect(message.message).toBe("Hello teammate!");

    // Verify file was written
    const messagePath = path.join(testBasePath, teamId, "mailbox", `${message.messageId}.json`);
    expect(fs.existsSync(messagePath)).toBe(true);
  });

  it("broadcasts to all teammates", () => {
    // Add another teammate
    addTeammate(teamId, {
      teammateId: "tm2",
      role: "tester",
      sessionKey: "agent:team-x:teammate:tester-tm2",
      status: "active",
      requirePlanApproval: false,
      planApproved: false,
      claimedTasks: 0,
      completedTasks: 0,
      createdAt: Date.now(),
    });

    const result = broadcastMessage({
      teamId,
      from: "lead",
      message: "Team announcement!",
      priority: "normal",
    });

    expect(result.messageId).toBeTruthy();
    expect(result.deliveredTo).toContain("tm1");
    expect(result.deliveredTo).toContain("tm2");
  });

  it("broadcasts exclude sender when excludeSelf is true", () => {
    const result = broadcastMessage({
      teamId,
      from: "tm1",
      message: "Message from tm1",
      priority: "normal",
      excludeSelf: true,
    });

    expect(result.deliveredTo).not.toContain("tm1");
    expect(result.deliveredTo).toContain("lead");
  });

  it("reads messages for a recipient", () => {
    sendMessage({
      teamId,
      from: "lead",
      to: "tm1",
      message: "Message 1",
      priority: "normal",
    });

    sendMessage({
      teamId,
      from: "lead",
      to: "tm1",
      message: "Message 2",
      priority: "urgent",
    });

    const messages = readMessages({
      teamId,
      recipientId: "tm1",
    });

    expect(messages).toHaveLength(2);
    // Sorted by createdAt ascending
    expect(messages.map((m) => m.message)).toContain("Message 1");
    expect(messages.map((m) => m.message)).toContain("Message 2");
  });

  it("does not return messages addressed to other recipients", () => {
    sendMessage({
      teamId,
      from: "lead",
      to: "tm1",
      message: "For tm1",
      priority: "normal",
    });

    sendMessage({
      teamId,
      from: "lead",
      to: "tm2",
      message: "For tm2",
      priority: "normal",
    });

    const messages = readMessages({
      teamId,
      recipientId: "tm1",
    });

    expect(messages).toHaveLength(1);
    expect(messages[0].message).toBe("For tm1");
  });

  it("cleans up expired messages", () => {
    const message = sendMessage({
      teamId,
      from: "lead",
      to: "tm1",
      message: "Old message",
      priority: "normal",
    });

    // Backdate the message's createdAt so it's older than the TTL cutoff.
    // Write the message file directly with an old timestamp.
    const messagePath = path.join(testBasePath, teamId, "mailbox", `${message.messageId}.json`);
    const raw = JSON.parse(fs.readFileSync(messagePath, "utf8"));
    raw.createdAt = Date.now() - 2 * 60 * 60 * 1000; // 2 hours ago
    fs.writeFileSync(messagePath, JSON.stringify(raw, null, 2));

    // Clean up messages older than 1 hour — our backdated message qualifies
    const deletedCount = cleanupExpiredMessages({
      teamId,
      ttlHours: 1,
    });

    expect(deletedCount).toBe(1);
    expect(fs.existsSync(messagePath)).toBe(false);
  });

  it("filters broadcast messages by recipient", () => {
    broadcastMessage({
      teamId,
      from: "lead",
      message: "Broadcast message",
      priority: "normal",
    });

    const messages = readMessages({
      teamId,
      recipientId: "tm1",
    });

    expect(messages.length).toBeGreaterThan(0);
    expect(messages[0].to).toBe("all");
  });

  it("returns empty array when no messages exist", () => {
    const messages = readMessages({
      teamId,
      recipientId: "tm1",
    });

    expect(messages).toHaveLength(0);
  });
});
