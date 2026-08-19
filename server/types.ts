export type AgentId = "codex" | "claude";
export type SpeakerId = AgentId | "you" | "system";
export type WritableAgent = AgentId | "nobody";

export interface RoomMessage {
  id: string;
  speaker: SpeakerId;
  text: string;
  timestamp: string;
  kind?: "chat" | "review" | "status";
}

export interface AgentSession {
  id: string;
  permission: "read-only" | "writable";
}

export interface RoomSettings {
  writableAgent: WritableAgent;
  reviewMode: "read-only";
  maxRounds: number;
  projectPath: string;
}

export interface RoomState {
  messages: RoomMessage[];
  sessions: Partial<Record<AgentId, AgentSession>>;
  settings: RoomSettings;
  status: "idle" | "working" | "error";
  activeAgent?: AgentId;
  error?: string;
}

