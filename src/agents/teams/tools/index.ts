import type { AnyAgentTool } from "../../tools/common.js";
import { AgentSwarm, type AgentSwarmOptions } from "../agent-swarm.js";
import { createTaskQuestionTool } from "./ask-question-tool.js";
import { createTaskSubmitTool, createTaskAnswerTool } from "./task-submit-tool.js";
import { createTeamCreateTool } from "./team-create-tool.js";

export { createTeamCreateTool } from "./team-create-tool.js";
export { createTaskSubmitTool, createTaskAnswerTool } from "./task-submit-tool.js";
export { createTaskQuestionTool } from "./ask-question-tool.js";

export function createAgentSwarmTools(opts?: AgentSwarmOptions): AnyAgentTool[] {
  const swarm = new AgentSwarm(opts);
  return [
    createTeamCreateTool({ ...opts, swarm }),
    createTaskSubmitTool({ ...opts, swarm }),
    createTaskQuestionTool({ ...opts, swarm }),
  ];
}
