import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  addTask as addTaskRaw,
  claimTask,
  completeTask,
  listTasks,
  getTask,
  removeTask,
  updateTask,
} from "./task-list.js";
import { TASK_BROADCAST_ANSWER } from "./task-taxonomy.js";

// Must be declared before vi.mock so the closure captures the reference
let testBasePath = "";

vi.mock("./team-registry.store.js", () => ({
  resolveTeamBasePath: () => testBasePath,
  saveTeamToDisk: vi.fn(),
  loadAllTeamsFromDisk: vi.fn().mockReturnValue(new Map()),
}));

describe("task-list", () => {
  const teamId = "test-team-123";
  const addTask = (params: Parameters<typeof addTaskRaw>[1]) => {
    if (params.title === TASK_BROADCAST_ANSWER) {
      return addTaskRaw(teamId, params);
    }
    const metadata = { ...(params.metadata ?? {}) };
    if (metadata.taskClass !== "primary" && metadata.taskClass !== "secondary") {
      metadata.taskClass = "primary";
    }
    return addTaskRaw(teamId, {
      ...params,
      metadata,
    });
  };

  beforeEach(() => {
    // Create a temp directory for test data
    testBasePath = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-task-list-test-"));
    // Create team directory so tasks.json can be written
    fs.mkdirSync(path.join(testBasePath, teamId), { recursive: true });
  });

  afterEach(() => {
    if (testBasePath && fs.existsSync(testBasePath)) {
      fs.rmSync(testBasePath, { recursive: true, force: true });
    }
  });

  it("adds a task with pending status", () => {
    const task = addTask({
      title: "Implement feature X",
      description: "Add new feature",
      priority: "normal",
    });

    expect(task.taskId).toBeTruthy();
    expect(task.title).toBe("Implement feature X");
    expect(task.status).toBe("pending");
    expect(task.priority).toBe("normal");
    expect(task.dependsOn).toEqual([]);
  });

  it("classifies normal tasks as secondary by default", () => {
    const primaryTask = addTaskRaw(teamId, {
      title: "Primary seed",
      priority: "normal",
      metadata: { taskClass: "primary" },
    });
    const task = addTaskRaw(teamId, {
      title: "Follow-up investigation",
      priority: "normal",
      metadata: { context_task_id: primaryTask.taskId },
    });
    expect(task.taskClass).toBe("secondary");
  });

  it("rejects secondary tasks without primary context", () => {
    expect(() =>
      addTaskRaw(teamId, {
        title: "No context task",
        priority: "normal",
      }),
    ).toThrow("Secondary tasks must derive exactly one primary context.");
  });

  it("assigns primary tasks to their own primary context", () => {
    const primaryTask = addTask({
      title: "Primary task",
      priority: "normal",
      metadata: { taskClass: "primary" },
    });

    expect(primaryTask.taskClass).toBe("primary");
    expect(primaryTask.metadata?.primary_context_task_id).toBe(primaryTask.taskId);
  });

  it("derives secondary task context from dependency primary task", () => {
    const primaryTask = addTask({
      title: "Primary task",
      priority: "normal",
      metadata: { taskClass: "primary" },
    });

    const secondaryTask = addTask({
      title: "Secondary task",
      priority: "normal",
      dependsOn: [primaryTask.taskId],
      metadata: { taskClass: "secondary" },
    });

    expect(secondaryTask.taskClass).toBe("secondary");
    expect(secondaryTask.metadata?.primary_context_task_id).toBe(primaryTask.taskId);
  });

  it("rejects secondary tasks that derive multiple primary contexts", () => {
    const primaryA = addTask({
      title: "Primary A",
      priority: "normal",
      metadata: { taskClass: "primary" },
    });
    const primaryB = addTask({
      title: "Primary B",
      priority: "normal",
      metadata: { taskClass: "primary" },
    });

    expect(() => {
      addTaskRaw(teamId, {
        title: "Ambiguous secondary",
        priority: "normal",
        dependsOn: [primaryA.taskId, primaryB.taskId],
      });
    }).toThrow("multiple primary contexts");
  });

  it("classifies reserved tasks outside primary/secondary", () => {
    const task = addTask({
      title: TASK_BROADCAST_ANSWER,
      assignTo: "lead",
      priority: "critical",
    });
    expect(task.taskClass).toBeUndefined();
    expect(task.metadata?.reservedTask).toBe(true);
    expect(task.metadata?.excludedTaskClass).toBe(true);
  });

  it("adds a blocked task when dependencies are not met", () => {
    const taskA = addTask({
      title: "Task A",
      priority: "normal",
    });

    const taskB = addTask({
      title: "Task B",
      dependsOn: [taskA.taskId],
      priority: "normal",
    });

    expect(taskB.status).toBe("blocked");
    expect(taskB.dependsOn).toEqual([taskA.taskId]);
  });

  it("rejects nonexistent dependencies", () => {
    expect(() => {
      addTask({
        title: "Task with bad dep",
        dependsOn: ["nonexistent-id"],
        priority: "normal",
      });
    }).toThrow("Dependency task nonexistent-id not found");
  });

  it("claims a task atomically (first-claim-wins)", () => {
    const task = addTask({
      title: "Claimable task",
      priority: "normal",
    });

    const result1 = claimTask(teamId, {
      taskId: task.taskId,
      claimerId: "teammate1",
    });

    expect(result1.success).toBe(true);
    expect(result1.task?.status).toBe("claimed");
    expect(result1.task?.assignee).toBe("teammate1");

    // Try claiming again - should fail
    const result2 = claimTask(teamId, {
      taskId: task.taskId,
      claimerId: "teammate2",
    });

    expect(result2.success).toBe(false);
    expect(result2.reason).toContain("not pending");
  });

  it("returns error when claiming nonexistent task", () => {
    const result = claimTask(teamId, {
      taskId: "nonexistent",
      claimerId: "teammate1",
    });

    expect(result.success).toBe(false);
    expect(result.reason).toBe("Task not found");
  });

  it("auto-selects highest priority task when no taskId given", () => {
    addTask({
      title: "Normal task",
      priority: "normal",
    });

    const criticalTask = addTask({
      title: "Critical task",
      priority: "critical",
    });

    addTask({
      title: "Low task",
      priority: "low",
    });

    const result = claimTask(teamId, {
      claimerId: "teammate1",
    });

    expect(result.success).toBe(true);
    expect(result.task?.taskId).toBe(criticalTask.taskId);
    expect(result.task?.priority).toBe("critical");
  });

  it("returns error when no pending tasks available for auto-select", () => {
    const result = claimTask(teamId, {
      claimerId: "teammate1",
    });

    expect(result.success).toBe(false);
    expect(result.reason).toBe("No available tasks to claim");
  });

  it("auto-unblocks tasks when dependencies complete", () => {
    const taskA = addTask({
      title: "Task A",
      priority: "normal",
    });

    const taskB = addTask({
      title: "Task B",
      dependsOn: [taskA.taskId],
      priority: "normal",
    });

    expect(taskB.status).toBe("blocked");

    // Claim and complete task A
    claimTask(teamId, {
      taskId: taskA.taskId,
      claimerId: "teammate1",
    });

    const completion = completeTask(teamId, {
      taskId: taskA.taskId,
      result: "success",
    });

    expect(completion.unblockedTasks).toContain(taskB.taskId);

    // Task B should now be pending
    const updatedTaskB = getTask(teamId, taskB.taskId);
    expect(updatedTaskB?.status).toBe("pending");
  });

  it("keeps tasks blocked when only some dependencies complete", () => {
    const taskA = addTask({ title: "Task A", priority: "normal" });
    const taskB = addTask({ title: "Task B", priority: "normal" });
    const taskC = addTask({
      title: "Task C",
      dependsOn: [taskA.taskId, taskB.taskId],
      priority: "normal",
    });

    expect(taskC.status).toBe("blocked");

    // Complete only task A
    claimTask(teamId, { taskId: taskA.taskId, claimerId: "tm1" });
    const result = completeTask(teamId, { taskId: taskA.taskId, result: "success" });

    // Task C should still be blocked (taskB not done yet)
    expect(result.unblockedTasks).not.toContain(taskC.taskId);
    const updatedC = getTask(teamId, taskC.taskId);
    expect(updatedC?.status).toBe("blocked");
  });

  it("computes blockedBy for tasks", () => {
    const taskA = addTask({
      title: "Task A",
      priority: "normal",
    });

    const taskB = addTask({
      title: "Task B",
      priority: "normal",
    });

    addTask({
      title: "Task C",
      dependsOn: [taskA.taskId, taskB.taskId],
      priority: "normal",
    });

    // Complete task A
    claimTask(teamId, {
      taskId: taskA.taskId,
      claimerId: "teammate1",
    });
    completeTask(teamId, {
      taskId: taskA.taskId,
      result: "success",
    });

    // List tasks and check blockedBy
    const { tasks } = listTasks(teamId, {
      status: ["blocked"],
    });

    expect(tasks).toHaveLength(1);
    expect(tasks[0].metadata?.blockedBy).toEqual([taskB.taskId]);
  });

  it("filters tasks by status", () => {
    const taskA = addTask({
      title: "Task A",
      priority: "normal",
    });

    addTask({
      title: "Task B",
      dependsOn: [taskA.taskId],
      priority: "normal",
    });

    const { tasks: pendingTasks } = listTasks(teamId, {
      status: ["pending"],
    });

    expect(pendingTasks).toHaveLength(1);
    expect(pendingTasks[0].taskId).toBe(taskA.taskId);

    const { tasks: blockedTasks } = listTasks(teamId, {
      status: ["blocked"],
    });

    expect(blockedTasks).toHaveLength(1);
  });

  it("filters tasks by assignee", () => {
    const task = addTask({
      title: "Task for teammate1",
      priority: "normal",
    });

    claimTask(teamId, {
      taskId: task.taskId,
      claimerId: "teammate1",
    });

    const { tasks } = listTasks(teamId, {
      assignee: "teammate1",
    });

    expect(tasks).toHaveLength(1);
    expect(tasks[0].assignee).toBe("teammate1");
  });

  it("filters tasks by priority", () => {
    addTask({
      title: "Normal task",
      priority: "normal",
    });

    const criticalTask = addTask({
      title: "Critical task",
      priority: "critical",
    });

    const { tasks } = listTasks(teamId, {
      priority: "critical",
    });

    expect(tasks).toHaveLength(1);
    expect(tasks[0].taskId).toBe(criticalTask.taskId);
  });

  it("computes task summary correctly", () => {
    const taskA = addTask({
      title: "Task A",
      priority: "normal",
    });

    addTask({
      title: "Task B",
      dependsOn: [taskA.taskId],
      priority: "normal",
    });

    claimTask(teamId, {
      taskId: taskA.taskId,
      claimerId: "teammate1",
    });

    const { summary } = listTasks(teamId, {});

    expect(summary.total).toBe(2);
    expect(summary.inProgress).toBe(1);
    expect(summary.blocked).toBe(1);
  });

  it("removes pending tasks", () => {
    const task = addTask({
      title: "Task to remove",
      priority: "normal",
    });

    const removed = removeTask(teamId, task.taskId);
    expect(removed).toBe(true);

    const retrieved = getTask(teamId, task.taskId);
    expect(retrieved).toBeNull();
  });

  it("prevents removing claimed tasks", () => {
    const task = addTask({
      title: "Claimed task",
      priority: "normal",
    });

    claimTask(teamId, {
      taskId: task.taskId,
      claimerId: "teammate1",
    });

    expect(() => {
      removeTask(teamId, task.taskId);
    }).toThrow("Cannot remove task in status");
  });

  it("marks completed tasks with result and summary", () => {
    const task = addTask({ title: "Task", priority: "normal" });
    claimTask(teamId, { taskId: task.taskId, claimerId: "tm1" });

    const result = completeTask(teamId, {
      taskId: task.taskId,
      result: "success",
      summary: "All done",
      artifacts: ["output.txt"],
    });

    expect(result.status).toBe("completed");
    const completed = getTask(teamId, task.taskId);
    expect(completed?.result).toBe("success");
    expect(completed?.summary).toBe("All done");
    expect(completed?.artifacts).toEqual(["output.txt"]);
    expect(completed?.completedAt).toBeTruthy();
  });

  it("marks failed tasks correctly", () => {
    const task = addTask({ title: "Task", priority: "normal" });
    claimTask(teamId, { taskId: task.taskId, claimerId: "tm1" });

    const result = completeTask(teamId, {
      taskId: task.taskId,
      result: "failure",
      summary: "Something went wrong",
    });

    expect(result.status).toBe("failed");
    const failed = getTask(teamId, task.taskId);
    expect(failed?.status).toBe("failed");
  });

  it("FIFO within same priority", () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValueOnce(1_000).mockReturnValueOnce(1_001);
    const first = addTask({ title: "First normal", priority: "high" });
    addTask({ title: "Second normal", priority: "high" });
    nowSpy.mockRestore();

    const result = claimTask(teamId, { claimerId: "tm1" });
    expect(result.task?.taskId).toBe(first.taskId);
  });

  it("adds task with unblocked status when all deps are completed", () => {
    const dep = addTask({ title: "Dep", priority: "normal" });
    claimTask(teamId, { taskId: dep.taskId, claimerId: "tm1" });
    completeTask(teamId, { taskId: dep.taskId, result: "success" });

    // Now add a task depending on the completed dep
    const task = addTask({
      title: "Dependent",
      dependsOn: [dep.taskId],
      priority: "normal",
    });

    // Should be pending, not blocked, since dep is already completed
    expect(task.status).toBe("pending");
  });

  it("blocks claimed tasks when new unmet dependencies are added", () => {
    const blocker = addTask({ title: "Blocker", priority: "normal" });
    const task = addTask({ title: "Needs info", priority: "normal" });
    claimTask(teamId, { taskId: task.taskId, claimerId: "tm1" });

    const updated = updateTask(teamId, task.taskId, { dependsOn: [blocker.taskId] });
    expect(updated.status).toBe("blocked");

    claimTask(teamId, { taskId: blocker.taskId, claimerId: "tm2" });
    completeTask(teamId, { taskId: blocker.taskId, result: "success" });

    const unblocked = getTask(teamId, task.taskId);
    expect(unblocked?.status).toBe("pending");
  });
});
