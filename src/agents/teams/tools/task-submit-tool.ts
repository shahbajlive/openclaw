import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "../../tools/common.js";
import type { TaskSubmitToolOptions } from "../types.js";
import { AgentSwarm } from "../agent-swarm.js";

const TaskSubmitSchema = Type.Object({
  revisionId: Type.Optional(
    Type.String({ description: "Revision id seen by assignee (for stale-submit guard)." }),
  ),
  answer: Type.String({ description: "Task submission payload." }),
  errorText: Type.Optional(
    Type.String({ description: "Set only when failed: human-readable failure reason." }),
  ),
  error: Type.Optional(Type.String({ description: "Legacy alias for errorText." })),
});

export type { TaskSubmitToolOptions } from "../types.js";

export function createTaskSubmitTool(opts?: TaskSubmitToolOptions): AnyAgentTool {
  const swarm = opts?.swarm ?? new AgentSwarm({ agentSessionKey: opts?.agentSessionKey });
  return {
    label: "Teams",
    name: "task_submit",
    description: "Submit your task result and advance dependency state.",
    parameters: TaskSubmitSchema,
    execute: async (toolCallId, args): Promise<AgentToolResult<unknown>> =>
      (await swarm.taskSubmit(toolCallId, args)) as AgentToolResult<unknown>,
  };
}

export const createTaskAnswerTool = createTaskSubmitTool;
