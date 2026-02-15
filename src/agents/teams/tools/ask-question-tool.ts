import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "../../tools/common.js";
import type { AskQuestionToolOptions } from "../types.js";
import { optionalStringEnum } from "../../schema/typebox.js";
import { AgentSwarm } from "../agent-swarm.js";

const AskQuestionSchema = Type.Object({
  dependencyTaskId: Type.String({
    description: "Task id for the dependency you need context from.",
  }),
  questionText: Type.String({ description: "Question for the dependency owner." }),
  mode: optionalStringEnum(["read", "edit"] as const, {
    description:
      "Question mode. read (default) asks for clarification; edit requests dependency rework.",
  }),
});

export type { AskQuestionToolOptions } from "../types.js";

export function createTaskQuestionTool(opts?: AskQuestionToolOptions): AnyAgentTool {
  const swarm = opts?.swarm ?? new AgentSwarm({ agentSessionKey: opts?.agentSessionKey });
  return {
    label: "Teams",
    name: "ask_question",
    description: "Ask a dependency question and block current work until answered.",
    parameters: AskQuestionSchema,
    execute: async (toolCallId, args): Promise<AgentToolResult<unknown>> =>
      (await swarm.askQuestion(toolCallId, args)) as AgentToolResult<unknown>,
  };
}
