import type { AnyAgentTool } from "../../tools/common.js";
import type { AgentSwarmToolsOptions } from "../types.js";
import { AgentSwarm } from "../agent-swarm.js";
import { createTaskQuestionTool } from "./ask-question-tool.js";
import { createTaskPlanTool } from "./task-plan-tool.js";
import { createTaskSearchTool } from "./task-search-tool.js";
import { createTaskSubmitTool, createTaskAnswerTool } from "./task-submit-tool.js";
import { createTeamCreateTool } from "./team-create-tool.js";

export { createTeamCreateTool } from "./team-create-tool.js";
export { createTaskSubmitTool, createTaskAnswerTool } from "./task-submit-tool.js";
export { createTaskQuestionTool } from "./ask-question-tool.js";
export { createTaskSearchTool } from "./task-search-tool.js";
export { createTaskPlanTool } from "./task-plan-tool.js";
export type {
  AgentSwarmToolsOptions,
  AskQuestionToolOptions,
  TaskSearchToolOptions,
  SwarmToolOptions,
  TaskPlanToolOptions,
  TaskSubmitToolOptions,
  TeamCreateToolOptions,
} from "../types.js";

export function createAgentSwarmTools(opts?: AgentSwarmToolsOptions): AnyAgentTool[] {
  const swarm = new AgentSwarm(opts);
  return [
    createTeamCreateTool({ ...opts, swarm }),
    createTaskPlanTool({ ...opts, swarm }),
    createTaskSearchTool({ ...opts, swarm }),
    createTaskSubmitTool({ ...opts, swarm }),
    createTaskQuestionTool({ ...opts, swarm }),
  ];
}
