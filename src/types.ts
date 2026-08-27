import type { ChatStyle, ParticipantStyles } from "../shared/chat-style";
import type { ConversationEnergy } from "../shared/conversation-energy";
import type { ActiveAgentId, AgentId, SpeakerId } from "../shared/participants";
import type { ImplementationCapability, ServerIdentity } from "../shared/protocol";
import type { ImprovementWorkshopView } from "../shared/workshop";
import type { GovernedImprovementDetail } from "../shared/governed-improvements";
import type { GovernedImprovementSummary } from "../shared/governed-improvements";
import type { ImprovementStatusContract } from "../shared/improvement-status";
import type { MessageMention } from "../shared/mentions";
import type { RoomAgentRoster } from "../shared/roster";

export type { AgentId, SpeakerId } from "../shared/participants";

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
export interface PublicPollProjection {
  pollId: string;
  question: string;
  options: string[];
  tallies: number[];
  totalVotes: number;
}

export interface HumanPresence {
  id: string;
  name: string;
  style: ChatStyle;
  avatarUrl?: string;
}

export interface DeploymentProvenance {
  schemaVersion: 1;
  commitSha: string | null;
  reference: { kind: "branch"; name: string } | { kind: "detached" } | { kind: "unavailable" };
  worktree: "clean" | "dirty" | "unavailable";
  epoch: string;
  observedAt: string;
  unavailableReason?: "git-unavailable" | "not-a-git-checkout" | "no-commit" | "inspection-failed";
}

export interface RoomState {
  messages: RoomMessage[];
  settings: {
    roomName: string;
    topic: string;
    conversationEnergy: ConversationEnergy;
    participantStyles: ParticipantStyles;
  };
  roster?: RoomAgentRoster;
  status: "idle" | "working" | "error";
  activeAgent?: AgentId;
  activeGenerations?: Record<string, AgentId>;
  error?: string;
  availability?: Partial<Record<ActiveAgentId, boolean>>;
  implementationCapabilities?: Partial<Record<ActiveAgentId, ImplementationCapability>>;
  agentHealth?: Partial<Record<ActiveAgentId, AgentHealth>>;
  server?: ServerIdentity;
  humans?: HumanPresence[];
  deployment?: DeploymentProvenance;
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
export interface ContinuationPolicyView { revision: number; enabled: boolean; policyVersion: string; updatedAt: string; defaultBudget: { timeMs: number; tokenLimit: number; toolCallLimit: number; retryLimit: number } }
export interface ContinuationJobView { jobId: string; jobRevision: number; owner: AgentId; task: { roomId: string; taskId: string }; taskRevision: number; assignmentId: string; objective: string; trigger: string; status: "QUEUED" | "RUNNING" | "WAITING_TOOL" | "BLOCKED" | "COMPLETED" | "FAILED" | "CANCELLED" | "ACKNOWLEDGED"; resultDisposition: string; resultSummary: string | null; blocker: string | null; nextEligibilityAt: string | null; updatedAt: string; usage: { elapsedMs: number; tokens: number; toolCalls: number; attempts: number } }
export interface ContinuationInboxEntry { inboxEntryId: string; inboxRevision: number; owner: AgentId; jobId: string; task: { taskId: string }; assignmentId: string; status: "UNREAD" | "ACKNOWLEDGED" | "CLOSED" | "ARCHIVED"; summary: string; createdAt: string; expiresAt: string }
export interface ContinuationDashboard { policy: ContinuationPolicyView; jobs: ContinuationJobView[] }
export interface InvestigationEvidenceRef { kind: "room_message" | "project_artifact" | "observability"; ref: string; label?: string }
export interface InvestigationPolicyView { revision: number; enabled: boolean; policyVersion: string; maxConcurrentGlobal: number; updatedAt: string; defaultBudget: { timeMs: number; tokenLimit: number; toolCallLimit: number; retryLimit: number } }
export interface InvestigationJobView { investigationId: string; revision: number; owner: AgentId; objective: string; trigger: string; signal: "AGENT_DECISION" | "AUTHENTICATED_HUMAN" | "TRUSTED_POLICY"; evidenceRefs: InvestigationEvidenceRef[]; status: "REQUESTED" | "QUEUED" | "RUNNING" | "WAITING_TOOL" | "CHECKPOINTED" | "BLOCKED" | "COMPLETED" | "FAILED" | "CANCELLED" | "ACKNOWLEDGED" | "ARCHIVED"; usage: { elapsedMs: number; tokens: number; toolCalls: number; attempts: number }; providerSessionEstablished: boolean; checkpoint: { attempt: number; summary: string; createdAt: string } | null; resultSummary: string | null; unresolvedQuestions: string[]; resultWaiting: boolean; blocker: string | null; createdAt: string; updatedAt: string; completedAt: string | null }
export interface InvestigationInboxEntry { inboxEntryId: string; revision: number; investigationId: string; owner: AgentId; status: "UNREAD" | "ACKNOWLEDGED" | "CLOSED" | "ARCHIVED"; summary: string; evidenceRefs: InvestigationEvidenceRef[]; unresolvedQuestions: string[]; createdAt: string; updatedAt: string; expiresAt: string }
export interface InvestigationDashboard { policy: InvestigationPolicyView; jobs: InvestigationJobView[] }
