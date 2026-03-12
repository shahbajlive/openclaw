import { onAgentEvent, type AgentRunCompletedEvent } from "../../infra/agent-events.js";
import type { InputProvenance } from "../../sessions/input-provenance.js";

const AGENT_RUN_CACHE_TTL_MS = 10 * 60_000;
/**
 * Embedded runs can emit transient lifecycle `error` events while auth/model
 * failover is still in progress. Give errors a short grace window so a
 * subsequent `start` event can cancel premature terminal snapshots.
 */
const AGENT_RUN_ERROR_RETRY_GRACE_MS = 15_000;

const agentRunCache = new Map<string, AgentRunSnapshot>();
const agentRunStarts = new Map<string, number>();
const pendingAgentRunErrors = new Map<string, PendingAgentRunError>();
const activeAgentRuns = new Map<string, ActiveAgentRunSnapshot>();
let agentRunListenerStarted = false;

type AgentRunSnapshot = {
  runId: string;
  status: "ok" | "error" | "timeout";
  startedAt?: number;
  endedAt?: number;
  error?: string;
  ts: number;
};

type PendingAgentRunError = {
  snapshot: AgentRunSnapshot;
  dueAt: number;
  timer: NodeJS.Timeout;
};

export type ActiveAgentRunSnapshot = {
  runId: string;
  sessionKey: string;
  startedAt: number;
  inputProvenance?: InputProvenance;
};

function pruneAgentRunCache(now = Date.now()) {
  for (const [runId, entry] of agentRunCache) {
    if (now - entry.ts > AGENT_RUN_CACHE_TTL_MS) {
      agentRunCache.delete(runId);
    }
  }
}

function recordAgentRunSnapshot(entry: AgentRunSnapshot) {
  pruneAgentRunCache(entry.ts);
  agentRunCache.set(entry.runId, entry);
}

function clearPendingAgentRunError(runId: string) {
  const pending = pendingAgentRunErrors.get(runId);
  if (!pending) {
    return;
  }
  clearTimeout(pending.timer);
  pendingAgentRunErrors.delete(runId);
}

function schedulePendingAgentRunError(snapshot: AgentRunSnapshot) {
  clearPendingAgentRunError(snapshot.runId);
  const dueAt = Date.now() + AGENT_RUN_ERROR_RETRY_GRACE_MS;
  const timer = setTimeout(() => {
    const pending = pendingAgentRunErrors.get(snapshot.runId);
    if (!pending) {
      return;
    }
    pendingAgentRunErrors.delete(snapshot.runId);
    recordAgentRunSnapshot(pending.snapshot);
  }, AGENT_RUN_ERROR_RETRY_GRACE_MS);
  timer.unref?.();
  pendingAgentRunErrors.set(snapshot.runId, { snapshot, dueAt, timer });
}

function getPendingAgentRunError(runId: string) {
  const pending = pendingAgentRunErrors.get(runId);
  if (!pending) {
    return undefined;
  }
  return {
    snapshot: pending.snapshot,
    dueAt: pending.dueAt,
  };
}

function createSnapshotFromRunCompletedEvent(evt: AgentRunCompletedEvent): AgentRunSnapshot {
  const startedAt =
    typeof evt.startedAt === "number" ? evt.startedAt : agentRunStarts.get(evt.runId);
  const endedAt = typeof evt.endedAt === "number" ? evt.endedAt : undefined;
  const error = typeof evt.error === "string" ? evt.error : undefined;
  return {
    runId: evt.runId,
    status: evt.outcome === "failed" ? "error" : evt.outcome === "aborted" ? "timeout" : "ok",
    startedAt,
    endedAt,
    error,
    ts: Date.now(),
  };
}

function ensureAgentRunListener() {
  if (agentRunListenerStarted) {
    return;
  }
  agentRunListenerStarted = true;
  onAgentEvent((evt) => {
    if (!evt) {
      return;
    }
    if (evt.eventType === "run.started") {
      const startedAt = typeof evt.startedAt === "number" ? evt.startedAt : undefined;
      agentRunStarts.set(evt.runId, startedAt ?? Date.now());
      clearPendingAgentRunError(evt.runId);
      // A new start means this run is active again (or retried). Drop stale
      // terminal snapshots so waiters don't resolve from old state.
      agentRunCache.delete(evt.runId);
      const sessionKey =
        typeof evt.sessionKey === "string" && evt.sessionKey.trim() ? evt.sessionKey : undefined;
      if (sessionKey) {
        activeAgentRuns.set(evt.runId, {
          runId: evt.runId,
          sessionKey,
          startedAt: startedAt ?? Date.now(),
          ...(evt.inputProvenance &&
          typeof evt.inputProvenance === "object" &&
          evt.inputProvenance !== null
            ? { inputProvenance: evt.inputProvenance }
            : {}),
        });
      }
      return;
    }
    if (evt.eventType !== "run.completed") {
      return;
    }
    activeAgentRuns.delete(evt.runId);
    const snapshot = createSnapshotFromRunCompletedEvent(evt);
    agentRunStarts.delete(evt.runId);
    if (evt.outcome === "failed") {
      schedulePendingAgentRunError(snapshot);
      return;
    }
    clearPendingAgentRunError(evt.runId);
    recordAgentRunSnapshot(snapshot);
  });
}

function getCachedAgentRun(runId: string) {
  pruneAgentRunCache();
  return agentRunCache.get(runId);
}

export function listActiveAgentRunsForSession(sessionKey: string): ActiveAgentRunSnapshot[] {
  ensureAgentRunListener();
  const normalizedSessionKey = sessionKey.trim();
  if (!normalizedSessionKey) {
    return [];
  }
  return [...activeAgentRuns.values()]
    .filter((entry) => entry.sessionKey === normalizedSessionKey)
    .toSorted((a, b) => b.startedAt - a.startedAt);
}

export function resetAgentJobStateForTest() {
  for (const pending of pendingAgentRunErrors.values()) {
    clearTimeout(pending.timer);
  }
  agentRunCache.clear();
  agentRunStarts.clear();
  pendingAgentRunErrors.clear();
  activeAgentRuns.clear();
}

export function resetAgentJobState() {
  resetAgentJobStateForTest();
}

export async function waitForAgentJob(params: {
  runId: string;
  timeoutMs: number;
  signal?: AbortSignal;
  ignoreCachedSnapshot?: boolean;
}): Promise<AgentRunSnapshot | null> {
  const { runId, timeoutMs, signal, ignoreCachedSnapshot = false } = params;
  ensureAgentRunListener();
  const cached = ignoreCachedSnapshot ? undefined : getCachedAgentRun(runId);
  if (cached) {
    return cached;
  }
  if (timeoutMs <= 0 || signal?.aborted) {
    return null;
  }

  return await new Promise((resolve) => {
    let settled = false;
    let pendingErrorTimer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;

    const clearPendingErrorTimer = () => {
      if (!pendingErrorTimer) {
        return;
      }
      clearTimeout(pendingErrorTimer);
      pendingErrorTimer = undefined;
    };

    const finish = (entry: AgentRunSnapshot | null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      clearPendingErrorTimer();
      unsubscribe();
      if (onAbort) {
        signal?.removeEventListener("abort", onAbort);
      }
      resolve(entry);
    };

    const scheduleErrorFinish = (
      snapshot: AgentRunSnapshot,
      delayMs = AGENT_RUN_ERROR_RETRY_GRACE_MS,
    ) => {
      clearPendingErrorTimer();
      const effectiveDelay = Math.max(1, Math.min(Math.floor(delayMs), 2_147_483_647));
      pendingErrorTimer = setTimeout(() => {
        const latest = ignoreCachedSnapshot ? undefined : getCachedAgentRun(runId);
        if (latest) {
          finish(latest);
          return;
        }
        recordAgentRunSnapshot(snapshot);
        finish(snapshot);
      }, effectiveDelay);
      pendingErrorTimer.unref?.();
    };

    if (!ignoreCachedSnapshot) {
      const pending = getPendingAgentRunError(runId);
      if (pending) {
        scheduleErrorFinish(pending.snapshot, pending.dueAt - Date.now());
      }
    }

    const unsubscribe = onAgentEvent((evt) => {
      if (!evt || (evt.eventType !== "run.started" && evt.eventType !== "run.completed")) {
        return;
      }
      if (evt.runId !== runId) {
        return;
      }
      if (evt.eventType === "run.started") {
        clearPendingErrorTimer();
        return;
      }
      const latest = ignoreCachedSnapshot ? undefined : getCachedAgentRun(runId);
      if (latest) {
        finish(latest);
        return;
      }
      const snapshot = createSnapshotFromRunCompletedEvent(evt);
      if (evt.outcome === "failed") {
        scheduleErrorFinish(snapshot);
        return;
      }
      recordAgentRunSnapshot(snapshot);
      finish(snapshot);
    });

    const timerDelayMs = Math.max(1, Math.min(Math.floor(timeoutMs), 2_147_483_647));
    const timer = setTimeout(() => finish(null), timerDelayMs);
    onAbort = () => finish(null);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

ensureAgentRunListener();
