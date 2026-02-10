import { Type } from "@sinclair/typebox";
import fs from "node:fs";
import path from "node:path";
import type { AnyAgentTool } from "../../tools/common.js";
import type { TeammatePlan } from "../types.js";
import { loadConfig } from "../../../config/config.js";
import { enqueueSystemEvent } from "../../../infra/system-events.js";
import { jsonResult, readStringParam } from "../../tools/common.js";
import { getTeam, isTeamLead } from "../team-registry.js";
import { saveTeamToDisk, resolveTeamBasePath } from "../team-registry.store.js";

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
      const cfg = loadConfig();
      if (!cfg.gateway?.teams?.enabled) {
        return jsonResult({ status: "error", error: "Teams are not enabled." });
      }

      // 2. Parse params
      const params = args as Record<string, unknown>;
      const teamId = readStringParam(params, "teamId", { required: true });
      const teammateId = readStringParam(params, "teammateId", { required: true });
      const action = readStringParam(params, "action", { required: true });
      const feedback = readStringParam(params, "feedback");

      // 3. Verify caller is the lead
      const callerSessionKey = opts?.agentSessionKey ?? "";
      if (!isTeamLead(teamId, callerSessionKey)) {
        return jsonResult({ status: "error", error: "Only the Team Lead can review plans." });
      }

      // 4. Get team from registry
      const team = getTeam(teamId);
      if (!team) {
        return jsonResult({ status: "error", error: `Team "${teamId}" not found.` });
      }

      const teammate = team.teammates[teammateId];
      if (!teammate) {
        return jsonResult({ status: "error", error: `Teammate "${teammateId}" not found.` });
      }

      // 5. Load plan from disk
      //    Path: ~/.openclaw/teams/{teamId}/plans/{teammateId}.json
      const basePath = resolveTeamBasePath(cfg);
      const planPath = path.join(basePath, teamId, "plans", `${teammateId}.json`);

      if (!fs.existsSync(planPath)) {
        return jsonResult({
          status: "error",
          error: "No plan submitted by this teammate.",
        });
      }

      let plan: TeammatePlan;
      try {
        const raw = fs.readFileSync(planPath, "utf-8");
        plan = JSON.parse(raw) as TeammatePlan;
      } catch {
        return jsonResult({
          status: "error",
          error: "Failed to load plan from disk.",
        });
      }

      // 6. Process action
      const recipientSessionKey = teammate.sessionKey;
      let notificationMessage = "";

      switch (action) {
        case "approve":
          // a. Set plan.status = "approved", plan.reviewedAt = Date.now()
          plan.status = "approved";
          plan.reviewedAt = Date.now();
          if (feedback) {
            plan.feedback = feedback;
          }

          // b. Set teammate.planApproved = true in registry
          teammate.planApproved = true;

          // c. Save plan back to disk
          try {
            fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));
          } catch {
            return jsonResult({
              status: "error",
              error: "Failed to save approved plan.",
            });
          }

          // d. Save team to persist teammate.planApproved
          try {
            saveTeamToDisk(team, cfg);
          } catch {
            // Non-fatal
          }

          // e. Notify teammate
          notificationMessage = feedback
            ? `Your plan has been approved. Feedback: ${feedback}\n\nYou can now use implementation tools.`
            : "Your plan has been approved. You can now use implementation tools.";
          break;

        case "reject":
          // a. Set plan.status = "rejected", plan.feedback = feedback
          plan.status = "rejected";
          plan.reviewedAt = Date.now();
          plan.feedback = feedback ?? "Plan rejected";

          // b. Save plan to disk
          try {
            fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));
          } catch {
            return jsonResult({
              status: "error",
              error: "Failed to save rejected plan.",
            });
          }

          // c. Notify teammate
          notificationMessage = `Your plan has been rejected.\n\nFeedback: ${plan.feedback}\n\nYou may re-submit with plan_submit.`;
          break;

        case "revise":
          // a. Set plan.status = "revision-requested", plan.feedback = feedback
          plan.status = "revision-requested";
          plan.reviewedAt = Date.now();
          plan.feedback = feedback ?? "Revision requested";

          // b. Save plan to disk
          try {
            fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));
          } catch {
            return jsonResult({
              status: "error",
              error: "Failed to save plan revision request.",
            });
          }

          // c. Notify teammate
          notificationMessage = `Revision requested for your plan.\n\nFeedback: ${plan.feedback}\n\nPlease update and re-submit using plan_submit.`;
          break;

        default:
          return jsonResult({
            status: "error",
            error: `Invalid action: "${action}". Use "approve", "reject", or "revise".`,
          });
      }

      // 7. Send notification to teammate
      enqueueSystemEvent(notificationMessage, {
        sessionKey: recipientSessionKey,
      });

      // 8. Return result
      return jsonResult({
        status: "reviewed",
        teammateId,
        action,
        planStatus: plan.status,
        feedback: feedback || undefined,
      });
    },
  };
}
