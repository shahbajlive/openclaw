# Task 06: Mailbox (Inter-Teammate Messaging)

**Layer:** 1 (Infrastructure)
**Dependencies:** Task 01 (types)
**Can run in parallel with:** Task 04, Task 05, Task 07

## What to Do

Create the mailbox system for async message passing between teammates. Messages are stored as individual JSON files on disk. They get delivered to teammates via `enqueueSystemEvent`.

## File to Create

### `src/agents/teams/mailbox.ts`

```typescript
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { TeamMessage, MessagePriority } from "./types.js";

// Key functions:

export function sendMessage(params: {
  teamId: string;
  from: string; // teammateId or "lead"
  to: string; // teammateId
  message: string;
  priority?: MessagePriority;
}): TeamMessage;
// 1. Generate UUID messageId
// 2. Create TeamMessage object
// 3. Write to ~/.openclaw/teams/{teamId}/mailbox/{messageId}.json
// 4. Deliver via enqueueSystemEvent (inject into recipient's next turn)
// 5. Return the message

export function broadcastMessage(params: {
  teamId: string;
  from: string; // teammateId or "lead"
  message: string;
  priority?: MessagePriority;
  excludeSelf?: boolean;
}): { messageId: string; deliveredTo: string[] };
// 1. Generate UUID messageId
// 2. Write message file with to="all"
// 3. Find all active teammates in the team (from team registry)
// 4. For each teammate (excluding sender if excludeSelf):
//    - Deliver via enqueueSystemEvent
// 5. Return messageId + list of teammate IDs delivered to

export function readMessages(params: {
  teamId: string;
  recipientId: string; // teammateId or "lead"
}): TeamMessage[];
// 1. Scan mailbox/ directory for message files
// 2. Filter: messages where to === recipientId or to === "all"
// 3. Filter: messages where read === false
// 4. Sort by createdAt ascending (oldest first)
// 5. Return unread messages

export function markRead(params: { teamId: string; messageId: string }): void;
// Load message file, set read=true, save back

export function cleanupExpiredMessages(params: { teamId: string; ttlHours: number }): number;
// Scan mailbox/ directory
// Delete message files older than ttlHours where read===true
// Return count of deleted messages
```

### Message delivery via `enqueueSystemEvent`

From `src/infra/system-events.ts` line 51:

```typescript
import { enqueueSystemEvent } from "../../infra/system-events.js";
```

When a message is sent, inject it into the recipient's next turn:

```typescript
function deliverMessage(recipientSessionKey: string, msg: TeamMessage): void {
  const prefix = msg.priority === "urgent" ? "[URGENT] " : "";
  const label = msg.to === "all" ? "Team Broadcast" : "Team Message";
  const text = `${prefix}From ${msg.from}: ${msg.message}`;
  enqueueSystemEvent(text, {
    sessionKey: recipientSessionKey,
    label,
  });
}
```

This is the same pattern used by hooks in `src/gateway/server/hooks.ts` and by the restart sentinel in `src/gateway/server-restart-sentinel.ts` line 29.

### File naming

Messages stored as: `~/.openclaw/teams/{teamId}/mailbox/{messageId}.json`

Where `messageId` is a UUID (e.g., `550e8400-e29b-41d4-a716-446655440000.json`).

### Helper to resolve paths

```typescript
function resolveMailboxDir(teamId: string): string {
  const basePath = resolveTeamBasePath(); // from team-registry.store.ts
  return path.join(basePath, teamId, "mailbox");
}

function resolveMessagePath(teamId: string, messageId: string): string {
  return path.join(resolveMailboxDir(teamId), `${messageId}.json`);
}
```

## Reference Files

- `src/infra/system-events.ts` line 51 -- `enqueueSystemEvent(text, options)`
- `src/gateway/server-restart-sentinel.ts` line 29 -- example of enqueueSystemEvent usage
- `src/gateway/server/hooks.ts` -- another example of system event injection
- Task 01 types for `TeamMessage`, `MessagePriority`

## Notes

- `sendMessage` and `broadcastMessage` need the recipient's session key to deliver via `enqueueSystemEvent`. The caller (messaging tools in Task 10) will look up session keys from the team registry.
- Messages are persistent (written to disk) so they survive if a teammate's context window is full and it can't process immediately.
- `cleanupExpiredMessages` should be called periodically (e.g., when reading messages) to keep the mailbox directory clean.
- The mailbox TTL comes from config: `gateway.teams.storage.mailboxTTLHours` (default: 24 hours).

## Acceptance Criteria

- [ ] `sendMessage` creates a JSON file in `mailbox/` and calls `enqueueSystemEvent`
- [ ] `broadcastMessage` creates one message file and delivers to all active teammates
- [ ] `readMessages` returns only unread messages for the given recipient
- [ ] `markRead` updates the message file
- [ ] `cleanupExpiredMessages` removes old read messages
- [ ] Messages survive if recipient is busy (persistent on disk)
- [ ] `pnpm build` passes
