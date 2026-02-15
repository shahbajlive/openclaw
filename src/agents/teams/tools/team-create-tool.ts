import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "../../tools/common.js";
import type { TeamCreateToolOptions } from "../types.js";
import { AgentSwarm } from "../agent-swarm.js";

const TeamCreateSchema = Type.Object({
  teamName: Type.String(),
  instruction: Type.String(),
});

export type { TeamCreateToolOptions } from "../types.js";

export function createTeamCreateTool(opts?: TeamCreateToolOptions): AnyAgentTool {
  const swarm = opts?.swarm ?? new AgentSwarm({ agentSessionKey: opts?.agentSessionKey });
  return {
    label: "Teams",
    name: "team_create",
    description: "Create a team with an initial instruction task.",
    parameters: TeamCreateSchema,
    execute: async (toolCallId, args): Promise<AgentToolResult<unknown>> =>
      (await swarm.teamCreate(toolCallId, args)) as AgentToolResult<unknown>,
  };
}
