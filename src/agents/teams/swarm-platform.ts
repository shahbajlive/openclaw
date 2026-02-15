import type { DependencyNotesByTaskId } from "./types.js";

export type SwarmSessionHistory = {
  messages: unknown[];
  sessionId?: string;
};

export type SwarmBootstrapRequest = {
  teamId: string;
  taskId: string;
  sessionKey: string;
  title: string;
  instruction: string;
  sessionLabel?: string;
  dependencyNotes?: DependencyNotesByTaskId;
};

export interface SwarmPlatform {
  sendBootstrap?(params: SwarmBootstrapRequest): void | Promise<void>;
  appendSessionNote?(params: {
    teamId: string;
    sessionKey: string;
    note: string;
  }): void | Promise<void>;
  announceSession?(params: {
    teamId: string;
    sessionKey: string;
    message: string;
  }): void | Promise<void>;
  readSessionHistory?(params: {
    teamId: string;
    sessionKey: string;
    limit: number;
  }): SwarmSessionHistory | Promise<SwarmSessionHistory>;
  interruptSession?(params: {
    teamId: string;
    sessionKey: string;
    reason: string;
  }): void | Promise<void>;
}
