
// TODO: we can make id as incrementing unique number, so we know which node came first

class AgentTeam {
  const teamId;
  constructor(teamId) {
    self.teamId   = teamId;
  }

  // B ask a question from A in edit mode: A -> B ==> A -> B -> A -> B and
  // B ask a question from A in read mode: A -> B ==> A -> Q ->

  // Tools
  // TODO: when answer of question comes, we have to go to the teammate session and insert reply. so next time when task picked, he has answer of the question.
  public ask_question(teammateId: string, taskId: string, query: string, mode: 'edit' | 'read'='read') {
    const task = self.getTask(taskId)
    const curr_task_id = self.getCurrentTaskId(teammateId)
    const curr_task = self.getTask(curr_task_id)

    const onSubmit = (reply: string) => {
      const primary_task_id = self.resolvePrimaryTaskId(taskId);
      const primary_task = self.getTask(primary_task_id);
      const contextSessionKey = primary_task.contextSessionKey;
      // TODO: insert answer into conversation chat.
      self.insert_query(contextSessionKey, reply);
    }
    const new_target_query_task_id = self.addTask({
      instruction: query,
      taskClass: 'secondary',
      assignee: task.assignee,
      status: 'pending',
      clones: 1,
      onSubmit
    })

    switch (mode) {
      case 'edit':
        const all_children_node_ids = self.getAllChildren(curr_task_id);
        for (const child_id of all_children_node_ids) {
          self.removeTaskDependency(child_id, curr_task_id);
        }

        const new_target_task_id = self.addTask({
          ...task,
          taskClass: 'primary',
          status: 'blocked',
          dependsOn: [curr_task_id],
          clones: task.clones++
        })

        const new_requester_task_id = self.addTask({
          ...curr_task,
          taskClass: 'primary',
          status: 'blocked',
          dependsOn: [new_target_task_id, new_target_query_task_id],
          clones: curr_task.clones++,
        })


        for (const child_id of all_children_node_ids) {
          self.addTaskDependency(child_id, new_requester_task_id);
        }

        self.updateTaskStatus(curr_task_id, 'completed');
        break;
      default:
        // read mode
        self.addTaskDependency(curr_task_id, new_target_query_task_id);
        self.updateTaskStatus(curr_task_id, 'blocked');
    }
    self.updateTeamateStatus(teammateId, 'idle');
  }

  public task_submit(teammateId: string, taskId: string, reply: string, error: any) {
    // error means non-ai related error. task will be failed and all work reverted.
    const task = self.getTask(taskId);
    if (error) {
      self.updateTaskStatus(taskId, 'failed');
      self.discard_changes(task.contextSessionKey);
      self.updateTeamateStatus(teammateId, 'idle');
    }

    const isPrimary = task.taskClass === 'primary';
    if (isPrimary) {
      let branchName = task.contextSessionKey;
      task.commitId = self.git_commit(branchName, task.title, reply);
      self.merge_to_team_branch(branchName);
    } else {
      // call hook to insert answer to session chat.
      if (task.onSubmit) task.onSubmit(reply);
    }
    self.updateTaskStatus(taskId, 'completed');
    self.updateTeamateStatus(teammateId, 'idle');
  }

  public updateTaskStatus(taskId: string, status: string) {
    const task = self.getTask(taskId);
    const unblock_children = (taskId: string) => {
      const all_children_task_ids = self.getChildren(taskId);
      for (const child_id of all_children_task_ids) {
        if (self.is_unblocked(child_id)) task.status = 'pending';
      }
    }
    task.status = status;
    switch (status) {
      case 'completed':
        unblock_children(taskId);
        break;
      case 'claimed':
        // resolve contextSessionKey and start working
        break;
    }
  }

  public updateTeammateStatus(teammateId: string, status: string) {
    const teammate = self.getTeammate(teammateId);
    teammate.status = status;
    if (teammate.status === 'idle') {
      self.register_idle_task_checker(teammateId);
    } else {
      self.
    }
  }

  public is_unblocked(taskId: string) {
    const task = self.getTask(taskId);
    return task.dependsOn.every(parent_task_id => {
      const parent_task = self.getTask(parent_task_id);
      return parent_task.status === 'completed';
    });
  }

  public register_idle_task_checker(teammateId: string) {
    const pid = setInterval(() => {
      const tasks = loadTasks();
      const teammateTasks = tasks.filter(task => task.assignee !== teammateId && task.status === 'pending').sortBy('priority', 'desc');
      if (teammateTasks.length > 0) {
        const claimTask = teammateTasks[0];
        self.updateTaskStatus(claimTask.id, 'claimed');
        clearInterval(pid);
      }
    }, 333);
  }
}