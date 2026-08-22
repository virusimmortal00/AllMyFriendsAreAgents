import type { ChatStyle, StyledParticipant } from "../../shared/chat-style.js";
import type {
  ChangeResult,
  DomainActor,
  EmergencyStop,
  Improvement,
  ImprovementChange,
  ImprovementRisk,
  ImprovementState,
} from "../../shared/improvement-domain.js";
import type { AgentId, RoomMessage, RoomSettings, RoomState } from "../types.js";
import type { MessageMention } from "../../shared/mentions.js";
import type {
  AddImprovementMilestoneResult,
  ImprovementLedgerRecords,
  ImprovementMilestoneState,
} from "../../shared/governed-improvements.js";
import type { AssignmentRecordStore } from "../assignment-record.js";
import type { WorkspaceRepository } from "./workspace-repository.js";

export interface RevisionConflict {
  readonly kind: "conflict";
  readonly expectedRevision: number;
  readonly actualRevision: number;
}

export type CreateImprovementResult =
  | { readonly kind: "created"; readonly improvement: Improvement }
  | { readonly kind: "conflict"; readonly id: string };

export interface ImprovementEvent {
  readonly improvementId: string;
  readonly revision: number;
  readonly actorId: string;
  readonly at: string;
  readonly change: "CREATE" | ImprovementChange | {
    readonly kind: "RECORD_MILESTONE";
    readonly milestoneId: string;
    readonly state: ImprovementMilestoneState;
    readonly summary: string;
  };
  readonly snapshot: Improvement;
}

export interface ImprovementListQuery {
  readonly states?: readonly ImprovementState[];
  readonly risks?: readonly ImprovementRisk[];
  readonly authorId?: string;
  readonly claimId?: string;
  readonly evidenceId?: string;
  readonly updatedAfter?: string;
  readonly updatedBefore?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface ImprovementPage {
  readonly items: readonly Improvement[];
  readonly nextCursor: string | null;
}

export interface EmergencyStopProjection extends EmergencyStop {
  readonly revision: number;
}

export type EmergencyStopChangeResult =
  | { readonly kind: "accepted"; readonly emergencyStop: EmergencyStopProjection }
  | RevisionConflict;

export interface RoomRepository extends AssignmentRecordStore, WorkspaceRepository {
  snapshot(): RoomState;
  addMessage(
    speaker: RoomMessage["speaker"],
    text: string,
    kind?: RoomMessage["kind"],
    style?: ChatStyle,
    burst?: { burstId: string; sequence: number },
    human?: { id: string; name: string; clientMessageId?: string; mentions?: MessageMention[] },
  ): Promise<RoomMessage>;
  updateSettings(update: Partial<RoomSettings>): Promise<void>;
  changeTopic(topic: string): Promise<void>;
  updateParticipantStyle(participant: StyledParticipant, style: ChatStyle): Promise<void>;
  setSession(agent: AgentId, id: string, permission: "read-only" | "writable"): Promise<void>;
  clearSession(agent: AgentId): Promise<void>;
  setStatus(status: RoomState["status"], activeAgent?: AgentId, error?: string): Promise<void>;
  createImprovement(improvement: Improvement): Promise<CreateImprovementResult>;
  getImprovement(id: string): Promise<Improvement | undefined>;
  listImprovements(query?: ImprovementListQuery): Promise<ImprovementPage>;
  applyImprovementChange(
    id: string,
    expectedRevision: number,
    change: ImprovementChange,
    actor: DomainActor,
    now: string,
  ): Promise<ChangeResult>;
  listImprovementEvents(
    id: string,
    options?: { readonly afterRevision?: number; readonly limit?: number },
  ): Promise<readonly ImprovementEvent[]>;
  getImprovementLedgerRecords(id: string): Promise<ImprovementLedgerRecords | undefined>;
  addImprovementMilestone(
    id: string,
    expectedRevision: number,
    milestone: { readonly id: string; readonly state: ImprovementMilestoneState; readonly summary: string },
    actor: DomainActor,
    now: string,
  ): Promise<AddImprovementMilestoneResult>;
  getEmergencyStop(): Promise<EmergencyStopProjection>;
  updateEmergencyStop(
    expectedRevision: number,
    update: { readonly active: boolean; readonly reason?: string },
    actor: DomainActor,
    now: string,
  ): Promise<EmergencyStopChangeResult>;
}
