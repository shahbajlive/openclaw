import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "../../tools/common.js";
import type { TaskPlanToolOptions } from "../types.js";
import { optionalStringEnum } from "../../schema/typebox.js";
import { AgentSwarm } from "../agent-swarm.js";

const TASK_PLAN_CLASS_VALUES = ["primary", "secondary"] as const;

const TaskPlanSchema = Type.Object({
  tasks: Type.Array(
    Type.Object({
      id: Type.Optional(
        Type.String({
          description: "Optional local DAG id used by dependsOn references.",
        }),
      ),
      title: Type.String({ description: "Short task title." }),
      instruction: Type.Optional(Type.String({ description: "Detailed task instruction." })),
      assignee: Type.Optional(
        Type.String({ description: "Optional assignment label (no execution routing impact)." }),
      ),
      dependsOn: Type.Optional(
        Type.Array(
          Type.String({
            description:
              "Dependency reference by local id or 1-based task index in this tasks list.",
          }),
        ),
      ),
      priority: Type.Optional(
        Type.Integer({
          minimum: 0,
          description: "Optional numeric priority override. Higher number means higher priority.",
        }),
      ),
      taskClass: optionalStringEnum(TASK_PLAN_CLASS_VALUES, {
        description: "Optional task class override. Allowed: primary, secondary.",
      }),
      contextSessionKey: Type.Optional(
        Type.String({ description: "Optional explicit context session key." }),
      ),
    }),
    {
      description:
        "Planned tasks to insert under the current assigned scope. Supports flat list or DAG via id+dependsOn.",
    },
  ),
});

export type { TaskPlanToolOptions } from "../types.js";

export function createTaskPlanTool(opts?: TaskPlanToolOptions): AnyAgentTool {
  const swarm = opts?.swarm ?? new AgentSwarm({ agentSessionKey: opts?.agentSessionKey });
  return {
    label: "Teams",
    name: "task_plan",
    description: "Scoped DAG planning from your current assigned task.",
    parameters: TaskPlanSchema,
    execute: async (toolCallId, args): Promise<AgentToolResult<unknown>> =>
      (await swarm.taskPlan(toolCallId, args)) as AgentToolResult<unknown>,
  };
}
