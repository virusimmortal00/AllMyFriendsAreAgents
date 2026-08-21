import type { ChatStyle, ParticipantStyles } from "../shared/chat-style";
import type { ConversationEnergy } from "../shared/conversation-energy";
import type { ActiveAgentId, AgentId, SpeakerId, WritableAgent } from "../shared/participants";
import type { ServerIdentity } from "../shared/protocol";
import type { ImprovementWorkshopView } from "../shared/workshop";

export type { AgentId, SpeakerId, WritableAgent } from "../shared/participants";

export interface AgentHealth {
  status: "cooldown" | "unavailable";
  reason: "rate_limit" | "authentication" | "timeout" | "configuration" | "provider_error";
  message: string;
  since: string;
  retryAt?: string;
}

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
  clientMessageId?: string;
}

export interface HumanPresence {
  id: string;
  name: string;
  style: ChatStyle;
}

export interface RoomState {
  messages: RoomMessage[];
  settings: {
    roomName: string;
    topic: string;
    writableAgent: WritableAgent;
    conversationEnergy: ConversationEnergy;
    participantStyles: ParticipantStyles;
  };
  status: "idle" | "working" | "error";
  activeAgent?: AgentId;
  error?: string;
  availability?: Record<ActiveAgentId, boolean>;
  agentHealth?: Partial<Record<ActiveAgentId, AgentHealth>>;
  server?: ServerIdentity;
  humans?: HumanPresence[];
}
export interface WorkshopResponse { improvement: ImprovementWorkshopView; emergencyStop: { active: boolean; reason: string | null; activatedAt: string | null }; }
