# Task 11: Plan Approval Tools

**Layer:** 2 (Tools)
**Dependencies:** Task 04 (team registry)
**Can run in parallel with:** Task 08, Task 09, Task 10

## What to Do

Create two tools for the plan approval workflow: `plan_submit` (used by teammates) and `plan_review` (used by the lead).

When a teammate is spawned with `requirePlanApproval: true`, they must submit a plan before using implementation tools. The lead reviews and approves/rejects/revises.

## Files to Create

### 1. `src/agents/tools/plan-submit-tool.ts`

Tool name: `plan_submit`
Who uses it: Teammates only (when `requirePlanApproval: true`)

```typescript
import { Type } from "@sinclair/typebox";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";
import { loadConfig } from "../../config/config.js";
import { getTeam, resolveCallerTeamContext } from "../teams/team-registry.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import type { TeammatePlan } from "../teams/types.js";

const PlanSubmitSchema = Type.Object({
  teamId: Type.String(),
  plan: Type.Object({
    summary: Type.String(),
    steps: Type.Array(
      Type.Object({
        description: Type.String(),
        estimatedTokens: Type.Optional(Type.Number()),
        tools: Type.Optional(Type.Array(Type.String())),
      }),
    ),
    risks: Type.Optional(Type.Array(Type.String())),
    alternatives: Type.Optional(Type.Array(Type.String())),
  }),
});

export function createPlanSubmitTool(opts?: { agentSessionKey?: string }): AnyAgentTool {
  return {
    label: "Teams",
    name: "plan_submit",
    description:
      "Submit a plan for lead approval. Required before using implementation tools when plan approval is enabled.",
    parameters: PlanSubmitSchema,
    execute: async (_toolCallId, args) => {
      // 1. Check teams enabled
      const cfg = loadConfig();
      if (!cfg.gateway?.teams?.enabled) {
        return jsonResult({ status: "error", error: "Teams are not enabled." });
      }

      // 2. Verify caller is a teammate (not the lead)
      const callerContext = resolveCallerTeamContext(opts?.agentSessionKey ?? "");
      if (!callerContext || callerContext.isLead) {
        return jsonResult({ status: "error", error: "Only teammates can submit plans." });
      }

      // 3. Verify teammate has requirePlanApproval
      const teammate = callerContext.teammate;
      if (!teammate?.requirePlanApproval) {
        return jsonResult({ status: "error", error: "Plan approval is not required for you." });
      }

      // 4. Build TeammatePlan object
      const params = args as Record<string, unknown>;
      const teamId = readStringParam(params, "teamId", { required: true });
      const planData = (params as any).plan;
      const plan: TeammatePlan = {
        teammateId: teammate.teammateId,
        teamId,
        status: "pending",
        plan: {
          summary: planData.summary,
          steps: planData.steps,
          risks: planData.risks,
          alternatives: planData.alternatives,
        },
        submittedAt: Date.now(),
      };

      // 5. Save plan to disk
      //    Path: ~/.openclaw/teams/{teamId}/plans/{teammateId}.json
      const basePath = resolveTeamBasePath(cfg);
      const planDir = path.join(basePath, teamId, "plans");
      fs.mkdirSync(planDir, { recursive: true });
      const planPath = path.join(planDir, `${teammate.teammateId}.json`);
      fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));

      // 6. Notify the lead via system event
      const team = callerContext.team;
      enqueueSystemEvent(
        `Teammate "${teammate.role}" has submitted a plan for approval:\n\nSummary: ${plan.plan.summary}\n\nSteps:\n${plan.plan.steps.map((s, i) => `${i + 1}. ${s.description}`).join("\n")}\n\nUse plan_review to approve, reject, or request revision.`,
        { sessionKey: team.leadSessionKey, label: "Plan Submitted" },
      );

      // 7. Return result
      return jsonResult({
        status: "submitted",
        teammateId: teammate.teammateId,
        planStatus: "pending",
        message: "Plan submitted. Waiting for lead approval.",
      });
    },
  };
}
```

### 2. `src/agents/tools/plan-review-tool.ts`

Tool name: `plan_review`
Who uses it: Lead only

```typescript
import { Type } from "@sinclair/typebox";
import fs from "node:fs";
import path from "node:path";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";
import { loadConfig } from "../../config/config.js";
import { getTeam, isTeamLead, updateTeammate } from "../teams/team-registry.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import type { TeammatePlan } from "../teams/types.js";

const PlanReviewSchema = Type.Object({
  teamId: Type.String(),
  teammateId: Type.String(),
  action: Type.String(), // "approve" | "reject" | "revise"
  feedback: Type.Optional(Type.String()),
});

export function createPlanReviewTool(opts?: { agentSessionKey?: string }): AnyAgentTool {
  return {
    label: "Teams",
    name: "plan_review",
    description: "Review a teammate's submitted plan. Approve, reject, or request revision.",
    parameters: PlanReviewSchema,
    execute: async (_toolCallId, args) => {
      // 1. Check teams enabled
      // 2. Verify caller is the lead

      // 3. Load plan from disk
      //    Path: ~/.openclaw/teams/{teamId}/plans/{teammateId}.json
      const params = args as Record<string, unknown>;
      const teamId = readStringParam(params, "teamId", { required: true });
      const teammateId = readStringParam(params, "teammateId", { required: true });
      const action = readStringParam(params, "action", { required: true });
      const feedback = readStringParam(params, "feedback");

      // Load and parse plan
      // If plan not found: return error "No plan submitted by this teammate"

      // 4. Process action
      switch (action) {
        case "approve":
          // a. Set plan.status = "approved", plan.reviewedAt = Date.now()
          // b. Set teammate.planApproved = true in registry
          //    This unlocks implementation tools for the teammate
          // c. Save plan back to disk
          // d. Notify teammate via system event:
          //    "Your plan has been approved. You can now use implementation tools."
          break;

        case "reject":
          // a. Set plan.status = "rejected", plan.feedback = feedback
          // b. Save plan to disk
          // c. Notify teammate:
          //    "Your plan has been rejected. Feedback: {feedback}. You may re-submit."
          break;

        case "revise":
          // a. Set plan.status = "revision-requested", plan.feedback = feedback
          // b. Save plan to disk
          // c. Notify teammate:
          //    "Revision requested for your plan. Feedback: {feedback}. Please update and re-submit."
          break;

        default:
          return jsonResult({
            status: "error",
            error: `Invalid action: "${action}". Use "approve", "reject", or "revise".`,
          });
      }

      return jsonResult({
        status: "reviewed",
        teammateId,
        action,
        feedback: feedback || undefined,
      });
    },
  };
}
```

## Plan Storage

Plans are stored at `~/.openclaw/teams/{teamId}/plans/{teammateId}.json`. Each teammate has at most one plan file. Re-submitting overwrites the previous plan.

```json
{
  "teammateId": "550e8400-...",
  "teamId": "abc123",
  "status": "pending",
  "plan": {
    "summary": "Implement rate limiting on auth endpoints",
    "steps": [
      { "description": "Add express-rate-limit dependency", "tools": ["exec"] },
      { "description": "Create rate limiter middleware", "tools": ["write"] },
      { "description": "Apply to /api/auth routes", "tools": ["edit"] },
      { "description": "Write tests", "tools": ["write", "exec"] }
    ],
    "risks": ["May affect existing request handlers"],
    "alternatives": ["Use nginx rate limiting instead"]
  },
  "submittedAt": 1707152400000
}
```

## How Plan Approval Unlocks Tools

When `plan_review` approves a plan:

1. It sets `teammate.planApproved = true` in the team registry
2. The next time the teammate's tool policy is resolved (in `createOpenClawCodingTools` from `src/agents/pi-tools.ts`), the deny list for `group:fs` + `group:runtime` is removed
3. The teammate's system prompt no longer includes the "submit plan first" instruction

This enforcement is wired up in Task 12 (wiring). This task (11) only handles the plan storage and review flow.

## Reference Files

- `src/infra/system-events.ts` -- `enqueueSystemEvent`
- `src/agents/teams/team-registry.ts` (Task 04) -- `getTeam`, `isTeamLead`, teammate update
- `src/agents/teams/types.ts` (Task 01) -- `TeammatePlan`, `PlanStatus`
- RFC section 3.5: `agen-swarm-proposal/initial-rought-design.md` lines 549-588

## Acceptance Criteria

- [ ] `plan_submit` saves plan to disk and notifies lead
- [ ] `plan_submit` only works for teammates with `requirePlanApproval: true`
- [ ] `plan_submit` rejects if caller is the lead
- [ ] `plan_review` with "approve" sets `planApproved = true` on teammate record
- [ ] `plan_review` with "reject" saves feedback and notifies teammate
- [ ] `plan_review` with "revise" saves feedback and notifies teammate
- [ ] `plan_review` only works for the lead
- [ ] Notifications use `enqueueSystemEvent` for both directions
- [ ] Plan file is overwritten on re-submit
- [ ] `pnpm build` passes
