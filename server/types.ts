import type { ChatStyle, ParticipantStyles } from "../shared/chat-style.js";
import type { ConversationEnergy } from "../shared/conversation-energy.js";
import type { ActiveAgentId, AgentId, SpeakerId, WritableAgent } from "../shared/participants.js";
import type { AgentHealth } from "./agent-health.js";
import type { RoomContinuationWorkRequest, ServerIdentity } from "../shared/protocol.js";
import type { MessageMention } from "../shared/mentions.js";
import type { ActiveGenerations } from "./active-generations.js";
import type { RoomAgentRoster } from "../shared/roster.js";

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
  clientMessageId?: string;
  mentions?: MessageMention[];
  continuationRequest?: RoomContinuationWorkRequest;
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
  roster?: RoomAgentRoster;
  status: "idle" | "working" | "error";
  activeAgent?: AgentId;
  error?: string;
  humans?: HumanPresence[];
}

export interface PublicRoomState extends Omit<RoomState, "sessions" | "settings" | "error"> {
  settings: Omit<RoomSettings, "projectPath">;
  activeGenerations?: ActiveGenerations;
  availability?: Partial<Record<ActiveAgentId, boolean>>;
  agentHealth?: Partial<Record<ActiveAgentId, AgentHealth>>;
  server?: ServerIdentity;
}
