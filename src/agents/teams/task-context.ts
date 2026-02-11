import type { Task } from "./types.js";

function byCreatedThenId(a: Task, b: Task): number {
  if (a.createdAt !== b.createdAt) {
    return a.createdAt - b.createdAt;
  }
  return a.taskId.localeCompare(b.taskId);
}

function normalizeTaskIdList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

function readPrimaryContextMetadataId(
  metadata: Record<string, unknown> | undefined,
): string | undefined {
  const primaryContext = metadata?.primary_context_task_id;
  if (typeof primaryContext === "string" && primaryContext.length > 0) {
    return primaryContext;
  }
  return undefined;
}

function collectSourceTaskIds(metadata: Record<string, unknown> | undefined): string[] {
  if (!metadata) {
    return [];
  }
  const oneToOneKeys = ["context_task_id", "source_task_id"] as const;
  const oneToManyKeys = ["source_task_ids"] as const;

  const ids = new Set<string>();
  for (const key of oneToOneKeys) {
    const value = metadata[key];
    if (typeof value === "string" && value.length > 0) {
      ids.add(value);
    }
  }
  for (const key of oneToManyKeys) {
    for (const id of normalizeTaskIdList(metadata[key])) {
      ids.add(id);
    }
  }
  return Array.from(ids);
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

function resolvePrimaryContextTaskIdInternal(
  taskId: string,
  tasksById: Map<string, Task>,
  visited: Set<string>,
): string | undefined {
  if (visited.has(taskId)) {
    return undefined;
  }
  visited.add(taskId);

  const current = tasksById.get(taskId);
  if (!current) {
    return undefined;
  }
  if (current.taskClass === "primary") {
    return current.taskId;
  }

  const explicitPrimary = readPrimaryContextMetadataId(current.metadata);
  if (explicitPrimary) {
    return explicitPrimary;
  }

  const candidates = new Set<string>();
  for (const sourceTaskId of collectSourceTaskIds(current.metadata)) {
    const resolved = resolvePrimaryContextTaskIdInternal(sourceTaskId, tasksById, visited);
    if (resolved) {
      candidates.add(resolved);
    }
  }
  if (candidates.size === 1) {
    return Array.from(candidates)[0];
  }

  for (const depId of current.dependsOn) {
    const resolved = resolvePrimaryContextTaskIdInternal(depId, tasksById, visited);
    if (resolved) {
      candidates.add(resolved);
    }
  }

  return selectStablePrimaryId(candidates, tasksById);
}

function resolvePrimaryFromReferencedTaskId(
  taskId: string,
  tasksById: Map<string, Task>,
): string | undefined {
  const referenced = tasksById.get(taskId);
  if (!referenced) {
    return undefined;
  }
  return resolvePrimaryContextTaskIdInternal(taskId, tasksById, new Set<string>());
}

export function derivePrimaryContextTaskIdForNewTask(params: {
  taskClass?: "primary" | "secondary";
  dependsOn?: string[];
  metadata?: Record<string, unknown>;
  existingTasks: Task[];
}): string | undefined {
  if (params.taskClass === "primary") {
    // Primary tasks self-point after taskId allocation.
    return undefined;
  }

  const metadata = params.metadata;
  const tasksById = new Map(params.existingTasks.map((task) => [task.taskId, task]));
  const explicitPrimary = readPrimaryContextMetadataId(metadata);
  if (explicitPrimary) {
    const resolved = resolvePrimaryFromReferencedTaskId(explicitPrimary, tasksById);
    if (!resolved) {
      throw new Error(
        `primary_context_task_id "${explicitPrimary}" does not resolve to a primary task.`,
      );
    }
    return resolved;
  }

  const candidates = new Set<string>();
  for (const sourceTaskId of collectSourceTaskIds(metadata)) {
    const resolved = resolvePrimaryFromReferencedTaskId(sourceTaskId, tasksById);
    if (resolved) {
      candidates.add(resolved);
    }
  }
  for (const depId of params.dependsOn ?? []) {
    const resolved = resolvePrimaryFromReferencedTaskId(depId, tasksById);
    if (resolved) {
      candidates.add(resolved);
    }
  }

  const isReservedTask = params.metadata?.reservedTask === true;
  if (candidates.size > 1) {
    if (isReservedTask) {
      // Reserved orchestration tasks may fan across contexts; dispatch resolves context later.
      return undefined;
    }
    const sorted = Array.from(candidates).toSorted();
    throw new Error(
      `Task derives from multiple primary contexts (${sorted.join(", ")}). Secondary tasks must map to exactly one primary context.`,
    );
  }
  const resolved = Array.from(candidates)[0];
  if (params.taskClass === "secondary" && !resolved) {
    if (isReservedTask) {
      // Reserved orchestration tasks may start without task context.
      return undefined;
    }
    throw new Error("Secondary tasks must derive exactly one primary context.");
  }
  return resolved;
}

export function resolvePrimaryContextTaskId(taskId: string, tasks: Task[]): string | undefined {
  const tasksById = new Map(tasks.map((task) => [task.taskId, task]));
  return resolvePrimaryContextTaskIdInternal(taskId, tasksById, new Set<string>());
}

export function resolvePrimaryContextTaskIds(taskIds: string[], tasks: Task[]): string[] {
  const ids = new Set<string>();
  for (const taskId of taskIds) {
    const primaryId = resolvePrimaryContextTaskId(taskId, tasks);
    if (primaryId) {
      ids.add(primaryId);
    }
  }
  const tasksById = new Map(tasks.map((task) => [task.taskId, task]));
  return Array.from(ids).toSorted((a, b) => {
    const ta = tasksById.get(a);
    const tb = tasksById.get(b);
    if (ta && tb) {
      return byCreatedThenId(ta, tb);
    }
    return a.localeCompare(b);
  });
}
