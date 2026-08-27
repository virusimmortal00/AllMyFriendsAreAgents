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
import type { RoomContinuationWorkRequest } from "../../shared/protocol.js";
import type {
  AddImprovementMilestoneResult,
  ImprovementLedgerRecords,
  ImprovementMilestoneState,
} from "../../shared/governed-improvements.js";
import type { AssignmentRecordStore } from "../assignment-record.js";
import type { ContinuationRecordStore } from "../continuation-record.js";
import type {
  Task,
  TaskActor,
  TaskChange,
  TaskChangeResult,
  TaskIdentity,
  TaskLifecycleState,
} from "../../shared/task-domain.js";
import type { RoomAgentRoster, RoomAgentRosterEntry } from "../../shared/roster.js";
import type { DeploymentProvenance } from "../deployment-provenance.js";
import type { CommandRecordStore } from "../command-record.js";

export const CANONICAL_ROOM_ID = "00000000-0000-4000-8000-000000000001";

export interface RevisionConflict {
  readonly kind: "conflict";
  readonly expectedRevision: number;
  readonly actualRevision: number;
}

export type RosterChangeResult =
  | { readonly kind: "accepted"; readonly roster: RoomAgentRoster }
  | RevisionConflict;

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

export type CreateTaskResult =
  | { readonly kind: "created"; readonly task: Task }
  | { readonly kind: "conflict"; readonly identity: TaskIdentity }
  | { readonly kind: "rejected"; readonly reason: string };

export interface TaskEvent {
  readonly roomId: string;
  readonly taskId: string;
  readonly revision: number;
  readonly actorId: string;
  readonly at: string;
  readonly change: "create" | TaskChange | { readonly kind: "fork"; readonly source: TaskIdentity };
  readonly snapshot: Task;
}

export interface TaskListQuery {
  readonly roomId?: string;
  readonly states?: readonly TaskLifecycleState[];
  readonly participantId?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface TaskPage { readonly items: readonly Task[]; readonly nextCursor: string | null }

export interface TaskDependencyQueryResult {
  readonly dependencies: readonly TaskIdentity[];
  readonly blockers: readonly TaskIdentity[];
  readonly dependents: readonly TaskIdentity[];
}

export type EmergencyStopChangeResult =
  | { readonly kind: "accepted"; readonly emergencyStop: EmergencyStopProjection }
  | RevisionConflict;

export interface RoomRepository extends AssignmentRecordStore, ContinuationRecordStore, CommandRecordStore {
  snapshot(): RoomState;
  addMessage(
    speaker: RoomMessage["speaker"],
    text: string,
    kind?: RoomMessage["kind"],
    style?: ChatStyle,
    burst?: { burstId: string; sequence: number },
    human?: { id: string; name: string; clientMessageId?: string; mentions?: MessageMention[]; continuationRequest?: RoomContinuationWorkRequest },
  ): Promise<RoomMessage>;
  updateSettings(update: Partial<RoomSettings>): Promise<void>;
  updateRoster(expectedRevision: number, entries: readonly RoomAgentRosterEntry[]): Promise<RosterChangeResult>;
  changeTopic(topic: string): Promise<void>;
  updateParticipantStyle(participant: StyledParticipant, style: ChatStyle): Promise<void>;
  setDeployment(provenance: DeploymentProvenance): Promise<void>;
  setSession(agent: AgentId, id: string, permission: "read-only" | "writable", codeEpoch?: string): Promise<void>;
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
  createTask(task: Task): Promise<CreateTaskResult>;
  /** Creates the initial projection and applies every supplied change in one atomic write. */
  createTaskWithChanges(task: Task, changes: readonly TaskChange[], actor: TaskActor, now: string): Promise<CreateTaskResult>;
  getTask(identity: TaskIdentity): Promise<Task | undefined>;
  listTasks(query?: TaskListQuery): Promise<TaskPage>;
  applyTaskChange(identity: TaskIdentity, expectedRevision: number, change: TaskChange, actor: TaskActor, now: string): Promise<TaskChangeResult>;
  /** Persists every change and event together, or leaves the task untouched. */
  applyTaskChanges(identity: TaskIdentity, expectedRevision: number, changes: readonly TaskChange[], actor: TaskActor, now: string): Promise<TaskChangeResult>;
  listTaskEvents(identity: TaskIdentity, options?: { readonly afterRevision?: number; readonly limit?: number }): Promise<readonly TaskEvent[]>;
  getTaskDependencies(identity: TaskIdentity): Promise<TaskDependencyQueryResult | undefined>;
  forkTask(source: TaskIdentity, expectedRevision: number, newTaskId: string, actor: TaskActor, now: string, title?: string): Promise<TaskChangeResult>;
}
