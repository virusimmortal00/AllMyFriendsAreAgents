import type { ChatStyle, ParticipantStyles } from "../shared/chat-style";
import type { ConversationEnergy } from "../shared/conversation-energy";
import type { AgentId, SpeakerId, WritableAgent } from "../shared/participants";

export type { AgentId, SpeakerId, WritableAgent } from "../shared/participants";

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

export interface RoomState {
  messages: RoomMessage[];
  sessions: Partial<Record<AgentId, { id: string; permission: "read-only" | "writable" }>>;
  settings: {
    roomName: string;
    topic: string;
    writableAgent: WritableAgent;
    conversationEnergy: ConversationEnergy;
    projectPath: string;
    participantStyles: ParticipantStyles;
  };
  status: "idle" | "working" | "error";
  activeAgent?: AgentId;
  error?: string;
  availability?: Record<AgentId, boolean>;
  humans?: HumanPresence[];
}
