# Task 07: System Prompts for Teams

**Layer:** 1 (Infrastructure)
**Dependencies:** Task 01 (types)
**Can run in parallel with:** Task 04, Task 05, Task 06

## What to Do

Create system prompt builders for team leads and teammates. These prompts get injected into the agent's context via `extraSystemPrompt` (same mechanism used by subagent system prompts).

## Pattern to Follow

Model after `buildSubagentSystemPrompt` in `src/agents/subagent-announce.ts` (around line 291). That function builds a system prompt string that gets passed as `extraSystemPrompt` to `callGateway`.

## File to Create

### `src/agents/teams/system-prompt.ts`

```typescript
import type { Team, Teammate, CoordinationMode } from "./types.js";

/**
 * Build the system prompt injected into the Team Lead's session.
 * This gives the lead awareness of the team, its mode, and available tools.
 */
export function buildTeamLeadSystemPrompt(params: {
  team: Team;
  teammatesList: Array<{ role: string; status: string; currentTask?: string }>;
}): string {
  const { team, teammatesList } = params;
  const lines: string[] = [];

  lines.push("# Team Lead Context");
  lines.push("");
  lines.push(`You are the Team Lead for team "${team.teamName}".`);
  if (team.description) {
    lines.push(`Team purpose: ${team.description}`);
  }
  lines.push(`Team ID: ${team.teamId}`);
  lines.push(`Coordination Mode: ${team.coordinationMode}`);
  lines.push("");

  // Teammate list
  if (teammatesList.length > 0) {
    lines.push("## Current Teammates");
    for (const t of teammatesList) {
      const taskInfo = t.currentTask ? ` (working on: ${t.currentTask})` : "";
      lines.push(`- ${t.role}: ${t.status}${taskInfo}`);
    }
    lines.push("");
  } else {
    lines.push("No teammates spawned yet. Use teammate_spawn to add team members.");
    lines.push("");
  }

  // Available tools
  lines.push("## Available Team Tools");
  lines.push("- team_status: Check team status and task summary");
  lines.push("- teammate_spawn: Add a new teammate to the team");
  lines.push("- teammate_message: Send a direct message to a teammate");
  lines.push("- teammate_broadcast: Send a message to all teammates");
  lines.push("- teammate_shutdown: Request a teammate to shut down");
  lines.push("- task_add: Add a task to the shared task list");
  lines.push("- task_list: View all tasks and their states");

  if (team.coordinationMode === "normal") {
    lines.push("- task_claim: Claim a task to work on yourself");
    lines.push("- task_complete: Mark a claimed task as done");
  }

  lines.push("- plan_review: Approve, reject, or request revision of a teammate's plan");
  lines.push("");

  // Mode-specific instructions
  if (team.coordinationMode === "delegate") {
    lines.push("## DELEGATE MODE");
    lines.push("You are in DELEGATE mode. Your role is coordination only.");
    lines.push(
      "- DO NOT claim tasks or use implementation tools (exec, write, edit, apply_patch).",
    );
    lines.push(
      "- Focus on: spawning teammates, assigning tasks, reviewing plans, synthesizing results.",
    );
    lines.push("- Let your teammates do the implementation work.");
    lines.push("");
  } else {
    lines.push("## NORMAL MODE");
    lines.push("You can both coordinate the team AND work on tasks directly.");
    lines.push("Use teammates for parallel work. Claim tasks yourself when it makes sense.");
    lines.push("");
  }

  // General guidance
  lines.push("## Coordination Tips");
  lines.push("- Break work into clear, focused tasks with good descriptions.");
  lines.push(
    "- Use task dependencies (dependsOn) to sequence work that has ordering requirements.",
  );
  lines.push("- Check team_status regularly to monitor progress.");
  lines.push("- When all tasks are complete, synthesize results and report to the user.");
  lines.push("- Use teammate_shutdown to clean up when work is done.");

  return lines.join("\n");
}

/**
 * Build the system prompt injected into a Teammate's session.
 * This gives the teammate awareness of its role, the team, and available tools.
 */
export function buildTeammateSystemPrompt(params: {
  team: Team;
  teammate: Teammate;
  otherTeammates: Array<{ role: string; teammateId: string }>;
}): string {
  const { team, teammate, otherTeammates } = params;
  const lines: string[] = [];

  lines.push("# Teammate Context");
  lines.push("");
  lines.push(`You are a teammate in team "${team.teamName}".`);
  lines.push(`Your role: ${teammate.role}`);
  lines.push(`Team ID: ${team.teamId}`);
  lines.push(`Your teammate ID: ${teammate.teammateId}`);
  if (team.description) {
    lines.push(`Team purpose: ${team.description}`);
  }
  lines.push("");

  // Other teammates
  if (otherTeammates.length > 0) {
    lines.push("## Your Teammates");
    lines.push(`- Team Lead (session: ${team.leadSessionKey})`);
    for (const t of otherTeammates) {
      lines.push(`- ${t.role} (id: ${t.teammateId})`);
    }
    lines.push("");
  }

  // Available tools
  lines.push("## Available Tools");
  lines.push("- task_claim: Claim an available task from the shared task list");
  lines.push("- task_complete: Mark your claimed task as done");
  lines.push("- task_list: View all tasks and their states");
  lines.push("- task_add: Add new tasks you discover while working");
  lines.push("- team_status: Check team status");
  lines.push("- teammate_message: Send a direct message to another teammate or the lead");
  lines.push("- teammate_broadcast: Send a message to everyone on the team");

  if (teammate.requirePlanApproval && !teammate.planApproved) {
    lines.push(
      "- plan_submit: Submit your plan for lead approval (REQUIRED before implementation)",
    );
  }
  lines.push("");

  // Plan approval restriction
  if (teammate.requirePlanApproval && !teammate.planApproved) {
    lines.push("## IMPORTANT: Plan Approval Required");
    lines.push("You MUST submit a plan using plan_submit BEFORE using any implementation tools.");
    lines.push("1. Analyze the problem and formulate a plan.");
    lines.push("2. Call plan_submit with your plan (summary, steps, risks, alternatives).");
    lines.push("3. Wait for the Team Lead to approve your plan.");
    lines.push(
      "4. Only after approval can you use implementation tools (exec, write, edit, etc.).",
    );
    lines.push("");
  }

  // Work guidelines
  lines.push("## Work Guidelines");
  lines.push("- Stay focused on your role and assigned tasks.");
  lines.push("- Claim tasks before working on them (use task_claim).");
  lines.push("- Mark tasks complete when done (use task_complete with a summary).");
  lines.push("- If you discover something that affects other teammates, send them a message.");
  lines.push("- If you find new work that needs doing, add it with task_add.");
  lines.push("- You do NOT have access to: heartbeat, cron jobs, hooks, or direct user messaging.");
  lines.push("- When your work is done, the lead will shut you down.");

  return lines.join("\n");
}
```

## Reference Files

- `src/agents/subagent-announce.ts` around line 291 -- `buildSubagentSystemPrompt` pattern
- `src/agents/tools/sessions-spawn-tool.ts` line 211-217 -- how `extraSystemPrompt` is passed to `callGateway`

## How Prompts Get Used

In `teammate_spawn` (Task 08), the system prompt is passed like this:

```typescript
const childSystemPrompt = buildTeammateSystemPrompt({ team, teammate, otherTeammates });

await callGateway({
  method: "agent",
  params: {
    message: task,
    sessionKey: teammateSessionKey,
    extraSystemPrompt: childSystemPrompt,
    // ...
  },
});
```

The lead's system prompt gets updated when team state changes (new teammates join, coordination mode is set). This is handled by the `team_create` tool (Task 08) which passes the lead prompt into the session context.

## Notes

- Teammate prompts explicitly say "NO heartbeat, NO cron, NO hooks" -- teammates are focused workers.
- The plan approval section is conditional: only shown when `requirePlanApproval` is true and the plan hasn't been approved yet.
- Delegate mode instructions are only shown to the lead, not to teammates.
- Keep prompts concise -- they consume context window tokens.

## Acceptance Criteria

- [ ] `buildTeamLeadSystemPrompt` produces a clear prompt with team info and available tools
- [ ] Lead prompt changes based on coordinationMode (normal vs delegate)
- [ ] `buildTeammateSystemPrompt` produces a clear prompt with role, team info, and tools
- [ ] Teammate prompt includes plan approval instructions when applicable
- [ ] Teammate prompt explicitly restricts heartbeat/cron/hooks
- [ ] Both prompts list teammates by role
- [ ] `pnpm build` passes
