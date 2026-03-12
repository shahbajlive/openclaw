import { SessionManager } from "@mariozechner/pi-coding-agent";

type AppendMessageArg = Parameters<SessionManager["appendMessage"]>[0];

export type GatewayInjectedAbortMeta = {
  aborted: true;
  origin: "rpc" | "stop-command";
  runId: string;
};

export type GatewayInjectedTimelineMeta = {
  canonical: true;
  seq?: number;
};

export type GatewayInjectedTranscriptAppendResult = {
  ok: boolean;
  messageId?: string;
  message?: Record<string, unknown>;
  error?: string;
};

export function appendInjectedMessageToTranscript(params: {
  transcriptPath: string;
  role: "system" | "user" | "assistant";
  message: string;
  agentId?: string;
  label?: string;
  runId?: string;
  provenance?: Record<string, unknown>;
  idempotencyKey?: string;
  abortMeta?: GatewayInjectedAbortMeta;
  timeline?: GatewayInjectedTimelineMeta;
  now?: number;
}): GatewayInjectedTranscriptAppendResult {
  const now = params.now ?? Date.now();
  const labelPrefix = params.label ? `[${params.label}]\n\n` : "";
  const baseMessageBody: Record<string, unknown> = {
    role: params.role,
    content: [{ type: "text", text: `${labelPrefix}${params.message}` }],
    timestamp: now,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    ...(params.runId ? { runId: params.runId } : {}),
    ...(params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {}),
  };
  const messageBody: Record<string, unknown> =
    params.role === "assistant"
      ? {
          ...baseMessageBody,
          // Pi stopReason is a strict enum; this is not model output, but we still store it as a
          // normal assistant message so it participates in the session parentId chain.
          stopReason: "stop",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          // Make these explicit so downstream tooling never treats this as model output.
          api: "openai-responses",
          provider: "openclaw",
          model: "gateway-injected",
          ...(params.abortMeta
            ? {
                openclawAbort: {
                  aborted: true,
                  origin: params.abortMeta.origin,
                  runId: params.abortMeta.runId,
                },
              }
            : {}),
          ...(params.timeline
            ? {
                __openclaw: {
                  timeline: params.timeline,
                },
              }
            : {}),
        }
      : {
          ...baseMessageBody,
          ...(params.provenance ? { provenance: params.provenance } : {}),
          ...(params.timeline
            ? {
                __openclaw: {
                  timeline: params.timeline,
                },
              }
            : {}),
        };

  try {
    const sessionManager = SessionManager.open(params.transcriptPath);
    const messageId = sessionManager.appendMessage(messageBody as unknown as AppendMessageArg);
    return { ok: true, messageId, message: messageBody };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function appendInjectedUserMessageToTranscript(params: {
  transcriptPath: string;
  message: string;
  agentId?: string;
  provenance?: Record<string, unknown>;
  idempotencyKey?: string;
  now?: number;
}): GatewayInjectedTranscriptAppendResult {
  return appendInjectedMessageToTranscript({
    ...params,
    role: "user",
  });
}

export function appendInjectedSystemMessageToTranscript(params: {
  transcriptPath: string;
  message: string;
  agentId?: string;
  runId?: string;
  idempotencyKey?: string;
  timeline?: GatewayInjectedTimelineMeta;
  now?: number;
}): GatewayInjectedTranscriptAppendResult {
  return appendInjectedMessageToTranscript({
    ...params,
    role: "system",
  });
}

export function appendInjectedAssistantMessageToTranscript(params: {
  transcriptPath: string;
  message: string;
  agentId?: string;
  label?: string;
  runId?: string;
  idempotencyKey?: string;
  abortMeta?: GatewayInjectedAbortMeta;
  timeline?: GatewayInjectedTimelineMeta;
  now?: number;
}): GatewayInjectedTranscriptAppendResult {
  return appendInjectedMessageToTranscript({
    ...params,
    role: "assistant",
  });
}
