import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Task, TaskPriority, TaskStatus, TaskSummary } from "./types.js";
import { loadJsonFile, saveJsonFile } from "../../infra/json-file.js";
import { resolveTeamBasePath } from "./team-registry.store.js";

function scheduleLeadStatusRecompute(teamId: string) {
  queueMicrotask(() => {
    import("./team-registry.js")
      .then((mod) => mod.recomputeLeadStatusFromTasks(teamId))
      .catch(() => {});
  });
}

/**
 * Add a task to the team's task list.
 */
export function addTask(
  teamId: string,
  params: {
    title: string;
    description?: string;
    dependsOn?: string[];
    assignTo?: string;
    priority?: TaskPriority;
    metadata?: Record<string, unknown>;
  },
): Task {
  const taskId = crypto.randomUUID();
  const now = Date.now();
  const dependsOn = params.dependsOn ?? [];

  return withTaskLock(teamId, () => {
    const tasks = loadTasks(teamId);

    // Validate dependencies exist
    for (const depId of dependsOn) {
      if (!tasks.has(depId)) {
        throw new Error(`Dependency task ${depId} not found`);
      }
    }

    // Check for circular dependencies
    for (const depId of dependsOn) {
      if (wouldCreateCycle(taskId, depId, tasks)) {
        throw new Error(`Adding dependency ${depId} would create a circular dependency`);
      }
    }

    // Determine initial status
    const isBlocked = dependsOn.some((depId) => {
      const dep = tasks.get(depId);
      return !dep || dep.status !== "completed";
    });

    const task: Task = {
      taskId,
      title: params.title,
      description: params.description,
      status: isBlocked ? "blocked" : "pending",
      assignee: params.assignTo,
      dependsOn,
      priority: params.priority ?? "normal",
      metadata: params.metadata,
      createdAt: now,
    };

    tasks.set(taskId, task);
    saveTasks(teamId, tasks);
    scheduleLeadStatusRecompute(teamId);

    return task;
  });
}

/**
 * Claim a task from the task list.
 */
export function claimTask(
  teamId: string,
  params: {
    taskId?: string;
    claimerId: string;
    filter?: { priority?: TaskPriority; tags?: string[] };
  },
): { success: boolean; task?: Task; reason?: string } {
  return withTaskLock(teamId, () => {
    const tasks = loadTasks(teamId);

    let targetTask: Task | undefined;

    if (params.taskId) {
      // Claim specific task
      targetTask = tasks.get(params.taskId);
      if (!targetTask) {
        return { success: false, reason: "Task not found" };
      }
    } else {
      // Auto-select highest priority pending task
      const candidates = Array.from(tasks.values())
        .filter((t) => t.status === "pending")
        .filter((t) => {
          if (params.filter?.priority && t.priority !== params.filter.priority) {
            return false;
          }
          return true;
        })
        .toSorted((a, b) => {
          // Priority order: critical > high > normal > low
          const priorityOrder = { critical: 4, high: 3, normal: 2, low: 1 };
          const aPriority = priorityOrder[a.priority];
          const bPriority = priorityOrder[b.priority];
          if (aPriority !== bPriority) {
            return bPriority - aPriority;
          }
          // FIFO within same priority
          return a.createdAt - b.createdAt;
        });

      targetTask = candidates[0];
      if (!targetTask) {
        return { success: false, reason: "No available tasks to claim" };
      }
    }

    // Verify task is claimable
    if (targetTask.status !== "pending") {
      return { success: false, reason: `Task is not pending (status: ${targetTask.status})` };
    }

    // Atomic update
    targetTask.status = "claimed";
    targetTask.assignee = params.claimerId;
    targetTask.claimedAt = Date.now();

    saveTasks(teamId, tasks);
    scheduleLeadStatusRecompute(teamId);

    return { success: true, task: targetTask };
  });
}

/**
 * Complete a task.
 */
export function completeTask(
  teamId: string,
  params: {
    taskId: string;
    result?: "success" | "failure";
    summary?: string;
    artifacts?: string[];
  },
): { taskId: string; status: "completed" | "failed"; unblockedTasks: string[] } {
  return withTaskLock(teamId, () => {
    const tasks = loadTasks(teamId);

    const task = tasks.get(params.taskId);
    if (!task) {
      throw new Error(`Task ${params.taskId} not found`);
    }

    if (task.status !== "claimed" && task.status !== "in-progress") {
      throw new Error(
        `Task ${params.taskId} is not claimed or in-progress (status: ${task.status})`,
      );
    }

    const newStatus = params.result === "failure" ? "failed" : "completed";
    task.status = newStatus;
    task.completedAt = Date.now();
    task.result = params.result;
    task.summary = params.summary;
    task.artifacts = params.artifacts;

    // Auto-unblock dependent tasks
    const unblockedTasks = onTaskComplete(params.taskId, tasks);

    saveTasks(teamId, tasks);
    scheduleLeadStatusRecompute(teamId);

    return { taskId: params.taskId, status: newStatus, unblockedTasks };
  });
}

/**
 * List tasks from the task list.
 */
export function listTasks(
  teamId: string,
  filter?: {
    status?: TaskStatus[];
    assignee?: string;
    priority?: TaskPriority;
    includeCompleted?: boolean;
  },
): { tasks: Task[]; summary: TaskSummary } {
  const tasks = loadTasks(teamId);

  let filtered = Array.from(tasks.values());

  // Apply filters
  if (filter?.status) {
    filtered = filtered.filter((t) => filter.status!.includes(t.status));
  }

  if (filter?.assignee) {
    filtered = filtered.filter((t) => t.assignee === filter.assignee);
  }

  if (filter?.priority) {
    filtered = filtered.filter((t) => t.priority === filter.priority);
  }

  if (!filter?.includeCompleted) {
    filtered = filtered.filter((t) => t.status !== "completed" && t.status !== "failed");
  }

  // Compute blockedBy for each task
  for (const task of filtered) {
    if (task.status === "blocked") {
      task.metadata = {
        ...task.metadata,
        blockedBy: computeBlockedBy(task, tasks),
      };
    }
  }

  // Compute summary
  const summary: TaskSummary = {
    total: tasks.size,
    pending: 0,
    blocked: 0,
    inProgress: 0,
    completed: 0,
    failed: 0,
  };

  for (const task of tasks.values()) {
    if (task.status === "pending") {
      summary.pending++;
    } else if (task.status === "blocked") {
      summary.blocked++;
    } else if (task.status === "claimed" || task.status === "in-progress") {
      summary.inProgress++;
    } else if (task.status === "completed") {
      summary.completed++;
    } else if (task.status === "failed") {
      summary.failed++;
    }
  }

  return { tasks: filtered, summary };
}

/**
 * Get a specific task.
 */
export function getTask(teamId: string, taskId: string): Task | null {
  const tasks = loadTasks(teamId);
  return tasks.get(taskId) ?? null;
}

/**
 * Update a task's properties.
 * Can update: status, priority, assignee, description, dependencies.
 */
export function updateTask(
  teamId: string,
  taskId: string,
  updates: {
    status?: TaskStatus;
    priority?: TaskPriority;
    assignee?: string;
    description?: string;
    dependsOn?: string[];
    metadata?: Record<string, unknown>;
  },
): Task {
  return withTaskLock(teamId, () => {
    const tasks = loadTasks(teamId);

    const task = tasks.get(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    // Apply updates
    if (updates.status !== undefined) {
      task.status = updates.status;
    }

    if (updates.priority !== undefined) {
      task.priority = updates.priority;
    }

    if (updates.assignee !== undefined) {
      task.assignee = updates.assignee;
    }

    if (updates.description !== undefined) {
      task.description = updates.description;
    }

    if (updates.dependsOn !== undefined) {
      // Validate dependencies exist
      for (const depId of updates.dependsOn) {
        if (!tasks.has(depId)) {
          throw new Error(`Dependency task ${depId} not found`);
        }
      }

      // Check for circular dependencies
      for (const depId of updates.dependsOn) {
        if (wouldCreateCycle(taskId, depId, tasks)) {
          throw new Error(`Adding dependency ${depId} would create a circular dependency`);
        }
      }

      task.dependsOn = updates.dependsOn;

      // Re-check if task should be blocked
      const isNowBlocked = updates.dependsOn.some((depId) => {
        const dep = tasks.get(depId);
        return !dep || dep.status !== "completed";
      });

      if (isNowBlocked && task.status === "pending") {
        task.status = "blocked";
      } else if (!isNowBlocked && task.status === "blocked") {
        task.status = "pending";
      }
    }

    if (updates.metadata !== undefined) {
      task.metadata = { ...task.metadata, ...updates.metadata };
    }

    saveTasks(teamId, tasks);
    scheduleLeadStatusRecompute(teamId);

    return task;
  });
}

/**
 * Remove a task from the list.
 * Only allows removing pending or blocked tasks.
 */
export function removeTask(teamId: string, taskId: string): boolean {
  return withTaskLock(teamId, () => {
    const tasks = loadTasks(teamId);

    const task = tasks.get(taskId);
    if (!task) {
      return false;
    }

    if (task.status !== "pending" && task.status !== "blocked") {
      throw new Error(`Cannot remove task in status: ${task.status}`);
    }

    tasks.delete(taskId);
    saveTasks(teamId, tasks);
    scheduleLeadStatusRecompute(teamId);

    return true;
  });
}

// ---- Internal helper functions ----

/**
 * Check if a task is blocked by incomplete dependencies.
 */
function isBlocked(task: Task, allTasks: Map<string, Task>): boolean {
  for (const depId of task.dependsOn) {
    const dep = allTasks.get(depId);
    if (!dep || dep.status !== "completed") {
      return true;
    }
  }
  return false;
}

/**
 * When a task completes, check which blocked tasks can now be unblocked.
 */
function onTaskComplete(completedTaskId: string, allTasks: Map<string, Task>): string[] {
  const unblocked: string[] = [];

  for (const task of allTasks.values()) {
    if (task.status === "blocked") {
      if (!isBlocked(task, allTasks)) {
        task.status = "pending";
        unblocked.push(task.taskId);
      }
    }
  }

  return unblocked;
}

/**
 * Check if adding a dependency would create a circular dependency.
 */
function wouldCreateCycle(taskId: string, newDep: string, tasks: Map<string, Task>): boolean {
  const visited = new Set<string>();
  const stack = [newDep];

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === taskId) {
      return true;
    }
    if (visited.has(current)) {
      continue;
    }
    visited.add(current);

    const task = tasks.get(current);
    if (task) {
      stack.push(...task.dependsOn);
    }
  }

  return false;
}

/**
 * Compute which dependencies are blocking a task.
 */
function computeBlockedBy(task: Task, allTasks: Map<string, Task>): string[] {
  return task.dependsOn.filter((depId) => {
    const dep = allTasks.get(depId);
    return !dep || dep.status !== "completed";
  });
}

// ---- File locking and I/O ----

/**
 * Resolve the tasks.json path for a team.
 */
function resolveTasksPath(teamId: string): string {
  const basePath = resolveTeamBasePath();
  return path.join(basePath, teamId, "tasks.json");
}

/**
 * Resolve the lock file path for tasks.
 */
function resolveTaskLockPath(teamId: string): string {
  return `${resolveTasksPath(teamId)}.lock`;
}

/**
 * Load tasks from disk.
 */
function loadTasks(teamId: string): Map<string, Task> {
  const filePath = resolveTasksPath(teamId);
  const raw = loadJsonFile(filePath);

  if (!raw || typeof raw !== "object") {
    return new Map();
  }

  const data = raw as { tasks?: unknown[] };
  if (!Array.isArray(data.tasks)) {
    return new Map();
  }

  const tasks = new Map<string, Task>();
  for (const item of data.tasks) {
    if (item && typeof item === "object") {
      const task = item as Task;
      if (task.taskId) {
        tasks.set(task.taskId, task);
      }
    }
  }

  return tasks;
}

/**
 * Save tasks to disk.
 */
function saveTasks(teamId: string, tasks: Map<string, Task>): void {
  const filePath = resolveTasksPath(teamId);
  const data = {
    tasks: Array.from(tasks.values()),
  };
  saveJsonFile(filePath, data);
}

/**
 * Execute a function with file locking.
 * Retries up to 5 times with 100ms delay.
 */
function withTaskLock<T>(teamId: string, fn: () => T): T {
  const lockPath = resolveTaskLockPath(teamId);
  const maxRetries = 5;
  const retryDelay = 100;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    let lockAcquired = false;
    try {
      // Try to acquire lock
      fs.writeFileSync(lockPath, String(process.pid), { flag: "wx", mode: 0o600 });
      lockAcquired = true;

      // Execute the function — errors from fn() must propagate immediately
      const result = fn();
      return result;
    } catch (err) {
      if (!lockAcquired) {
        // Lock acquisition failed — retry with backoff
        if (attempt < maxRetries - 1) {
          const sleepMs = retryDelay * (attempt + 1);
          const start = Date.now();
          while (Date.now() - start < sleepMs) {
            // Busy wait
          }
          continue;
        }
        throw new Error(
          `Failed to acquire task lock for team ${teamId} after ${maxRetries} attempts`,
          { cause: err },
        );
      }
      // fn() threw — rethrow immediately (not a lock error)
      throw err;
    } finally {
      // Always release lock if it was acquired
      if (lockAcquired) {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // Ignore unlock errors
        }
      }
    }
  }

  throw new Error(`Failed to acquire task lock for team ${teamId}`);
}
