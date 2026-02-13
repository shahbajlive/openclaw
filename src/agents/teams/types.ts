export const TEAM_STATUS = {
  INIT: "init",
  WORKING: "working",
  FAILED: "failed",
  IDLE: "idle",
} as const;

export const RESERVED_MATE_ID = {
  LEAD: "lead",
  CHORE: "chore",
  PR_REVIEWER: "pr_reviewer",
} as const;

export const MATE_STATUS = {
  INIT: "init",
  IDLE: "idle",
  WORKING: "working",
  FAILED: "failed",
} as const;

export const PRIORITY_ORDER = {
  critical: 4,
  high: 3,
  normal: 2,
  low: 1,
} as const;

export type TaskPriority = number;

export const TASK_STATUS = {
  PENDING: "pending",
  BLOCKED: "blocked",
  CLAIMED: "claimed",
  IN_PROGRESS: "in-progress",
  COMPLETED: "completed",
  FAILED: "failed",
} as const;

export type TeamStatus = (typeof TEAM_STATUS)[keyof typeof TEAM_STATUS];
export type MateStatus = (typeof MATE_STATUS)[keyof typeof MATE_STATUS];
export type TaskStatus = (typeof TASK_STATUS)[keyof typeof TASK_STATUS];
export type TaskClass = "primary" | "secondary";

export type Teammate = {
  teammateId: string;
  status: MateStatus;
  model?: string;
  createdAt: number;
  updatedAt: number;
  currentTaskId?: string;
};

export type Team = {
  teamId: string;
  teamName: string;
  instruction: string;
  creatorSessionKey?: string;
  teamAgentId: string;
  status: TeamStatus;
  createdAt: number;
  updatedAt: number;
  teammates: Record<string, Teammate>;
  tmuxPanes?: {
    sessionName: string;
    leadPaneId?: string;
    teammatePaneIds: Record<string, string>;
    updatedAt: number;
  };
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
  commitId?: string;
  clones: number;
  onSubmit?: (taskId: string, reply: string) => void;
};

// ---- Swarm ----

export type SwarmTask = Task;

export type SwarmTaskNode = {
  taskId: string;
  assignee: string;
  status: TaskStatus;
};

export type SwarmAskMode = "read" | "edit";

export type SwarmAddTaskParams = {
  title: string;
  assignTo?: string;
  priority?: Task["priority"] | keyof typeof PRIORITY_ORDER;
  dependsOn?: string[];
  instruction?: string;
  taskClass?: Task["taskClass"];
  status?: Task["status"];
  contextSessionKey?: string;
  onSubmit?: (taskId: string, reply: string) => void;
};

export type SwarmTeamMember = Teammate;

export type SwarmTeamContext = {
  isLead: boolean;
  teammateId: string;
  task: SwarmTask;
};

export type SwarmTeamRecord = Team;
