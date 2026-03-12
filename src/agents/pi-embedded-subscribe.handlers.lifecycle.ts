import {
  createActivityRef,
  emitActivityCompleted,
  emitRunCompleted,
  emitRunStarted,
} from "../infra/agent-events.js";
import { createInlineCodeState } from "../markdown/code-spans.js";
import { formatAssistantErrorText } from "./pi-embedded-helpers.js";
import type { EmbeddedPiSubscribeContext } from "./pi-embedded-subscribe.handlers.types.js";
import { isAssistantMessage } from "./pi-embedded-utils.js";

export {
  handleAutoCompactionEnd,
  handleAutoCompactionStart,
} from "./pi-embedded-subscribe.handlers.compaction.js";

export function handleAgentStart(ctx: EmbeddedPiSubscribeContext) {
  ctx.log.debug(`embedded run agent start: runId=${ctx.params.runId}`);
  emitRunStarted({
    runId: ctx.params.runId,
    sessionKey: ctx.params.sessionKey,
    startedAt: Date.now(),
  });
  void ctx.params.onAgentEvent?.({
    stream: "lifecycle",
    data: { phase: "start" },
  });
}

export function handleAgentEnd(ctx: EmbeddedPiSubscribeContext) {
  const lastAssistant = ctx.state.lastAssistant;
  const isError = isAssistantMessage(lastAssistant) && lastAssistant.stopReason === "error";
  const errorText =
    isError && lastAssistant
      ? (
          formatAssistantErrorText(lastAssistant, {
            cfg: ctx.params.config,
            sessionKey: ctx.params.sessionKey,
            provider: lastAssistant.provider,
            model: lastAssistant.model,
          }) ||
          lastAssistant.errorMessage ||
          "LLM request failed."
        ).trim()
      : undefined;

  emitActivityCompleted({
    runId: ctx.params.runId,
    sessionKey: ctx.params.sessionKey,
    activity: createActivityRef({
      activityId: `${ctx.params.runId}:assistant`,
      kind: "assistant_message",
      origin: { type: "self" },
    }),
    outcome: isError ? "failed" : "completed",
    ...(errorText ? { error: errorText } : {}),
  });

  if (isError && lastAssistant) {
    ctx.log.warn(
      `embedded run agent end: runId=${ctx.params.runId} isError=true error=${errorText}`,
    );
    emitRunCompleted({
      runId: ctx.params.runId,
      sessionKey: ctx.params.sessionKey,
      outcome: "failed",
      endedAt: Date.now(),
      error: errorText,
    });
    void ctx.params.onAgentEvent?.({
      stream: "lifecycle",
      data: {
        phase: "error",
        error: errorText,
      },
    });
  } else {
    ctx.log.debug(`embedded run agent end: runId=${ctx.params.runId} isError=${isError}`);
    emitRunCompleted({
      runId: ctx.params.runId,
      sessionKey: ctx.params.sessionKey,
      outcome: "completed",
      endedAt: Date.now(),
    });
    void ctx.params.onAgentEvent?.({
      stream: "lifecycle",
      data: { phase: "end" },
    });
  }

  ctx.flushBlockReplyBuffer();
  // Flush the reply pipeline so the response reaches the channel before
  // compaction wait blocks the run.  This mirrors the pattern used by
  // handleToolExecutionStart and ensures delivery is not held hostage to
  // long-running compaction (#35074).
  void ctx.params.onBlockReplyFlush?.();

  ctx.state.blockState.thinking = false;
  ctx.state.blockState.final = false;
  ctx.state.blockState.inlineCode = createInlineCodeState();

  if (ctx.state.pendingCompactionRetry > 0) {
    ctx.resolveCompactionRetry();
  } else {
    ctx.maybeResolveCompactionWait();
  }
}
