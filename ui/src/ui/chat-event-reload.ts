export type ChatRecoveryReloadReason = "reconnect" | "seq-gap" | "manual" | "session-change";

export function shouldReloadHistoryForRecovery(reason: ChatRecoveryReloadReason): boolean {
  return (
    reason === "reconnect" ||
    reason === "seq-gap" ||
    reason === "manual" ||
    reason === "session-change"
  );
}
