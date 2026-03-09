import type { ChatEventPayload } from "./controllers/chat.ts";

export function shouldReloadHistoryForFinalEvent(payload: ChatEventPayload | undefined): boolean {
  if (!payload || payload.state !== "final") {
    return false;
  }
  return payload.message === undefined;
}

export type ChatRecoveryReloadReason = "reconnect" | "seq-gap" | "manual" | "session-change";

export function shouldReloadHistoryForRecovery(reason: ChatRecoveryReloadReason): boolean {
  return (
    reason === "reconnect" ||
    reason === "seq-gap" ||
    reason === "manual" ||
    reason === "session-change"
  );
}
