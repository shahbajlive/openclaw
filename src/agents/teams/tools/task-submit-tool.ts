import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "../../tools/common.js";
import { AgentSwarm, type AgentSwarmOptions } from "../agent-swarm.js";

const TaskSubmitSchema = Type.Object({
  teamId: Type.String(),
  teammateId: Type.String(),
  taskId: Type.String({ description: "Task id." }),
  answer: Type.String({ description: "Task submission payload." }),
  errorText: Type.Optional(Type.String({ description: "Failure reason for a failed task." })),
  error: Type.Optional(Type.String({ description: "Failure reason for a failed task." })),
});

export type TaskSubmitToolOptions = AgentSwarmOptions & {
  swarm?: AgentSwarm;
};

export function createTaskSubmitTool(opts?: TaskSubmitToolOptions): AnyAgentTool {
  const swarm = opts?.swarm ?? new AgentSwarm({ agentSessionKey: opts?.agentSessionKey });
  return {
    label: "Teams",
    name: "task_submit",
    description: "Submit your task result and advance dependency state.",
    parameters: TaskSubmitSchema,
    execute: (toolCallId, args) => swarm.taskSubmit(toolCallId, args),
  };
}

export const createTaskAnswerTool = createTaskSubmitTool;
