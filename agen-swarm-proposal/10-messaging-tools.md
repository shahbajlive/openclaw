# Task 10: Messaging Tools

**Layer:** 2 (Tools)
**Dependencies:** Task 04 (team registry), Task 06 (mailbox)
**Can run in parallel with:** Task 08, Task 09, Task 11

## What to Do

Create two tools for inter-teammate communication: `teammate_message` and `teammate_broadcast`.

## Files to Create

### 1. `src/agents/tools/teammate-message-tool.ts`

Tool name: `teammate_message`
Who uses it: Lead + Teammates

```typescript
import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";
import { loadConfig } from "../../config/config.js";
import {
  getTeam,
  getTeammateBySessionKey,
  resolveCallerTeamContext,
} from "../teams/team-registry.js";
import { sendMessage } from "../teams/mailbox.js";

const TeammateMessageSchema = Type.Object({
  teamId: Type.String(),
  to: Type.String(), // teammateId
  message: Type.String(),
  priority: Type.Optional(Type.String()), // "normal" | "urgent"
  waitForReply: Type.Optional(Type.Boolean()),
  timeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
});

export function createTeammateMessageTool(opts?: { agentSessionKey?: string }): AnyAgentTool {
  return {
    label: "Teams",
    name: "teammate_message",
    description: "Send a direct message to a specific teammate in your team.",
    parameters: TeammateMessageSchema,
    execute: async (_toolCallId, args) => {
      // 1. Check teams enabled
      const cfg = loadConfig();
      if (!cfg.gateway?.teams?.enabled) {
        return jsonResult({ status: "error", error: "Teams are not enabled." });
      }

      // 2. Get team from registry
      const params = args as Record<string, unknown>;
      const teamId = readStringParam(params, "teamId", { required: true });
      const team = getTeam(teamId);
      if (!team) {
        return jsonResult({ status: "error", error: "Team not found." });
      }

      // 3. Determine sender identity (lead or teammateId)
      const callerContext = resolveCallerTeamContext(opts?.agentSessionKey ?? "");
      if (!callerContext) {
        return jsonResult({ status: "error", error: "You are not a member of this team." });
      }
      const fromId = callerContext.isLead
        ? "lead"
        : (callerContext.teammate?.teammateId ?? "unknown");

      // 4. Find recipient teammate
      const toId = readStringParam(params, "to", { required: true });
      const recipient = team.teammates[toId];
      if (!recipient) {
        return jsonResult({ status: "error", error: `Teammate "${toId}" not found.` });
      }

      // 5. Send message via mailbox
      const priority = params.priority === "urgent" ? "urgent" : "normal";
      const msg = sendMessage({
        teamId,
        from: fromId,
        to: toId,
        message: readStringParam(params, "message", { required: true }),
        priority,
        recipientSessionKey: recipient.sessionKey,
      });

      // 6. Return result
      return jsonResult({
        messageId: msg.messageId,
        delivered: true,
      });

      // Note: waitForReply is a future enhancement.
      // For v1, messages are async (fire and forget + system event injection).
    },
  };
}
```

### 2. `src/agents/tools/teammate-broadcast-tool.ts`

Tool name: `teammate_broadcast`
Who uses it: Lead + Teammates

```typescript
const TeammateBroadcastSchema = Type.Object({
  teamId: Type.String(),
  message: Type.String(),
  priority: Type.Optional(Type.String()), // "normal" | "urgent"
  excludeSelf: Type.Optional(Type.Boolean()),
});

export function createTeammateBroadcastTool(opts?: { agentSessionKey?: string }): AnyAgentTool {
  return {
    label: "Teams",
    name: "teammate_broadcast",
    description: "Send a message to all active teammates in your team.",
    parameters: TeammateBroadcastSchema,
    execute: async (_toolCallId, args) => {
      // 1. Check teams enabled
      // 2. Get team from registry
      // 3. Determine sender identity (lead or teammateId)
      // 4. Call broadcastMessage from mailbox
      //    - Pass all active teammate session keys for delivery
      //    - excludeSelf: if true, skip the sender
      // 5. Return { messageId, deliveredTo: [...teammateIds] }
    },
  };
}
```

## How Messages Get Delivered

The mailbox (Task 06) calls `enqueueSystemEvent()` from `src/infra/system-events.ts`. This injects the message into the recipient's next agent turn as a system-level message. The recipient sees it in their context and can respond.

Flow:

```
sender calls teammate_message
  -> mailbox.sendMessage() writes file + enqueueSystemEvent(recipientSessionKey)
  -> recipient's next turn includes the message as system context
  -> recipient can call teammate_message back (or just continue working)
```

## Reference Files

- `src/agents/teams/mailbox.ts` (Task 06) -- `sendMessage`, `broadcastMessage`
- `src/agents/teams/team-registry.ts` (Task 04) -- `getTeam`, `resolveCallerTeamContext`
- `src/infra/system-events.ts` -- `enqueueSystemEvent`
- `src/agents/tools/common.js` -- `jsonResult`, `readStringParam`, `AnyAgentTool`

## Notes

- `waitForReply` in the RFC is an advanced feature. For v1, implement it as a simple note in the response: "Message sent. Teammate will see it on their next turn." If you want to implement blocking wait, use `callGateway` with `agent.wait` pattern from `subagent-registry.ts` line 322.
- Messages are persistent (on disk) so they won't be lost if the recipient is busy.
- The `to` parameter on `teammate_message` accepts a `teammateId`. The tool needs to look up the recipient's `sessionKey` from the team registry to deliver via `enqueueSystemEvent`.
- Sending a message to `"lead"` should be supported -- look up `team.leadSessionKey`.

## Acceptance Criteria

- [ ] `teammate_message` sends a message to a specific teammate
- [ ] `teammate_message` resolves recipient's session key from registry
- [ ] `teammate_message` returns error if recipient not found
- [ ] `teammate_broadcast` delivers to all active teammates
- [ ] `teammate_broadcast` respects `excludeSelf` flag
- [ ] Messages are delivered via `enqueueSystemEvent`
- [ ] Messages are persisted to disk
- [ ] Both tools identify the sender correctly (lead or teammateId)
- [ ] `pnpm build` passes
