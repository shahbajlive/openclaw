import crypto from "node:crypto";
import type { SwarmPlatform } from "./teams/swarm-platform.js";
import type { DependencyNotesByTaskId } from "./teams/types.js";
import { callGateway } from "../gateway/call.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel.js";
import { AGENT_LANE_NESTED } from "./lanes.js";

function buildBootstrapMessage(params: {
  title: string;
  instruction: string;
  dependencyNotes?: DependencyNotesByTaskId;
}): string {
  const planningLine =
    params.title === "Create Subtask"
      ? "Skill: task planner. For this task, call task_plan to create subtasks. task_plan auto-completes this splitter task; do not call task_submit for it."
      : params.title === "end_task"
        ? "Skill: report generation. For this task, call task_submit with your final report. System broadcasts it to caller."
        : "When done, call task_submit with answer.";
  const dependencyNotesLines = Object.entries(params.dependencyNotes ?? {}).flatMap(
    ([dependencyTaskId, notes]) => {
      const lines = [`Dependency updates from ${dependencyTaskId}:`];
      for (const note of notes) {
        const text = note.text.replaceAll("\n", " ").trim();
        lines.push(`- [${note.kind}] ${text}`);
      }
      return lines;
    },
  );
  return [
    `Title: ${params.title}`,
    "",
    "Instruction:",
    params.instruction,
    "",
    ...(dependencyNotesLines.length > 0
      ? [
          "New Dependency Notes:",
          ...dependencyNotesLines,
          "Use taskSearch if you need full dependency history/context.",
          "",
        ]
      : []),
    planningLine,
    "If you fail (token/network/runtime), call task_submit with errorText and a short answer.",
  ].join("\n");
}

function normalizeBootstrapFailure(params: { status?: string; error?: unknown }): string {
  const status = typeof params.status === "string" ? params.status.trim().toLowerCase() : "";
  const raw =
    params.error instanceof Error
      ? params.error.message
      : typeof params.error === "string"
        ? params.error
        : "";
  const text = raw.trim();
  const lower = text.toLowerCase();

  if (status === "timeout") return text || "Session run timed out before task completion.";
  if (
    lower.includes("token") ||
    lower.includes("context length") ||
    lower.includes("max tokens") ||
    lower.includes("maximum context")
  ) {
    return text ? `Token limit: ${text}` : "Session run hit token/context limit.";
  }
  if (
    lower.includes("network") ||
    lower.includes("econn") ||
    lower.includes("socket") ||
    lower.includes("dns") ||
    lower.includes("timed out") ||
    lower.includes("connection") ||
    lower.includes("503") ||
    lower.includes("502") ||
    lower.includes("429")
  ) {
    return text
      ? `Network/provider error: ${text}`
      : "Session run failed due to network/provider error.";
  }
  if (text) return text;
  return status === "error"
    ? "Session run failed due to execution error."
    : "Session run failed before task submission.";
}

export function createOpenClawSwarmPlatform(params: {
  bootstrapWaitMs: number;
  submitBootstrapFailure: (
    context: { teamId: string; taskId: string },
    errorText: string,
  ) => Promise<void> | void;
}): SwarmPlatform {
  return {
    sendBootstrap: async (request) => {
      const sessionKey = request.sessionKey.trim();
      if (!sessionKey) {
        await params.submitBootstrapFailure(
          { teamId: request.teamId, taskId: request.taskId },
          "Missing task session key for bootstrap.",
        );
        return;
      }

      const idempotencyKey = crypto.randomUUID();
      const bootstrapMessage = buildBootstrapMessage({
        title: request.title,
        instruction: request.instruction,
        dependencyNotes: request.dependencyNotes,
      });

      try {
        const accepted = await callGateway<{ runId?: string }>({
          method: "agent",
          params: {
            message: bootstrapMessage,
            sessionKey,
            idempotencyKey,
            deliver: false,
            channel: INTERNAL_MESSAGE_CHANNEL,
            lane: AGENT_LANE_NESTED,
          },
          timeoutMs: 10_000,
        });
        const runId =
          typeof accepted?.runId === "string" && accepted.runId.trim()
            ? accepted.runId
            : idempotencyKey;
        const wait = await callGateway<{ status?: string; error?: string }>({
          method: "agent.wait",
          params: {
            runId,
            timeoutMs: params.bootstrapWaitMs,
          },
          timeoutMs: params.bootstrapWaitMs + 10_000,
        });
        const waitStatus = typeof wait?.status === "string" ? wait.status.trim().toLowerCase() : "";
        if (waitStatus === "ok") return;
        await params.submitBootstrapFailure(
          { teamId: request.teamId, taskId: request.taskId },
          normalizeBootstrapFailure({ status: waitStatus, error: wait?.error }),
        );
      } catch (err) {
        await params.submitBootstrapFailure(
          { teamId: request.teamId, taskId: request.taskId },
          normalizeBootstrapFailure({ status: "error", error: err }),
        );
      }
    },
    appendSessionNote: async (request) => {
      const sessionKey = request.sessionKey.trim();
      const note = request.note.trim();
      if (!sessionKey || !note) return;
      await callGateway({
        method: "chat.inject",
        params: {
          sessionKey,
          message: note,
          label: "teams",
        },
        timeoutMs: 10_000,
      });
    },
    announceSession: async (request) => {
      const sessionKey = request.sessionKey.trim();
      const message = request.message.trim();
      if (!sessionKey || !message) return;
      await callGateway({
        method: "agent",
        params: {
          sessionKey,
          message,
          deliver: true,
          idempotencyKey: crypto.randomUUID(),
        },
        expectFinal: true,
        timeoutMs: 60_000,
      });
    },
    readSessionHistory: async (request) => {
      const sessionKey = request.sessionKey.trim();
      if (!sessionKey) return { messages: [] };
      const limit = Number.isFinite(request.limit) ? Math.max(1, Math.min(50, request.limit)) : 10;
      const result = await callGateway<{ messages?: unknown[]; sessionId?: string }>({
        method: "chat.history",
        params: {
          sessionKey,
          limit,
        },
        timeoutMs: 10_000,
      });
      return {
        messages: Array.isArray(result?.messages) ? result.messages : [],
        ...(typeof result?.sessionId === "string" ? { sessionId: result.sessionId } : {}),
      };
    },
    interruptSession: async (request) => {
      const sessionKey = request.sessionKey.trim();
      if (!sessionKey) return;
      await callGateway({
        method: "chat.abort",
        params: { sessionKey },
        timeoutMs: 10_000,
      });
      const reason = request.reason.trim();
      if (!reason) return;
      await callGateway({
        method: "chat.inject",
        params: {
          sessionKey,
          message: reason,
          label: "teams",
        },
        timeoutMs: 10_000,
      });
    },
  };
}
