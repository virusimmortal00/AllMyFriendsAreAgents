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
  humanId?: string;
  speakerName?: string;
}

export interface HumanPresence {
  id: string;
  name: string;
  style: ChatStyle;
}

export interface AgentSession {
  id: string;
  permission: "read-only" | "writable";
}

export interface RoomSettings {
  roomName: string;
  topic: string;
  writableAgent: WritableAgent;
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
  humans?: HumanPresence[];
}

export interface PublicRoomState extends Omit<RoomState, "sessions" | "settings" | "error"> {
  settings: Omit<RoomSettings, "projectPath">;
  availability?: Record<AgentId, boolean>;
}
