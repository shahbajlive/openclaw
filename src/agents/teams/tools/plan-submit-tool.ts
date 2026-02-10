import { Type } from "@sinclair/typebox";
import fs from "node:fs";
import path from "node:path";
import type { AnyAgentTool } from "../../tools/common.js";
import type { TeammatePlan } from "../types.js";
import { loadConfig } from "../../../config/config.js";
import { enqueueSystemEvent } from "../../../infra/system-events.js";
import { jsonResult, readStringParam } from "../../tools/common.js";
import { resolveCallerTeamContext } from "../team-registry.js";
import { resolveTeamBasePath } from "../team-registry.store.js";

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
      "Submit a plan for Team Lead approval. Required before using implementation tools when plan approval is enabled.",
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

      // 4. Parse params
      const params = args as Record<string, unknown>;
      const teamId = readStringParam(params, "teamId", { required: true });
      const planDataRaw = params.plan;

      if (!planDataRaw || typeof planDataRaw !== "object") {
        return jsonResult({ status: "error", error: "Invalid plan data." });
      }

      // 5. Build TeammatePlan object
      const planData = planDataRaw as Record<string, unknown>;
      const plan: TeammatePlan = {
        teammateId: teammate.teammateId,
        teamId,
        status: "pending",
        plan: {
          summary: (planData.summary as string) ?? "",
          steps:
            (planData.steps as Array<{
              description: string;
              estimatedTokens?: number;
              tools?: string[];
            }>) ?? [],
          risks: planData.risks as string[] | undefined,
          alternatives: planData.alternatives as string[] | undefined,
        },
        submittedAt: Date.now(),
      };

      // 6. Save plan to disk
      //    Path: ~/.openclaw/teams/{teamId}/plans/{teammateId}.json
      try {
        const basePath = resolveTeamBasePath(cfg);
        const planDir = path.join(basePath, teamId, "plans");
        fs.mkdirSync(planDir, { recursive: true });
        const planPath = path.join(planDir, `${teammate.teammateId}.json`);
        fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));
      } catch (err) {
        const messageText =
          err instanceof Error
            ? err.message
            : typeof err === "string"
              ? err
              : "failed to save plan";
        return jsonResult({
          status: "error",
          error: `Failed to save plan: ${messageText}`,
        });
      }

      // 7. Notify the lead via system event
      const team = callerContext.team;
      const stepsFormatted = plan.plan.steps.map((s, i) => `${i + 1}. ${s.description}`).join("\n");
      const notificationMessage = `Teammate "${teammate.role}" has submitted a plan for approval:\n\nSummary: ${plan.plan.summary}\n\nSteps:\n${stepsFormatted}\n\nUse plan_review to approve, reject, or request revision.`;

      enqueueSystemEvent(notificationMessage, {
        sessionKey: team.leadSessionKey,
      });

      // 8. Return result
      return jsonResult({
        status: "submitted",
        teammateId: teammate.teammateId,
        planStatus: "pending",
        message: "Plan submitted. Waiting for lead approval.",
      });
    },
  };
}
