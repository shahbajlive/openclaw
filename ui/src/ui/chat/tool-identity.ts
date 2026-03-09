const TOOL_TIMESTAMP_BUCKET_MS = 2 * 60 * 1000;

export type ToolIdentityInput = {
  toolCallId?: string | null;
  runId?: string | null;
  sessionKey?: string | null;
  name?: string | null;
  timestamp?: number | null;
};

function toTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function resolveToolCallIdFromContent(message: Record<string, unknown>): string {
  const content = message.content;
  if (!Array.isArray(content)) {
    return "";
  }
  for (const entry of content) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const item = entry as Record<string, unknown>;
    const type = typeof item.type === "string" ? item.type.trim().toLowerCase() : "";
    if (type !== "toolcall" && type !== "tool_call" && type !== "tooluse" && type !== "tool_use") {
      continue;
    }
    const id = toTrimmedString(item.id);
    if (id) {
      return id;
    }
    const toolCallId = toTrimmedString(item.toolCallId);
    if (toolCallId) {
      return toolCallId;
    }
    const snake = toTrimmedString(item.tool_call_id);
    if (snake) {
      return snake;
    }
  }
  return "";
}

export function normalizeToolName(value: unknown): string {
  return toTrimmedString(value).toLowerCase();
}

export function resolveToolCallId(message: unknown): string {
  const m = message as Record<string, unknown>;
  const camel = toTrimmedString(m.toolCallId);
  if (camel) {
    return camel;
  }
  const snake = toTrimmedString(m.tool_call_id);
  if (snake) {
    return snake;
  }
  return resolveToolCallIdFromContent(m);
}

export function resolveToolRunId(message: unknown): string {
  const m = message as Record<string, unknown>;
  const camel = toTrimmedString(m.runId);
  if (camel) {
    return camel;
  }
  return toTrimmedString(m.run_id);
}

export function resolveToolSessionKey(message: unknown): string {
  const m = message as Record<string, unknown>;
  return toTrimmedString(m.sessionKey);
}

function bucketToolTimestamp(timestamp: number | null | undefined): number | null {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp) || timestamp <= 0) {
    return null;
  }
  return Math.floor(timestamp / TOOL_TIMESTAMP_BUCKET_MS) * TOOL_TIMESTAMP_BUCKET_MS;
}

export function buildToolDedupeKeys(input: ToolIdentityInput): string[] {
  const toolCallId = toTrimmedString(input.toolCallId);
  const runId = toTrimmedString(input.runId);
  const sessionKey = toTrimmedString(input.sessionKey);
  const name = normalizeToolName(input.name);
  const tsBucket = bucketToolTimestamp(input.timestamp);

  const keys: string[] = [];
  if (toolCallId) {
    keys.push(`tool:id:${toolCallId}`);
  }
  if (runId && name) {
    keys.push(`tool:run-name:${runId}:${name}`);
  }
  if (sessionKey && name) {
    keys.push(`tool:session-name:${sessionKey}:${name}`);
  }
  if (runId && name && tsBucket !== null) {
    keys.push(`tool:run-name-ts:${runId}:${name}:${tsBucket}`);
  }
  if (sessionKey && name && tsBucket !== null) {
    keys.push(`tool:session-name-ts:${sessionKey}:${name}:${tsBucket}`);
  }
  if (name && tsBucket !== null) {
    keys.push(`tool:name-ts:${name}:${tsBucket}`);
  }
  return keys;
}

export function buildPrimaryToolDedupeKey(input: ToolIdentityInput): string | null {
  const keys = buildToolDedupeKeys(input);
  return keys[0] ?? null;
}
