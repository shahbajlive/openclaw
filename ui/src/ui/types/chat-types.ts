/**
 * Chat message types for the UI layer.
 */

/** Union type for items in the chat thread */
export type ChatItem =
  | { kind: "message"; key: string; message: unknown; runId?: string | null }
  | { kind: "divider"; key: string; label: string; timestamp: number }
  | { kind: "stream"; key: string; text: string; startedAt: number; runId?: string | null }
  | { kind: "reading-indicator"; key: string; runId?: string | null }
  | {
      kind: "processing-indicator";
      key: string;
      startedAt: number;
      runId?: string | null;
      phase?: "processing" | "thinking" | "typing" | "tool_running" | "finalizing" | null;
    };

export type MessageGroupChild =
  | { kind: "message"; message: unknown; key: string }
  | { kind: "stream"; text: string; startedAt: number }
  | { kind: "reading-indicator" }
  | {
      kind: "processing-indicator";
      phase?: "processing" | "thinking" | "typing" | "tool_running" | "finalizing" | null;
    };

/** A group of consecutive messages from the same role (Slack-style layout) */
export type MessageGroup = {
  kind: "group";
  key: string;
  role: string;
  runId?: string | null;
  speakerKey?: string;
  speakerLabel?: string;
  speakerInitial?: string;
  speakerAvatar?: string;
  speakerAccent?: string;
  children: MessageGroupChild[];
  timestamp: number;
  isStreaming: boolean;
};

/** Content item types in a normalized message */
export type MessageContentItem = {
  type: "text" | "tool_call" | "tool_result";
  text?: string;
  name?: string;
  args?: unknown;
};

/** Normalized message structure for rendering */
export type NormalizedMessage = {
  role: string;
  content: MessageContentItem[];
  timestamp: number;
  id?: string;
  speakerKey?: string;
  speakerLabel?: string;
  speakerInitial?: string;
  speakerAvatar?: string;
  speakerAccent?: string;
};

/** Tool card representation for tool calls and results */
export type ToolCard = {
  kind: "call" | "result";
  name: string;
  args?: unknown;
  text?: string;
};
