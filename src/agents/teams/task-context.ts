import { type Task } from "./types.js";

function byCreatedThenId(a: Task, b: Task): number {
  if (a.createdAt !== b.createdAt) {
    return a.createdAt - b.createdAt;
  }
  return a.taskId.localeCompare(b.taskId);
}

function selectStablePrimaryId(
  primaryIds: Set<string>,
  tasksById: Map<string, Task>,
): string | undefined {
  if (primaryIds.size === 0) {
    return undefined;
  }
  const sorted = Array.from(primaryIds)
    .map((id) => tasksById.get(id))
    .filter((task): task is Task => Boolean(task))
    .toSorted(byCreatedThenId);
  return sorted[0]?.taskId ?? Array.from(primaryIds).toSorted()[0];
}

function buildDependentsIndex(tasks: Task[]): Map<string, string[]> {
  const dependentsByTaskId = new Map<string, string[]>();
  for (const task of tasks) {
    for (const dependencyId of task.dependsOn) {
      const dependents = dependentsByTaskId.get(dependencyId) ?? [];
      dependents.push(task.taskId);
      dependentsByTaskId.set(dependencyId, dependents);
    }
  }
  return dependentsByTaskId;
}

function recursiveFindPrimaryTaskId(
  taskId: string,
  tasksById: Map<string, Task>,
  dependentsByTaskId: Map<string, string[]>,
  visited: Set<string>,
): string | undefined {
  if (visited.has(taskId)) {
    return undefined;
  }
  const pathVisited = new Set(visited);
  pathVisited.add(taskId);

  const current = tasksById.get(taskId);
  if (!current) {
    return undefined;
  }
  if (current.taskClass === "primary") {
    return current.taskId;
  }

  const candidates = new Set<string>();
  const dependents = dependentsByTaskId.get(taskId) ?? [];
  for (const dependentTaskId of dependents) {
    const resolved = recursiveFindPrimaryTaskId(
      dependentTaskId,
      tasksById,
      dependentsByTaskId,
      pathVisited,
    );
    if (resolved) {
      candidates.add(resolved);
    }
  }

  return selectStablePrimaryId(candidates, tasksById);
}

// whenever we add a task, we should find primary task to decide context session key
export function resolvePrimaryContextTaskId(taskId: string, tasks: Task[]): string | undefined {
  const tasksById = new Map(tasks.map((task) => [task.taskId, task]));
  const dependentsByTaskId = buildDependentsIndex(tasks);
  return recursiveFindPrimaryTaskId(taskId, tasksById, dependentsByTaskId, new Set<string>());
}
