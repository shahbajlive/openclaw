export type UiWsTraceEntry = {
  ts: number;
  event: string;
  instanceId?: string | null;
  tab?: string | null;
  sessionKey?: string | null;
  runId?: string | null;
  details?: Record<string, unknown>;
};

declare global {
  interface Window {
    __OPENCLAW_WS_TRACE__?: UiWsTraceEntry[];
  }
}

const TRACE_LIMIT = 500;

function pushTrace(entry: UiWsTraceEntry) {
  if (typeof window === "undefined") {
    return;
  }
  const next = window.__OPENCLAW_WS_TRACE__ ?? [];
  next.push(entry);
  if (next.length > TRACE_LIMIT) {
    next.splice(0, next.length - TRACE_LIMIT);
  }
  window.__OPENCLAW_WS_TRACE__ = next;
}

export function traceUiWs(entry: UiWsTraceEntry) {
  pushTrace(entry);
}
