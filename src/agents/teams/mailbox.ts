import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { MessagePriority, TeamMessage } from "./types.js";
import { loadJsonFile, saveJsonFile } from "../../infra/json-file.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { getTeam } from "./team-registry.js";
import { resolveTeamBasePath } from "./team-registry.store.js";

/**
 * Send a direct message to a teammate.
 */
export function sendMessage(params: {
  teamId: string;
  from: string; // teammateId or "lead"
  to: string; // teammateId
  message: string;
  priority?: MessagePriority;
}): TeamMessage {
  const messageId = crypto.randomUUID();
  const now = Date.now();

  const teamMessage: TeamMessage = {
    messageId,
    teamId: params.teamId,
    from: params.from,
    to: params.to,
    message: params.message,
    priority: params.priority ?? "normal",
    createdAt: now,
  };

  // Write to disk
  writeMessage(params.teamId, teamMessage);

  // Deliver to recipient via system event
  const team = getTeam(params.teamId);
  if (team) {
    const recipientSessionKey = findRecipientSessionKey(team, params.to);
    if (recipientSessionKey) {
      deliverMessage(recipientSessionKey, teamMessage);
    }
  }

  return teamMessage;
}

/**
 * Broadcast a message to all teammates.
 */
export function broadcastMessage(params: {
  teamId: string;
  from: string; // teammateId or "lead"
  message: string;
  priority?: MessagePriority;
  excludeSelf?: boolean;
}): { messageId: string; deliveredTo: string[] } {
  const messageId = crypto.randomUUID();
  const now = Date.now();

  const teamMessage: TeamMessage = {
    messageId,
    teamId: params.teamId,
    from: params.from,
    to: "all",
    message: params.message,
    priority: params.priority ?? "normal",
    createdAt: now,
  };

  // Write to disk
  writeMessage(params.teamId, teamMessage);

  // Deliver to all active teammates
  const deliveredTo: string[] = [];
  const team = getTeam(params.teamId);
  if (team) {
    // Deliver to teammates
    for (const teammate of Object.values(team.teammates)) {
      if (params.excludeSelf && teammate.teammateId === params.from) {
        continue;
      }
      if (teammate.status === "active" || teammate.status === "idle") {
        deliverMessage(teammate.sessionKey, teamMessage);
        deliveredTo.push(teammate.teammateId);
      }
    }

    // Deliver to lead if not the sender
    if (params.from !== "lead") {
      deliverMessage(team.leadSessionKey, teamMessage);
      deliveredTo.push("lead");
    }
  }

  return { messageId, deliveredTo };
}

/**
 * Read messages for a recipient.
 * Note: Messages are delivered immediately via system events, so this is primarily for historical/audit purposes.
 */
export function readMessages(params: {
  teamId: string;
  recipientId: string; // teammateId or "lead"
}): TeamMessage[] {
  const mailboxDir = resolveMailboxDir(params.teamId);

  if (!fs.existsSync(mailboxDir)) {
    return [];
  }

  const messages: TeamMessage[] = [];

  try {
    const files = fs.readdirSync(mailboxDir);
    for (const file of files) {
      if (!file.endsWith(".json")) {
        continue;
      }

      const filePath = path.join(mailboxDir, file);
      const raw = loadJsonFile(filePath);
      if (!raw || typeof raw !== "object") {
        continue;
      }

      const message = raw as TeamMessage;

      // Filter by recipient
      if (message.to !== params.recipientId && message.to !== "all") {
        continue;
      }

      messages.push(message);
    }
  } catch {
    // Ignore read errors
  }

  // Sort by createdAt ascending (oldest first)
  messages.sort((a, b) => a.createdAt - b.createdAt);

  return messages;
}

/**
 * Clean up expired messages.
 * Deletes messages older than ttlHours.
 */
export function cleanupExpiredMessages(params: { teamId: string; ttlHours: number }): number {
  const mailboxDir = resolveMailboxDir(params.teamId);

  if (!fs.existsSync(mailboxDir)) {
    return 0;
  }

  const cutoffTime = Date.now() - params.ttlHours * 60 * 60 * 1000;
  let deletedCount = 0;

  try {
    const files = fs.readdirSync(mailboxDir);
    for (const file of files) {
      if (!file.endsWith(".json")) {
        continue;
      }

      const filePath = path.join(mailboxDir, file);
      const raw = loadJsonFile(filePath);
      if (!raw || typeof raw !== "object") {
        continue;
      }

      const message = raw as TeamMessage;

      // Delete messages older than TTL
      if (message.createdAt < cutoffTime) {
        try {
          fs.unlinkSync(filePath);
          deletedCount++;
        } catch {
          // Ignore delete errors
        }
      }
    }
  } catch {
    // Ignore read errors
  }

  return deletedCount;
}

// ---- Internal helper functions ----

/**
 * Resolve the mailbox directory for a team.
 */
function resolveMailboxDir(teamId: string): string {
  const basePath = resolveTeamBasePath();
  return path.join(basePath, teamId, "mailbox");
}

/**
 * Resolve the path for a specific message file.
 */
function resolveMessagePath(teamId: string, messageId: string): string {
  return path.join(resolveMailboxDir(teamId), `${messageId}.json`);
}

/**
 * Write a message to disk.
 */
function writeMessage(teamId: string, message: TeamMessage): void {
  const messagePath = resolveMessagePath(teamId, message.messageId);
  saveJsonFile(messagePath, message);
}

/**
 * Find the session key for a recipient ID.
 */
function findRecipientSessionKey(
  team: {
    leadSessionKey: string;
    teammates: Record<string, { teammateId: string; sessionKey: string }>;
  },
  recipientId: string,
): string | null {
  if (recipientId === "lead") {
    return team.leadSessionKey;
  }

  const teammate = team.teammates[recipientId];
  if (teammate) {
    return teammate.sessionKey;
  }

  return null;
}

/**
 * Deliver a message via system event.
 */
function deliverMessage(recipientSessionKey: string, msg: TeamMessage): void {
  const prefix = msg.priority === "urgent" ? "[URGENT] " : "";
  const fromLabel = msg.from === "lead" ? "Team Lead" : msg.from;
  const text = `${prefix}From ${fromLabel}: ${msg.message}`;

  enqueueSystemEvent(text, {
    sessionKey: recipientSessionKey,
  });
}
