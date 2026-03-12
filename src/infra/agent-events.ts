import type { VerboseLevel } from "../auto-reply/thinking.js";
import type { InputProvenance } from "../sessions/input-provenance.js";

export type AgentActivityKind =
  | "assistant_message"
  | "reasoning"
  | "tool_call"
  | "subagent_call"
  | "peer_agent_call"
  | "command"
  | "file_change"
  | "web_search"
  | "compaction"
  | (string & {});

export type AgentRunOutcome = "completed" | "failed" | "aborted" | "cancelled";
export type AgentActivityOutcome = "completed" | "failed" | "cancelled";

export type AgentEventOrigin =
  | { type: "user" }
  | { type: "self"; agentId?: string; sessionKey?: string; runId?: string }
  | { type: "subagent"; agentId?: string; sessionKey?: string; runId?: string }
  | { type: "peer_agent"; agentId?: string; sessionKey?: string; runId?: string }
  | { type: "system"; source?: string };

export type AgentEventTarget = {
  agentId?: string;
  sessionKey?: string;
  runId?: string;
};

type AgentEventBase = {
  runId: string;
  rootRunId: string;
  seq: number;
  ts: number;
  sessionKey?: string;
  inputProvenance?: InputProvenance;
};

type AgentRunEventBase = AgentEventBase & {
  eventType: "run.started" | "run.updated" | "run.completed";
};

type AgentActivityEventBase = AgentEventBase & {
  eventType: "activity.started" | "activity.updated" | "activity.output" | "activity.completed";
  activityId: string;
  kind: AgentActivityKind;
  parentActivityId?: string;
  origin?: AgentEventOrigin;
  target?: AgentEventTarget;
};

export type AgentRunStartedEvent = AgentRunEventBase & {
  eventType: "run.started";
  startedAt?: number;
  meta?: Record<string, unknown>;
};

export type AgentRunUpdatedEvent = AgentRunEventBase & {
  eventType: "run.updated";
  patch: Record<string, unknown>;
};

export type AgentRunCompletedEvent = AgentRunEventBase & {
  eventType: "run.completed";
  outcome: AgentRunOutcome;
  startedAt?: number;
  endedAt?: number;
  error?: string;
  stopReason?: string;
  result?: Record<string, unknown>;
};

export type AgentActivityStartedEvent = AgentActivityEventBase & {
  eventType: "activity.started";
  input?: Record<string, unknown>;
  meta?: Record<string, unknown>;
};

export type AgentActivityUpdatedEvent = AgentActivityEventBase & {
  eventType: "activity.updated";
  patch: Record<string, unknown>;
};

export type AgentActivityOutputEvent = AgentActivityEventBase & {
  eventType: "activity.output";
  output: Record<string, unknown>;
};

export type AgentActivityCompletedEvent = AgentActivityEventBase & {
  eventType: "activity.completed";
  outcome: AgentActivityOutcome;
  error?: string;
  result?: Record<string, unknown>;
};

export type AgentEventPayload =
  | AgentRunStartedEvent
  | AgentRunUpdatedEvent
  | AgentRunCompletedEvent
  | AgentActivityStartedEvent
  | AgentActivityUpdatedEvent
  | AgentActivityOutputEvent
  | AgentActivityCompletedEvent;

export type AgentRunContext = {
  sessionKey?: string;
  sessionId?: string;
  verboseLevel?: VerboseLevel;
  inputProvenance?: InputProvenance;
  isHeartbeat?: boolean;
  isControlUiVisible?: boolean;
  queuedChatItemId?: string;
  agentId?: string;
  rootRunId?: string;
  parentActivityId?: string;
  origin?: AgentEventOrigin;
  target?: AgentEventTarget;
};

export type AgentActivityRef = {
  activityId: string;
  kind: AgentActivityKind;
  parentActivityId?: string;
  origin?: AgentEventOrigin;
  target?: AgentEventTarget;
};

const seqByRun = new Map<string, number>();
const listeners = new Set<(evt: AgentEventPayload) => void>();
const runContextById = new Map<string, AgentRunContext>();

type AgentEventDraft = {
  eventType: AgentEventPayload["eventType"];
  runId: string;
  sessionKey?: string;
  [key: string]: unknown;
};

export function registerAgentRunContext(runId: string, context: AgentRunContext) {
  if (!runId) {
    return;
  }
  const existing = runContextById.get(runId);
  if (!existing) {
    runContextById.set(runId, { ...context });
    return;
  }
  Object.assign(existing, {
    ...existing,
    ...Object.fromEntries(Object.entries(context).filter(([, value]) => value !== undefined)),
  });
}

export function getAgentRunContext(runId: string) {
  return runContextById.get(runId);
}

export function clearAgentRunContext(runId: string) {
  runContextById.delete(runId);
}

export function resetAgentRunContextForTest() {
  runContextById.clear();
  seqByRun.clear();
}

function enrichAgentEvent(event: AgentEventDraft): AgentEventPayload {
  const nextSeq = (seqByRun.get(event.runId) ?? 0) + 1;
  seqByRun.set(event.runId, nextSeq);
  const context = runContextById.get(event.runId);
  const isControlUiVisible = context?.isControlUiVisible ?? true;
  const sessionKey = isControlUiVisible ? (event.sessionKey ?? context?.sessionKey) : undefined;
  return {
    ...event,
    sessionKey,
    inputProvenance: context?.inputProvenance,
    rootRunId: context?.rootRunId ?? event.runId,
    seq: nextSeq,
    ts: Date.now(),
  } as AgentEventPayload;
}

export function emitAgentEvent(event: AgentEventDraft) {
  const enriched = enrichAgentEvent(event);
  for (const listener of listeners) {
    try {
      listener(enriched);
    } catch {
      // ignore listener errors to preserve event fan-out
    }
  }
}

export function onAgentEvent(listener: (evt: AgentEventPayload) => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function createActivityRef(params: AgentActivityRef): AgentActivityRef {
  return params;
}

export function emitRunStarted(params: {
  runId: string;
  sessionKey?: string;
  startedAt?: number;
  meta?: Record<string, unknown>;
}) {
  emitAgentEvent({
    eventType: "run.started",
    runId: params.runId,
    sessionKey: params.sessionKey,
    startedAt: params.startedAt,
    meta: params.meta,
  });
}

export function emitRunUpdated(params: {
  runId: string;
  sessionKey?: string;
  patch: Record<string, unknown>;
}) {
  emitAgentEvent({
    eventType: "run.updated",
    runId: params.runId,
    sessionKey: params.sessionKey,
    patch: params.patch,
  });
}

export function emitRunCompleted(params: {
  runId: string;
  sessionKey?: string;
  outcome: AgentRunOutcome;
  startedAt?: number;
  endedAt?: number;
  error?: string;
  stopReason?: string;
  result?: Record<string, unknown>;
}) {
  emitAgentEvent({
    eventType: "run.completed",
    runId: params.runId,
    sessionKey: params.sessionKey,
    outcome: params.outcome,
    startedAt: params.startedAt,
    endedAt: params.endedAt,
    error: params.error,
    stopReason: params.stopReason,
    result: params.result,
  });
}

export function emitActivityStarted(params: {
  runId: string;
  sessionKey?: string;
  activity: AgentActivityRef;
  input?: Record<string, unknown>;
  meta?: Record<string, unknown>;
}) {
  emitAgentEvent({
    eventType: "activity.started",
    runId: params.runId,
    sessionKey: params.sessionKey,
    activityId: params.activity.activityId,
    kind: params.activity.kind,
    parentActivityId: params.activity.parentActivityId,
    origin: params.activity.origin,
    target: params.activity.target,
    input: params.input,
    meta: params.meta,
  });
}

export function emitActivityUpdated(params: {
  runId: string;
  sessionKey?: string;
  activity: AgentActivityRef;
  patch: Record<string, unknown>;
}) {
  emitAgentEvent({
    eventType: "activity.updated",
    runId: params.runId,
    sessionKey: params.sessionKey,
    activityId: params.activity.activityId,
    kind: params.activity.kind,
    parentActivityId: params.activity.parentActivityId,
    origin: params.activity.origin,
    target: params.activity.target,
    patch: params.patch,
  });
}

export function emitActivityOutput(params: {
  runId: string;
  sessionKey?: string;
  activity: AgentActivityRef;
  output: Record<string, unknown>;
}) {
  emitAgentEvent({
    eventType: "activity.output",
    runId: params.runId,
    sessionKey: params.sessionKey,
    activityId: params.activity.activityId,
    kind: params.activity.kind,
    parentActivityId: params.activity.parentActivityId,
    origin: params.activity.origin,
    target: params.activity.target,
    output: params.output,
  });
}

export function emitActivityCompleted(params: {
  runId: string;
  sessionKey?: string;
  activity: AgentActivityRef;
  outcome: AgentActivityOutcome;
  error?: string;
  result?: Record<string, unknown>;
}) {
  emitAgentEvent({
    eventType: "activity.completed",
    runId: params.runId,
    sessionKey: params.sessionKey,
    activityId: params.activity.activityId,
    kind: params.activity.kind,
    parentActivityId: params.activity.parentActivityId,
    origin: params.activity.origin,
    target: params.activity.target,
    outcome: params.outcome,
    error: params.error,
    result: params.result,
  });
}
