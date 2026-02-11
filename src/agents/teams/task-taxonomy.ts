import type { Task } from "./types.js";

export const TASK_INIT = "init_task";
export const TASK_LEAD_REVIEW = "lead_review";
export const TASK_QUESTION_REQUEST = "qn_request";
export const TASK_REVIEW_QUESTION = "review_question";
export const TASK_BROADCAST_ANSWER = "broadcast_answer";

const RESERVED_TASKS = new Set<string>([
  TASK_INIT,
  TASK_LEAD_REVIEW,
  TASK_QUESTION_REQUEST,
  TASK_REVIEW_QUESTION,
  TASK_BROADCAST_ANSWER,
]);

type TaskMetadata = Record<string, unknown> | undefined;

function readTaskClass(metadata: TaskMetadata): "primary" | "secondary" | undefined {
  const value = metadata?.taskClass;
  if (value === "primary" || value === "secondary") {
    return value;
  }
  return undefined;
}

export function isQuestionRequestTitle(title: string): boolean {
  return title === TASK_QUESTION_REQUEST || title.startsWith(`${TASK_QUESTION_REQUEST}_`);
}

export function isReservedTaskTitle(title: string): boolean {
  return RESERVED_TASKS.has(title) || isQuestionRequestTitle(title);
}

export function isTaskClassExemptTitle(title: string): boolean {
  return title === TASK_INIT || title === TASK_BROADCAST_ANSWER;
}

export function inferTaskClass(
  title: string,
  metadata?: Record<string, unknown>,
): "primary" | "secondary" | undefined {
  const explicit = readTaskClass(metadata);
  if (explicit) {
    return explicit;
  }
  if (isTaskClassExemptTitle(title)) {
    return undefined;
  }
  if (metadata?.source === "init_plan" || typeof metadata?.initTaskId === "string") {
    return "primary";
  }
  return "secondary";
}

export function withTaskClass(
  title: string,
  metadata?: Record<string, unknown>,
): {
  taskClass?: "primary" | "secondary";
  isReservedTask: boolean;
  metadata?: Record<string, unknown>;
} {
  const taskClass = inferTaskClass(title, metadata);
  const isReservedTask = isReservedTaskTitle(title);
  const excludedTaskClass = taskClass === undefined;
  const nextMetadata: Record<string, unknown> = {
    ...(metadata ?? {}),
    reservedTask: isReservedTask,
    orchestrationTask: isReservedTask,
  };
  if (taskClass) {
    nextMetadata.taskClass = taskClass;
  } else {
    delete nextMetadata.taskClass;
  }
  nextMetadata.excludedTaskClass = excludedTaskClass;
  if (
    metadata &&
    metadata.taskClass === taskClass &&
    metadata.reservedTask === isReservedTask &&
    metadata.orchestrationTask === isReservedTask &&
    metadata.excludedTaskClass === excludedTaskClass
  ) {
    return { taskClass, isReservedTask, metadata };
  }
  return {
    taskClass,
    isReservedTask,
    metadata: nextMetadata,
  };
}

export function isOpen(task: Task): boolean {
  return task.status !== "completed" && task.status !== "failed";
}
