import { Container, Spacer, Text } from "@mariozechner/pi-tui";
import { theme } from "../theme/theme.js";
import { AssistantMessageComponent } from "./assistant-message.js";
import { ToolExecutionComponent } from "./tool-execution.js";
import { UserMessageComponent } from "./user-message.js";

export class ChatLog extends Container {
  private toolById = new Map<string, ToolExecutionComponent>();
  private streamingRuns = new Map<string, AssistantMessageComponent>();
  private toolsExpanded = false;
  private toolOrder: string[] = []; // Track tool insertion order
  private toolGroupSummary: Text | null = null;
  private roleLabel: string | null = null;
  private roleColor: string | null = null;

  /**
   * Set a role context that is applied as a colored @Role badge to every
   * new AssistantMessageComponent. Pass null to clear.
   */
  setRoleContext(role: string | null, color: string | null) {
    this.roleLabel = role;
    this.roleColor = color;
  }

  private applyRoleBadge(component: AssistantMessageComponent) {
    if (this.roleLabel) {
      component.setRoleBadge(this.roleLabel, this.roleColor);
    }
  }

  clearAll() {
    this.clear();
    this.toolById.clear();
    this.streamingRuns.clear();
    this.toolOrder = [];
    this.toolGroupSummary = null;
  }

  addSystem(text: string) {
    this.addChild(new Spacer(1));
    this.addChild(new Text(theme.system(text), 1, 0));
  }

  addUser(text: string) {
    this.addChild(new UserMessageComponent(text));
  }

  private resolveRunId(runId?: string) {
    return runId ?? "default";
  }

  startAssistant(text: string, runId?: string) {
    const component = new AssistantMessageComponent(text);
    this.applyRoleBadge(component);
    this.streamingRuns.set(this.resolveRunId(runId), component);
    this.addChild(component);
    return component;
  }

  updateAssistant(text: string, runId?: string) {
    const effectiveRunId = this.resolveRunId(runId);
    const existing = this.streamingRuns.get(effectiveRunId);
    if (!existing) {
      this.startAssistant(text, runId);
      return;
    }
    existing.setText(text);
  }

  finalizeAssistant(text: string, runId?: string) {
    const effectiveRunId = this.resolveRunId(runId);
    const existing = this.streamingRuns.get(effectiveRunId);
    if (existing) {
      existing.setText(text);
      this.streamingRuns.delete(effectiveRunId);
      return;
    }
    const component = new AssistantMessageComponent(text);
    this.applyRoleBadge(component);
    this.addChild(component);
  }

  startTool(toolCallId: string, toolName: string, args: unknown) {
    const existing = this.toolById.get(toolCallId);
    if (existing) {
      existing.setArgs(args);
      return existing;
    }
    const component = new ToolExecutionComponent(toolName, args);
    component.setExpanded(this.toolsExpanded);
    this.toolById.set(toolCallId, component);
    this.toolOrder.push(toolCallId);
    this.addChild(component);
    this.updateToolGrouping();
    return component;
  }

  updateToolArgs(toolCallId: string, args: unknown) {
    const existing = this.toolById.get(toolCallId);
    if (!existing) {
      return;
    }
    existing.setArgs(args);
  }

  updateToolResult(
    toolCallId: string,
    result: unknown,
    opts?: { isError?: boolean; partial?: boolean },
  ) {
    const existing = this.toolById.get(toolCallId);
    if (!existing) {
      return;
    }
    if (opts?.partial) {
      existing.setPartialResult(result as Record<string, unknown>);
      return;
    }
    existing.setResult(result as Record<string, unknown>, {
      isError: opts?.isError,
    });
  }

  setToolsExpanded(expanded: boolean) {
    this.toolsExpanded = expanded;
    for (const tool of this.toolById.values()) {
      tool.setExpanded(expanded);
    }
    this.updateToolGrouping();
  }

  private updateToolGrouping() {
    // Remove existing summary if present
    if (this.toolGroupSummary) {
      this.removeChild(this.toolGroupSummary);
      this.toolGroupSummary = null;
    }

    const count = this.toolOrder.length;
    if (count === 0) {
      return;
    }

    // When collapsed and there are many tools, show a summary count at the top
    if (!this.toolsExpanded && count > 5) {
      const summaryText = theme.dim(`└─ ${count} tool uses (ctrl+o to expand details)`);
      this.toolGroupSummary = new Text(summaryText, 1, 0);
      // Insert summary before the first tool
      const firstTool = this.toolById.get(this.toolOrder[0]);
      if (firstTool) {
        const idx = this.children.indexOf(firstTool);
        if (idx >= 0) {
          this.children.splice(idx, 0, this.toolGroupSummary);
        }
      }
    }
  }
}
