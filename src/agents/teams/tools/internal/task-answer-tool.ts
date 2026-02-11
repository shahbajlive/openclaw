import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "../../../tools/common.js";
import { loadConfig } from "../../../../config/config.js";
import { jsonResult, readStringArrayParam, readStringParam } from "../../../tools/common.js";
import { resolvePrimaryContextTaskId } from "../../task-context.js";
import {
  addTask,
  completeTask,
  forceCompleteTask,
  getTask,
  listTasks,
  updateTask,
} from "../../task-list.js";
import { TASK_INIT, TASK_LEAD_REVIEW } from "../../task-taxonomy.js";
import {
  getTeam,
  notifyLeadIfTeamIdle,
  resolveCallerTeamContext,
  transitionTeammateToIdle,
  updateLeadStatus,
  updateTeamStatus,
} from "../../team-registry.js";
import { saveTeamToDisk } from "../../team-registry.store.js";
import { LEAD_STATUS_IDLE, type TaskPriority } from "../../types.js";

const TaskAnswerSchema = Type.Object({
  teamId: Type.String(),
  answer: Type.String({ description: "Your answer for the current task." }),
  taskId: Type.Optional(
    Type.String({
      description: "The task id you are answering. Defaults to your current task.",
    }),
  ),
  artifacts: Type.Optional(Type.Array(Type.String())),
});

type InitPlanTask = {
  id?: string;
  title: string;
  description?: string;
  assignee?: string;
  dependsOn?: Array<string | number>;
  priority?: TaskPriority;
};

type ParsedInitPlan = {
  tasks: InitPlanTask[];
  warnings: string[];
};

const PRIORITY_VALUES = new Set<TaskPriority>(["critical", "high", "normal", "low"]);

function extractFailureReason(answer: string): string | null {
  const trimmed = answer.trim();
  const match = trimmed.match(/^fail(?:ed)?\b\s*[:\-]?\s*(.*)$/i);
  if (!match) {
    return null;
  }
  const reason = (match[1] ?? "").trim();
  return reason || "No reason provided.";
}

function extractPlanJson(answer: string): string | null {
  const fenced = answer.match(/```json\s*([\s\S]*?)```/i) ?? answer.match(/```([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }
  const trimmed = answer.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return trimmed;
  }
  return null;
}

function parseInitPlan(answer: string): ParsedInitPlan | { error: string } {
  const jsonText = extractPlanJson(answer);
  if (!jsonText) {
    return {
      error: "init_task answer must include JSON (use a ```json fenced block) describing tasks.",
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    return {
      error: `Failed to parse init_task JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const tasksRaw = Array.isArray(parsed) ? parsed : (parsed as { tasks?: unknown }).tasks;
  if (!Array.isArray(tasksRaw) || tasksRaw.length === 0) {
    return { error: "init_task JSON must include a non-empty tasks array." };
  }

  const warnings: string[] = [];
  const tasks: InitPlanTask[] = [];
  for (const [index, entry] of tasksRaw.entries()) {
    if (!entry || typeof entry !== "object") {
      warnings.push(`Skipping task ${index + 1}: not an object.`);
      continue;
    }
    const title =
      typeof (entry as { title?: unknown }).title === "string"
        ? (entry as { title?: string }).title?.trim()
        : "";
    if (!title) {
      warnings.push(`Skipping task ${index + 1}: missing title.`);
      continue;
    }
    const idRaw = (entry as { id?: unknown }).id;
    const id = typeof idRaw === "string" ? idRaw.trim() : undefined;
    const descriptionRaw = (entry as { description?: unknown }).description;
    const description = typeof descriptionRaw === "string" ? descriptionRaw : undefined;
    const assigneeRaw = (entry as { assignee?: unknown }).assignee;
    const assignee = typeof assigneeRaw === "string" ? assigneeRaw.trim() : undefined;
    const dependsRaw = (entry as { dependsOn?: unknown }).dependsOn;
    const dependsOn = Array.isArray(dependsRaw)
      ? dependsRaw.filter(
          (dep): dep is string | number => typeof dep === "string" || typeof dep === "number",
        )
      : undefined;
    const priorityRaw = (entry as { priority?: unknown }).priority;
    const priority =
      typeof priorityRaw === "string" && PRIORITY_VALUES.has(priorityRaw as TaskPriority)
        ? (priorityRaw as TaskPriority)
        : undefined;
    if (priorityRaw && !priority) {
      warnings.push(
        `Task ${index + 1} has invalid priority "${String(priorityRaw)}"; using default.`,
      );
    }

    tasks.push({
      id,
      title,
      description,
      assignee,
      dependsOn,
      priority,
    });
  }

  if (tasks.length === 0) {
    return { error: "init_task JSON did not include any valid tasks." };
  }

  return { tasks, warnings };
}

export function createTaskAnswerTool(opts?: { agentSessionKey?: string }): AnyAgentTool {
  return {
    label: "Teams",
    name: "task_answer",
    description:
      "Submit your answer for a claimed task. The system records the answer and marks the task as done.",
    parameters: TaskAnswerSchema,
    execute: async (_toolCallId, args) => {
      const cfg = loadConfig();
      if (!cfg.gateway?.teams?.enabled) {
        return jsonResult({ status: "error", error: "Teams are not enabled." });
      }

      const params = args as Record<string, unknown>;
      const teamId = readStringParam(params, "teamId", { required: true });
      const answer = readStringParam(params, "answer", { required: true });
      const taskIdParam = readStringParam(params, "taskId");
      const artifacts = readStringArrayParam(params, "artifacts");

      const team = getTeam(teamId);
      if (!team) {
        return jsonResult({ status: "error", error: `Team "${teamId}" not found.` });
      }

      const callerContext = resolveCallerTeamContext(opts?.agentSessionKey ?? "");
      if (!callerContext) {
        return jsonResult({ status: "error", error: "You are not a member of this team." });
      }
      if (callerContext.teammate?.isChore) {
        return jsonResult({
          status: "error",
          error: "Chore teammate cannot submit answers.",
        });
      }

      const teammate = callerContext.teammate;
      const taskId = callerContext.isLead ? taskIdParam : (taskIdParam ?? teammate?.currentTaskId);
      if (!taskId) {
        return jsonResult({
          status: "error",
          error: "No active task found. Provide taskId or claim a task first.",
        });
      }

      const task = getTask(teamId, taskId);
      if (!task) {
        return jsonResult({ status: "error", error: `Task "${taskId}" not found.` });
      }

      if (callerContext.isLead) {
        if (task.assignee !== "lead") {
          return jsonResult({
            status: "error",
            error: "Lead can only answer lead-assigned tasks.",
          });
        }
        if (task.title !== TASK_LEAD_REVIEW && task.title !== TASK_INIT) {
          return jsonResult({
            status: "error",
            error: "Lead can only answer lead_review or init_task tasks.",
          });
        }
      } else {
        if (!teammate) {
          return jsonResult({ status: "error", error: "Caller is not a teammate." });
        }
        if (task.assignee !== teammate.teammateId) {
          return jsonResult({
            status: "error",
            error: "You can only answer tasks assigned to you.",
          });
        }
        if (task.status !== "claimed" && task.status !== "in-progress") {
          return jsonResult({
            status: "error",
            error: `Task is not active (status: ${task.status}).`,
          });
        }
      }

      let initPlanSummary:
        | {
            tasks: Array<{ taskId: string; title: string; assignee?: string }>;
            warnings: string[];
          }
        | undefined;

      if (callerContext.isLead && task.title === TASK_INIT) {
        const parsed = parseInitPlan(answer);
        if ("error" in parsed) {
          return jsonResult({ status: "error", error: parsed.error });
        }
        const warnings = [...parsed.warnings];
        const createdTasks: Array<{ taskId: string; title: string; assignee?: string }> = [];
        const idToTaskId = new Map<string, string>();

        const resolveAssignee = (raw?: string): { assignee?: string; warning?: string } => {
          if (!raw) {
            return {};
          }
          if (raw === "lead") {
            return { warning: "init_task cannot assign work to lead; leaving unassigned." };
          }
          const teammateById = team.teammates[raw];
          if (teammateById && !teammateById.isChore) {
            return { assignee: teammateById.teammateId };
          }
          const teammateByRole = Object.values(team.teammates).find(
            (tm) => tm.role === raw && !tm.isChore,
          );
          if (teammateByRole) {
            return { assignee: teammateByRole.teammateId };
          }
          if (raw === "chore") {
            return { warning: "init_task cannot assign work to chore; leaving unassigned." };
          }
          return {
            warning: `Unknown assignee "${raw}"; leaving task unassigned.`,
          };
        };

        const createdSpecs = parsed.tasks.map((spec, index) => {
          const { assignee, warning } = resolveAssignee(spec.assignee);
          if (warning) {
            warnings.push(`Task ${index + 1}: ${warning}`);
          }
          const created = addTask(teamId, {
            title: spec.title,
            description: spec.description,
            assignTo: assignee,
            priority: spec.priority,
            dependsOn: [taskId],
            metadata: {
              source: "init_plan",
              initTaskId: taskId,
              initPlanId: spec.id,
              requestedAssignee: spec.assignee,
              taskClass: "primary",
            },
          });
          createdTasks.push({
            taskId: created.taskId,
            title: created.title,
            assignee: created.assignee,
          });
          if (spec.id) {
            idToTaskId.set(spec.id, created.taskId);
          }
          idToTaskId.set(String(index + 1), created.taskId);
          return { spec, taskId: created.taskId };
        });

        for (const { spec, taskId: createdId } of createdSpecs) {
          if (!spec.dependsOn || spec.dependsOn.length === 0) {
            continue;
          }
          const resolvedDeps: string[] = [];
          for (const dep of spec.dependsOn) {
            const key = typeof dep === "number" ? String(dep) : dep;
            const resolved = idToTaskId.get(key);
            if (resolved) {
              resolvedDeps.push(resolved);
            } else {
              warnings.push(
                `Task "${spec.title}" dependsOn "${String(dep)}" but no matching task was found.`,
              );
            }
          }
          if (resolvedDeps.length > 0) {
            try {
              updateTask(teamId, createdId, {
                dependsOn: Array.from(new Set([taskId, ...resolvedDeps])),
              });
            } catch (err) {
              warnings.push(
                `Failed to apply dependencies for "${spec.title}": ${
                  err instanceof Error ? err.message : String(err)
                }`,
              );
            }
          }
        }

        initPlanSummary = {
          tasks: createdTasks,
          warnings,
        };
      }
      try {
        const teammateFailureReason =
          !callerContext.isLead && teammate ? extractFailureReason(answer) : null;
        const completionResult = callerContext.isLead
          ? forceCompleteTask(teamId, {
              taskId,
              summary: answer,
              artifacts,
            })
          : completeTask(teamId, {
              taskId,
              result: teammateFailureReason ? "failure" : "success",
              summary: answer,
              artifacts,
            });

        if (teammate) {
          teammate.currentTask = undefined;
          teammate.currentTaskId = undefined;
          teammate.completedTasks++;
          try {
            saveTeamToDisk(callerContext.team, cfg);
          } catch {
            // Non-fatal: in-memory state is already updated.
          }
        }

        if (teammate && teammateFailureReason) {
          const { tasks: allTasks } = listTasks(teamId, { includeCompleted: true });
          const hasOpenLifecycleReview = allTasks.some(
            (item) =>
              item.title === TASK_LEAD_REVIEW &&
              item.assignee === "lead" &&
              item.status !== "completed" &&
              item.status !== "failed" &&
              item.metadata?.source === "teammate_failure" &&
              item.metadata?.failed_task_id === taskId,
          );
          if (!hasOpenLifecycleReview) {
            const { tasks: allTasks } = listTasks(teamId, { includeCompleted: true });
            const primaryTaskId = resolvePrimaryContextTaskId(taskId, allTasks);
            addTask(teamId, {
              title: TASK_LEAD_REVIEW,
              description:
                `Teammate "${teammate.role}" failed task "${task.title}" (${taskId}).\n` +
                `Reason: ${teammateFailureReason}\n` +
                "Decide whether to retry, reassign, or replace this teammate." +
                (primaryTaskId ? `\nPrimary context task: ${primaryTaskId}` : ""),
              assignTo: "lead",
              priority: "critical",
              metadata: {
                source: "teammate_failure",
                teammate_id: teammate.teammateId,
                failed_task_id: taskId,
                context_task_id: taskId,
                primary_context_task_id: primaryTaskId,
              },
            });
          }
        }

        if (teammate) {
          transitionTeammateToIdle(teamId, teammate.teammateId);
        } else if (callerContext.isLead) {
          if (task.title === TASK_INIT) {
            const initFailure = extractFailureReason(answer);
            if (initFailure) {
              try {
                updateTask(teamId, taskId, {
                  metadata: {
                    initFailure: true,
                    initFailureReason: initFailure,
                  },
                });
              } catch {
                // Best effort metadata flag for team-status recompute.
              }
            }
            updateTeamStatus(teamId, initFailure ? "failed" : "working");
          }
          updateLeadStatus(teamId, LEAD_STATUS_IDLE);
        }
        notifyLeadIfTeamIdle(teamId);

        return jsonResult({
          status: "completed",
          taskId: completionResult.taskId,
          taskStatus: completionResult.status,
          unblockedTasks: completionResult.unblockedTasks,
          unblockedCount: completionResult.unblockedTasks.length,
          initPlan: initPlanSummary,
        });
      } catch (err) {
        const messageText =
          err instanceof Error
            ? err.message
            : typeof err === "string"
              ? err
              : "failed to submit answer";
        return jsonResult({ status: "error", error: messageText });
      }
    },
  };
}
