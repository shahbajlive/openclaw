// src/agents/teams/types.ts

// ---- Coordination Mode ----

export type CoordinationMode = "normal" | "delegate";

// ---- Team ----

export type TeamConfig = {
  maxTeammates: number;
  notifyOnUnblock: boolean;
};

export type TeamStatus = "active" | "completed" | "failed" | "interrupted";

export type Team = {
  teamId: string; // UUID
  teamName: string; // human-readable
  description?: string;
  leadSessionKey: string;
  coordinationMode: CoordinationMode;
  status: TeamStatus;
  maxTeammates: number;
  createdAt: number;
  updatedAt: number;
  teammates: Record<string, Teammate>; // keyed by teammateId
  config: TeamConfig;
};

// ---- Teammate ----

export type TeammateStatus = "spawning" | "active" | "idle" | "completed" | "failed";

export type Teammate = {
  teammateId: string; // UUID
  role: string;
  sessionKey: string;
  status: TeammateStatus;
  model?: string; // cross-model support
  requirePlanApproval: boolean;
  planApproved: boolean; // false until lead approves
  currentTask?: string;
  claimedTasks: number;
  completedTasks: number;
  createdAt: number;
  timeout?: number; // seconds before auto-termination
};

// ---- Task ----

export type TaskStatus = "pending" | "blocked" | "claimed" | "in-progress" | "completed" | "failed";
export type TaskPriority = "low" | "normal" | "high" | "critical";

export type Task = {
  taskId: string;
  title: string;
  description?: string;
  status: TaskStatus;
  assignee?: string; // teammateId
  dependsOn: string[]; // task IDs
  priority: TaskPriority;
  metadata?: Record<string, unknown>;
  result?: "success" | "failure";
  summary?: string;
  artifacts?: string[];
  createdAt: number;
  claimedAt?: number;
  completedAt?: number;
};

// ---- Team Message ----

export type MessagePriority = "normal" | "urgent";

export type TeamMessage = {
  messageId: string;
  teamId: string;
  from: string; // teammateId or "lead"
  to: string; // teammateId or "all" for broadcast
  message: string;
  priority: MessagePriority;
  read: boolean;
  createdAt: number;
};

// ---- Plan (for plan approval workflow) ----

export type PlanStatus = "pending" | "approved" | "rejected" | "revision-requested";

export type PlanStep = {
  description: string;
  estimatedTokens?: number;
  tools?: string[];
};

export type TeammatePlan = {
  teammateId: string;
  teamId: string;
  status: PlanStatus;
  plan: {
    summary: string;
    steps: PlanStep[];
    risks?: string[];
    alternatives?: string[];
  };
  feedback?: string;
  submittedAt: number;
  reviewedAt?: number;
};

// ---- Task Summary (used by team_status) ----

export type TaskSummary = {
  total: number;
  pending: number;
  blocked: number;
  inProgress: number;
  completed: number;
  failed: number;
};
