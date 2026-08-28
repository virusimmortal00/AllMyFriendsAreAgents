import type { ChatStyle, ParticipantStyles } from "../shared/chat-style.js";
import type { ConversationEnergy } from "../shared/conversation-energy.js";
import type { ActiveAgentId, AgentId, SpeakerId, WritableAgent } from "../shared/participants.js";
import type { AgentHealth } from "./agent-health.js";
import type { ImplementationCapability, RoomContinuationWorkRequest, ServerIdentity } from "../shared/protocol.js";
import type { MessageMention } from "../shared/mentions.js";
import type { ActiveGenerations } from "./active-generations.js";
import type { RoomAgentRoster } from "../shared/roster.js";
import type { DeploymentProvenance } from "./deployment-provenance.js";
import type { PreflightEvidence } from "../shared/preflight.js";
import type { RoomConfiguration, RoomConfigurationAuditEvent } from "./room-configuration.js";

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
  /** Server-only recipient boundary. This field is stripped from every client projection. */
  recipientHumanId?: string;
}

export interface HumanPresence {
  id: string;
  name: string;
  style: ChatStyle;
  avatarUrl?: string;
}

export interface AgentSession {
  id: string;
  permission: "read-only" | "writable";
  configurationFingerprint?: string;
  configurationRevision?: number;
  codeEpoch?: string;
  invalidatedAt?: string;
  invalidationReason?: string;
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
  deployment?: DeploymentProvenance;
  /** Optional for backward-compatible JSON state; absence resolves to built-in defaults. */
  roomConfiguration?: RoomConfiguration;
  roomConfigurationAudit?: RoomConfigurationAuditEvent[];
  /** JSON-backend persistence for derived context summaries; never sent to room clients. */
  agentContextSummaries?: Array<{ agentId: AgentId; spanStartId: string; spanEndId: string; configRevision: number; summary: string }>;
}

export interface PublicRoomState extends Omit<RoomState, "sessions" | "settings" | "error" | "agentContextSummaries" | "roomConfigurationAudit"> {
  settings: Omit<RoomSettings, "projectPath" | "writableAgent">;
  activeGenerations?: ActiveGenerations;
  availability?: Partial<Record<ActiveAgentId, boolean>>;
  implementationCapabilities?: Partial<Record<ActiveAgentId, ImplementationCapability>>;
  agentHealth?: Partial<Record<ActiveAgentId, AgentHealth>>;
  server?: ServerIdentity;
  preflightEvidence?: PreflightEvidence;
  githubReadStatus?: { state: "ready" | "unavailable"; reason: string };
}
