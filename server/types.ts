import type { ChatStyle, ParticipantStyles } from "../shared/chat-style.js";
import type { ConversationEnergy } from "../shared/conversation-energy.js";
import type { AgentId, SpeakerId, WritableAgent } from "../shared/participants.js";

export type { AgentId, SpeakerId, WritableAgent } from "../shared/participants.js";

export interface RoomMessage {
  id: string;
  speaker: SpeakerId;
  text: string;
  timestamp: string;
  kind?: "chat" | "review" | "status" | "topic";
  style?: ChatStyle;
  burstId?: string;
  sequence?: number;
}

export interface AgentSession {
  id: string;
  permission: "read-only" | "writable";
}

export interface RoomSettings {
  topic: string;
  writableAgent: WritableAgent;
  reviewMode: "read-only";
  conversationEnergy: ConversationEnergy;
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
