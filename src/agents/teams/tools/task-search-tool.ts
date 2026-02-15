import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "../../tools/common.js";
import type { TaskSearchToolOptions } from "../types.js";
import { optionalStringEnum } from "../../schema/typebox.js";
import { AgentSwarm } from "../agent-swarm.js";

const TaskSearchSchema = Type.Object({
  dependencyTaskId: Type.Optional(
    Type.String({ description: "Optional dependency task id to filter by." }),
  ),
  mode: optionalStringEnum(["current", "history"] as const, {
    description:
      "Read mode. current (default) returns concise latest state; history returns timeline slices.",
  }),
  sinceRevisionId: Type.Optional(
    Type.String({
      description:
        "Optional revision id cursor. history mode returns revisions after this cursor when found.",
    }),
  ),
  limit: Type.Optional(
    Type.Number({ minimum: 1, maximum: 50, description: "Max notes/revisions per dependency." }),
  ),
  includeChat: Type.Optional(
    Type.Boolean({ description: "Include dependency session chat excerpts." }),
  ),
  chatLimit: Type.Optional(
    Type.Number({ minimum: 1, maximum: 50, description: "Max chat messages per dependency." }),
  ),
});

export type { TaskSearchToolOptions } from "../types.js";

export function createTaskSearchTool(opts?: TaskSearchToolOptions): AnyAgentTool {
  const swarm = opts?.swarm ?? new AgentSwarm({ agentSessionKey: opts?.agentSessionKey });
  return {
    label: "Teams",
    name: "taskSearch",
    description: "Read dependency revisions, notes, and optional chat excerpts.",
    parameters: TaskSearchSchema,
    execute: async (toolCallId, args): Promise<AgentToolResult<unknown>> =>
      (await swarm.taskSearch(toolCallId, args)) as AgentToolResult<unknown>,
  };
}
