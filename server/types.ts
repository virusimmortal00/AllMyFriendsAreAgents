import type { ChatStyle, ParticipantStyles } from "../shared/chat-style.js";

export type AgentId = "codex" | "claude";
export type SpeakerId = AgentId | "you" | "system";
export type WritableAgent = AgentId | "nobody";

export interface RoomMessage {
  id: string;
  speaker: SpeakerId;
  text: string;
  timestamp: string;
  kind?: "chat" | "review" | "status" | "topic";
  style?: ChatStyle;
}

export interface AgentSession {
  id: string;
  permission: "read-only" | "writable";
}

export interface RoomSettings {
  topic: string;
  writableAgent: WritableAgent;
  reviewMode: "read-only";
  maxRounds: number;
  projectPath: string;
  participantStyles: ParticipantStyles;
}

export interface RoomState {
  messages: RoomMessage[];
  sessions: Partial<Record<AgentId, AgentSession>>;
  settings: RoomSettings;
  status: "idle" | "working" | "error";
  activeAgent?: AgentId;
  error?: string;
}
