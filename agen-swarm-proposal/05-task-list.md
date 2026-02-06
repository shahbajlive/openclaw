# Task 05: Shared Task List

**Layer:** 1 (Infrastructure)
**Dependencies:** Task 01 (types)
**Can run in parallel with:** Task 04, Task 06, Task 07

## What to Do

Create the file-backed task list that teams use to coordinate work. Tasks have dependencies, blocking/unblocking logic, and file-level locking for concurrent claims.

## File to Create

### `src/agents/teams/task-list.ts`

All logic from RFC section 3.4 (lines 440-510 of `initial-rought-design.md`).

```typescript
// Key functions:

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
): Task;
// 1. Generate UUID taskId
// 2. Load tasks.json (with file lock)
// 3. If dependsOn is set, validate:
//    a. All referenced tasks exist
//    b. Adding this dependency would NOT create a cycle (wouldCreateCycle)
// 4. Determine initial status:
//    - "blocked" if any dependency is not completed
//    - "pending" otherwise
// 5. If assignTo is set, record it
// 6. Save tasks.json (release lock)
// 7. Return created Task

export function claimTask(
  teamId: string,
  params: {
    taskId?: string;
    claimerId: string;
    filter?: { priority?: TaskPriority; tags?: string[] };
  },
): { success: boolean; task?: Task; reason?: string };
// 1. Load tasks.json (with file lock -- critical for concurrent claims)
// 2. If taskId given: try to claim that specific task
//    If no taskId: auto-select the highest-priority "pending" task
// 3. Check: task.status must be "pending" (not blocked, not already claimed)
// 4. Atomic update: set status="claimed", assignee=claimerId, claimedAt=now
// 5. Save tasks.json (release lock)
// 6. Return { success: true, task } or { success: false, reason: "..." }

export function completeTask(
  teamId: string,
  params: {
    taskId: string;
    result?: "success" | "failure";
    summary?: string;
    artifacts?: string[];
  },
): { taskId: string; status: "completed" | "failed"; unblockedTasks: string[] };
// 1. Load tasks.json (with file lock)
// 2. Find task, verify it's in "claimed" or "in-progress" state
// 3. Set status to "completed" or "failed" based on result
// 4. Set completedAt, summary, artifacts
// 5. Run onTaskComplete() to auto-unblock dependents
// 6. Save tasks.json (release lock)
// 7. Return { taskId, status, unblockedTasks }

export function listTasks(
  teamId: string,
  filter?: {
    status?: TaskStatus[];
    assignee?: string;
    priority?: TaskPriority;
    includeCompleted?: boolean;
  },
): { tasks: Task[]; summary: TaskSummary };
// Load tasks.json (no lock needed -- read only)
// Apply filters
// Compute blockedBy for each task (which of its deps are incomplete)
// Return filtered list + summary counts

export function getTask(teamId: string, taskId: string): Task | null;
// Load tasks.json, find by taskId

export function removeTask(teamId: string, taskId: string): boolean;
// Load tasks.json (with lock), remove task, save
// Only allow removing if task is "pending" or "blocked" (not in progress)
```

### Internal helper functions (from RFC section 3.4):

```typescript
function isBlocked(task: Task, allTasks: Map<string, Task>): boolean {
  for (const depId of task.dependsOn) {
    const dep = allTasks.get(depId);
    if (!dep || dep.status !== "completed") {
      return true;
    }
  }
  return false;
}

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

function wouldCreateCycle(taskId: string, newDep: string, tasks: Map<string, Task>): boolean {
  const visited = new Set<string>();
  const stack = [newDep];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === taskId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    const task = tasks.get(current);
    if (task) {
      stack.push(...task.dependsOn);
    }
  }
  return false;
}

function computeBlockedBy(task: Task, allTasks: Map<string, Task>): string[] {
  return task.dependsOn.filter((depId) => {
    const dep = allTasks.get(depId);
    return !dep || dep.status !== "completed";
  });
}
```

### File locking

Use the same lock pattern from `src/config/sessions/store.ts` (the `withSessionStoreLock` function). The key idea: use `proper-lockfile` or a simple write-lock file to prevent two teammates from claiming the same task simultaneously.

Simple approach: use `fs.writeFileSync` with `{ flag: "wx" }` to create a `tasks.json.lock` file, then delete after write. Wrap in retry logic.

```typescript
async function withTaskLock<T>(teamId: string, fn: () => T): Promise<T> {
  const lockPath = resolveTaskLockPath(teamId);
  // Acquire lock (retry up to 5 times with 100ms delay)
  // Execute fn()
  // Release lock (delete lockfile)
  // Return result
}

function resolveTasksPath(teamId: string): string {
  const basePath = resolveTeamBasePath();
  return path.join(basePath, teamId, "tasks.json");
}

function loadTasks(teamId: string): Map<string, Task> {
  const filePath = resolveTasksPath(teamId);
  // Read file, parse JSON, build Map<taskId, Task>
  // Return empty map if file doesn't exist
}

function saveTasks(teamId: string, tasks: Map<string, Task>): void {
  const filePath = resolveTasksPath(teamId);
  // Ensure directory exists
  // Write JSON with pretty formatting
}
```

## Reference Files

- RFC section 3.4: `agen-swarm-proposal/initial-rought-design.md` lines 440-510
- Session store locking pattern: `src/config/sessions/store.ts`
- `resolveTeamBasePath` from Task 04 (`team-registry.store.ts`)

## Notes

- File locking is critical for `claimTask` since multiple teammates may try to claim simultaneously. "First claim wins" semantics.
- `wouldCreateCycle` does a DFS from the new dependency to see if it eventually reaches back to the task being modified.
- `onTaskComplete` is the auto-unblock function: when a task completes, scan all blocked tasks and move newly-unblocked ones to "pending".
- Priority ordering for auto-select: `critical > high > normal > low`. Within same priority, FIFO (oldest first by `createdAt`).

## Acceptance Criteria

- [ ] `addTask` creates a task with correct initial status (pending or blocked)
- [ ] `addTask` rejects circular dependencies
- [ ] `claimTask` with file locking prevents double-claims
- [ ] `claimTask` with no taskId auto-selects highest priority pending task
- [ ] `completeTask` auto-unblocks dependent tasks
- [ ] `listTasks` filters work correctly
- [ ] `computeBlockedBy` shows which deps are incomplete
- [ ] All operations survive concurrent access (file locking)
- [ ] `pnpm build` passes
