/**
 * Chat message types for the UI layer.
 */

export type ChatLiveActor = {
  role: "assistant" | "peer";
  actorKey: string;
  label: string;
  avatar?: string | null;
  accent?: string | null;
};

export type ChatLiveActivity = {
  activityId: string;
  runId: string;
  parentActivityId?: string | null;
  kind: string;
  actor: ChatLiveActor;
  startedAt: number;
  updatedAt: number;
  text?: string;
  statusLabel?: string | null;
  completed?: boolean;
};

/** Union type for items in the chat thread */
export type ChatItem =
  | { kind: "message"; key: string; message: unknown; runId?: string | null }
  | { kind: "divider"; key: string; label: string; timestamp: number }
  | {
      kind: "stream";
      key: string;
      text: string;
      startedAt: number;
      runId?: string | null;
      activityId?: string | null;
      actor?: ChatLiveActor;
      statusLabel?: string | null;
    }
  | { kind: "reading-indicator"; key: string; runId?: string | null }
  | {
      kind: "processing-indicator";
      key: string;
      startedAt: number;
      runId?: string | null;
      activityId?: string | null;
      actor?: ChatLiveActor;
      phase?: "processing" | "thinking" | "typing" | "tool_running" | null;
      statusLabel?: string | null;
    };

export type MessageGroupChild =
  | { kind: "message"; message: unknown; key: string }
  | { kind: "stream"; text: string; startedAt: number; statusLabel?: string | null }
  | { kind: "reading-indicator" }
  | {
      kind: "processing-indicator";
      phase?: "processing" | "thinking" | "typing" | "tool_running" | null;
      statusLabel?: string | null;
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
