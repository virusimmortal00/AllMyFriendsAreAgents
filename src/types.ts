import type { ChatStyle, ParticipantStyles } from "../shared/chat-style";

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

export interface RoomState {
  messages: RoomMessage[];
  sessions: Partial<Record<AgentId, { id: string; permission: "read-only" | "writable" }>>;
  settings: {
    topic: string;
    writableAgent: WritableAgent;
    reviewMode: "read-only";
    maxRounds: number;
    projectPath: string;
    participantStyles: ParticipantStyles;
  };
  status: "idle" | "working" | "error";
  activeAgent?: AgentId;
  error?: string;
  availability?: Record<AgentId, boolean>;
}
