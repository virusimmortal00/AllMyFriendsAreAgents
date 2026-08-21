import type { ChatStyle, ParticipantStyles } from "../shared/chat-style";
import type { ConversationEnergy } from "../shared/conversation-energy";
import type { ActiveAgentId, AgentId, SpeakerId, WritableAgent } from "../shared/participants";
import type { ServerIdentity } from "../shared/protocol";
import type { ImprovementWorkshopView } from "../shared/workshop";
import type { GovernedImprovementDetail } from "../shared/governed-improvements";
import type { GovernedImprovementSummary } from "../shared/governed-improvements";
import type { ImprovementStatusContract } from "../shared/improvement-status";
import type { MessageMention } from "../shared/mentions";

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
  mentions?: MessageMention[];
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
export interface WorkshopResponse extends GovernedImprovementDetail {
  kind: "found";
  improvement: ImprovementWorkshopView;
  emergencyStop: { active: boolean; reason: string | null; activatedAt: string | null };
}
export interface HeartbeatStatus {
  configured: boolean;
  active: boolean;
  runtime: { revision: number; enabled: boolean; emergencyStopped: boolean; changedBy: string | null; changedAt: string | null; reason: string | null };
  policy: { version: string; cadenceMs: number; maxConcurrency: number; maxSelectedPerRun: number; maxDispatchedPerRun: number; maxAttemptsPerRevision: number; retryAfterMs: number; timeBudgetMs: number; permittedCapabilities: readonly string[]; prohibitedCapabilities: readonly string[]; eligibleStates: readonly string[]; governedProposalRequired: boolean };
  audit: readonly { revision: number; kind: "AUTHORIZED" | "EMERGENCY_STOPPED"; actorId: string; at: string; reason: string }[];
}
export type { GovernedImprovementDetail, GovernedImprovementSummary, ImprovementStatusContract };
