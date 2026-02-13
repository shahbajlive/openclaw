import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "../../tools/common.js";
import { AgentSwarm, type AgentSwarmOptions } from "../agent-swarm.js";

const TeamCreateSchema = Type.Object({
  teamName: Type.String(),
  instruction: Type.String(),
});

export type TeamCreateToolOptions = AgentSwarmOptions & {
  swarm?: AgentSwarm;
};

export function createTeamCreateTool(opts?: TeamCreateToolOptions): AnyAgentTool {
  const swarm = opts?.swarm ?? new AgentSwarm({ agentSessionKey: opts?.agentSessionKey });
  return {
    label: "Teams",
    name: "team_create",
    description: "Create a team with an initial instruction task.",
    parameters: TeamCreateSchema,
    execute: (toolCallId, args) => swarm.teamCreate(toolCallId, args),
  };
}
