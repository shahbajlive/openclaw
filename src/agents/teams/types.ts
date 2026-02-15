import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { SwarmPlatform } from "./swarm-platform.js";

export const RESERVED_MATE_ID = {
  LEAD: "lead",
  CHORE: "chore",
  PR_REVIEWER: "pr_reviewer",
} as const;

export type AgentSwarmOptions = {
  agentSessionKey?: string;
  platform?: SwarmPlatform;
};

export type TaskPriority = number;

export const TASK_STATUS = {
  BLOCKED: "blocked",
  PENDING: "pending",
  CLAIMED: "claimed",
  IN_PROGRESS: "in-progress",
  PAUSED: "paused", // means blocked by only its secondary task
  COMPLETED: "completed",
  FAILED: "failed",
  DELETED: "deleted",
} as const;

export type TaskStatus = (typeof TASK_STATUS)[keyof typeof TASK_STATUS];
export type TaskRevisionStatus = TaskStatus | "superseded";
export type TaskClass = "primary" | "secondary";
export type TaskFrontierVector = Record<string, number>;
export type TaskRevisionCause = "create" | "manual" | "upstream_revision" | "retry";
export type DependencyNoteKind = "submit" | "revision" | "question_answer";

export type DependencyNote = {
  noteId: string;
  sourceTaskId: string;
  sourceRevisionId?: string;
  kind: DependencyNoteKind;
  text: string;
  createdAt: number;
};

export type DependencyNotesByTaskId = Record<string, DependencyNote[]>;

export type TaskChatCheckpoint = {
  capturedAt: number;
  limit: number;
  digest: string;
  sessionId?: string;
  sample: Array<{ role?: string; text: string; createdAt?: number }>;
};

export type TaskStructuredEventKind =
  | "fact"
  | "evidence"
  | "decision"
  | "assumption"
  | "risk"
  | "question"
  | "answer"
  | "plan"
  | "output"
  | "thinking_summary"
  | "next";

export type TaskStructuredEventStatus = "active" | "open" | "resolved" | "superseded";

export type TaskStructuredEventSource = "tool" | "envelope" | "fallback";

export type TaskStructuredEvent = {
  eventId: string;
  eventKey: string;
  kind: TaskStructuredEventKind;
  title: string;
  summary: string;
  status: TaskStructuredEventStatus;
  tokens: string[];
  refs: string[];
  source: TaskStructuredEventSource;
  createdAt: number;
  supersedesEventId?: string;
};

export type TaskRevisionRecord = {
  revisionId: string;
  taskId: string;
  revision: number;
  status: TaskRevisionStatus;
  taskClass: TaskClass;
  assignee: string;
  dependsOnTaskIds: string[];
  dependsOnRevisionFrontier: TaskFrontierVector;
  basedOnFrontier: TaskFrontierVector;
  previousRevisionId?: string;
  cause?: TaskRevisionCause;
  causeTaskId?: string;
  causeRevision?: number;
  supersededByRevisionId?: string;
  submit: string;
  commitId?: string;
  chatCheckpoint?: TaskChatCheckpoint;
  structuredEvents?: TaskStructuredEvent[];
  createdAt: number;
  claimedAt: number;
  completedAt: number;
};

export type Task = {
  taskId: string;
  title: string;
  instruction: string;
  submit: string;
  status: TaskStatus;
  assignee: string;
  contextSessionKey: string;
  dependsOn: string[];
  priority: TaskPriority;
  taskClass: TaskClass;
  createdAt: number;
  claimedAt: number;
  completedAt: number;
  deletedAt: number;
  commitId?: string;
  revisionId?: string;
  revision?: number;
  dependsOnRevisionFrontier?: TaskFrontierVector;
  basedOnFrontier?: TaskFrontierVector;
  previousRevisionId?: string;
  cause?: TaskRevisionCause;
  causeTaskId?: string;
  causeRevision?: number;
  supersededByRevisionId?: string;
  clones: number;
  dependencyNotes?: DependencyNotesByTaskId;
};

// ---- Swarm ----

export type SwarmTask = Task;

export type SwarmAskMode = "read" | "edit";

export type SwarmAddTaskParams = {
  title: string;
  assignTo?: string;
  priority?: Task["priority"];
  dependsOn?: string[];
  instruction?: string;
  taskClass?: Task["taskClass"];
  status?: Task["status"];
  contextSessionKey?: string;
};

// ---- Agent Swarm internals ----

export type TaskPlanItem = {
  taskKey: string;
  title: string;
  instruction?: string;
  assignee?: string;
  dependsOnKeys: string[];
  priority?: SwarmTask["priority"];
  taskClass?: SwarmTask["taskClass"];
  contextSessionKey?: string;
};

export type TaskRestoreSnapshot = {
  taskId: string;
  status: SwarmTask["status"];
  completedAt: number;
  deletedAt: number;
};

export type TaskRevisionRegistry = {
  byRevisionId: Map<string, TaskRevisionRecord>;
  latestByTaskId: Map<string, TaskRevisionRecord>;
  byTaskId: Map<string, TaskRevisionRecord[]>;
  byTaskAndFrontierKey: Map<string, TaskRevisionRecord>;
  historyIndexByRevisionId: Map<string, number>;
};

export type PropagationMetrics = {
  enqueuedSources: number;
  maxQueueDepth: number;
  drainRuns: number;
  drainedSources: number;
  descendantsVisited: number;
  revisedDescendants: number;
  skippedByShortCircuit: number;
  skippedByFrontierDedupe: number;
  interruptedSessions: number;
  lastUpdatedAt: number;
};

export type EndTaskChronologyCacheEntry = {
  graphVersion: number;
  instruction: string;
};

export type GraphOptions = {
  onTaskPending?: (task: SwarmTask) => void;
  onGraphChanged?: () => void;
};

export type PendingTaskQueueEntry = {
  taskId: string;
  priority: number;
  createdAt: number;
  sequence: number;
};

// ---- Team tool options ----

export type AgentSwarmToolsOptions = AgentSwarmOptions;

export type TeamCreateToolRuntime = {
  teamCreate(toolCallId: string, args: unknown): Promise<AgentToolResult<unknown>>;
};

export type AskQuestionToolRuntime = {
  askQuestion(toolCallId: string, args: unknown): Promise<AgentToolResult<unknown>>;
};

export type TaskSubmitToolRuntime = {
  taskSubmit(toolCallId: string, args: unknown): Promise<AgentToolResult<unknown>>;
};

export type TaskPlanToolRuntime = {
  taskPlan(toolCallId: string, args: unknown): Promise<AgentToolResult<unknown>>;
};

export type TaskSearchToolRuntime = {
  taskSearch(toolCallId: string, args: unknown): Promise<AgentToolResult<unknown>>;
};

export type TeamCreateToolOptions = AgentSwarmToolsOptions & {
  swarm?: TeamCreateToolRuntime;
};

export type AskQuestionToolOptions = AgentSwarmToolsOptions & {
  swarm?: AskQuestionToolRuntime;
};

export type TaskSubmitToolOptions = AgentSwarmToolsOptions & {
  swarm?: TaskSubmitToolRuntime;
};

export type TaskPlanToolOptions = AgentSwarmToolsOptions & {
  swarm?: TaskPlanToolRuntime;
};

export type TaskSearchToolOptions = AgentSwarmToolsOptions & {
  swarm?: TaskSearchToolRuntime;
};

export type SwarmToolOptions =
  | TeamCreateToolOptions
  | AskQuestionToolOptions
  | TaskSubmitToolOptions
  | TaskPlanToolOptions
  | TaskSearchToolOptions;
