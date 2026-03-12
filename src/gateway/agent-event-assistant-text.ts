import type { AgentEventPayload } from "../infra/agent-events.js";

export function resolveAssistantStreamDeltaText(evt: AgentEventPayload): string {
  if (evt.eventType !== "activity.output" || evt.kind !== "assistant_message") {
    return "";
  }
  const delta = evt.output.delta;
  const text = evt.output.text;
  return typeof delta === "string" ? delta : typeof text === "string" ? text : "";
}
