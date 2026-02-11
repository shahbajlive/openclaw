# Team Examples

This file contains prompt templates to exercise different team topologies and message flow patterns.

## Sequential Headcount

Goal: teammates coordinate in strict order and report the final team strength.

Prompt:
```
Create a team of 10 and run a sequential headcount from 1 to 10. No one should miss. Report the total count at the end.
```

## Ring Passing

Goal: test cyclic routing and handoffs across the full team.

Prompt:
```
Create a team of 5 and run a ring pass twice. Each hop should include a counter. After two full loops, return the final summary.
```

## Fan Out and Fan In

Goal: parallel execution followed by aggregation.

Prompt:
```
Create a team of 4. Split the work into 4 subtasks, collect results, then summarize.
```

## Pipeline

Goal: staged processing where each teammate transforms the output of the previous stage.

Prompt:
```
Create a team of 3 and run a pipeline: draft input, clean/transform, then validate and summarize. Each stage passes output to the next. Report the final output.
```

## Debate Then Judge

Goal: adversarial comparison with a single adjudicator.

Prompt:
```
Create a team of 3 and run a debate: argue "A", argue "B", then judge with 2–3 reasons. Only the final judgment should be reported.
```

## Timed Relay Headcount

Goal: coordination with timestamps to measure latency and ordering.

Prompt:
```
Create a team of 5 and run a timed headcount relay. Start with "1 @<timestamp>", append number and timestamp at each hop, and return the full log at the end.
```

## Chore Always Runs

Goal: verify a chore teammate monitors work regardless of explicit user request.

Prompt:
```
Create a team with a dedicated chore teammate (taskless auditor). Have the chore monitor active work and flag any issue it sees, then report the lead_review outcome.
```

## Node Asks Question on Prev Task

Goal: ensure a node asks a question about a previous task, it is routed, answered, and unblocks the current task.

Prompt:
```
Create a team of 2. Node Y is blocked on curr_task and asks a question about prev_task. Create a qn_request assigned to X (the dependency owner), have X answer it, then have Y complete curr_task. Summarize the resolution.
```

## Chore Flags Lead Review

Goal: chore flags a lead_review flow before delivery can proceed.

Prompt:
```
Create a team of 3. The chore auditor detects a policy violation and flags a lead_review with a review_question. Block a delivery task until the lead_review completes. Report the final delivery status.
```

## Upstream Question Chain

Goal: multi-hop question routing across prior tasks.

Prompt:
```
Create a team of 3. Node Y asks a question about prev_task owned by X. X cannot answer and asks an upstream question about an earlier task owned by Z. Use qn_request tasks only (no separate answer task and no lead routing for Q/A), then complete Y's task. Summarize the chain.
```

## Backlog Overflow Audit

Goal: chore flags a backlog overflow and the team clears the queue.

Prompt:
```
Create a team of 4. Add enough pending tasks to exceed the backlog limit so the chore flags a lead_review. Clear the backlog and report the final status.
```

## Break Point Stress Mix

Goal: push routing, reviews, and dependencies to a break point.

Prompt:
```
Create a team of 7. Run fan-out tasks, a 3-step pipeline, qn_request tasks to unblock integration work, a re-ask on a previous answer, and a chore-triggered lead_review. Only after all dependencies clear, complete the final delivery. Provide a short final summary.
```

## Complex Stress Scenario

Goal: exercise fan-out, pipeline, question routing, chores, and lead review in one run.

Prompt:
```
Create a team of 6. Run fan-out tasks, a 3-step pipeline, qn_request tasks to unblock integration work, and a chore that triggers a lead_review. Only after all dependencies clear, complete the final delivery. Provide a short final summary.
```

## Mega Parallel Review Loop

Goal: full-system stress with nested qn routing, spot checks, and PR revision loop before final delivery.

Prompt:
```
Create a team of 8. Run fan-out + pipeline work, then have integration ask a dependency question that triggers an upstream qn_request chain. Add a chore-triggered lead_review and a spot_check before submission. After submission, run a pr_review that requests one pr_revision_request round, then approve and complete final delivery. Return a short summary with the key blockers and how they were resolved.
```
