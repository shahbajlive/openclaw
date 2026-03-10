import { Type } from "@sinclair/typebox";
import { loadConfig, type OpenClawConfig } from "../../config/config.js";
import { normalizeAgentId, resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import type { AnyAgentTool } from "./common.js";
import { discoverTeammatesForAgent, type RelatedAgentSummary } from "./teammate-discovery.js";

const DiscoverTeammatesSchema = Type.Object({});

function buildText(params: {
  requester: RelatedAgentSummary;
  reportsTo: RelatedAgentSummary | null;
  commands: RelatedAgentSummary[];
  siblings: RelatedAgentSummary[];
  canDirectMessage: boolean;
  guidance: string;
  missingParentId?: string | null;
  missingChildIds?: string[];
}): string {
  const lines: string[] = [];
  lines.push(
    `You are ${params.requester.name} (${params.requester.id}) [mention: ${params.requester.mention}].`,
  );
  if (!params.reportsTo) {
    if (params.missingParentId) {
      lines.push(`Configured parent ${params.missingParentId} was not found in agents.list.`);
    } else {
      lines.push("No parent is configured, so parent-and-siblings discovery is unavailable.");
    }
    lines.push(params.guidance);
    return lines.join("\n");
  }

  lines.push("Whom to report:");
  {
    const brief = params.reportsTo.brief?.trim() ? ` - ${params.reportsTo.brief.trim()}` : "";
    lines.push(
      `- ${params.reportsTo.name} (${params.reportsTo.id})${brief} [mention: ${params.reportsTo.mention}]`,
    );
  }

  if (params.commands.length > 0) {
    lines.push("Who are on my command:");
    for (const command of params.commands) {
      const brief = command.brief?.trim() ? ` - ${command.brief.trim()}` : "";
      lines.push(`- ${command.name} (${command.id})${brief} [mention: ${command.mention}]`);
    }
  }

  if (params.siblings.length > 0) {
    lines.push("Siblings:");
    for (const sibling of params.siblings) {
      const brief = sibling.brief?.trim() ? ` - ${sibling.brief.trim()}` : "";
      lines.push(`- ${sibling.name} (${sibling.id})${brief} [mention: ${sibling.mention}]`);
    }
  }

  if ((params.missingChildIds?.length ?? 0) > 0) {
    lines.push(`Ignored missing directReports entries: ${params.missingChildIds?.join(", ")}.`);
  }
  lines.push(
    params.canDirectMessage
      ? "Direct messaging is available from this session by tool access."
      : "Direct messaging is not available from this session by tool access.",
  );
  lines.push(params.guidance);
  return lines.join("\n");
}

export function createDiscoverTeammatesTool(opts: {
  workspaceDir: string;
  config?: OpenClawConfig;
  agentSessionKey?: string;
  requesterAgentIdOverride?: string;
}): AnyAgentTool {
  return {
    label: "Teammates",
    name: "discover_teammates",
    description:
      "Discover teammates by local hierarchy. Leaf agents get parent + siblings. Non-leaf agents get parent + children. Do not use this for whole-org discovery.",
    parameters: DiscoverTeammatesSchema,
    execute: async () => {
      const requesterAgentId = normalizeAgentId(
        opts.requesterAgentIdOverride ?? resolveAgentIdFromSessionKey(opts.agentSessionKey),
      );

      try {
        const details = await discoverTeammatesForAgent({
          config: opts.config ?? loadConfig(),
          requesterAgentId,
          workspaceDir: opts.workspaceDir,
        });
        if (details.error === "requester_not_found") {
          const text = `No configured teammate entry was found for ${requesterAgentId} in agents.list.`;
          return {
            content: [{ type: "text", text }],
            details: {
              requester: requesterAgentId,
              error: "requester_not_found",
            },
          };
        }

        const guidance = details.canDirectMessage
          ? "Use files and contracts for substantive handoff. Use direct messages only for urgency, blockers, or short coordination. To contact a teammate, write a normal message starting with their mention, for example @frontend_engineer can you review this?"
          : `Use files and contracts for substantive handoff. Route urgent coordination through ${
              details.reportsTo?.id ?? "your parent"
            } when needed.`;
        const text = buildText({
          requester: details.requester,
          reportsTo: details.reportsTo,
          commands: details.commands,
          siblings: details.siblings,
          canDirectMessage: details.canDirectMessage,
          guidance,
          missingChildIds: details.missingChildIds,
          missingParentId: details.missingParentId,
        });
        return {
          content: [{ type: "text", text }],
          details,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text",
              text: `Could not resolve teammates from agents.list: ${message}`,
            },
          ],
          details: {
            requester: requesterAgentId,
            error: "discovery_unavailable",
            message,
          },
        };
      }
    },
  };
}
