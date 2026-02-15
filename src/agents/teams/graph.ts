import {
  RESERVED_MATE_ID,
  TASK_STATUS,
  type GraphOptions,
  type TaskRestoreSnapshot,
  type SwarmAddTaskParams,
  type SwarmTask,
  type PendingTaskQueueEntry,
} from "./types.js";

const EMPTY_EDGE_SET = new Set<string>();

export class PendingTaskQueue {
  private readonly heap: PendingTaskQueueEntry[] = [];
  private readonly queuedTaskIds = new Set<string>();
  private sequence = 0;

  public get size(): number {
    return this.heap.length;
  }

  public enqueue(task: Pick<SwarmTask, "taskId" | "priority" | "createdAt">): void {
    if (this.queuedTaskIds.has(task.taskId)) return;
    this.queuedTaskIds.add(task.taskId);
    this.push({
      taskId: task.taskId,
      priority: task.priority,
      createdAt: task.createdAt,
      sequence: this.sequence,
    });
    this.sequence += 1;
  }

  public dequeueTaskId(): string | undefined {
    const entry = this.pop();
    return entry?.taskId;
  }

  private isHigherPriority(a: PendingTaskQueueEntry, b: PendingTaskQueueEntry): boolean {
    if (a.priority !== b.priority) return a.priority > b.priority;
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt;
    return a.sequence < b.sequence;
  }

  private push(entry: PendingTaskQueueEntry): void {
    this.heap.push(entry);
    this.siftUp(this.heap.length - 1);
  }

  private pop(): PendingTaskQueueEntry | undefined {
    if (this.heap.length === 0) return undefined;
    const top = this.heap[0]!;
    const last = this.heap.pop();
    this.queuedTaskIds.delete(top.taskId);
    if (last && this.heap.length > 0) {
      this.heap[0] = last;
      this.siftDown(0);
    }
    return top;
  }

  private siftUp(index: number): void {
    let child = index;
    while (child > 0) {
      const parent = Math.floor((child - 1) / 2);
      const parentEntry = this.heap[parent]!;
      const childEntry = this.heap[child]!;
      if (this.isHigherPriority(parentEntry, childEntry)) {
        break;
      }
      this.heap[parent] = childEntry;
      this.heap[child] = parentEntry;
      child = parent;
    }
  }

  private siftDown(index: number): void {
    let parent = index;
    const length = this.heap.length;
    while (true) {
      const left = parent * 2 + 1;
      const right = left + 1;
      let best = parent;

      const bestEntry = this.heap[best]!;
      if (left < length && this.isHigherPriority(this.heap[left]!, bestEntry)) {
        best = left;
      }
      if (right < length && this.isHigherPriority(this.heap[right]!, this.heap[best]!)) {
        best = right;
      }
      if (best === parent) {
        break;
      }

      const parentEntry = this.heap[parent]!;
      this.heap[parent] = this.heap[best]!;
      this.heap[best] = parentEntry;
      parent = best;
    }
  }
}

export class Graph {
  private readonly teamId: string;
  private readonly tasks = new Map<string, SwarmTask>();
  private readonly dependenciesByTaskId = new Map<string, Set<string>>();
  private readonly dependantsByTaskId = new Map<string, Set<string>>();
  private readonly pendingTaskIdsByAssignee = new Map<string, Set<string>>();
  private readonly opts: GraphOptions;
  private mutationDepth = 0;
  private readonly queuedPendingTaskIds = new Set<string>();
  private taskSeq = 0;
  private version = 0;

  constructor(teamId: string, opts?: GraphOptions) {
    this.teamId = teamId;
    this.opts = opts ?? {};
  }

  public addTask(params: SwarmAddTaskParams & { assignee?: string }): SwarmTask {
    const taskId = this.nextTaskId();
    const dependsOn = this.normalizeDependsOn(params.dependsOn);
    const taskClass = params.taskClass ?? "secondary";

    this.assertNoCycle(taskId, dependsOn);

    const task: SwarmTask = {
      taskId,
      title: params.title,
      instruction: params.instruction ?? params.title,
      submit: "",
      status: params.status ?? (dependsOn.length > 0 ? TASK_STATUS.BLOCKED : TASK_STATUS.PENDING),
      assignee: params.assignTo ?? params.assignee ?? RESERVED_MATE_ID.LEAD,
      contextSessionKey: params.contextSessionKey ?? `task:${taskId}`,
      dependsOn,
      priority: this.normalizePriority(params.priority),
      taskClass,
      createdAt: Date.now(),
      claimedAt: 0,
      completedAt: 0,
      deletedAt: 0,
      clones: 1,
    };

    this.tasks.set(taskId, task);
    this.bumpVersion();
    this.ensureNode(taskId);
    this.syncDependencies(taskId, dependsOn);
    this.syncPendingIndex(undefined, task);
    this.refreshBlockedState(taskId);
    const created = this.mustGetTask(taskId);
    if (created.status === TASK_STATUS.PENDING) {
      this.emitTaskPending(created);
    }
    return created;
  }

  public beginGraphMutation(): void {
    this.mutationDepth += 1;
  }

  public endGraphMutation(): void {
    if (this.mutationDepth === 0) return;
    this.mutationDepth -= 1;
    if (this.mutationDepth > 0) return;
    this.flushQueuedPendingTaskEvents();
  }

  public getTask(taskId: string): SwarmTask | undefined {
    return this.tasks.get(taskId);
  }

  public getVersion(): number {
    return this.version;
  }

  public listActiveTasksBySession(sessionKey: string): SwarmTask[] {
    return this.listTasks().filter((task) => {
      if (task.contextSessionKey !== sessionKey) return false;
      return (
        task.status !== TASK_STATUS.COMPLETED &&
        task.status !== TASK_STATUS.FAILED &&
        task.status !== TASK_STATUS.DELETED
      );
    });
  }

  public claimIfPending(taskId: string): SwarmTask {
    const task = this.mustGetTask(taskId);
    if (task.status !== TASK_STATUS.PENDING) return task;
    return this.updateTask(taskId, { status: TASK_STATUS.CLAIMED, claimedAt: Date.now() });
  }

  public listTasks(): SwarmTask[] {
    return Array.from(this.tasks.values());
  }

  public listPendingTasksForAssignee(teammateId: string): SwarmTask[] {
    const taskIds = this.pendingTaskIdsByAssignee.get(teammateId);
    if (!taskIds || taskIds.size === 0) return [];

    const pending: SwarmTask[] = [];
    for (const taskId of taskIds) {
      const task = this.getTask(taskId);
      if (!task || task.status !== TASK_STATUS.PENDING || task.assignee !== teammateId) {
        continue;
      }
      pending.push(task);
    }
    return pending;
  }

  public removeTask(taskId: string): TaskRestoreSnapshot[] {
    const snapshots: TaskRestoreSnapshot[] = [];
    const visited = new Set<string>();

    const softDelete = (id: string) => {
      if (visited.has(id)) return;
      visited.add(id);
      const current = this.getTask(id);
      if (!current) return;
      for (const dependantId of this.directDependantsOf(id)) {
        const dependant = this.getTask(dependantId);
        if (dependant && dependant.taskId !== id && dependant.status !== TASK_STATUS.DELETED) {
          softDelete(dependant.taskId);
        }
      }
      if (current.status === TASK_STATUS.DELETED) return;
      snapshots.push({
        taskId: current.taskId,
        status: current.status,
        completedAt: current.completedAt,
        deletedAt: current.deletedAt,
      });
      this.updateTask(current.taskId, {
        status: TASK_STATUS.DELETED,
        completedAt: Date.now(),
        deletedAt: Date.now(),
      });
    };

    softDelete(taskId);
    return snapshots;
  }

  public updateTask(taskId: string, patch: Partial<SwarmTask>): SwarmTask {
    const task = this.mustGetTask(taskId);

    const nextDependsOn =
      patch.dependsOn !== undefined ? this.normalizeDependsOn(patch.dependsOn) : task.dependsOn;

    if (patch.dependsOn !== undefined) {
      this.assertNoCycle(taskId, nextDependsOn);
      this.syncDependencies(taskId, nextDependsOn);
    }

    const next: SwarmTask = {
      ...task,
      ...patch,
      dependsOn: nextDependsOn,
    };
    const becamePending =
      next.status === TASK_STATUS.PENDING &&
      (task.status !== TASK_STATUS.PENDING || task.assignee !== next.assignee);

    this.tasks.set(taskId, next);
    this.bumpVersion();
    this.syncPendingIndex(task, next);
    this.ensureNode(taskId);

    if (patch.dependsOn !== undefined && patch.status === undefined) {
      this.refreshBlockedState(taskId);
    }

    const updated = this.mustGetTask(taskId);
    if (becamePending && updated.status === TASK_STATUS.PENDING) {
      this.emitTaskPending(updated);
    }

    return updated;
  }

  public applyDependencyBatch(updates: Array<{ taskId: string; dependsOn: string[] }>): void {
    if (updates.length === 0) return;

    const normalizedByTaskId = new Map<string, string[]>();
    const nextDependenciesByTaskId = new Map<string, Set<string>>();
    for (const taskId of this.tasks.keys()) {
      nextDependenciesByTaskId.set(taskId, new Set(this.directDependenciesOf(taskId)));
    }

    for (const update of updates) {
      const task = this.mustGetTask(update.taskId);
      const normalizedDependsOn = this.normalizeDependsOn(update.dependsOn);
      if (normalizedDependsOn.includes(task.taskId)) {
        throw new Error(`Dependency Cycle Found: ${task.taskId} -> ${task.taskId}`);
      }
      normalizedByTaskId.set(task.taskId, normalizedDependsOn);

      const nextDependsOn = new Set<string>();
      for (const depId of normalizedDependsOn) {
        if (!nextDependenciesByTaskId.has(depId)) {
          nextDependenciesByTaskId.set(depId, new Set<string>());
        }
        nextDependsOn.add(depId);
      }
      nextDependenciesByTaskId.set(task.taskId, nextDependsOn);
    }

    this.assertNoCycleForDependencyMap(nextDependenciesByTaskId);

    for (const [taskId, dependsOn] of normalizedByTaskId) {
      const task = this.mustGetTask(taskId);
      this.tasks.set(taskId, {
        ...task,
        dependsOn,
      });
      this.bumpVersion();
      this.syncDependencies(taskId, dependsOn);
      this.refreshBlockedState(taskId);
    }
  }

  public addDependency(taskId: string, dependencyId: string): SwarmTask {
    const task = this.mustGetTask(taskId);
    if (task.dependsOn.includes(dependencyId)) return task;

    const updated = this.updateTask(taskId, {
      dependsOn: [...task.dependsOn, dependencyId],
    });

    if (
      updated.status !== TASK_STATUS.CLAIMED &&
      updated.status !== TASK_STATUS.IN_PROGRESS &&
      updated.status !== TASK_STATUS.COMPLETED &&
      updated.status !== TASK_STATUS.FAILED
    ) {
      return this.updateTask(taskId, { status: TASK_STATUS.BLOCKED });
    }

    return updated;
  }

  public removeDependency(taskId: string, dependencyId: string): SwarmTask {
    const task = this.mustGetTask(taskId);
    if (!task.dependsOn.includes(dependencyId)) return task;

    const updated = this.updateTask(taskId, {
      dependsOn: task.dependsOn.filter((id) => id !== dependencyId),
    });

    this.refreshBlockedState(taskId);
    return updated;
  }

  public getAllChildren(taskId: string): string[] {
    if (!this.hasNode(taskId)) return [];
    const seen = new Set<string>();
    const result: string[] = [];
    const stack = [...this.directDependantsOf(taskId)];

    while (stack.length > 0) {
      const current = stack.pop();
      if (!current || seen.has(current)) {
        continue;
      }
      seen.add(current);
      if (this.getTask(current)) {
        result.push(current);
      }
      for (const next of this.directDependantsOf(current)) {
        if (!seen.has(next)) {
          stack.push(next);
        }
      }
    }

    return result;
  }

  public getAllChildrenTopologically(taskId: string): string[] {
    const descendants = this.getAllChildren(taskId);
    if (descendants.length <= 1) return descendants;

    const descendantSet = new Set(descendants);
    const indegreeByTaskId = new Map<string, number>();
    const ready: string[] = [];
    const ordered: string[] = [];
    let readyIndex = 0;

    for (const descendantTaskId of descendants) {
      const deps = this.directDependenciesOf(descendantTaskId);
      let indegree = 0;
      for (const depId of deps) {
        if (descendantSet.has(depId)) {
          indegree += 1;
        }
      }
      indegreeByTaskId.set(descendantTaskId, indegree);
      if (indegree === 0) {
        ready.push(descendantTaskId);
      }
    }

    while (readyIndex < ready.length) {
      const currentTaskId = ready[readyIndex];
      readyIndex += 1;
      ordered.push(currentTaskId);
      for (const dependantId of this.directDependantsOf(currentTaskId)) {
        if (!descendantSet.has(dependantId)) {
          continue;
        }
        const indegree = (indegreeByTaskId.get(dependantId) ?? 0) - 1;
        indegreeByTaskId.set(dependantId, indegree);
        if (indegree === 0) {
          ready.push(dependantId);
        }
      }
    }

    if (ordered.length === descendants.length) return ordered;

    // Defensive fallback; DAG should prevent this path.
    const seen = new Set(ordered);
    const remaining = descendants.filter((descendantTaskId) => !seen.has(descendantTaskId));
    return ordered.concat(remaining);
  }

  public completeTask(params: { taskId: string; result: "success" | "failure" }): {
    taskId: string;
    status: SwarmTask["status"];
    unblockedTasks: string[];
  } {
    const status = params.result === "failure" ? TASK_STATUS.FAILED : TASK_STATUS.COMPLETED;
    const task = this.updateTask(params.taskId, {
      status,
      completedAt: Date.now(),
    });

    const unblockedTasks: string[] = [];
    if (status === TASK_STATUS.COMPLETED) {
      for (const childId of this.directDependantsOf(params.taskId)) {
        if (this.getTask(childId) && this.refreshBlockedState(childId)) {
          unblockedTasks.push(childId);
        }
      }
    }

    return { taskId: task.taskId, status, unblockedTasks };
  }

  public listActiveLeafTasks(excludeTaskIds?: Set<string>): SwarmTask[] {
    const excluded = excludeTaskIds ?? new Set<string>();
    const leaves: SwarmTask[] = [];

    for (const task of this.tasks.values()) {
      if (task.status === TASK_STATUS.DELETED || excluded.has(task.taskId)) {
        continue;
      }

      let hasActiveDependant = false;
      for (const dependantId of this.directDependantsOf(task.taskId)) {
        if (excluded.has(dependantId)) {
          continue;
        }
        const dependant = this.getTask(dependantId);
        if (!dependant || dependant.status === TASK_STATUS.DELETED) {
          continue;
        }
        hasActiveDependant = true;
        break;
      }

      if (!hasActiveDependant) {
        leaves.push(task);
      }
    }

    return leaves;
  }

  private normalizePriority(value?: SwarmTask["priority"]): number {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    return 0;
  }

  private normalizeDependsOn(dependsOn?: string[]): string[] {
    if (!dependsOn || dependsOn.length === 0) return [];
    return Array.from(new Set(dependsOn));
  }

  private nextTaskId(): string {
    this.taskSeq += 1;
    return `${this.teamId}:t${this.taskSeq}`;
  }

  private mustGetTask(taskId: string): SwarmTask {
    const task = this.getTask(taskId);
    if (!task) {
      throw new Error(`Task "${taskId}" not found.`);
    }
    return task;
  }

  private ensureNode(taskId: string): void {
    if (!this.dependenciesByTaskId.has(taskId)) {
      this.dependenciesByTaskId.set(taskId, new Set());
    }
    if (!this.dependantsByTaskId.has(taskId)) {
      this.dependantsByTaskId.set(taskId, new Set());
    }
  }

  private hasNode(taskId: string): boolean {
    return this.dependenciesByTaskId.has(taskId);
  }

  private directDependenciesOf(taskId: string): ReadonlySet<string> {
    return this.dependenciesByTaskId.get(taskId) ?? EMPTY_EDGE_SET;
  }

  private directDependantsOf(taskId: string): ReadonlySet<string> {
    return this.dependantsByTaskId.get(taskId) ?? EMPTY_EDGE_SET;
  }

  private addEdge(taskId: string, depId: string): void {
    this.ensureNode(taskId);
    this.ensureNode(depId);
    this.dependenciesByTaskId.get(taskId)?.add(depId);
    this.dependantsByTaskId.get(depId)?.add(taskId);
  }

  private removeEdge(taskId: string, depId: string): void {
    this.dependenciesByTaskId.get(taskId)?.delete(depId);
    this.dependantsByTaskId.get(depId)?.delete(taskId);
  }

  private syncPendingIndex(previous: SwarmTask | undefined, next: SwarmTask): void {
    if (previous) {
      this.removePendingTask(previous.assignee, previous.taskId);
    }
    if (next.status === TASK_STATUS.PENDING) {
      this.addPendingTask(next.assignee, next.taskId);
    }
  }

  private addPendingTask(teammateId: string, taskId: string): void {
    let set = this.pendingTaskIdsByAssignee.get(teammateId);
    if (!set) {
      set = new Set<string>();
      this.pendingTaskIdsByAssignee.set(teammateId, set);
    }
    set.add(taskId);
  }

  private removePendingTask(teammateId: string, taskId: string): void {
    const set = this.pendingTaskIdsByAssignee.get(teammateId);
    if (!set) return;
    set.delete(taskId);
    if (set.size === 0) {
      this.pendingTaskIdsByAssignee.delete(teammateId);
    }
  }

  private syncDependencies(taskId: string, nextDependsOn: string[]): void {
    this.ensureNode(taskId);
    const next = new Set(nextDependsOn);
    const current = new Set(this.directDependenciesOf(taskId));

    for (const depId of current) {
      if (!next.has(depId)) {
        this.removeEdge(taskId, depId);
      }
    }

    for (const depId of next) {
      if (!current.has(depId)) {
        this.addEdge(taskId, depId);
      }
    }
  }

  private assertNoCycle(taskId: string, nextDependsOn: string[]): void {
    for (const depId of nextDependsOn) {
      if (depId === taskId || this.hasPath(depId, taskId)) {
        throw new Error(`Dependency Cycle Found: ${taskId} -> ${depId} -> ${taskId}`);
      }
    }
  }

  private assertNoCycleForDependencyMap(dependenciesByTaskId: Map<string, Set<string>>): void {
    const visiting = new Set<string>();
    const visited = new Set<string>();

    const visit = (taskId: string): boolean => {
      if (visiting.has(taskId)) return true;
      if (visited.has(taskId)) return false;

      visiting.add(taskId);
      for (const depId of dependenciesByTaskId.get(taskId) ?? []) {
        if (visit(depId)) return true;
      }
      visiting.delete(taskId);
      visited.add(taskId);
      return false;
    };

    for (const taskId of dependenciesByTaskId.keys()) {
      if (visit(taskId)) {
        throw new Error(`Dependency Cycle Found in batch update involving "${taskId}".`);
      }
    }
  }

  private hasPath(start: string, target: string): boolean {
    if (start === target) return true;
    if (!this.hasNode(start)) return false;

    const visited = new Set<string>([start]);
    const stack = [start];
    while (stack.length > 0) {
      const node = stack.pop();
      if (!node) {
        continue;
      }
      for (const depId of this.directDependenciesOf(node)) {
        if (depId === target) return true;
        if (!visited.has(depId)) {
          visited.add(depId);
          stack.push(depId);
        }
      }
    }

    return false;
  }

  private refreshBlockedState(taskId: string): boolean {
    const task = this.getTask(taskId);
    if (!task) return false;

    if (
      task.status === TASK_STATUS.COMPLETED ||
      task.status === TASK_STATUS.FAILED ||
      task.status === TASK_STATUS.DELETED ||
      task.status === TASK_STATUS.CLAIMED ||
      task.status === TASK_STATUS.IN_PROGRESS
    ) {
      return false;
    }

    const isUnblocked = task.dependsOn.every((depId) => {
      const dep = this.getTask(depId);
      return !dep || dep.status === TASK_STATUS.COMPLETED;
    });

    const nextStatus = isUnblocked ? TASK_STATUS.PENDING : TASK_STATUS.BLOCKED;
    if (task.status === nextStatus) return false;

    this.updateTask(taskId, { status: nextStatus });
    return nextStatus === TASK_STATUS.PENDING;
  }

  private emitTaskPending(task: SwarmTask): void {
    if (this.mutationDepth > 0) {
      this.queuedPendingTaskIds.add(task.taskId);
      return;
    }
    this.opts.onTaskPending?.(task);
  }

  private flushQueuedPendingTaskEvents(): void {
    if (this.queuedPendingTaskIds.size === 0) return;
    const queuedIds = Array.from(this.queuedPendingTaskIds);
    this.queuedPendingTaskIds.clear();

    for (const taskId of queuedIds) {
      const task = this.getTask(taskId);
      if (!task || task.status !== TASK_STATUS.PENDING) {
        continue;
      }
      this.opts.onTaskPending?.(task);
    }
  }

  private bumpVersion(): void {
    this.version += 1;
    this.opts.onGraphChanged?.();
  }
}
