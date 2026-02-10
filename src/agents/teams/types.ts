// src/agents/teams/types.ts

// ---- Coordination Mode ----

// ---- Lead Status Constants ----

export const LEAD_STATUS_SPAWNING = "spawning";
export const LEAD_STATUS_IDLE = "idle";
export const LEAD_STATUS_WORKING = "working";
export const LEAD_STATUS_COMPLETED = "completed";
export const LEAD_STATUS_FAILED = "failed";
export const LEAD_STATUS_INTERRUPTED = "interrupted";

export type LeadStatus =
  | typeof LEAD_STATUS_SPAWNING
  | typeof LEAD_STATUS_IDLE
  | typeof LEAD_STATUS_WORKING
  | typeof LEAD_STATUS_COMPLETED
  | typeof LEAD_STATUS_FAILED
  | typeof LEAD_STATUS_INTERRUPTED;

// ---- Teammate Status Constants ----

export const TEAMMATE_STATUS_SPAWNING = "spawning";
export const TEAMMATE_STATUS_ACTIVE = "active";
export const TEAMMATE_STATUS_IDLE = "idle";
export const TEAMMATE_STATUS_COMPLETED = "completed";
export const TEAMMATE_STATUS_FAILED = "failed";
export const TEAMMATE_STATUS_INTERRUPTED = "interrupted";

// ---- Team ----

export type TeamConfig = {
  notifyOnUnblock: boolean;
};

export type TeamStatus = "active" | "completed" | "failed" | "interrupted";

export type Team = {
  teamId: string; // UUID
  teamName: string; // human-readable
  description?: string;
  creatorSessionKey?: string; // session that created the team (may be outside the team)
  teamAgentId: string; // agent id backing the team workspace + sessions
  leadSessionKey: string;
  status: TeamStatus;
  persistent: boolean; // false for auto-cleanup teams, true for persistent teams
  boundSessionKey?: string; // gateway session key for non-persistent teams (used for cleanup)
  createdAt: number;
  updatedAt: number;
  teammates: Record<string, Teammate>; // keyed by teammateId
  config: TeamConfig;
  tmuxPanes?: {
    sessionName: string;
    leadPaneId?: string;
    teammatePaneIds: Record<string, string>;
    updatedAt: number;
  };
  // Guard: only send idle-notification to the lead once per idle window.
  // Reset when a new teammate is spawned or a new task is added.
  idleNotificationSent?: boolean;
  // Lead status tracking
  leadStatus?: LeadStatus;
  leadRunId?: string;
  answerBroadcasted?: boolean;
};

// ---- Teammate ----

export type TeammateStatus =
  | "spawning"
  | "active"
  | "idle"
  | "completed"
  | "failed"
  | "interrupted";

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
  from: string; // teammateId | "lead" | "creator"
  to: string; // teammateId or "all" for broadcast
  message: string;
  priority: MessagePriority;
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
