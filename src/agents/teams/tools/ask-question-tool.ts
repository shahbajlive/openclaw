import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "../../tools/common.js";
import { AgentSwarm, type AgentSwarmOptions } from "../agent-swarm.js";

const AskQuestionSchema = Type.Object({
  teamId: Type.String(),
  teammateId: Type.String(),
  taskId: Type.String({
    description: "Current task id.",
  }),
  dependencyTaskId: Type.String({
    description: "Task id for the dependency you need context from.",
  }),
  questionText: Type.String({ description: "Question for the dependency owner." }),
  mode: Type.Optional(Type.String({ description: "Question mode: read (default) or edit." })),
});

export type AskQuestionToolOptions = AgentSwarmOptions & {
  swarm?: AgentSwarm;
};

export function createTaskQuestionTool(opts?: AskQuestionToolOptions): AnyAgentTool {
  const swarm = opts?.swarm ?? new AgentSwarm({ agentSessionKey: opts?.agentSessionKey });
  return {
    label: "Teams",
    name: "ask_question",
    description: "Ask a teammate question and block current work until it is answered.",
    parameters: AskQuestionSchema,
    execute: (toolCallId, args) => swarm.askQuestion(toolCallId, args),
  };
}
