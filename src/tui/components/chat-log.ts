import type { Component } from "@mariozechner/pi-tui";
import { Container, Spacer, Text } from "@mariozechner/pi-tui";
import { theme } from "../theme/theme.js";
import { AssistantMessageComponent } from "./assistant-message.js";
import { ToolExecutionComponent } from "./tool-execution.js";
import { UserMessageComponent } from "./user-message.js";

export class ChatLog extends Container {
  private readonly maxComponents: number;
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

  constructor(maxComponents = 180) {
    super();
    this.maxComponents = Math.max(20, Math.floor(maxComponents));
  }

  private dropComponentReferences(component: Component) {
    for (const [toolId, tool] of this.toolById.entries()) {
      if (tool === component) {
        this.toolById.delete(toolId);
      }
    }
    for (const [runId, message] of this.streamingRuns.entries()) {
      if (message === component) {
        this.streamingRuns.delete(runId);
      }
    }
  }

  private pruneOverflow() {
    while (this.children.length > this.maxComponents) {
      const oldest = this.children[0];
      if (!oldest) {
        return;
      }
      this.removeChild(oldest);
      this.dropComponentReferences(oldest);
    }
  }

  private append(component: Component) {
    this.addChild(component);
    this.pruneOverflow();
  }

  clearAll() {
    this.clear();
    this.toolById.clear();
    this.streamingRuns.clear();
    this.toolOrder = [];
    this.toolGroupSummary = null;
  }

  addSystem(text: string) {
    this.append(new Spacer(1));
    this.append(new Text(theme.system(text), 1, 0));
  }

  addUser(text: string) {
    this.append(new UserMessageComponent(text));
  }

  private resolveRunId(runId?: string) {
    return runId ?? "default";
  }

  startAssistant(text: string, runId?: string) {
    const component = new AssistantMessageComponent(text);
    this.applyRoleBadge(component);
    this.streamingRuns.set(this.resolveRunId(runId), component);
    this.append(component);
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
    this.append(new AssistantMessageComponent(text));
  }

  dropAssistant(runId?: string) {
    const effectiveRunId = this.resolveRunId(runId);
    const existing = this.streamingRuns.get(effectiveRunId);
    if (!existing) {
      return;
    }
    this.removeChild(existing);
    this.streamingRuns.delete(effectiveRunId);
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
    this.append(component);
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
