import { chmod, mkdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_PARTICIPANT_STYLES, normalizeParticipantStyles, sanitizeChatStyle, type ChatStyle, type StyledParticipant } from "../../shared/chat-style.js";
import { DEFAULT_CONVERSATION_ENERGY, isConversationEnergy } from "../../shared/conversation-energy.js";
import {
  applyImprovementChange as applyDomainImprovementChange,
  type DomainActor,
  type Improvement,
  type ImprovementChange,
} from "../../shared/improvement-domain.js";
import { AGENT_PROFILES, SUPPORTED_AGENT_IDS, isActiveAgentId, isAgentId, isParticipantId, normalizeWritableAgent, type ActiveAgentId } from "../../shared/participants.js";
import { defaultRoomAgentRoster, enabledRoomAgentIds, normalizeRoomAgentRoster, participantConfigurationFingerprint, participantConfigurationFingerprintMatches, roomAgentEntry, validateRosterEntries, type RoomAgentRosterEntry } from "../../shared/roster.js";
import { createDefaultRoomState } from "../room-store.js";
import type { AgentId, AgentSession, RoomMessage, RoomSettings, RoomState, SpeakerId } from "../types.js";
import { CLEAR_EMERGENCY_STOP, emergencyStopProjection, normalizeStoredImprovement, paginateImprovements } from "./improvement-storage.js";
import { seedWaveOneImprovements } from "./improvement-ledger.js";
import type {
  CreateImprovementResult,
  EmergencyStopChangeResult,
  EmergencyStopProjection,
  ImprovementEvent,
  ImprovementListQuery,
  RoomRepository,
} from "./room-repository.js";
import { runSqliteMigrations } from "./sqlite-migrations.js";
import type { RoomContinuationWorkRequest } from "../../shared/protocol.js";
import type {
  AddImprovementMilestoneResult,
  EvidenceSourceClass,
  ImprovementLedgerRecords,
  ImprovementMilestoneState,
  StoredImprovementMilestone,
} from "../../shared/governed-improvements.js";
import type { ImprovementStatusContract } from "../../shared/improvement-status.js";
import { normalizeAssignmentRecord, type AssignmentRecord } from "../assignment-record.js";
import {
  applyTaskChange as applyDomainTaskChange,
  forkTask as forkDomainTask,
  type Task,
  type TaskActor,
  type TaskChange,
  type TaskChangeResult,
  type TaskIdentity,
} from "../../shared/task-domain.js";
import { paginateTasks } from "./task-storage.js";
import { validateContinuationDurableState } from "./continuation-storage.js";
import { CANONICAL_ROOM_ID, type CreateTaskResult, type TaskEvent, type TaskListQuery } from "./room-repository.js";
import { canTransitionContinuation, canTransitionContinuationInbox, continuationAuditMatches, continuationInboxMatchesJob, continuationInboxMutationMatches, continuationInboxStartsJobResult, continuationProvenanceHash, continuationRecordIsCanonical, continuationRecordProvenanceMatches, finalizeContinuationAudit, normalizeContinuationAuditEvent, normalizeContinuationInboxEntry, normalizeContinuationPolicy, normalizeContinuationRecord, type CasResult, type ContinuationAuditEvent, type ContinuationInboxEntry, type ContinuationPolicy, type ContinuationRecord } from "../continuation-record.js";
import { normalizeDeploymentEpoch, normalizeDeploymentProvenance, type DeploymentProvenance } from "../deployment-provenance.js";
import type { AgentContextSummaryKey } from "../transcript.js";
import { defaultRoomConfiguration, normalizeRoomConfiguration, type RoomConfiguration, type RoomConfigurationUpdate } from "../room-configuration.js";
import { COMMAND_RECORD_RETENTION_MS, DIAGNOSTIC_RETENTION_MS, MAX_COMMAND_SUBMISSIONS_PER_ROOM, MAX_COMMAND_TOMBSTONES_PER_ROOM, MAX_DIAGNOSTICS_PER_ROOM_AGENT, MAX_DIAGNOSTIC_QUERY_LIMIT, MAX_DIAGNOSTIC_SEARCH_LENGTH, MAX_OPEN_POLLS_PER_ROOM, MAX_RECENT_POLLS, parseCommandPollCursor, type AcceptCommandResult, type CloseCommandPollResult, type CommandAcceptance, type CommandAttempt, type CommandAuditIdentity, type CommandGhExecution, type CommandInvoker, type CommandPoll, type CommandPovExecution, type CommandReassignment, type CommandSubmission, type CommandVote, type DiagnosticQuery, type DiagnosticRecord, type RoundRobinState } from "../command-record.js";
import { validAttempt, validAudit, validCommandAcceptance, validCommandReassignment, validDiagnostic, validGhExecution, validPoll, validPovExecution, validRoundRobin, validSubmission, validVote } from "./command-storage.js";
import { ensureDurableIdentityMigration, prepareDurableIdentityBackup } from "./identity-migration.js";
import type { DurableProjectRecord, DurableRoomRecord, DurableServerRecord, IdentityMigrationEvidence, RepositoryReferenceRecord, SourceWorkBinding, SourceWorkKind, StorageScope } from "./identity-domain.js";
import { boundedReconciliationReason } from "./identity-domain.js";

export const DEFAULT_ROOM_ID = CANONICAL_ROOM_ID;
export const DEFAULT_ROOM_SLUG = "the-agent-room";

async function restrictDatabaseFiles(databasePath: string) {
  await Promise.all([databasePath, `${databasePath}-wal`, `${databasePath}-shm`].map(async (filePath) => {
    try {
      await chmod(filePath, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }));
}

interface RoomRow {
  id: string;
  name: string;
  topic: string;
  writable_agent: string;
  conversation_energy: string;
  project_path: string;
  participant_styles_json: string;
  status: RoomState["status"];
  active_agent: string | null;
  error: string | null;
  roster_revision: number;
  roster_schema_version: number;
  deployment_provenance_json: string | null;
}

interface RoomSettingsRow {
  configuration_revision: number;
  base_prompt_revision: number;
  base_prompt_text: string | null;
  summarizer_model: string | null;
  summarizer_prompt_text: string;
  summarizer_prompt_revision: number;
  feature_flags_json: string;
  preflight_mode: string;
  updated_at: string;
}

interface MessageRow {
  id: string;
  speaker: string;
  speaker_name: string | null;
  human_id: string | null;
  client_message_id: string | null;
  text: string;
  kind: string | null;
  style_json: string | null;
  burst_id: string | null;
  burst_sequence: number | null;
  created_at: string;
  mentions_json: string | null;
  continuation_request_json: string | null;
  recipient_human_id: string | null;
}

interface SessionRow {
  agent_id: string;
  provider_session_id: string;
  permission: AgentSession["permission"];
  configuration_fingerprint: string | null;
  configuration_revision: number | null;
  code_epoch: string | null;
  lane: string;
  invalidated_at: string | null;
  invalidation_reason: string | null;
}

interface ImprovementRow {
  projection_json: string;
}

interface ImprovementEventRow {
  improvement_id: string;
  revision: number;
  actor_id: string;
  occurred_at: string;
  change_json: string;
  snapshot_json: string;
}

interface TaskRow { projection_json: string }
interface TaskEventRow { room_id: string; task_id: string; revision: number; actor_id: string; occurred_at: string; change_json: string; snapshot_json: string }

interface LedgerRevisionRow {
  revision: number;
  lifecycle_state: Improvement["state"];
  status_contract_json: string;
  created_at: string;
}

interface LedgerEvidenceRow {
  evidence_id: string;
  introduced_revision: number;
  qualification: EvidenceSourceClass;
  evidence_kind: string;
  uri: string;
  summary: string;
  recorded_at: string;
}

interface LedgerMilestoneRow {
  milestone_id: string;
  introduced_revision: number;
  state: ImprovementMilestoneState;
  summary: string;
  recorded_at: string;
}

interface LedgerAuditRow {
  event_id: string;
  revision: number;
  event_kind: string;
  actor_id: string;
  occurred_at: string;
  details_json: string;
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function storedSpeaker(value: string): SpeakerId {
  if (value === "you" || value === "system" || isAgentId(value)) return value;
  return "system";
}

function storedKind(value: string | null): RoomMessage["kind"] {
  return value === "chat" || value === "review" || value === "status" || value === "topic" ? value : undefined;
}

function messageFromRow(row: MessageRow, participantStyles: RoomSettings["participantStyles"]): RoomMessage {
  const speaker = storedSpeaker(row.speaker);
  const participant = isParticipantId(speaker) ? speaker : undefined;
  const rawStyle = parseJson<unknown>(row.style_json, undefined);
  const style = participant && rawStyle
    ? sanitizeChatStyle(rawStyle, participantStyles[participant])
    : undefined;
  const mentions = parseJson<NonNullable<RoomMessage["mentions"]>>(row.mentions_json, []);
  const continuationRequest = parseJson<RoomContinuationWorkRequest | undefined>(row.continuation_request_json, undefined);
  return {
    id: row.id,
    speaker,
    text: row.text,
    timestamp: row.created_at,
    ...(storedKind(row.kind) ? { kind: storedKind(row.kind) } : {}),
    ...(style ? { style } : {}),
    ...(row.burst_id ? { burstId: row.burst_id } : {}),
    ...(row.burst_sequence !== null ? { sequence: row.burst_sequence } : {}),
    ...(row.human_id ? { humanId: row.human_id } : {}),
    ...(row.speaker_name ? { speakerName: row.speaker_name } : {}),
    ...(row.client_message_id ? { clientMessageId: row.client_message_id } : {}),
    ...(mentions.length ? { mentions } : {}),
    ...(continuationRequest ? { continuationRequest } : {}),
    ...(row.recipient_human_id ? { recipientHumanId: row.recipient_human_id } : {}),
  };
}

function messageFor(
  state: RoomState,
  speaker: RoomMessage["speaker"],
  text: string,
  kind: RoomMessage["kind"] = "chat",
  style?: ChatStyle,
  burst?: { burstId: string; sequence: number },
  human?: { id: string; name: string; clientMessageId?: string; mentions?: RoomMessage["mentions"]; continuationRequest?: RoomContinuationWorkRequest },
): RoomMessage {
  const participant = isParticipantId(speaker) ? speaker : undefined;
  const messageStyle = participant
    ? sanitizeChatStyle(style, state.settings.participantStyles[participant] || DEFAULT_PARTICIPANT_STYLES["codex-sol"])
    : undefined;
  return {
    id: randomUUID(),
    speaker,
    text: text.trim(),
    timestamp: new Date().toISOString(),
    kind,
    ...(messageStyle ? { style: messageStyle } : {}),
    ...(burst ? { burstId: burst.burstId, sequence: burst.sequence } : {}),
    ...(human ? { humanId: human.id, speakerName: human.name } : {}),
    ...(!human && speaker !== "you" && speaker !== "system" ? { speakerName: AGENT_PROFILES[speaker]?.conversationalName || speaker } : {}),
    ...(human?.clientMessageId ? { clientMessageId: human.clientMessageId } : {}),
    ...(human?.mentions?.length ? { mentions: structuredClone(human.mentions) } : {}),
    ...(human?.continuationRequest ? { continuationRequest: structuredClone(human.continuationRequest) } : {}),
  };
}

export class SqliteRoomRepository implements RoomRepository {
  private state?: RoomState;

  private constructor(
    readonly databasePath: string,
    private readonly database: DatabaseSync,
    private readonly projectRoot: string,
    readonly roomId: string,
  ) {}

  static async open(
    projectRoot: string,
    databasePath: string,
    options: { initializeDefaultRoom?: boolean; seedImprovements?: boolean; deferIdentityMigration?: boolean; roomId?: string } = {},
  ) {
    const databaseDirectory = path.dirname(databasePath);
    await mkdir(databaseDirectory, { recursive: true, mode: 0o700 });
    await chmod(databaseDirectory, 0o700);
    const database = new DatabaseSync(databasePath, { timeout: 5_000, enableForeignKeyConstraints: true });
    try {
      database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");
      const identityBackupPath = await prepareDurableIdentityBackup(database, databasePath);
      await runSqliteMigrations(database);
      await restrictDatabaseFiles(databasePath);

      const roomId = options.roomId?.trim() || CANONICAL_ROOM_ID;
      const repository = new SqliteRoomRepository(databasePath, database, projectRoot, roomId);
      repository.seedAgents();
      if (!repository.hasPersistedRoom() && options.initializeDefaultRoom !== false) {
        if (roomId !== CANONICAL_ROOM_ID) throw new Error(`Durable room ${roomId} must be provisioned with an explicit server/project scope before it can be opened.`);
        repository.replaceState(createDefaultRoomState(projectRoot));
      }
      if (!options.deferIdentityMigration) await ensureDurableIdentityMigration(database, identityBackupPath, () => new Date().toISOString(), "sqlite-in-place", path.dirname(databasePath));
      if (repository.hasPersistedRoom()) {
        repository.state = repository.loadState();
        repository.assertContinuationDurableState();
        repository.setStatusSync("idle");
      }
      if (options.seedImprovements && repository.hasPersistedRoom()) {
        seedWaveOneImprovements(database, repository.roomId);
      }
      return repository;
    } catch (error) {
      database.close();
      throw error;
    }
  }

  close() {
    this.database.close();
  }

  /** Used by the one-way JSON importer after its canonical projections commit. */
  async migrateDurableIdentities(backupPath: string | null = null, sourceKind: IdentityMigrationEvidence["sourceKind"] = "sqlite-in-place", legacyStateDirectory = path.dirname(this.databasePath), jsonImportManifest?: { readonly sourceDigest: string; readonly manifest: Readonly<Record<string, unknown>> }, allowJsonImportOverExistingIdentity = false) {
    const evidence = await ensureDurableIdentityMigration(this.database, backupPath, () => new Date().toISOString(), sourceKind, legacyStateDirectory, jsonImportManifest, allowJsonImportOverExistingIdentity);
    if (this.hasPersistedRoom()) this.state = this.loadState();
    return evidence;
  }

  verifyJsonImportManifest(sourceDigest: string, allowOverwrite = false) {
    const existing = this.database.prepare("SELECT source_kind FROM storage_identity_migrations WHERE migration_version='durable-identities/v1'").get() as { source_kind: string } | undefined;
    if (!existing) return;
    if (this.database.prepare("SELECT 1 FROM storage_import_manifests WHERE source_digest=?").get(sourceDigest)) return;
    if (existing.source_kind === "json-import") {
      throw new Error("JSON import source manifest changed after the verified migration; restore the original source or use an explicit reviewed migration.");
    }
    if (!allowOverwrite) throw new Error(`Durable identity storage was initialized from ${existing.source_kind}; importing JSON requires explicit overwrite authorization.`);
  }

  async getDurableServer(): Promise<DurableServerRecord> {
    const row = this.database.prepare("SELECT * FROM durable_servers ORDER BY created_at,server_id LIMIT 1").get() as Record<string, unknown> | undefined;
    if (!row) throw new Error("Durable server identity is unavailable; complete the SQLite identity migration first.");
    return durableServerFromRow(row);
  }

  async getStorageScope(roomId: string): Promise<StorageScope | undefined> {
    if (roomId !== this.roomId) return undefined;
    const room = await this.getDurableRoom(roomId);
    if (!room) return undefined;
    const project = room.projectId ? await this.getDurableProject(room.projectId) : undefined;
    const repository = project?.repositoryReferenceId ? await this.getRepositoryReference(project.repositoryReferenceId) : undefined;
    return { schemaVersion: 1, serverId: room.serverId, roomId: room.roomId, projectId: room.projectId,
      repositoryReferenceId: repository?.repositoryReferenceId || null, repositoryReferenceRevision: repository?.revision || null };
  }

  async getDurableRoom(roomId: string): Promise<DurableRoomRecord | undefined> {
    if (roomId !== this.roomId) return undefined;
    const row = this.database.prepare("SELECT id,server_id,project_id,identity_revision,created_at,updated_at FROM rooms WHERE id=?").get(roomId) as Record<string, unknown> | undefined;
    return row?.server_id ? durableRoomFromRow(row) : undefined;
  }

  async getDurableProject(projectId: string): Promise<DurableProjectRecord | undefined> {
    const row = this.database.prepare("SELECT p.* FROM durable_projects p JOIN rooms r ON r.project_id=p.project_id WHERE r.id=? AND p.project_id=?").get(this.roomId, projectId) as Record<string, unknown> | undefined;
    return row ? durableProjectFromRow(row) : undefined;
  }

  async getRepositoryReference(repositoryReferenceId: string): Promise<RepositoryReferenceRecord | undefined> {
    const row = this.database.prepare("SELECT rr.* FROM repository_references rr JOIN durable_projects p ON p.project_id=rr.project_id JOIN rooms r ON r.project_id=p.project_id WHERE r.id=? AND rr.repository_reference_id=?").get(this.roomId, repositoryReferenceId) as Record<string, unknown> | undefined;
    return row ? repositoryReferenceFromRow(row) : undefined;
  }

  async getSourceWorkBinding(kind: SourceWorkKind, workId: string): Promise<SourceWorkBinding | undefined> {
    const row = this.database.prepare("SELECT * FROM source_work_bindings WHERE room_id=? AND work_kind=? AND work_id=?").get(this.roomId, kind, workId) as Record<string, unknown> | undefined;
    return row ? sourceWorkBindingFromRow(row) : undefined;
  }

  async putSourceWorkBinding(binding: SourceWorkBinding): Promise<void> {
    if (binding.schemaVersion !== 1 || !binding.kind || !binding.workId || !binding.roomId || !Number.isSafeInteger(binding.revision) || binding.revision < 1) throw new Error("Invalid source-work binding identity.");
    if (binding.reasonCode && boundedReconciliationReason(binding.reasonCode) !== binding.reasonCode) throw new Error("Source-work binding reason codes must be stable and bounded.");
    if (JSON.stringify(binding.evidence).length > 16_000 || Object.values(binding.evidence).some((value) => value !== null && !["string", "number", "boolean"].includes(typeof value))) throw new Error("Source-work binding evidence must be bounded server-only scalar data.");
    if (binding.roomId !== this.roomId) throw new Error(`Source-work binding belongs to another room.`);
    const room = await this.getDurableRoom(binding.roomId);
    if (!room || room.projectId !== binding.projectId) throw new Error("Source-work room/project identity does not match durable storage.");
    if (binding.repositoryReferenceId) {
      const repository = await this.getRepositoryReference(binding.repositoryReferenceId);
      if (!repository || repository.projectId !== binding.projectId || repository.revision !== binding.repositoryReferenceRevision) throw new Error("Source-work repository reference is missing or stale.");
      if (binding.state === "bound" && repository.state === "unverified-legacy-placeholder") throw new Error("An unverified legacy repository placeholder cannot grant source-work authority.");
    }
    const timestamp = new Date().toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.database.prepare("SELECT revision,created_at FROM source_work_bindings WHERE room_id=? AND work_kind=? AND work_id=?")
        .get(this.roomId, binding.kind, binding.workId) as { revision: number; created_at: string } | undefined;
      if (current && binding.revision !== current.revision + 1) throw new Error(`Source-work binding revision conflict for ${binding.kind}/${binding.workId}.`);
      if (!current && binding.revision !== 1) throw new Error(`A new source-work binding must begin at revision 1.`);
      const values = [binding.roomId, binding.projectId, binding.repositoryReferenceId, binding.repositoryReferenceRevision,
        binding.originTaskId, binding.originTaskRevision, binding.implementationJobId, binding.implementationWorkerId,
        binding.state, binding.reasonCode, JSON.stringify(binding.evidence), binding.revision, current?.created_at || binding.createdAt || timestamp,
        binding.updatedAt || timestamp, binding.kind, binding.workId];
      const written = this.database.prepare(`INSERT INTO source_work_bindings(
        room_id,project_id,repository_reference_id,repository_reference_revision,origin_task_id,origin_task_revision,
        implementation_job_id,implementation_worker_id,reconciliation_state,reason_code,evidence_json,revision,created_at,updated_at,work_kind,work_id
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(room_id,work_kind,work_id) DO UPDATE SET
        project_id=excluded.project_id,repository_reference_id=excluded.repository_reference_id,
        repository_reference_revision=excluded.repository_reference_revision,origin_task_id=excluded.origin_task_id,
        origin_task_revision=excluded.origin_task_revision,implementation_job_id=excluded.implementation_job_id,
        implementation_worker_id=excluded.implementation_worker_id,reconciliation_state=excluded.reconciliation_state,
        reason_code=excluded.reason_code,evidence_json=excluded.evidence_json,revision=excluded.revision,updated_at=excluded.updated_at
      WHERE source_work_bindings.revision=excluded.revision-1`).run(...values);
      if (written.changes !== 1) throw new Error(`Source-work binding revision conflict for ${binding.kind}/${binding.workId}.`);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  async identityMigrationEvidence(): Promise<IdentityMigrationEvidence | undefined> {
    const row = this.database.prepare("SELECT * FROM storage_identity_migrations WHERE migration_version='durable-identities/v1'").get() as Record<string, unknown> | undefined;
    return row ? identityEvidenceFromRow(row) : undefined;
  }

  hasPersistedRoom() {
    return Boolean(this.database.prepare("SELECT 1 FROM rooms WHERE id = ?").get(this.roomId));
  }

  snapshot(): RoomState {
    if (!this.state) throw new Error("The SQLite room has not been initialized.");
    return structuredClone(this.state);
  }

  replaceState(state: RoomState, options: { overwrite?: boolean } = {}) {
    if (this.hasPersistedRoom() && !options.overwrite) {
      throw new Error(`The SQLite database already contains room ${this.roomId}. Pass overwrite=true to replace it.`);
    }
    const now = new Date().toISOString();
    this.database.exec("SAVEPOINT replace_room_state");
    try {
      this.database.prepare(`
        INSERT INTO rooms(
          id, slug, name, topic, writable_agent, conversation_energy, project_path,
          participant_styles_json, status, active_agent, error, roster_revision, roster_schema_version,
          deployment_provenance_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          slug = excluded.slug,
          name = excluded.name,
          topic = excluded.topic,
          writable_agent = excluded.writable_agent,
          conversation_energy = excluded.conversation_energy,
          project_path = excluded.project_path,
          participant_styles_json = excluded.participant_styles_json,
          status = excluded.status,
          active_agent = excluded.active_agent,
          error = excluded.error,
          roster_revision = excluded.roster_revision,
          roster_schema_version = excluded.roster_schema_version,
          deployment_provenance_json = excluded.deployment_provenance_json,
          updated_at = excluded.updated_at
      `).run(
        this.roomId,
        this.roomId === CANONICAL_ROOM_ID ? DEFAULT_ROOM_SLUG : `room-${this.roomId}`,
        state.settings.roomName,
        state.settings.topic,
        state.settings.writableAgent,
        state.settings.conversationEnergy,
        state.settings.projectPath,
        JSON.stringify(state.settings.participantStyles),
        state.status,
        state.activeAgent || null,
        state.error || null,
        normalizeRoomAgentRoster(state.roster).revision,
        3,
        state.deployment ? JSON.stringify(state.deployment) : null,
        now,
        now,
      );
      if (options.overwrite) this.clearGovernedStateForOverwrite();
      this.database.prepare("DELETE FROM messages WHERE room_id = ?").run(this.roomId);
      this.database.prepare("DELETE FROM agent_sessions WHERE room_id = ?").run(this.roomId);
      this.database.prepare("DELETE FROM room_agents WHERE room_id = ?").run(this.roomId);
      for (const message of state.messages) this.insertMessage(message);
      const activeSessions: RoomState["sessions"] = {};
      for (const [agent, session] of Object.entries(state.sessions) as Array<[AgentId, AgentSession]>) {
        if (session.permission === "writable") {
          this.upsertInvalidatedSession(agent, session.id, session.configurationFingerprint, session.configurationRevision, session.codeEpoch, now);
          continue;
        }
        this.upsertSession(agent, session.id, session.permission, session.configurationFingerprint, session.configurationRevision, session.codeEpoch);
        activeSessions[agent] = structuredClone(session);
      }
      normalizeRoomAgentRoster(state.roster).entries.forEach((entry, position) => {
        this.upsertRosterAgent(entry);
        this.database.prepare(`
        INSERT INTO room_agents(room_id, agent_id, enabled, position, configuration_json, last_seen_message_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(this.roomId, entry.agentId, entry.enabled ? 1 : 0, position, JSON.stringify(entry), entry.lastSeenMessageId || null, now, now);
      });
      this.database.prepare("DELETE FROM room_settings WHERE room_id = ?").run(this.roomId);
      if (state.roomConfiguration) this.persistRoomConfiguration(normalizeRoomConfiguration(state.roomConfiguration));
      this.database.exec("RELEASE replace_room_state");
      this.state = { ...structuredClone(state), sessions: activeSessions };
    } catch (error) {
      this.database.exec("ROLLBACK TO replace_room_state; RELEASE replace_room_state;");
      throw error;
    }
  }

  async importRoomData(input: {
    state: RoomState;
    assignments: readonly AssignmentRecord[];
    tasks: readonly Task[];
    taskEvents: readonly TaskEvent[];
    continuationPolicy: ContinuationPolicy | undefined;
    continuations: readonly ContinuationRecord[];
    continuationInbox: readonly ContinuationInboxEntry[];
    continuationAudit: readonly ContinuationAuditEvent[];
    overwrite?: boolean;
  }) {
    const compatibleState = { ...structuredClone(input.state), sessions: Object.fromEntries(Object.entries(input.state.sessions).filter(([, session]) => session?.permission === "read-only")) } as RoomState;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (!this.hasPersistedRoom() || input.overwrite) this.replaceState(input.state, { overwrite: input.overwrite });
      else if (!samePersistedRoomState(this.snapshot(), compatibleState)) throw new Error("The SQLite database already contains a different default room. Pass overwrite=true to replace it.");
      for (const assignment of input.assignments) await this.putAssignment(assignment);
      this.importTasks(input.tasks, input.taskEvents);
      this.importContinuations(input.continuationPolicy, input.continuations, input.continuationInbox, input.continuationAudit);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      this.state = this.hasPersistedRoom() ? this.loadState() : undefined;
      throw error;
    }
  }

  async addMessage(
    speaker: RoomMessage["speaker"],
    text: string,
    kind: RoomMessage["kind"] = "chat",
    style?: ChatStyle,
    burst?: { burstId: string; sequence: number },
    human?: { id: string; name: string; clientMessageId?: string; mentions?: RoomMessage["mentions"]; continuationRequest?: RoomContinuationWorkRequest },
  ) {
    const state = this.snapshot();
    const message = messageFor(state, speaker, text, kind, style, burst, human);
    this.insertMessage(message);
    state.messages.push(message);
    this.state = state;
    return message;
  }

  async addCommandAuditMessageOnce(auditId: string, text: string) {
    const id=`command-audit:${auditId}`; const existing=this.state?.messages.find((message)=>message.id===id); if(existing)return structuredClone(existing);
    const state=this.snapshot(); const message={...messageFor(state,"system",text,"status"),id}; this.insertMessage(message); state.messages.push(message); this.state=state; return structuredClone(message);
  }

  async addCommandDeliveryMessageOnce(attemptId: string, sequence: number, speaker: RoomMessage["speaker"], text: string, style?: ChatStyle, burst?: { burstId: string; sequence: number }) {
    const id=`command-delivery:${attemptId}:${sequence}`; const existing=this.state?.messages.find((message)=>message.id===id); if(existing)return structuredClone(existing);
    const state=this.snapshot(); const message={...messageFor(state,speaker,text,"chat",style,burst),id}; this.insertMessage(message); state.messages.push(message); this.state=state; return structuredClone(message);
  }

  async addPrivateCommandResponseOnce(submissionId: string, humanId: string, text: string) {
    const id=`command-private:${submissionId}`; const existing=this.state?.messages.find((message)=>message.id===id); if(existing)return structuredClone(existing);
    const state=this.snapshot(); const message:RoomMessage={...messageFor(state,"system",text,"status"),id,recipientHumanId:humanId}; this.insertMessage(message); state.messages.push(message); this.state=state; return structuredClone(message);
  }

  async updateSettings(update: Partial<RoomSettings>) {
    const state = this.snapshot();
    state.settings = { ...state.settings, ...update };
    this.persistSettings(state.settings);
    this.invalidateAgentContextSummaries();
    this.state = state;
  }

  async getRoomConfiguration() {
    return normalizeRoomConfiguration(this.snapshot().roomConfiguration);
  }

  async updateRoomConfiguration(update: RoomConfigurationUpdate, actorId: string) {
    const current = await this.getRoomConfiguration();
    const baseChanged = Object.prototype.hasOwnProperty.call(update, "basePromptText");
    const summarizerChanged = Object.prototype.hasOwnProperty.call(update, "summarizerModel") || Object.prototype.hasOwnProperty.call(update, "summarizerPromptText");
    const flagsChanged = Object.prototype.hasOwnProperty.call(update, "featureFlags");
    const routingChanged = Object.prototype.hasOwnProperty.call(update, "preflightMode");
    const now = new Date().toISOString();
    const next = normalizeRoomConfiguration({
      ...current,
      ...update,
      basePromptText: update.basePromptText === "" ? undefined : update.basePromptText ?? (baseChanged ? null : current.basePromptText),
      basePromptRevision: current.basePromptRevision + (baseChanged ? 1 : 0),
      summarizerPromptRevision: current.summarizerPromptRevision + (summarizerChanged ? 1 : 0),
      configurationRevision: current.configurationRevision + 1,
      updatedAt: now,
    });
    const changeKind = [baseChanged, summarizerChanged, flagsChanged || routingChanged].filter(Boolean).length > 1 ? "mixed" : baseChanged ? "base_prompt" : summarizerChanged ? "summarizer" : "feature_flags";
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.persistRoomConfiguration(next);
      this.database.prepare(`INSERT INTO room_settings_history(event_id, room_id, actor_id, change_kind, base_prompt_revision, summarizer_prompt_revision, snapshot_json, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(randomUUID(), this.roomId, actorId, changeKind, next.basePromptRevision, next.summarizerPromptRevision, JSON.stringify(next), now);
      this.invalidateAgentContextSummaries();
      this.database.exec("COMMIT");
      const state = this.snapshot();
      state.roomConfiguration = next;
      this.state = state;
      return structuredClone(next);
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  async updateRoster(expectedRevision: number, entries: readonly RoomAgentRosterEntry[]) {
    const validated = validateRosterEntries(entries);
    if (!validated) throw new Error("Invalid room roster entries.");
    const state = this.snapshot();
    const current = normalizeRoomAgentRoster(state.roster);
    if (current.revision !== expectedRevision) return { kind: "conflict" as const, expectedRevision, actualRevision: current.revision };
    const roster = { schemaVersion: 3 as const, revision: current.revision + 1, entries: structuredClone(validated.map((entry) => { const previous = current.entries.find((candidate) => candidate.agentId === entry.agentId); const changed = previous && participantConfigurationFingerprint(previous) !== participantConfigurationFingerprint(entry); if (!changed) return { ...entry, configurationRevision: previous?.configurationRevision || entry.configurationRevision || 1, lastSeenMessageId: previous?.lastSeenMessageId ?? null }; const { selectionConfirmationRequired: _confirmation, ...confirmedEntry } = entry; return { ...confirmedEntry, configurationRevision: (previous.configurationRevision || 1) + 1, sessionInvalidationReason: "Model configuration changed; the previous OpenCode session was invalidated.", lastSeenMessageId: previous.lastSeenMessageId ?? null }; })) };
    for (const entry of roster.entries) state.settings.participantStyles[entry.agentId] ||= structuredClone(DEFAULT_PARTICIPANT_STYLES["codex-sol"]);
    const enabled = new Set(enabledRoomAgentIds(roster));
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const now = new Date().toISOString();
      const updated = this.database.prepare("UPDATE rooms SET roster_revision = ?, roster_schema_version = 3, updated_at = ? WHERE id = ? AND roster_revision = ?")
        .run(roster.revision, now, this.roomId, expectedRevision);
      if (updated.changes !== 1) {
        const latest = this.database.prepare("SELECT roster_revision FROM rooms WHERE id = ?").get(this.roomId) as { roster_revision: number };
        this.database.exec("ROLLBACK");
        return { kind: "conflict" as const, expectedRevision, actualRevision: latest.roster_revision };
      }
      this.database.prepare("DELETE FROM room_agents WHERE room_id = ?").run(this.roomId);
      const insert = this.database.prepare("INSERT INTO room_agents(room_id, agent_id, enabled, position, configuration_json, last_seen_message_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
      roster.entries.forEach((entry, position) => { this.upsertRosterAgent(entry); insert.run(this.roomId, entry.agentId, entry.enabled ? 1 : 0, position, JSON.stringify(entry), entry.lastSeenMessageId || null, now, now); });
      for (const agent of Object.keys(state.sessions) as AgentId[]) {
        const previous = current.entries.find((entry) => entry.agentId === agent); const updatedEntry = roster.entries.find((entry) => entry.agentId === agent);
        if (enabled.has(agent as never) && previous && updatedEntry && participantConfigurationFingerprint(previous) === participantConfigurationFingerprint(updatedEntry)) continue;
        this.database.prepare("DELETE FROM agent_sessions WHERE room_id = ? AND agent_id = ?").run(this.roomId, agent);
        delete state.sessions[agent];
      }
      if (state.settings.writableAgent !== "nobody" && !enabled.has(state.settings.writableAgent)) {
        state.settings.writableAgent = "nobody";
      }
      this.persistSettings(state.settings);
      this.invalidateAgentContextSummaries();
      this.database.exec("COMMIT");
      state.roster = roster;
      this.state = state;
      return { kind: "accepted" as const, roster: structuredClone(roster) };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  async changeTopic(topic: string) {
    const state = this.snapshot();
    if (topic === state.settings.topic) return;
    const message = messageFor(state, "system", `Room topic: ${topic}`, "topic");
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare("UPDATE rooms SET topic = ?, updated_at = ? WHERE id = ?")
        .run(topic, new Date().toISOString(), this.roomId);
      this.database.prepare("DELETE FROM agent_sessions WHERE room_id = ?").run(this.roomId);
      this.database.prepare("UPDATE room_agents SET last_seen_message_id = NULL, updated_at = ? WHERE room_id = ?").run(new Date().toISOString(), this.roomId);
      this.invalidateAgentContextSummaries();
      this.insertMessage(message);
      this.database.exec("COMMIT");
      state.settings.topic = topic;
      state.sessions = {};
      state.roster = { ...normalizeRoomAgentRoster(state.roster), entries: normalizeRoomAgentRoster(state.roster).entries.map((entry) => ({ ...entry, lastSeenMessageId: null })) };
      state.messages.push(message);
      this.state = state;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  async updateParticipantStyle(participant: StyledParticipant, style: ChatStyle) {
    const state = this.snapshot();
    state.settings.participantStyles[participant] = sanitizeChatStyle(style, state.settings.participantStyles[participant]);
    this.persistSettings(state.settings);
    this.invalidateAgentContextSummaries();
    this.state = state;
  }

  async setDeployment(provenance: DeploymentProvenance) {
    this.database.prepare("UPDATE rooms SET deployment_provenance_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(provenance), new Date().toISOString(), this.roomId);
    const state = this.snapshot();
    state.deployment = structuredClone(provenance);
    this.state = state;
  }

  async setSession(agent: AgentId, id: string, permission: "read-only" | "writable", codeEpoch?: string) {
    const state = this.snapshot();
    const entry = roomAgentEntry(state.roster, agent);
    const normalizedEpoch = normalizeDeploymentEpoch(codeEpoch);
    const session = { id, permission, ...(entry ? { configurationFingerprint: participantConfigurationFingerprint(entry), configurationRevision: entry.configurationRevision || 1 } : {}), ...(normalizedEpoch ? { codeEpoch: normalizedEpoch } : {}) };
    this.upsertSession(agent, id, permission, session.configurationFingerprint, session.configurationRevision, session.codeEpoch);
    state.sessions[agent] = session;
    this.state = state;
  }

  async clearSession(agent: AgentId) {
    this.database.prepare("DELETE FROM agent_sessions WHERE room_id = ? AND agent_id = ?").run(this.roomId, agent);
    const state = this.snapshot();
    delete state.sessions[agent];
    this.state = state;
  }

  async setLastSeenMessageId(agent: AgentId, messageId: string | null) {
    if (messageId !== null && !this.database.prepare("SELECT 1 FROM messages WHERE room_id = ? AND id = ?").get(this.roomId, messageId)) {
      throw new Error("Cannot advance an agent cursor to an unknown room message.");
    }
    const result = this.database.prepare("UPDATE room_agents SET last_seen_message_id = ?, updated_at = ? WHERE room_id = ? AND agent_id = ?")
      .run(messageId, new Date().toISOString(), this.roomId, agent);
    if (result.changes !== 1) throw new Error("Cannot advance the cursor for an agent outside the room roster.");
    const state = this.snapshot();
    const roster = normalizeRoomAgentRoster(state.roster);
    state.roster = { ...roster, entries: roster.entries.map((entry) => entry.agentId === agent ? { ...entry, lastSeenMessageId: messageId } : entry) };
    this.state = state;
  }

  async getAgentContextSummary(key: AgentContextSummaryKey) {
    const row = this.database.prepare("SELECT summary FROM agent_context_summaries WHERE room_id = ? AND agent_id = ? AND span_start_message_id = ? AND span_end_message_id = ? AND config_revision = ?")
      .get(this.roomId, key.agentId, key.spanStartId, key.spanEndId, key.configRevision) as unknown as { summary: string } | undefined;
    return row?.summary;
  }

  async putAgentContextSummary(key: AgentContextSummaryKey, summary: string) {
    if (key.configRevision !== (await this.getRoomConfiguration()).configurationRevision) return;
    this.database.prepare(`
      INSERT INTO agent_context_summaries(room_id, agent_id, span_start_message_id, span_end_message_id, config_revision, summary, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(room_id, agent_id, span_start_message_id, span_end_message_id, config_revision)
      DO UPDATE SET summary = excluded.summary, created_at = excluded.created_at
    `).run(this.roomId, key.agentId, key.spanStartId, key.spanEndId, key.configRevision, summary, new Date().toISOString());
  }

  async setStatus(status: RoomState["status"], activeAgent?: AgentId, error?: string) {
    this.setStatusSync(status, activeAgent, error);
  }

  async createImprovement(improvement: Improvement): Promise<CreateImprovementResult> {
    if (improvement.revision !== 1 || improvement.attribution.at(-1)?.revision !== 1) {
      throw new Error("A newly persisted improvement must be at revision 1.");
    }
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (this.database.prepare("SELECT 1 FROM canonical_improvements WHERE room_id = ? AND id = ?")
        .get(this.roomId, improvement.id)) {
        this.database.exec("ROLLBACK");
        return { kind: "conflict", id: improvement.id };
      }
      const snapshot = structuredClone(improvement);
      this.database.prepare(`
        INSERT INTO canonical_improvements(
          room_id, id, revision, state, risk, author_id, created_at, updated_at,
          projection_json, status_contract_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        this.roomId,
        snapshot.id,
        snapshot.revision,
        snapshot.state,
        snapshot.risk,
        snapshot.authorId,
        snapshot.createdAt,
        snapshot.updatedAt,
        JSON.stringify(snapshot),
        JSON.stringify(snapshot.statusContract),
      );
      this.insertImprovementEvent({
        improvementId: snapshot.id,
        revision: 1,
        actorId: snapshot.authorId,
        at: snapshot.createdAt,
        change: "CREATE",
        snapshot,
      });
      this.insertImprovementLedgerRevision(snapshot, snapshot.authorId, "CREATED", "revision-1");
      this.database.exec("COMMIT");
      return { kind: "created", improvement: structuredClone(snapshot) };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  async getImprovement(id: string) {
    const row = this.database.prepare(`
      SELECT projection_json FROM canonical_improvements WHERE room_id = ? AND id = ?
    `).get(this.roomId, id) as unknown as ImprovementRow | undefined;
    return row ? normalizeStoredImprovement(parseJson<Improvement>(row.projection_json, undefined as never)) : undefined;
  }

  async listImprovements(query: ImprovementListQuery = {}) {
    const rows = this.database.prepare(`
      SELECT projection_json FROM canonical_improvements WHERE room_id = ?
    `).all(this.roomId) as unknown as ImprovementRow[];
    return paginateImprovements(rows.map((row) => normalizeStoredImprovement(parseJson<Improvement>(row.projection_json, undefined as never))), query);
  }

  async applyImprovementChange(
    id: string,
    expectedRevision: number,
    change: ImprovementChange,
    actor: DomainActor,
    now: string,
  ) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.database.prepare(`
        SELECT projection_json FROM canonical_improvements WHERE room_id = ? AND id = ?
      `).get(this.roomId, id) as unknown as ImprovementRow | undefined;
      if (!row) {
        this.database.exec("ROLLBACK");
        return { kind: "rejected" as const, reason: `Improvement ${id} does not exist` };
      }
      const current = normalizeStoredImprovement(parseJson<Improvement>(row.projection_json, undefined as never));
      const result = applyDomainImprovementChange(current, expectedRevision, change, actor, now);
      if (result.kind !== "accepted") {
        this.database.exec("ROLLBACK");
        return result;
      }
      if (result.improvement.revision === current.revision) {
        this.database.exec("ROLLBACK");
        return { kind: "accepted" as const, improvement: structuredClone(current) };
      }
      const snapshot = result.improvement;
      const updated = this.database.prepare(`
        UPDATE canonical_improvements SET
          revision = ?, state = ?, risk = ?, author_id = ?, updated_at = ?, projection_json = ?,
          status_contract_json = ?
        WHERE room_id = ? AND id = ? AND revision = ?
      `).run(
        snapshot.revision,
        snapshot.state,
        snapshot.risk,
        snapshot.authorId,
        snapshot.updatedAt,
        JSON.stringify(snapshot),
        JSON.stringify(snapshot.statusContract),
        this.roomId,
        id,
        expectedRevision,
      );
      if (updated.changes !== 1) {
        const actual = this.database.prepare(`
          SELECT revision FROM canonical_improvements WHERE room_id = ? AND id = ?
        `).get(this.roomId, id) as { revision: number };
        this.database.exec("ROLLBACK");
        return { kind: "conflict" as const, expectedRevision, actualRevision: actual.revision };
      }
      this.insertImprovementEvent({ improvementId: id, revision: snapshot.revision, actorId: actor.id, at: now, change, snapshot });
      this.insertImprovementLedgerRevision(snapshot, actor.id, "REVISED", `revision-${snapshot.revision}`, change);
      if (change.kind === "ADD_EVIDENCE") {
        this.database.prepare(`
          INSERT INTO canonical_improvement_evidence(
            room_id, improvement_id, evidence_id, introduced_revision, qualification,
            evidence_kind, uri, summary, recorded_at
          ) VALUES (?, ?, ?, ?, 'UNQUALIFIED', 'REFERENCE', ?, ?, ?)
        `).run(this.roomId, id, change.evidence.id, snapshot.revision, change.evidence.uri, change.evidence.description, now);
      }
      this.database.exec("COMMIT");
      return { kind: "accepted" as const, improvement: structuredClone(snapshot) };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  async listImprovementEvents(id: string, options: { readonly afterRevision?: number; readonly limit?: number } = {}) {
    const limit = Math.max(1, Math.min(100, Math.trunc(options.limit ?? 50)));
    const rows = this.database.prepare(`
      SELECT improvement_id, revision, actor_id, occurred_at, change_json, snapshot_json
      FROM canonical_improvement_events
      WHERE room_id = ? AND improvement_id = ? AND revision > ?
      ORDER BY revision
      LIMIT ?
    `).all(this.roomId, id, options.afterRevision ?? 0, limit) as unknown as ImprovementEventRow[];
    return rows.map((row): ImprovementEvent => ({
      improvementId: row.improvement_id,
      revision: row.revision,
      actorId: row.actor_id,
      at: row.occurred_at,
      change: parseJson(row.change_json, "CREATE"),
      snapshot: normalizeStoredImprovement(parseJson<Improvement>(row.snapshot_json, undefined as never)),
    }));
  }

  async getImprovementLedgerRecords(id: string): Promise<ImprovementLedgerRecords | undefined> {
    if (!this.database.prepare("SELECT 1 FROM canonical_improvements WHERE room_id = ? AND id = ?").get(this.roomId, id)) {
      return undefined;
    }
    const revisions = this.database.prepare(`
      SELECT revision, lifecycle_state, status_contract_json, created_at
      FROM canonical_improvement_revisions
      WHERE room_id = ? AND improvement_id = ? ORDER BY revision
    `).all(this.roomId, id) as unknown as LedgerRevisionRow[];
    const evidence = this.database.prepare(`
      SELECT evidence_id, introduced_revision, qualification, evidence_kind, uri, summary, recorded_at
      FROM canonical_improvement_evidence
      WHERE room_id = ? AND improvement_id = ? ORDER BY introduced_revision, evidence_id
    `).all(this.roomId, id) as unknown as LedgerEvidenceRow[];
    const milestones = this.database.prepare(`
      SELECT milestone_id, introduced_revision, state, summary, recorded_at
      FROM canonical_improvement_milestone_records
      WHERE room_id = ? AND improvement_id = ? ORDER BY introduced_revision, milestone_id
    `).all(this.roomId, id) as unknown as LedgerMilestoneRow[];
    const audit = this.database.prepare(`
      SELECT event_id, revision, event_kind, actor_id, occurred_at, details_json
      FROM canonical_improvement_audit_history
      WHERE room_id = ? AND improvement_id = ? ORDER BY revision, event_id
    `).all(this.roomId, id) as unknown as LedgerAuditRow[];
    return {
      revisions: revisions.map((row) => ({
        revision: row.revision,
        state: row.lifecycle_state,
        status: parseJson<ImprovementStatusContract>(row.status_contract_json, undefined as never),
        createdAt: row.created_at,
      })),
      evidence: evidence.map((row) => ({
        id: row.evidence_id,
        introducedRevision: row.introduced_revision,
        sourceClass: row.qualification,
        kind: row.evidence_kind,
        uri: row.uri,
        summary: row.summary,
        recordedAt: row.recorded_at,
      })),
      milestones: milestones.map((row) => ({
        improvementId: id,
        id: row.milestone_id,
        introducedRevision: row.introduced_revision,
        state: row.state,
        summary: row.summary,
        recordedAt: row.recorded_at,
      })),
      audit: audit.map((row) => ({
        eventId: row.event_id,
        revision: row.revision,
        eventKind: row.event_kind,
        actorId: row.actor_id,
        occurredAt: row.occurred_at,
        details: parseJson<unknown>(row.details_json, null),
      })),
    };
  }

  async addImprovementMilestone(
    id: string,
    expectedRevision: number,
    milestone: { readonly id: string; readonly state: ImprovementMilestoneState; readonly summary: string },
    actor: DomainActor,
    now: string,
  ): Promise<AddImprovementMilestoneResult> {
    const normalized = normalizeMilestoneInput(milestone);
    if (!normalized || !actor.id.trim()) return { kind: "rejected", reason: "A milestone ID, state, summary, and actor are required" };
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.database.prepare(`
        SELECT projection_json FROM canonical_improvements WHERE room_id = ? AND id = ?
      `).get(this.roomId, id) as unknown as ImprovementRow | undefined;
      if (!row) {
        this.database.exec("ROLLBACK");
        return { kind: "missing_item", canonicalId: id };
      }
      const current = normalizeStoredImprovement(parseJson<Improvement>(row.projection_json, undefined as never));
      const prior = this.database.prepare(`
        SELECT milestone_id, introduced_revision, state, summary, recorded_at
        FROM canonical_improvement_milestone_records
        WHERE room_id = ? AND improvement_id = ? AND milestone_id = ?
        ORDER BY introduced_revision DESC LIMIT 1
      `).get(this.roomId, id, normalized.id) as unknown as LedgerMilestoneRow | undefined;
      if (prior && prior.state === normalized.state && prior.summary === normalized.summary) {
        this.database.exec("ROLLBACK");
        return {
          kind: "accepted",
          created: false,
          revision: current.revision,
          milestone: milestoneFromRow(id, prior),
        };
      }
      if (current.revision !== expectedRevision) {
        this.database.exec("ROLLBACK");
        return { kind: "conflict", expectedRevision, actualRevision: current.revision };
      }
      const revision = current.revision + 1;
      const snapshot: Improvement = {
        ...current,
        revision,
        updatedAt: now,
        attribution: [...current.attribution, { actorId: actor.id, at: now, change: `RECORD_MILESTONE:${normalized.id}`, revision }],
      };
      const change = { kind: "RECORD_MILESTONE" as const, milestoneId: normalized.id, state: normalized.state, summary: normalized.summary };
      const updated = this.database.prepare(`
        UPDATE canonical_improvements SET revision = ?, updated_at = ?, projection_json = ?
        WHERE room_id = ? AND id = ? AND revision = ?
      `).run(revision, now, JSON.stringify(snapshot), this.roomId, id, expectedRevision);
      if (updated.changes !== 1) {
        const actual = this.database.prepare("SELECT revision FROM canonical_improvements WHERE room_id = ? AND id = ?")
          .get(this.roomId, id) as { revision: number };
        this.database.exec("ROLLBACK");
        return { kind: "conflict", expectedRevision, actualRevision: actual.revision };
      }
      this.insertImprovementEvent({ improvementId: id, revision, actorId: actor.id, at: now, change, snapshot });
      this.insertImprovementLedgerRevision(snapshot, actor.id, "REVISED", `revision-${revision}`, change);
      this.database.prepare(`
        INSERT INTO canonical_improvement_milestone_records(
          room_id, improvement_id, milestone_id, introduced_revision, state, summary, recorded_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(this.roomId, id, normalized.id, revision, normalized.state, normalized.summary, now);
      this.database.exec("COMMIT");
      return {
        kind: "accepted",
        created: true,
        revision,
        milestone: { improvementId: id, ...normalized, introducedRevision: revision, recordedAt: now },
      };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  async getEmergencyStop(): Promise<EmergencyStopProjection> {
    return this.getEmergencyStopSync();
  }

  private getEmergencyStopSync(): EmergencyStopProjection {
    const row = this.database.prepare("SELECT projection_json FROM emergency_stops WHERE room_id = ?")
      .get(this.roomId) as { projection_json: string } | undefined;
    return row ? parseJson(row.projection_json, { ...CLEAR_EMERGENCY_STOP }) : { ...CLEAR_EMERGENCY_STOP };
  }

  async updateEmergencyStop(
    expectedRevision: number,
    update: { readonly active: boolean; readonly reason?: string },
    actor: DomainActor,
    now: string,
  ): Promise<EmergencyStopChangeResult> {
    if (!actor.id.trim()) throw new Error("Actor ID must not be empty");
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.getEmergencyStopSync();
      if (current.revision !== expectedRevision) {
        this.database.exec("ROLLBACK");
        return { kind: "conflict", expectedRevision, actualRevision: current.revision };
      }
      const next = emergencyStopProjection(current, update, actor.id, now);
      this.database.prepare(`
        INSERT INTO emergency_stops(room_id, revision, projection_json, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(room_id) DO UPDATE SET
          revision = excluded.revision,
          projection_json = excluded.projection_json,
          updated_at = excluded.updated_at
        WHERE emergency_stops.revision = ?
      `).run(this.roomId, next.revision, JSON.stringify(next), now, expectedRevision);
      this.database.prepare(`
        INSERT INTO emergency_stop_events(room_id, revision, actor_id, occurred_at, snapshot_json)
        VALUES (?, ?, ?, ?, ?)
      `).run(this.roomId, next.revision, actor.id, now, JSON.stringify(next));
      this.database.exec("COMMIT");
      return { kind: "accepted", emergencyStop: structuredClone(next) };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  async listAssignments() {
    const rows = this.database.prepare("SELECT * FROM assignment_records WHERE room_id = ? ORDER BY created_at, assignment_id").all(this.roomId) as unknown as Array<Record<string, unknown>>;
    return rows.map(assignmentFromRow).filter((record): record is AssignmentRecord => Boolean(record));
  }

  async getAssignment(assignmentId: string) {
    const row = this.database.prepare("SELECT * FROM assignment_records WHERE room_id = ? AND assignment_id = ?").get(this.roomId, assignmentId) as unknown as Record<string, unknown> | undefined;
    return row ? assignmentFromRow(row) : undefined;
  }

  async putAssignment(assignment: AssignmentRecord) {
    const value = normalizeAssignmentRecord(assignment);
    if (!value) throw new Error("Invalid assignment record");
    this.database.prepare(`
      INSERT INTO assignment_records(
        room_id, assignment_id, improvement_id, developer_member_id, developer_member_config_revision,
        agent_id, fencing_token, manifest_revision, pinned_base_sha, branch_name, observed_head_sha,
        workspace_path, lifecycle_status, lifecycle_revision, cancelled_at, disposed_at, last_operation_key,
        recovery_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(room_id, assignment_id) DO UPDATE SET
        observed_head_sha = excluded.observed_head_sha,
        lifecycle_status = excluded.lifecycle_status,
        lifecycle_revision = excluded.lifecycle_revision,
        cancelled_at = excluded.cancelled_at,
        disposed_at = excluded.disposed_at,
        last_operation_key = excluded.last_operation_key,
        recovery_json = excluded.recovery_json,
        updated_at = excluded.updated_at
    `).run(this.roomId, value.assignmentId, value.improvementId, value.developerMemberId,
      value.developerMemberConfigRevision, value.agent, value.fencingToken, value.manifestRevision,
      value.pinnedBaseSha, value.branch, value.observedHeadSha, value.workspacePath,
      value.lifecycleStatus, value.lifecycleRevision ?? 1, value.cancelledAt ?? null, value.disposedAt ?? null,
      value.lastOperationKey ?? null, JSON.stringify(value.recovery), value.createdAt, value.updatedAt);
  }

  async getContinuationPolicy() {
    const row = this.database.prepare("SELECT projection_json FROM continuation_policies WHERE room_id = ?").get(this.roomId) as { projection_json: string } | undefined;
    return row ? normalizeContinuationPolicy(parseJson(row.projection_json, undefined)) : undefined;
  }
  async compareAndSetContinuationPolicy(expectedRevision: number, policy: ContinuationPolicy): Promise<CasResult<ContinuationPolicy>> {
    this.assertContinuationDurableState();
    const value = normalizeContinuationPolicy(policy); if (!value || value.roomId !== this.roomId || value.revision !== expectedRevision + 1) throw new Error("Invalid continuation policy");
    const current = await this.getContinuationPolicy(); if (current && (current.roomId !== value.roomId || current.projectPathHash !== value.projectPathHash || current.policyVersion !== value.policyVersion)) throw new Error("Continuation policy provenance is immutable");
    if (expectedRevision === 0) {
      const result = this.database.prepare("INSERT OR IGNORE INTO continuation_policies(room_id, revision, projection_json, updated_at) VALUES (?, ?, ?, ?)").run(this.roomId, value.revision, JSON.stringify(value), value.updatedAt);
      return result.changes ? { kind: "accepted", value: structuredClone(value) } : { kind: "conflict", actualRevision: (await this.getContinuationPolicy())?.revision };
    }
    const result = this.database.prepare("UPDATE continuation_policies SET revision = ?, projection_json = ?, updated_at = ? WHERE room_id = ? AND revision = ?").run(value.revision, JSON.stringify(value), value.updatedAt, this.roomId, expectedRevision);
    return result.changes ? { kind: "accepted", value: structuredClone(value) } : { kind: "conflict", actualRevision: (await this.getContinuationPolicy())?.revision };
  }
  async listContinuations(owner?: AgentId) {
    const rows = (owner
      ? this.database.prepare("SELECT projection_json FROM continuation_jobs WHERE room_id = ? AND owner_agent_id = ? ORDER BY updated_at DESC, job_id").all(this.roomId, owner)
      : this.database.prepare("SELECT projection_json FROM continuation_jobs WHERE room_id = ? ORDER BY updated_at DESC, job_id").all(this.roomId)) as unknown as Array<{ projection_json: string }>;
    return rows.map((row) => normalizeContinuationRecord(parseJson(row.projection_json, undefined))).filter((value): value is ContinuationRecord => Boolean(value));
  }
  async getContinuation(jobId: string) { const row = this.database.prepare("SELECT projection_json FROM continuation_jobs WHERE room_id = ? AND job_id = ?").get(this.roomId, jobId) as { projection_json: string } | undefined; return row ? normalizeContinuationRecord(parseJson(row.projection_json, undefined)) : undefined; }
  async createContinuation(record: ContinuationRecord, event: ContinuationAuditEvent): Promise<CasResult<ContinuationRecord>> {
    this.assertContinuationDurableState();
    const value = normalizeContinuationRecord(record); const audit = normalizeContinuationAuditEvent(event); if (!value || !continuationRecordIsCanonical(value, this.roomId) || value.jobRevision !== 1 || value.status !== "QUEUED" || !continuationAuditMatches(null, value, audit)) throw new Error("Invalid initial continuation");
    this.database.exec("BEGIN IMMEDIATE"); try { this.database.prepare("INSERT INTO continuation_jobs(room_id, job_id, owner_agent_id, job_revision, status, projection_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(this.roomId, value.jobId, value.owner, value.jobRevision, value.status, JSON.stringify(value), value.createdAt, value.updatedAt); this.insertContinuationAudit(audit!); this.database.exec("COMMIT"); return { kind: "accepted", value: structuredClone(value) }; }
    catch (error) { this.database.exec("ROLLBACK"); if (String(error).includes("UNIQUE constraint failed")) return { kind: "conflict" }; throw error; }
  }
  async compareAndSetContinuation(expectedRevision: number, record: ContinuationRecord, event: ContinuationAuditEvent): Promise<CasResult<ContinuationRecord>> {
    this.assertContinuationDurableState();
    const value = normalizeContinuationRecord(record); const audit = normalizeContinuationAuditEvent(event); if (!value || value.jobRevision !== expectedRevision + 1) throw new Error("Invalid continuation CAS revision");
    const before = await this.getContinuation(value.jobId); if (!before) return { kind: "not_found" }; if (before.jobRevision !== expectedRevision || !canTransitionContinuation(before.status, value.status)) return { kind: "conflict", actualRevision: before.jobRevision };
    if (!continuationRecordIsCanonical(value, this.roomId) || !continuationRecordProvenanceMatches(before, value)) throw new Error("Continuation provenance is immutable");
    if (!continuationAuditMatches(before, value, audit)) throw new Error("Invalid continuation audit event");
    this.database.exec("BEGIN IMMEDIATE"); try { const result = this.database.prepare("UPDATE continuation_jobs SET job_revision = ?, status = ?, projection_json = ?, updated_at = ? WHERE room_id = ? AND job_id = ? AND job_revision = ?").run(value.jobRevision, value.status, JSON.stringify(value), value.updatedAt, this.roomId, value.jobId, expectedRevision); if (!result.changes) { this.database.exec("ROLLBACK"); const existing = await this.getContinuation(value.jobId); return existing ? { kind: "conflict", actualRevision: existing.jobRevision } : { kind: "not_found" }; } this.insertContinuationAudit(audit!); this.database.exec("COMMIT"); return { kind: "accepted", value: structuredClone(value) }; }
    catch (error) { this.database.exec("ROLLBACK"); if (String(error).includes("UNIQUE constraint failed")) return { kind: "conflict" }; throw error; }
  }
  async completeContinuation(expectedRevision: number, record: ContinuationRecord, entry: ContinuationInboxEntry, maxEntries: number, event: ContinuationAuditEvent): Promise<CasResult<ContinuationRecord>> {
    this.assertContinuationDurableState();
    const job = normalizeContinuationRecord(record); const inbox = normalizeContinuationInboxEntry(entry); const audit = normalizeContinuationAuditEvent(event); if (!job || !inbox || !continuationRecordIsCanonical(job, this.roomId) || inbox.roomId !== this.roomId || !continuationInboxStartsJobResult(inbox, job) || job.jobRevision !== expectedRevision + 1) throw new Error("Invalid atomic completion");
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const beforeRow = this.database.prepare("SELECT projection_json FROM continuation_jobs WHERE room_id = ? AND job_id = ?").get(this.roomId, job.jobId) as { projection_json: string } | undefined;
      const before = beforeRow ? normalizeContinuationRecord(parseJson(beforeRow.projection_json, undefined)) : undefined;
      if (!before || before.jobRevision !== expectedRevision || !canTransitionContinuation(before.status, job.status)) { this.database.exec("ROLLBACK"); return before ? { kind: "conflict", actualRevision: before.jobRevision } : { kind: "not_found" }; }
      if (!continuationRecordProvenanceMatches(before, job)) throw new Error("Continuation provenance is immutable");
      if (!continuationAuditMatches(before, job, audit)) throw new Error("Invalid completion audit event");
      const changed = this.database.prepare("UPDATE continuation_jobs SET job_revision = ?, status = ?, projection_json = ?, updated_at = ? WHERE room_id = ? AND job_id = ? AND job_revision = ?").run(job.jobRevision, job.status, JSON.stringify(job), job.updatedAt, this.roomId, job.jobId, expectedRevision);
      if (!changed.changes) { const row = this.database.prepare("SELECT job_revision FROM continuation_jobs WHERE room_id = ? AND job_id = ?").get(this.roomId, job.jobId) as { job_revision: number } | undefined; this.database.exec("ROLLBACK"); return row ? { kind: "conflict", actualRevision: row.job_revision } : { kind: "not_found" }; }
      this.database.prepare("INSERT INTO continuation_inbox(room_id, inbox_entry_id, job_id, owner_agent_id, inbox_revision, status, projection_json, created_at, updated_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(this.roomId, inbox.inboxEntryId, inbox.jobId, inbox.owner, inbox.inboxRevision, inbox.status, JSON.stringify(inbox), inbox.createdAt, inbox.updatedAt, inbox.expiresAt);
      this.insertContinuationAudit(audit!);
      const rows = this.database.prepare("SELECT projection_json FROM continuation_inbox WHERE room_id = ? AND owner_agent_id = ? AND status IN ('UNREAD','ACKNOWLEDGED') ORDER BY created_at, inbox_entry_id").all(this.roomId, inbox.owner) as unknown as Array<{ projection_json: string }>;
      for (const stale of rows.map((row) => normalizeContinuationInboxEntry(parseJson(row.projection_json, undefined))).filter((v): v is ContinuationInboxEntry => Boolean(v)).slice(0, Math.max(0, rows.length - Math.max(1, maxEntries)))) {
        const archived = { ...stale, inboxRevision: stale.inboxRevision + 1, status: "ARCHIVED" as const, updatedAt: inbox.createdAt, closedAt: inbox.createdAt };
        if (!continuationInboxMutationMatches(stale, archived, true)) throw new Error("Invalid capacity inbox archive");
        this.database.prepare("UPDATE continuation_inbox SET inbox_revision = ?, status = ?, projection_json = ?, updated_at = ? WHERE room_id = ? AND inbox_entry_id = ? AND inbox_revision = ?").run(archived.inboxRevision, archived.status, JSON.stringify(archived), archived.updatedAt, this.roomId, archived.inboxEntryId, stale.inboxRevision);
        const staleJob = await this.getContinuation(stale.jobId);
        if (staleJob?.resultDisposition === "INBOX") {
          const archivedJob = { ...staleJob, jobRevision: staleJob.jobRevision + 1, resultDisposition: "ARCHIVED" as const, updatedAt: inbox.createdAt };
          const archiveEvent = capacityArchiveAudit(archivedJob, staleJob.status, inbox.createdAt);
          if (!continuationAuditMatches(staleJob, archivedJob, archiveEvent)) throw new Error("Invalid archived continuation projection");
          this.database.prepare("UPDATE continuation_jobs SET job_revision = ?, projection_json = ?, updated_at = ? WHERE room_id = ? AND job_id = ? AND job_revision = ?").run(archivedJob.jobRevision, JSON.stringify(archivedJob), archivedJob.updatedAt, this.roomId, archivedJob.jobId, staleJob.jobRevision);
          this.insertContinuationAudit(archiveEvent);
        }
      }
      this.database.exec("COMMIT"); return { kind: "accepted", value: structuredClone(job) };
    } catch (error) { this.database.exec("ROLLBACK"); if (String(error).includes("UNIQUE constraint failed")) return { kind: "conflict" }; throw error; }
  }
  async listContinuationAudit(jobId: string) { const rows = this.database.prepare("SELECT projection_json FROM continuation_job_events WHERE room_id = ? AND job_id = ? ORDER BY job_revision").all(this.roomId, jobId) as unknown as Array<{ projection_json: string }>; return rows.map((row) => normalizeContinuationAuditEvent(parseJson(row.projection_json, undefined))).filter((event): event is ContinuationAuditEvent => Boolean(event)); }
  async listContinuationInbox(owner: AgentId) { const rows = this.database.prepare("SELECT projection_json FROM continuation_inbox WHERE room_id = ? AND owner_agent_id = ? ORDER BY created_at DESC, inbox_entry_id").all(this.roomId, owner) as unknown as Array<{ projection_json: string }>; return rows.map((row) => normalizeContinuationInboxEntry(parseJson(row.projection_json, undefined))).filter((value): value is ContinuationInboxEntry => Boolean(value)); }
  async getContinuationInboxEntry(inboxEntryId: string) { const row = this.database.prepare("SELECT projection_json FROM continuation_inbox WHERE room_id = ? AND inbox_entry_id = ?").get(this.roomId, inboxEntryId) as { projection_json: string } | undefined; return row ? normalizeContinuationInboxEntry(parseJson(row.projection_json, undefined)) : undefined; }
  async compareAndSetContinuationInbox(expectedRevision: number, entry: ContinuationInboxEntry): Promise<CasResult<ContinuationInboxEntry>> {
    this.assertContinuationDurableState();
    const value = normalizeContinuationInboxEntry(entry); if (!value || value.inboxRevision !== expectedRevision + 1) throw new Error("Invalid inbox CAS revision");
    const before = await this.getContinuationInboxEntry(value.inboxEntryId); if (!before) return { kind: "not_found" }; if (before.inboxRevision !== expectedRevision || !canTransitionContinuationInbox(before.status, value.status) || value.status === "ARCHIVED") return { kind: "conflict", actualRevision: before.inboxRevision }; if (value.roomId !== this.roomId || !continuationInboxMutationMatches(before, value, false)) throw new Error("Invalid continuation inbox mutation or immutable provenance");
    const changed = this.database.prepare("UPDATE continuation_inbox SET inbox_revision = ?, status = ?, projection_json = ?, updated_at = ?, expires_at = ? WHERE room_id = ? AND inbox_entry_id = ? AND inbox_revision = ?").run(value.inboxRevision, value.status, JSON.stringify(value), value.updatedAt, value.expiresAt, this.roomId, value.inboxEntryId, expectedRevision);
    if (changed.changes) return { kind: "accepted", value: structuredClone(value) }; const existing = await this.getContinuationInboxEntry(value.inboxEntryId); return existing ? { kind: "conflict", actualRevision: existing.inboxRevision } : { kind: "not_found" };
  }
  async archiveContinuationInbox(expectedRevision: number, entry: ContinuationInboxEntry): Promise<CasResult<ContinuationInboxEntry>> {
    this.assertContinuationDurableState();
    const value = normalizeContinuationInboxEntry(entry); if (!value || value.status !== "ARCHIVED" || value.inboxRevision !== expectedRevision + 1) throw new Error("Invalid inbox archive");
    this.database.exec("BEGIN IMMEDIATE"); try { const before = await this.getContinuationInboxEntry(value.inboxEntryId); if (!before) { this.database.exec("ROLLBACK"); return { kind: "not_found" }; } if (before.inboxRevision !== expectedRevision) { this.database.exec("ROLLBACK"); return { kind: "conflict", actualRevision: before.inboxRevision }; } if (value.roomId !== this.roomId || !continuationInboxMutationMatches(before, value, true)) throw new Error("Invalid continuation inbox archive or immutable provenance"); const job = await this.getContinuation(before.jobId); if (!job) { this.database.exec("ROLLBACK"); return { kind: "not_found" }; } if (!continuationInboxMatchesJob(value, job)) throw new Error("Continuation inbox provenance does not match its job"); const archivedJob = { ...job, jobRevision: job.jobRevision + 1, resultDisposition: "ARCHIVED" as const, updatedAt: value.updatedAt }; const archiveEvent = capacityArchiveAudit(archivedJob, job.status, value.updatedAt); if (!continuationAuditMatches(job, archivedJob, archiveEvent)) throw new Error("Invalid archived continuation projection"); this.database.prepare("UPDATE continuation_inbox SET inbox_revision = ?, status = ?, projection_json = ?, updated_at = ? WHERE room_id = ? AND inbox_entry_id = ? AND inbox_revision = ?").run(value.inboxRevision, value.status, JSON.stringify(value), value.updatedAt, this.roomId, value.inboxEntryId, expectedRevision); this.database.prepare("UPDATE continuation_jobs SET job_revision = ?, projection_json = ?, updated_at = ? WHERE room_id = ? AND job_id = ? AND job_revision = ?").run(archivedJob.jobRevision, JSON.stringify(archivedJob), archivedJob.updatedAt, this.roomId, archivedJob.jobId, job.jobRevision); this.insertContinuationAudit(archiveEvent); this.database.exec("COMMIT"); return { kind: "accepted", value: structuredClone(value) }; } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }
  importContinuations(policy: ContinuationPolicy | undefined, jobs: readonly ContinuationRecord[], inbox: readonly ContinuationInboxEntry[], events: readonly ContinuationAuditEvent[] = []) {
    this.assertContinuationDurableState();
    const normalizedPolicy = policy ? normalizeContinuationPolicy(policy) : undefined; if (policy && !normalizedPolicy) throw new Error("Invalid imported continuation policy");
    const normalizedJobs = jobs.map((raw) => { const value = normalizeContinuationRecord(raw); if (!value) throw new Error("Invalid imported continuation job"); return value; });
    const normalizedInbox = inbox.map((raw) => { const value = normalizeContinuationInboxEntry(raw); if (!value) throw new Error("Invalid imported continuation inbox entry"); return value; });
    const normalizedEvents = events.map((raw) => { const value = normalizeContinuationAuditEvent(raw); if (!value) throw new Error("Invalid imported continuation audit event"); return value; });
    validateContinuationDurableState(normalizedPolicy, normalizedJobs, normalizedInbox, normalizedEvents, this.roomId);
    this.database.exec("SAVEPOINT import_continuations");
    try {
      if (normalizedPolicy) {
        const value = normalizedPolicy;
        const existing = this.database.prepare("SELECT projection_json FROM continuation_policies WHERE room_id = ?").get(this.roomId) as { projection_json: string } | undefined;
        if (existing && existing.projection_json !== JSON.stringify(value)) throw new Error("Imported continuation policy diverges from SQLite");
        if (!existing) this.database.prepare("INSERT INTO continuation_policies(room_id, revision, projection_json, updated_at) VALUES (?, ?, ?, ?)").run(this.roomId, value.revision, JSON.stringify(value), value.updatedAt);
      }
      for (const job of normalizedJobs) {
        const existing = this.database.prepare("SELECT projection_json FROM continuation_jobs WHERE room_id = ? AND job_id = ?").get(this.roomId, job.jobId) as { projection_json: string } | undefined;
        if (existing && existing.projection_json !== JSON.stringify(job)) throw new Error(`Continuation ${job.jobId} diverges from SQLite`);
        if (!existing) this.database.prepare("INSERT INTO continuation_jobs(room_id, job_id, owner_agent_id, job_revision, status, projection_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(this.roomId, job.jobId, job.owner, job.jobRevision, job.status, JSON.stringify(job), job.createdAt, job.updatedAt);
      }
      for (const entry of normalizedInbox) {
        const existing = this.database.prepare("SELECT projection_json FROM continuation_inbox WHERE room_id = ? AND inbox_entry_id = ?").get(this.roomId, entry.inboxEntryId) as { projection_json: string } | undefined;
        if (existing && existing.projection_json !== JSON.stringify(entry)) throw new Error(`Inbox entry ${entry.inboxEntryId} diverges from SQLite`);
        if (!existing) this.database.prepare("INSERT INTO continuation_inbox(room_id, inbox_entry_id, job_id, owner_agent_id, inbox_revision, status, projection_json, created_at, updated_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(this.roomId, entry.inboxEntryId, entry.jobId, entry.owner, entry.inboxRevision, entry.status, JSON.stringify(entry), entry.createdAt, entry.updatedAt, entry.expiresAt);
      }
      for (const event of normalizedEvents) { const existing = this.database.prepare("SELECT projection_json FROM continuation_job_events WHERE room_id = ? AND job_id = ? AND job_revision = ?").get(this.roomId, event.jobId, event.jobRevision) as { projection_json: string } | undefined; if (existing && existing.projection_json !== JSON.stringify(event)) throw new Error(`Continuation audit ${event.eventId} diverges from SQLite`); if (!existing) this.insertContinuationAudit(event); }
      this.database.exec("RELEASE import_continuations");
    } catch (error) { this.database.exec("ROLLBACK TO import_continuations; RELEASE import_continuations;"); throw error; }
  }

  async createTask(task: Task): Promise<CreateTaskResult> {
    if (task.roomId !== this.roomId) return { kind: "rejected", reason: `SQLite room repository only owns room ${this.roomId}` };
    if (task.revision !== 1 || task.lifecycleHistory[0]?.operation !== "create") return { kind: "rejected", reason: "A newly persisted task must be a canonical revision 1 task" };
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (this.taskRow(task)) {
        this.database.exec("ROLLBACK");
        return { kind: "conflict", identity: { roomId: task.roomId, taskId: task.taskId } };
      }
      this.insertTask(task);
      this.insertTaskEvent({ roomId: task.roomId, taskId: task.taskId, revision: 1, actorId: task.attribution[0]!.actorId, at: task.createdAt, change: "create", snapshot: task });
      this.replaceTaskLinks(task);
      this.database.exec("COMMIT");
      return { kind: "created", task: structuredClone(task) };
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  async createTaskWithChanges(task: Task, changes: readonly TaskChange[], actor: TaskActor, now: string): Promise<CreateTaskResult> {
    if (task.roomId !== this.roomId) return { kind: "rejected", reason: `SQLite room repository only owns room ${this.roomId}` };
    if (task.revision !== 1 || task.lifecycleHistory[0]?.operation !== "create" || task.attribution[0]?.actorId !== actor.id) return { kind: "rejected", reason: "Atomic task creation requires a canonical revision 1 task from the same actor" };
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (this.taskRow(task)) { this.database.exec("ROLLBACK"); return { kind: "conflict", identity: { roomId: task.roomId, taskId: task.taskId } }; }
      let current = structuredClone(task);
      const events: TaskEvent[] = [{ roomId: task.roomId, taskId: task.taskId, revision: 1, actorId: actor.id, at: task.createdAt, change: "create", snapshot: structuredClone(task) }];
      for (const change of changes) {
        if (change.kind === "add_dependency" || change.kind === "add_blocker") {
          if (!this.taskRow(change.task)) { this.database.exec("ROLLBACK"); return { kind: "rejected", reason: `Linked task ${change.task.taskId} does not exist in room ${change.task.roomId}` }; }
          if (change.kind === "add_dependency" && this.createsTaskDependencyCycle(task, change.task)) { this.database.exec("ROLLBACK"); return { kind: "rejected", reason: "Task dependency would create a direct or transitive cycle" }; }
        }
        const changed = applyDomainTaskChange(current, current.revision, change, actor, now);
        if (changed.kind !== "accepted") { this.database.exec("ROLLBACK"); return { kind: "rejected", reason: changed.kind === "rejected" ? changed.reason : "Atomic task creation conflicted" }; }
        current = changed.task;
        events.push({ roomId: task.roomId, taskId: task.taskId, revision: current.revision, actorId: actor.id, at: now, change, snapshot: current });
      }
      this.insertTask(current);
      this.replaceTaskLinks(current);
      for (const event of events) this.insertTaskEvent(event);
      this.database.exec("COMMIT");
      return { kind: "created", task: structuredClone(current) };
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  async getTask(identity: TaskIdentity) {
    const row = this.taskRow(identity);
    return row ? parseJson<Task>(row.projection_json, undefined as never) : undefined;
  }

  async listTasks(query: TaskListQuery = {}) {
    if (query.roomId && query.roomId !== this.roomId) return { items: [], nextCursor: null };
    const rows = this.database.prepare("SELECT projection_json FROM canonical_tasks WHERE room_id = ?").all(this.roomId) as unknown as TaskRow[];
    return paginateTasks(rows.map((row) => parseJson<Task>(row.projection_json, undefined as never)), query);
  }

  async applyTaskChange(identity: TaskIdentity, expectedRevision: number, change: TaskChange, actor: TaskActor, now: string): Promise<TaskChangeResult> {
    return this.applyTaskChanges(identity, expectedRevision, [change], actor, now);
  }

  async applyTaskChanges(identity: TaskIdentity, expectedRevision: number, changes: readonly TaskChange[], actor: TaskActor, now: string): Promise<TaskChangeResult> {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.taskRow(identity);
      if (!row) { this.database.exec("ROLLBACK"); return { kind: "rejected", reason: `Task ${identity.taskId} does not exist in room ${identity.roomId}` }; }
      let current = parseJson<Task>(row.projection_json, undefined as never);
      if (!changes.length) { this.database.exec("ROLLBACK"); return { kind: "rejected", reason: "At least one task change is required" }; }
      const events: Array<{ change: TaskChange; snapshot: Task }> = [];
      let revision = expectedRevision;
      for (const change of changes) {
        if (change.kind === "add_dependency" || change.kind === "add_blocker") {
          if (!this.taskRow(change.task)) { this.database.exec("ROLLBACK"); return { kind: "rejected", reason: `Linked task ${change.task.taskId} does not exist in room ${change.task.roomId}` }; }
          if (change.kind === "add_dependency" && this.createsTaskDependencyCycle(identity, change.task)) { this.database.exec("ROLLBACK"); return { kind: "rejected", reason: "Task dependency would create a direct or transitive cycle" }; }
        }
        const result = applyDomainTaskChange(current, revision, change, actor, now);
        if (result.kind !== "accepted") { this.database.exec("ROLLBACK"); return result; }
        current = result.task;
        revision = current.revision;
        events.push({ change, snapshot: current });
      }
      const snapshot = current;
      const updated = this.database.prepare(`UPDATE canonical_tasks SET revision = ?, lifecycle_state = ?, title = ?, description = ?, projection_json = ?, updated_at = ? WHERE room_id = ? AND task_id = ? AND revision = ?`)
        .run(snapshot.revision, snapshot.state, snapshot.title, snapshot.description, JSON.stringify(snapshot), snapshot.updatedAt, identity.roomId, identity.taskId, expectedRevision);
      if (updated.changes !== 1) {
        const actual = this.database.prepare("SELECT revision FROM canonical_tasks WHERE room_id = ? AND task_id = ?").get(identity.roomId, identity.taskId) as { revision: number };
        this.database.exec("ROLLBACK"); return { kind: "conflict", expectedRevision, actualRevision: actual.revision };
      }
      this.replaceTaskLinks(snapshot);
      for (const event of events) this.insertTaskEvent({ roomId: identity.roomId, taskId: identity.taskId, revision: event.snapshot.revision, actorId: actor.id, at: now, change: event.change, snapshot: event.snapshot });
      this.database.exec("COMMIT");
      return { kind: "accepted", task: structuredClone(snapshot) };
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  async listTaskEvents(identity: TaskIdentity, options: { readonly afterRevision?: number; readonly limit?: number } = {}) {
    if (identity.roomId !== this.roomId) return [];
    const limit = Math.max(1, Math.min(100, Math.trunc(options.limit ?? 50)));
    const rows = this.database.prepare(`SELECT room_id, task_id, revision, actor_id, occurred_at, change_json, snapshot_json FROM canonical_task_events WHERE room_id = ? AND task_id = ? AND revision > ? ORDER BY revision LIMIT ?`)
      .all(identity.roomId, identity.taskId, options.afterRevision ?? 0, limit) as unknown as TaskEventRow[];
    return rows.map((row): TaskEvent => ({ roomId: row.room_id, taskId: row.task_id, revision: row.revision, actorId: row.actor_id, at: row.occurred_at, change: parseJson(row.change_json, "create"), snapshot: parseJson<Task>(row.snapshot_json, undefined as never) }));
  }

  async getTaskDependencies(identity: TaskIdentity) {
    const task = await this.getTask(identity);
    if (!task) return undefined;
    const rows = this.database.prepare("SELECT task_id FROM canonical_task_links WHERE room_id = ? AND target_task_id = ? AND link_kind = 'dependency' ORDER BY task_id").all(identity.roomId, identity.taskId) as unknown as Array<{ task_id: string }>;
    return { dependencies: structuredClone(task.dependencies), blockers: structuredClone(task.blockers), dependents: rows.map(({ task_id }) => ({ roomId: identity.roomId, taskId: task_id })) };
  }

  async forkTask(source: TaskIdentity, expectedRevision: number, newTaskId: string, actor: TaskActor, now: string, title?: string): Promise<TaskChangeResult> {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.taskRow(source);
      if (!row) { this.database.exec("ROLLBACK"); return { kind: "rejected", reason: `Task ${source.taskId} does not exist in room ${source.roomId}` }; }
      const current = parseJson<Task>(row.projection_json, undefined as never);
      if (current.revision !== expectedRevision) { this.database.exec("ROLLBACK"); return { kind: "conflict", expectedRevision, actualRevision: current.revision }; }
      const identity = { roomId: source.roomId, taskId: newTaskId };
      if (this.taskRow(identity)) { this.database.exec("ROLLBACK"); return { kind: "rejected", reason: `Task ${newTaskId} already exists` }; }
      const result = forkDomainTask(current, expectedRevision, { taskId: newTaskId, title, actor, now });
      if (result.kind !== "accepted") { this.database.exec("ROLLBACK"); return result; }
      const snapshot = result.task;
      this.insertTask(snapshot);
      this.insertTaskEvent({ roomId: snapshot.roomId, taskId: snapshot.taskId, revision: 1, actorId: actor.id, at: now, change: { kind: "fork", source }, snapshot });
      this.replaceTaskLinks(snapshot);
      this.database.exec("COMMIT");
      return { kind: "accepted", task: structuredClone(snapshot) };
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  async createCommandSubmission(value: CommandSubmission) { this.assertOwnedRoom(value.roomId); if (!validSubmission(value)) throw new Error("Invalid command submission"); const row = this.database.prepare("SELECT invocation_json, command_name, invoker_kind, invoker_id, invoker_display_name, submission_id, client_submission_id, created_at FROM command_submissions WHERE room_id = ? AND (submission_id = ? OR client_submission_id = ?)").get(value.roomId, value.submissionId, value.clientSubmissionId) as Record<string, string> | undefined; if (row) return { kind: "duplicate" as const, submission: commandSubmissionFromRow(value.roomId, row) }; this.database.prepare("INSERT INTO command_submissions(submission_id,room_id,client_submission_id,command_name,invocation_json,invoker_kind,invoker_id,invoker_display_name,created_at) VALUES (?,?,?,?,?,?,?,?,?)").run(value.submissionId,value.roomId,value.clientSubmissionId,value.command,JSON.stringify(value.invocation),value.invoker.kind,value.invoker.id,value.invoker.displayName,value.createdAt); return { kind: "created" as const, submission: structuredClone(value) }; }
  async acceptCommand(value: CommandAcceptance): Promise<AcceptCommandResult> { this.assertOwnedRoom(value.submission.roomId); if(!validCommandAcceptance(value))throw new Error("Invalid command acceptance"); const compacted=this.database.prepare("SELECT * FROM command_submission_tombstones WHERE room_id=? AND (submission_id=? OR client_submission_id=?)").get(value.submission.roomId,value.submission.submissionId,value.submission.clientSubmissionId) as Record<string,unknown>|undefined;if(compacted)return{kind:"compacted-duplicate",tombstone:{roomId:String(compacted.room_id),submissionId:String(compacted.submission_id),clientSubmissionId:String(compacted.client_submission_id),command:compacted.command_name as CommandSubmission["command"],compactedAt:String(compacted.compacted_at)}}; this.database.exec("BEGIN IMMEDIATE"); try { const submission=value.submission; const duplicate=this.database.prepare("SELECT invocation_json,command_name,invoker_kind,invoker_id,invoker_display_name,submission_id,client_submission_id,created_at FROM command_submissions WHERE room_id=? AND (submission_id=? OR client_submission_id=?)").get(submission.roomId,submission.submissionId,submission.clientSubmissionId) as Record<string,string>|undefined; if(duplicate){this.database.exec("ROLLBACK");return{kind:"duplicate",submission:commandSubmissionFromRow(submission.roomId,duplicate)};} if(value.poll){const open=Number((this.database.prepare("SELECT count(*) AS total FROM command_polls WHERE room_id=? AND state=\'OPEN\'").get(submission.roomId) as {total:number}).total);if(open>=MAX_OPEN_POLLS_PER_ROOM){this.database.exec("ROLLBACK");return{kind:"rejected",reason:`A room can have at most ${MAX_OPEN_POLLS_PER_ROOM} open polls.`};}} const current=this.commandRoundRobinState(submission.roomId); if(value.roundRobin&&current.revision!==value.roundRobin.expectedRevision){this.database.exec("ROLLBACK");return{kind:"conflict",actualRevision:current.revision};} this.database.prepare("INSERT INTO command_submissions(submission_id,room_id,client_submission_id,command_name,invocation_json,invoker_kind,invoker_id,invoker_display_name,created_at) VALUES (?,?,?,?,?,?,?,?,?)").run(submission.submissionId,submission.roomId,submission.clientSubmissionId,submission.command,JSON.stringify(submission.invocation),submission.invoker.kind,submission.invoker.id,submission.invoker.displayName,submission.createdAt); const audit=value.audit; this.database.prepare("INSERT INTO command_audit_identities(audit_id,room_id,submission_id,command_name,invoker_kind,invoker_id,target_agent_ids_json,created_at) VALUES (?,?,?,?,?,?,?,?)").run(audit.auditId,audit.roomId,audit.submissionId,audit.command,audit.invokerKind,audit.invokerId,JSON.stringify(audit.targetAgentIds),audit.createdAt); if(value.poll){const poll=value.poll;this.database.prepare("INSERT INTO command_polls(poll_id,room_id,submission_id,question,options_json,creator_kind,creator_id,state,revision,closed_at,closer_kind,closer_id,close_mutation_id,final_tallies_json,final_total_votes,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(poll.pollId,poll.roomId,poll.submissionId,poll.question,JSON.stringify(poll.options),poll.creatorKind,poll.creatorId,poll.state,poll.revision,poll.closedAt,poll.closerKind,poll.closerId,poll.closeMutationId,poll.finalTallies?JSON.stringify(poll.finalTallies):null,poll.finalTotalVotes,poll.createdAt);} if(value.attempt){const attempt=value.attempt;this.database.prepare("INSERT INTO command_attempts(attempt_id,room_id,submission_id,attempt,agent_id,generation_id,status,reason,room_epoch,roster_revision,agent_configuration_revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").run(attempt.attemptId,attempt.roomId,attempt.submissionId,attempt.attempt,attempt.agentId,attempt.generationId,attempt.status,attempt.reason,attempt.roomEpoch??null,attempt.rosterRevision??null,attempt.agentConfigurationRevision??null,attempt.createdAt,attempt.updatedAt);} if(value.povExecution){const pov=value.povExecution;this.database.prepare("INSERT INTO command_pov_executions(execution_id,room_id,submission_id,target_agent_ids_json,processed_target_agent_ids_json,current_target_agent_id,generation_id,delivery_messages_json,delivery_result_json,room_epoch,roster_revision,agent_configuration_revision,status,reason,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(pov.executionId,pov.roomId,pov.submissionId,JSON.stringify(pov.targetAgentIds),JSON.stringify(pov.processedTargetAgentIds),pov.currentTargetAgentId??null,pov.generationId??null,pov.deliveryMessages===undefined?null:JSON.stringify(pov.deliveryMessages),pov.deliveryResult===undefined?null:JSON.stringify(pov.deliveryResult),pov.roomEpoch??null,pov.rosterRevision??null,pov.agentConfigurationRevision??null,pov.status,pov.reason,pov.createdAt,pov.updatedAt);} if(value.roundRobin){const rr=value.roundRobin.state;this.database.prepare("INSERT INTO command_round_robin(room_id,last_assigned_agent_id,revision,updated_at) VALUES (?,?,?,?) ON CONFLICT(room_id) DO UPDATE SET last_assigned_agent_id=excluded.last_assigned_agent_id,revision=excluded.revision,updated_at=excluded.updated_at").run(rr.roomId,rr.lastAssignedAgentId,rr.revision,rr.updatedAt);} this.database.exec("COMMIT");return{kind:"accepted",acceptance:structuredClone(value)}; }catch(error){this.database.exec("ROLLBACK");throw error;} }
  async reassignCommandAttempt(value: CommandReassignment) {
    this.assertOwnedRoom(value.current.roomId);
    this.assertOwnedRoom(value.next.roomId);
    this.assertOwnedRoom(value.roundRobin.state.roomId);
    if (!validCommandReassignment(value)) throw new Error("Invalid command reassignment");
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.database.prepare("SELECT * FROM command_attempts WHERE room_id=? AND attempt_id=?").get(value.current.roomId, value.current.attemptId) as Record<string, unknown> | undefined;
      if (!row) { this.database.exec("ROLLBACK"); return { kind: "not-found" as const }; }
      const stored = attemptFromRow(row);
      const pointer = this.commandRoundRobinState(value.current.roomId);
      const duplicate = this.database.prepare("SELECT 1 FROM command_attempts WHERE room_id=? AND (attempt_id=? OR (submission_id=? AND attempt=?))").get(value.next.roomId, value.next.attemptId, value.next.submissionId, value.next.attempt);
      const conflicts = stored.updatedAt !== value.expectedUpdatedAt
        || stored.submissionId !== value.current.submissionId
        || stored.attempt !== value.current.attempt
        || stored.agentId !== value.current.agentId
        || stored.createdAt !== value.current.createdAt
        || !validAttemptTransition(stored.status, value.current.status)
        || pointer.revision !== value.roundRobin.expectedRevision
        || Boolean(duplicate);
      if (conflicts) { this.database.exec("ROLLBACK"); return { kind: "conflict" as const }; }
      const update = this.database.prepare("UPDATE command_attempts SET generation_id=?,status=?,reason=?,updated_at=? WHERE room_id=? AND attempt_id=? AND updated_at=?").run(value.current.generationId, value.current.status, value.current.reason, value.current.updatedAt, value.current.roomId, value.current.attemptId, value.expectedUpdatedAt);
      if (update.changes !== 1) { this.database.exec("ROLLBACK"); return { kind: "conflict" as const }; }
      const next = value.next;
      this.database.prepare("INSERT INTO command_attempts(attempt_id,room_id,submission_id,attempt,agent_id,generation_id,status,reason,room_epoch,roster_revision,agent_configuration_revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").run(next.attemptId,next.roomId,next.submissionId,next.attempt,next.agentId,next.generationId,next.status,next.reason,next.roomEpoch??null,next.rosterRevision??null,next.agentConfigurationRevision??null,next.createdAt,next.updatedAt);
      const rr = value.roundRobin.state;
      this.database.prepare("INSERT INTO command_round_robin(room_id,last_assigned_agent_id,revision,updated_at) VALUES (?,?,?,?) ON CONFLICT(room_id) DO UPDATE SET last_assigned_agent_id=excluded.last_assigned_agent_id,revision=excluded.revision,updated_at=excluded.updated_at").run(rr.roomId, rr.lastAssignedAgentId, rr.revision, rr.updatedAt);
      this.database.exec("COMMIT");
      return { kind: "accepted" as const, current: structuredClone(value.current), next: structuredClone(next) };
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }
  async getCommandSubmission(roomId: string, submissionId: string) {if(roomId!==this.roomId)return undefined; const row = this.database.prepare("SELECT invocation_json, command_name, invoker_kind, invoker_id, invoker_display_name, submission_id, client_submission_id, created_at FROM command_submissions WHERE room_id = ? AND submission_id = ?").get(roomId, submissionId) as Record<string, string> | undefined; return row ? commandSubmissionFromRow(roomId, row) : undefined; }
  private commandRoundRobinState(roomId: string) { this.assertOwnedRoom(roomId); const row = this.database.prepare("SELECT last_assigned_agent_id,revision,updated_at FROM command_round_robin WHERE room_id = ?").get(roomId) as { last_assigned_agent_id: ActiveAgentId | null; revision: number; updated_at: string } | undefined; return row ? { roomId, lastAssignedAgentId: row.last_assigned_agent_id, revision: row.revision, updatedAt: row.updated_at } : { roomId, lastAssignedAgentId: null, revision: 0, updatedAt: new Date(0).toISOString() }; }
  async getRoundRobinState(roomId: string) {if(roomId!==this.roomId)return {roomId,lastAssignedAgentId:null,revision:0,updatedAt:new Date(0).toISOString()}; return this.commandRoundRobinState(roomId); }
  async compareAndSetRoundRobinState(expectedRevision: number, value: RoundRobinState) { this.assertOwnedRoom(value.roomId); if (!validRoundRobin(value) || value.revision !== expectedRevision + 1) throw new Error("Invalid round-robin state"); this.database.exec("BEGIN IMMEDIATE"); try { const current = this.commandRoundRobinState(value.roomId); if (current.revision !== expectedRevision) { this.database.exec("ROLLBACK"); return { kind: "conflict" as const, actualRevision: current.revision }; } this.database.prepare("INSERT INTO command_round_robin(room_id,last_assigned_agent_id,revision,updated_at) VALUES (?,?,?,?) ON CONFLICT(room_id) DO UPDATE SET last_assigned_agent_id=excluded.last_assigned_agent_id,revision=excluded.revision,updated_at=excluded.updated_at").run(value.roomId,value.lastAssignedAgentId,value.revision,value.updatedAt); this.database.exec("COMMIT"); return { kind: "accepted" as const, state: structuredClone(value) }; } catch (error) { this.database.exec("ROLLBACK"); throw error; } }
  async createCommandAttempt(value: CommandAttempt) { this.assertOwnedRoom(value.roomId); if (!validAttempt(value)) throw new Error("Invalid command attempt"); const row = this.database.prepare("SELECT * FROM command_attempts WHERE room_id=? AND (attempt_id=? OR (submission_id=? AND attempt=?))").get(value.roomId,value.attemptId,value.submissionId,value.attempt) as Record<string, unknown> | undefined; if (row) return { kind: "duplicate" as const, attempt: attemptFromRow(row) }; this.database.prepare("INSERT INTO command_attempts(attempt_id,room_id,submission_id,attempt,agent_id,generation_id,status,reason,room_epoch,roster_revision,agent_configuration_revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").run(value.attemptId,value.roomId,value.submissionId,value.attempt,value.agentId,value.generationId,value.status,value.reason,value.roomEpoch??null,value.rosterRevision??null,value.agentConfigurationRevision??null,value.createdAt,value.updatedAt); return { kind: "created" as const, attempt: structuredClone(value) }; }
  async listCommandAttempts(roomId: string, submissionId: string) {if(roomId!==this.roomId)return []; return (this.database.prepare("SELECT * FROM command_attempts WHERE room_id=? AND submission_id=? ORDER BY attempt").all(roomId,submissionId) as Record<string, unknown>[]).map(attemptFromRow); }
  async listPendingCommandAttempts(roomId: string) {if(roomId!==this.roomId)return []; return (this.database.prepare("SELECT * FROM command_attempts WHERE room_id=? AND status IN ('queued','active','delivery-pending') ORDER BY created_at,attempt_id").all(roomId) as Record<string, unknown>[]).map(attemptFromRow); }
  async compareAndSetCommandAttempt(expectedUpdatedAt: string, value: CommandAttempt) { this.assertOwnedRoom(value.roomId); if (!validAttempt(value) || value.updatedAt === expectedUpdatedAt) throw new Error("Invalid command attempt transition"); const current = this.database.prepare("SELECT * FROM command_attempts WHERE room_id=? AND attempt_id=?").get(value.roomId,value.attemptId) as Record<string, unknown> | undefined; if (!current) return { kind: "not-found" as const }; const attempt = attemptFromRow(current); if (attempt.updatedAt !== expectedUpdatedAt || attempt.submissionId !== value.submissionId || attempt.attempt !== value.attempt || attempt.agentId !== value.agentId || attempt.createdAt !== value.createdAt || !validAttemptTransition(attempt.status,value.status)) return { kind: "conflict" as const }; const result = this.database.prepare("UPDATE command_attempts SET generation_id=?,status=?,reason=?,delivery_messages_json=?,delivery_result_json=?,updated_at=? WHERE room_id=? AND attempt_id=? AND updated_at=?").run(value.generationId,value.status,value.reason,value.deliveryMessages?JSON.stringify(value.deliveryMessages):null,value.deliveryResult?JSON.stringify(value.deliveryResult):null,value.updatedAt,value.roomId,value.attemptId,expectedUpdatedAt); return result.changes === 1 ? { kind: "accepted" as const, attempt: structuredClone(value) } : { kind: "conflict" as const }; }
  async createCommandPoll(value: CommandPoll) { this.assertOwnedRoom(value.roomId); if (!validPoll(value)) throw new Error("Invalid command poll"); const row = this.database.prepare("SELECT * FROM command_polls WHERE room_id=? AND (poll_id=? OR submission_id=?)").get(value.roomId,value.pollId,value.submissionId) as Record<string, unknown> | undefined; if (row) return { kind: "duplicate" as const, poll: pollFromRow(row) }; this.database.prepare("INSERT INTO command_polls(poll_id,room_id,submission_id,question,options_json,creator_kind,creator_id,state,revision,closed_at,closer_kind,closer_id,close_mutation_id,final_tallies_json,final_total_votes,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(value.pollId,value.roomId,value.submissionId,value.question,JSON.stringify(value.options),value.creatorKind,value.creatorId,value.state,value.revision,value.closedAt,value.closerKind,value.closerId,value.closeMutationId,value.finalTallies?JSON.stringify(value.finalTallies):null,value.finalTotalVotes,value.createdAt); return { kind: "created" as const, poll: structuredClone(value) }; }
  async listCommandPolls(roomId: string,query:{limit?:number;before?:string;state?:CommandPoll["state"]}={}) {if(roomId!==this.roomId)return []; const limit=Math.max(1,Math.min(MAX_RECENT_POLLS,query.limit||50));const before=parseCommandPollCursor(query.before);return (this.database.prepare("SELECT * FROM command_polls WHERE room_id=? AND (? IS NULL OR state=?) AND (? IS NULL OR created_at<? OR (created_at=? AND poll_id<?)) ORDER BY created_at DESC,poll_id DESC LIMIT ?").all(roomId,query.state||null,query.state||null,before?.createdAt||null,before?.createdAt||null,before?.createdAt||null,before?.pollId||null,limit) as Record<string,unknown>[]).map(pollFromRow); }
  async getCommandPoll(roomId: string, pollId: string) {if(roomId!==this.roomId)return undefined; const row = this.database.prepare("SELECT * FROM command_polls WHERE room_id=? AND poll_id=?").get(roomId,pollId) as Record<string, unknown> | undefined; return row ? pollFromRow(row) : undefined; }
  async createCommandVote(value: CommandVote) { if(value.roomId!==this.roomId)return {kind:"rejected" as const,reason:"Poll or option does not exist in this room."}; if (!validVote(value)) throw new Error("Invalid command vote"); this.database.exec("BEGIN IMMEDIATE"); try { const pollRow=this.database.prepare("SELECT * FROM command_polls WHERE room_id=? AND poll_id=?").get(value.roomId,value.pollId) as Record<string,unknown>|undefined; const poll=pollRow?pollFromRow(pollRow):undefined; if(!poll||value.optionIndex>=poll.options.length){this.database.exec("ROLLBACK");return{kind:"rejected" as const,reason:"Poll or option does not exist in this room."};} const row=this.database.prepare("SELECT * FROM command_poll_votes WHERE room_id=? AND poll_id=? AND (voter_id=? OR mutation_id=?)").get(value.roomId,value.pollId,value.voterId,value.mutationId) as Record<string,unknown>|undefined;if(row){this.database.exec("ROLLBACK");return{kind:"duplicate" as const,vote:voteFromRow(row)};}if(poll.state!=="OPEN"){this.database.exec("ROLLBACK");return{kind:"rejected" as const,reason:"This poll is closed."};}this.database.prepare("INSERT INTO command_poll_votes(room_id,poll_id,voter_id,mutation_id,option_index,created_at) VALUES (?,?,?,?,?,?)").run(value.roomId,value.pollId,value.voterId,value.mutationId,value.optionIndex,value.createdAt);this.database.exec("COMMIT");return{kind:"created" as const,vote:structuredClone(value)};}catch(error){this.database.exec("ROLLBACK");throw error;} }
  async closeCommandPoll(input:{roomId:string;pollId:string;expectedRevision:number;mutationId:string;closerKind:CommandInvoker["kind"]|"controller";closerId:string;closedAt:string}):Promise<CloseCommandPollResult>{this.assertOwnedRoom(input.roomId);this.database.exec("BEGIN IMMEDIATE");try{const row=this.database.prepare("SELECT * FROM command_polls WHERE room_id=? AND poll_id=?").get(input.roomId,input.pollId) as Record<string,unknown>|undefined;if(!row){this.database.exec("ROLLBACK");return{kind:"not-found",reason:"Poll not found."};}const poll=pollFromRow(row);if(poll.state==="CLOSED"){this.database.exec("ROLLBACK");return poll.closeMutationId===input.mutationId?{kind:"duplicate",poll}:{kind:"rejected",reason:"This poll is already closed."};}if(poll.revision!==input.expectedRevision){this.database.exec("ROLLBACK");return{kind:"conflict",poll};}const votes=(this.database.prepare("SELECT * FROM command_poll_votes WHERE room_id=? AND poll_id=?").all(input.roomId,input.pollId) as Record<string,unknown>[]).map(voteFromRow);const tallies=poll.options.map((_,index)=>votes.filter((vote)=>vote.optionIndex===index).length);const result=this.database.prepare("UPDATE command_polls SET state='CLOSED',revision=revision+1,closed_at=?,closer_kind=?,closer_id=?,close_mutation_id=?,final_tallies_json=?,final_total_votes=? WHERE room_id=? AND poll_id=? AND state='OPEN' AND revision=?").run(input.closedAt,input.closerKind,input.closerId,input.mutationId,JSON.stringify(tallies),votes.length,input.roomId,input.pollId,input.expectedRevision);if(result.changes!==1){this.database.exec("ROLLBACK");return{kind:"conflict",poll:(await this.getCommandPoll(input.roomId,input.pollId))!};}this.database.exec("COMMIT");return{kind:"closed",poll:{...poll,state:"CLOSED",revision:poll.revision+1,closedAt:input.closedAt,closerKind:input.closerKind,closerId:input.closerId,closeMutationId:input.mutationId,finalTallies:tallies,finalTotalVotes:votes.length}};}catch(error){this.database.exec("ROLLBACK");throw error;}}
  async listCommandVotes(roomId: string, pollId: string) {if(roomId!==this.roomId)return []; return (this.database.prepare("SELECT * FROM command_poll_votes WHERE room_id=? AND poll_id=? ORDER BY created_at,voter_id").all(roomId,pollId) as Record<string, unknown>[]).map(voteFromRow); }
  async createCommandAuditIdentity(value: CommandAuditIdentity) { this.assertOwnedRoom(value.roomId); if (!validAudit(value)) throw new Error("Invalid command audit"); const row = this.database.prepare("SELECT * FROM command_audit_identities WHERE room_id=? AND (audit_id=? OR submission_id=?)").get(value.roomId,value.auditId,value.submissionId) as Record<string, unknown> | undefined; if (row) return { kind: "duplicate" as const, audit: auditFromRow(row) }; this.database.prepare("INSERT INTO command_audit_identities(audit_id,room_id,submission_id,command_name,invoker_kind,invoker_id,target_agent_ids_json,created_at) VALUES (?,?,?,?,?,?,?,?)").run(value.auditId,value.roomId,value.submissionId,value.command,value.invokerKind,value.invokerId,JSON.stringify(value.targetAgentIds),value.createdAt); return { kind: "created" as const, audit: structuredClone(value) }; }
  async getCommandAuditIdentity(roomId: string, submissionId: string) {if(roomId!==this.roomId)return undefined; const row = this.database.prepare("SELECT * FROM command_audit_identities WHERE room_id=? AND submission_id=?").get(roomId,submissionId) as Record<string, unknown> | undefined; return row ? auditFromRow(row) : undefined; }
  async listCommandAuditIdentities(roomId: string) {if(roomId!==this.roomId)return []; return (this.database.prepare("SELECT * FROM command_audit_identities WHERE room_id=? ORDER BY created_at,audit_id").all(roomId) as Record<string,unknown>[]).map(auditFromRow); }
  async listPendingPovExecutions(roomId:string){if(roomId!==this.roomId)return [];return(this.database.prepare("SELECT * FROM command_pov_executions WHERE room_id=? AND status IN ('queued','active') ORDER BY created_at,execution_id").all(roomId) as Record<string,unknown>[]).map(povExecutionFromRow);}
  async getPovExecution(roomId:string,submissionId:string){if(roomId!==this.roomId)return undefined;const row=this.database.prepare("SELECT * FROM command_pov_executions WHERE room_id=? AND submission_id=?").get(roomId,submissionId) as Record<string,unknown>|undefined;return row?povExecutionFromRow(row):undefined;}
  async compareAndSetPovExecution(expectedUpdatedAt:string,value:CommandPovExecution){this.assertOwnedRoom(value.roomId);if(!validPovExecution(value)||value.updatedAt===expectedUpdatedAt)throw new Error("Invalid POV execution transition");const row=this.database.prepare("SELECT * FROM command_pov_executions WHERE room_id=? AND execution_id=?").get(value.roomId,value.executionId) as Record<string,unknown>|undefined;if(!row)return{kind:"not-found" as const};const current=povExecutionFromRow(row);const valid=current.updatedAt===expectedUpdatedAt&&current.submissionId===value.submissionId&&current.createdAt===value.createdAt&&JSON.stringify(current.targetAgentIds)===JSON.stringify(value.targetAgentIds)&&current.processedTargetAgentIds.every((agent)=>value.processedTargetAgentIds.includes(agent))&&(current.status==="queued"&&["active","failed","cancelled"].includes(value.status)||current.status==="active"&&["active","completed","failed","cancelled"].includes(value.status));if(!valid)return{kind:"conflict" as const};const result=this.database.prepare("UPDATE command_pov_executions SET target_agent_ids_json=?,processed_target_agent_ids_json=?,current_target_agent_id=?,generation_id=?,delivery_messages_json=?,delivery_result_json=?,room_epoch=?,roster_revision=?,agent_configuration_revision=?,status=?,reason=?,updated_at=? WHERE room_id=? AND execution_id=? AND updated_at=?").run(JSON.stringify(value.targetAgentIds),JSON.stringify(value.processedTargetAgentIds),value.currentTargetAgentId??null,value.generationId??null,value.deliveryMessages===undefined?null:JSON.stringify(value.deliveryMessages),value.deliveryResult===undefined?null:JSON.stringify(value.deliveryResult),value.roomEpoch??null,value.rosterRevision??null,value.agentConfigurationRevision??null,value.status,value.reason,value.updatedAt,value.roomId,value.executionId,expectedUpdatedAt);return result.changes===1?{kind:"accepted" as const,execution:structuredClone(value)}:{kind:"conflict" as const};}
  async createGhExecution(value:CommandGhExecution){this.assertOwnedRoom(value.roomId);if(!validGhExecution(value))throw new Error("Invalid GitHub execution");const row=this.database.prepare("SELECT * FROM command_gh_executions WHERE room_id=? AND (execution_id=? OR submission_id=?)").get(value.roomId,value.executionId,value.submissionId) as Record<string,unknown>|undefined;if(row)return{kind:"duplicate" as const,execution:ghExecutionFromRow(row)};this.database.prepare("INSERT INTO command_gh_executions(execution_id,room_id,submission_id,status,delivery_status,projection_json,rendered_text,failure_kind,diagnostics_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(value.executionId,value.roomId,value.submissionId,value.status,value.deliveryStatus,value.projection?JSON.stringify(value.projection):null,value.renderedText,value.failureKind,JSON.stringify(value.diagnostics),value.createdAt,value.updatedAt);return{kind:"created" as const,execution:structuredClone(value)};}
  async getGhExecution(roomId:string,submissionId:string){if(roomId!==this.roomId)return undefined;const row=this.database.prepare("SELECT * FROM command_gh_executions WHERE room_id=? AND submission_id=?").get(roomId,submissionId) as Record<string,unknown>|undefined;return row?ghExecutionFromRow(row):undefined;}
  async listPendingGhExecutions(roomId:string){if(roomId!==this.roomId)return [];return(this.database.prepare("SELECT * FROM command_gh_executions WHERE room_id=? AND (status='queued' OR delivery_status='pending') ORDER BY created_at,execution_id").all(roomId) as Record<string,unknown>[]).map(ghExecutionFromRow);}
  async compareAndSetGhExecution(expectedUpdatedAt:string,value:CommandGhExecution){this.assertOwnedRoom(value.roomId);if(!validGhExecution(value)||value.updatedAt===expectedUpdatedAt||value.status==="queued")throw new Error("Invalid GitHub execution transition");const current=await this.getGhExecution(value.roomId,value.submissionId);if(!current)return{kind:"not-found" as const};if(current.executionId!==value.executionId||current.status!=="queued"||current.updatedAt!==expectedUpdatedAt||current.createdAt!==value.createdAt)return{kind:"conflict" as const};const result=this.database.prepare("UPDATE command_gh_executions SET status=?,projection_json=?,rendered_text=?,failure_kind=?,diagnostics_json=?,updated_at=? WHERE room_id=? AND execution_id=? AND status='queued' AND updated_at=?").run(value.status,value.projection?JSON.stringify(value.projection):null,value.renderedText,value.failureKind,JSON.stringify(value.diagnostics),value.updatedAt,value.roomId,value.executionId,expectedUpdatedAt);return result.changes===1?{kind:"accepted" as const,execution:structuredClone(value)}:{kind:"conflict" as const};}
  async markGhExecutionDelivered(roomId:string,executionId:string,expectedUpdatedAt:string,updatedAt:string){this.assertOwnedRoom(roomId);if(!updatedAt||updatedAt===expectedUpdatedAt)throw new Error("Invalid GitHub delivery transition");const result=this.database.prepare("UPDATE command_gh_executions SET delivery_status='delivered',updated_at=? WHERE room_id=? AND execution_id=? AND status<>'queued' AND delivery_status='pending' AND updated_at=?").run(updatedAt,roomId,executionId,expectedUpdatedAt);if(result.changes===1){const row=this.database.prepare("SELECT * FROM command_gh_executions WHERE room_id=? AND execution_id=?").get(roomId,executionId) as Record<string,unknown>;return{kind:"accepted" as const,execution:ghExecutionFromRow(row)};}const row=this.database.prepare("SELECT 1 FROM command_gh_executions WHERE room_id=? AND execution_id=?").get(roomId,executionId);return row?{kind:"conflict" as const}:{kind:"not-found" as const};}
  async appendDiagnostic(value: DiagnosticRecord) { this.assertOwnedRoom(value.roomId); if (!validDiagnostic(value)) throw new Error("Invalid diagnostic record"); const row = this.database.prepare("SELECT * FROM command_diagnostics WHERE room_id=? AND (record_id=? OR correlation_id=?)").get(value.roomId,value.recordId,value.correlationId) as Record<string, unknown> | undefined; if (row) return { kind: "duplicate" as const, record: diagnosticFromRow(row) }; this.database.prepare("INSERT INTO command_diagnostics(record_id,room_id,agent_id,attempt_id,generation_id,correlation_id,prompt_head,prompt_fingerprint,reason,metadata_json,diagnostic_text,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run(value.recordId,value.roomId,value.agentId,value.attemptId,value.generationId,value.correlationId,value.promptHead,value.promptFingerprint,value.reason,JSON.stringify(value.metadata),value.diagnosticText,value.createdAt); this.database.prepare("DELETE FROM command_diagnostics WHERE created_at < ?").run(new Date(Date.now()-DIAGNOSTIC_RETENTION_MS).toISOString()); this.database.prepare("DELETE FROM command_diagnostics WHERE rowid IN (SELECT rowid FROM command_diagnostics WHERE room_id=? AND agent_id=? ORDER BY created_at DESC,record_id DESC LIMIT -1 OFFSET ?)").run(value.roomId,value.agentId,MAX_DIAGNOSTICS_PER_ROOM_AGENT); return { kind: "created" as const, record: structuredClone(value) }; }
  async getDiagnostic(roomId: string, agentId: ActiveAgentId, recordId: string) {if(roomId!==this.roomId)return undefined; const row = this.database.prepare("SELECT * FROM command_diagnostics WHERE room_id=? AND agent_id=? AND record_id=?").get(roomId,agentId,recordId) as Record<string, unknown> | undefined; return row ? diagnosticFromRow(row) : undefined; }
  async listDiagnostics(roomId: string, input: ActiveAgentId | DiagnosticQuery, legacyLimit = 50) {if(roomId!==this.roomId)return []; const query = typeof input === "string" ? { agentId: input, limit: legacyLimit } : input; const limit = Math.max(1,Math.min(MAX_DIAGNOSTIC_QUERY_LIMIT,query.limit||50)); const search = query.search?.trim().slice(0,MAX_DIAGNOSTIC_SEARCH_LENGTH); const escapedSearch=search?.replaceAll("\\","\\\\").replaceAll("%","\\%").replaceAll("_","\\_"); const rows = this.database.prepare("SELECT * FROM command_diagnostics WHERE room_id=? AND agent_id=? AND (? IS NULL OR reason=?) AND (? IS NULL OR lower(reason || char(10) || coalesce(prompt_head,'') || char(10) || coalesce(diagnostic_text,'')) LIKE '%' || lower(?) || '%' ESCAPE '\\') ORDER BY created_at DESC,record_id DESC LIMIT ?").all(roomId,query.agentId,query.reason||null,query.reason||null,escapedSearch||null,escapedSearch||null,limit) as Record<string, unknown>[]; return rows.map(diagnosticFromRow); }

  async compactCommandRecords(roomId:string,now:string){this.assertOwnedRoom(roomId);const cutoff=new Date(Date.parse(now)-COMMAND_RECORD_RETENTION_MS).toISOString();const rows=this.database.prepare("SELECT submission_id,client_submission_id,command_name,created_at FROM command_submissions WHERE room_id=? ORDER BY created_at DESC,submission_id DESC").all(roomId) as Array<Record<string,unknown>>;const pending=new Set((this.database.prepare("SELECT submission_id FROM command_attempts WHERE room_id=? AND status IN ('queued','active','delivery-pending') UNION SELECT submission_id FROM command_pov_executions WHERE room_id=? AND status IN ('queued','active') UNION SELECT submission_id FROM command_polls WHERE room_id=? AND state='OPEN' UNION SELECT submission_id FROM command_gh_executions WHERE room_id=? AND (status='queued' OR delivery_status='pending')").all(roomId,roomId,roomId,roomId) as Array<{submission_id:string}>).map((row)=>row.submission_id));const removed=rows.filter((row,index)=>!pending.has(String(row.submission_id))&&(index>=MAX_COMMAND_SUBMISSIONS_PER_ROOM||String(row.created_at)<cutoff));if(!removed.length)return;this.database.exec("BEGIN IMMEDIATE");try{for(const row of removed){this.database.prepare("INSERT INTO command_submission_tombstones(room_id,submission_id,client_submission_id,command_name,compacted_at) VALUES (?,?,?,?,?) ON CONFLICT DO NOTHING").run(roomId,String(row.submission_id),String(row.client_submission_id),String(row.command_name),now);this.database.prepare("DELETE FROM command_submissions WHERE room_id=? AND submission_id=?").run(roomId,String(row.submission_id));}this.database.prepare("DELETE FROM command_submission_tombstones WHERE rowid IN (SELECT rowid FROM command_submission_tombstones WHERE room_id=? ORDER BY compacted_at DESC,submission_id DESC LIMIT -1 OFFSET ?)").run(roomId,MAX_COMMAND_TOMBSTONES_PER_ROOM);this.database.exec("COMMIT");}catch(error){this.database.exec("ROLLBACK");throw error;}}

  /** Imports canonical projections and append-only history without replacing newer local revisions. */
  importTasks(tasks: readonly Task[], events: readonly TaskEvent[]) {
    this.database.exec("SAVEPOINT import_tasks");
    try {
      const imported = new Set<string>();
      for (const task of tasks) {
        if (task.roomId !== this.roomId) throw new Error(`Cannot import task ${task.taskId} from another room`);
        const existing = this.database.prepare("SELECT revision, projection_json FROM canonical_tasks WHERE room_id = ? AND task_id = ?").get(task.roomId, task.taskId) as { revision: number; projection_json: string } | undefined;
        if (!existing) {
          this.insertTask(task);
          imported.add(task.taskId);
        } else if (existing.revision === task.revision) {
          if (existing.projection_json !== JSON.stringify(task)) throw new Error(`Task ${task.taskId} has a divergent projection at revision ${task.revision}`);
          imported.add(task.taskId);
        }
      }
      for (const task of tasks) {
        if (imported.has(task.taskId)) this.replaceTaskLinks(task);
      }
      const insertEvent = this.database.prepare(`INSERT OR IGNORE INTO canonical_task_events(room_id, task_id, revision, actor_id, occurred_at, change_json, snapshot_json) VALUES (?, ?, ?, ?, ?, ?, ?)`);
      for (const event of events) {
        if (event.roomId !== this.roomId) throw new Error(`Cannot import task event ${event.taskId}/${event.revision} from another room`);
        if (!imported.has(event.taskId)) continue;
        insertEvent.run(event.roomId, event.taskId, event.revision, event.actorId, event.at, JSON.stringify(event.change), JSON.stringify(event.snapshot));
      }
      this.database.exec("RELEASE import_tasks");
      return imported.size;
    } catch (error) { this.database.exec("ROLLBACK TO import_tasks; RELEASE import_tasks;"); throw error; }
  }

  private setStatusSync(status: RoomState["status"], activeAgent?: AgentId, error?: string) {
    this.database.prepare("UPDATE rooms SET status = ?, active_agent = ?, error = ?, updated_at = ? WHERE id = ?")
      .run(status, activeAgent || null, error || null, new Date().toISOString(), this.roomId);
    const state = this.snapshot();
    state.status = status;
    state.activeAgent = activeAgent;
    state.error = error;
    this.state = state;
  }

  private assertOwnedRoom(roomId: string) {
    if (roomId !== this.roomId) throw new Error(`SQLite room repository ${this.roomId} cannot access room ${roomId}.`);
  }

  private taskRow(identity: TaskIdentity) {
    if (identity.roomId !== this.roomId) return undefined;
    return this.database.prepare("SELECT projection_json FROM canonical_tasks WHERE room_id = ? AND task_id = ?").get(identity.roomId, identity.taskId) as unknown as TaskRow | undefined;
  }
  private assertContinuationDurableState() {
    const policyRows = this.database.prepare("SELECT projection_json FROM continuation_policies WHERE room_id = ?").all(this.roomId) as unknown as Array<{ projection_json: string }>;
    const jobRows = this.database.prepare("SELECT projection_json FROM continuation_jobs WHERE room_id = ?").all(this.roomId) as unknown as Array<{ projection_json: string }>;
    const inboxRows = this.database.prepare("SELECT projection_json FROM continuation_inbox WHERE room_id = ?").all(this.roomId) as unknown as Array<{ projection_json: string }>;
    const eventRows = this.database.prepare("SELECT projection_json FROM continuation_job_events WHERE room_id = ?").all(this.roomId) as unknown as Array<{ projection_json: string }>;
    const parsePolicy = (row: { projection_json: string }) => normalizeContinuationPolicy(parseJson(row.projection_json, undefined));
    const policies = policyRows.map(parsePolicy); const jobs = jobRows.map((row) => normalizeContinuationRecord(parseJson(row.projection_json, undefined))); const inbox = inboxRows.map((row) => normalizeContinuationInboxEntry(parseJson(row.projection_json, undefined))); const events = eventRows.map((row) => normalizeContinuationAuditEvent(parseJson(row.projection_json, undefined)));
    if (policies.some((value) => !value) || jobs.some((value) => !value) || inbox.some((value) => !value) || events.some((value) => !value)) throw new Error("Malformed SQLite continuation state");
    validateContinuationDurableState(policies[0], jobs as ContinuationRecord[], inbox as ContinuationInboxEntry[], events as ContinuationAuditEvent[], this.roomId);
  }
  private clearGovernedStateForOverwrite() {
    this.database.prepare("DELETE FROM command_diagnostics WHERE room_id = ?").run(this.roomId);
    this.database.prepare("DELETE FROM command_submission_tombstones WHERE room_id = ?").run(this.roomId);
    this.database.prepare("DELETE FROM command_round_robin WHERE room_id = ?").run(this.roomId);
    this.database.prepare("DELETE FROM command_submissions WHERE room_id = ?").run(this.roomId);
    this.database.prepare("DELETE FROM continuation_job_events WHERE room_id = ?").run(this.roomId);
    this.database.prepare("DELETE FROM continuation_inbox WHERE room_id = ?").run(this.roomId);
    this.database.prepare("DELETE FROM continuation_jobs WHERE room_id = ?").run(this.roomId);
    this.database.prepare("DELETE FROM continuation_policies WHERE room_id = ?").run(this.roomId);
    this.database.prepare("DELETE FROM canonical_task_links WHERE room_id = ?").run(this.roomId);
    this.database.exec("DROP TRIGGER canonical_task_events_immutable_update; DROP TRIGGER canonical_task_events_immutable_delete;");
    this.database.prepare("DELETE FROM canonical_task_events WHERE room_id = ?").run(this.roomId);
    this.database.prepare("DELETE FROM canonical_tasks WHERE room_id = ?").run(this.roomId);
    this.database.exec(`
      CREATE TRIGGER canonical_task_events_immutable_update
      BEFORE UPDATE ON canonical_task_events BEGIN SELECT RAISE(ABORT, 'task events are immutable'); END;
      CREATE TRIGGER canonical_task_events_immutable_delete
      BEFORE DELETE ON canonical_task_events BEGIN SELECT RAISE(ABORT, 'task events are immutable'); END;
    `);
    this.database.prepare("DELETE FROM assignment_records WHERE room_id = ?").run(this.roomId);
  }
  private insertContinuationAudit(event: ContinuationAuditEvent) { this.database.prepare("INSERT INTO continuation_job_events(room_id, job_id, job_revision, event_id, occurred_at, projection_json) VALUES (?, ?, ?, ?, ?, ?)").run(this.roomId, event.jobId, event.jobRevision, event.eventId, event.at, JSON.stringify(event)); }

  private insertTask(task: Task) {
    if (task.roomId !== this.roomId) throw new Error(`Cannot insert task ${task.taskId} into another room`);
    this.database.prepare(`INSERT INTO canonical_tasks(room_id, task_id, revision, lifecycle_state, title, description, projection_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(task.roomId, task.taskId, task.revision, task.state, task.title, task.description, JSON.stringify(task), task.createdAt, task.updatedAt);
  }

  private insertTaskEvent(event: TaskEvent) {
    if (event.roomId !== this.roomId) throw new Error(`Cannot insert task event ${event.taskId}/${event.revision} into another room`);
    this.database.prepare(`INSERT INTO canonical_task_events(room_id, task_id, revision, actor_id, occurred_at, change_json, snapshot_json) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(event.roomId, event.taskId, event.revision, event.actorId, event.at, JSON.stringify(event.change), JSON.stringify(event.snapshot));
  }

  private replaceTaskLinks(task: Task) {
    if (task.roomId !== this.roomId) throw new Error(`Cannot replace task links for another room`);
    this.database.prepare("DELETE FROM canonical_task_links WHERE room_id = ? AND task_id = ?").run(task.roomId, task.taskId);
    const insert = this.database.prepare("INSERT INTO canonical_task_links(room_id, task_id, link_kind, target_task_id) VALUES (?, ?, ?, ?)");
    for (const link of task.dependencies) insert.run(task.roomId, task.taskId, "dependency", link.taskId);
    for (const link of task.blockers) insert.run(task.roomId, task.taskId, "blocker", link.taskId);
  }

  private createsTaskDependencyCycle(source: TaskIdentity, target: TaskIdentity) {
    if (source.roomId !== this.roomId || target.roomId !== this.roomId || source.taskId === target.taskId) return true;
    const rows = this.database.prepare("SELECT task_id, target_task_id FROM canonical_task_links WHERE room_id = ? AND link_kind = 'dependency'").all(source.roomId) as unknown as Array<{ task_id: string; target_task_id: string }>;
    const edges = new Map<string, string[]>();
    for (const row of rows) edges.set(row.task_id, [...(edges.get(row.task_id) ?? []), row.target_task_id]);
    const visited = new Set<string>();
    const visit = (id: string): boolean => {
      if (id === source.taskId) return true;
      if (visited.has(id)) return false;
      visited.add(id);
      return (edges.get(id) ?? []).some(visit);
    };
    return visit(target.taskId);
  }

  private seedAgents() {
    const now = new Date().toISOString();
    const statement = this.database.prepare(`
      INSERT INTO agents(id, display_name, provider, model_id, configuration_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, '{}', ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        display_name = excluded.display_name,
        provider = excluded.provider,
        model_id = excluded.model_id,
        updated_at = excluded.updated_at
    `);
    for (const agent of SUPPORTED_AGENT_IDS) {
      const profile = AGENT_PROFILES[agent];
      statement.run(agent, profile.displayName, profile.provider, profile.modelId, now, now);
    }
  }

  private loadState(): RoomState {
    const row = this.database.prepare("SELECT * FROM rooms WHERE id = ?").get(this.roomId) as unknown as RoomRow | undefined;
    if (!row) throw new Error(`The SQLite room ${this.roomId} does not exist.`);
    const participantStyles = normalizeParticipantStyles(parseJson(row.participant_styles_json, {}));
    const configuredProjectPath = process.env.ALL_MY_FRIENDS_ARE_AGENTS_PROJECT_PATH || process.env.AGENTWIRE_PROJECT_PATH;
    const storedRosterEntries: Array<Record<string, unknown> & { agentId: string; enabled: boolean }> = (
      this.database.prepare("SELECT agent_id, enabled, configuration_json, last_seen_message_id FROM room_agents WHERE room_id = ? ORDER BY position, agent_id").all(this.roomId) as unknown as Array<{ agent_id: string; enabled: number; configuration_json: string; last_seen_message_id: string | null }>
    ).map((entry) => ({ ...parseJson<Record<string, unknown>>(entry.configuration_json, {}), agentId: entry.agent_id, enabled: Boolean(entry.enabled), ...(entry.last_seen_message_id ? { lastSeenMessageId: entry.last_seen_message_id } : {}) }));
    const roster = normalizeRoomAgentRoster({ ...(row.roster_schema_version === 3 ? { schemaVersion: 3 as const } : {}), revision: row.roster_revision, entries: storedRosterEntries });
    const settings: RoomSettings = {
      roomName: row.name,
      topic: row.topic,
      writableAgent: normalizeWritableAgent(row.writable_agent),
      conversationEnergy: isConversationEnergy(row.conversation_energy) ? row.conversation_energy : DEFAULT_CONVERSATION_ENERGY,
      projectPath: configuredProjectPath || row.project_path || this.projectRoot,
      participantStyles,
    };
    const enabledAgents = new Set(enabledRoomAgentIds(roster));
    if (settings.writableAgent !== "nobody" && !enabledAgents.has(settings.writableAgent)) settings.writableAgent = "nobody";
    const messages = (this.database.prepare("SELECT * FROM messages WHERE room_id = ? ORDER BY row_id").all(this.roomId) as unknown as MessageRow[])
      .map((message) => messageFromRow(message, participantStyles));
    const sessions: Partial<Record<AgentId, AgentSession>> = {};
    for (const session of this.database.prepare("SELECT * FROM agent_sessions WHERE room_id = ?").all(this.roomId) as unknown as SessionRow[]) {
      const laneCompatible = session.permission === "read-only" && session.lane === "room-conversation"
        || session.permission === "writable" && session.lane === "implementation";
      if (isActiveAgentId(session.agent_id) && enabledAgents.has(session.agent_id) && laneCompatible && session.invalidated_at === null) {
        const entry = roomAgentEntry(roster, session.agent_id);
        if (entry?.modelId === "configured") {
          this.database.prepare("DELETE FROM agent_sessions WHERE room_id = ? AND agent_id = ?").run(this.roomId, session.agent_id);
          continue;
        }
        const fingerprint = entry ? participantConfigurationFingerprint(entry) : undefined;
        const rawHarness = storedRosterEntries.find((candidate) => candidate.agentId === session.agent_id)?.harness;
        const compatible = entry && (participantConfigurationFingerprintMatches(session.configuration_fingerprint || undefined, entry)
          || !session.configuration_fingerprint && rawHarness === "opencode");
        if (!compatible) {
          this.database.prepare("DELETE FROM agent_sessions WHERE room_id = ? AND agent_id = ?").run(this.roomId, session.agent_id);
          continue;
        }
        const codeEpoch = normalizeDeploymentEpoch(session.code_epoch);
        sessions[session.agent_id] = { id: session.provider_session_id, permission: session.permission, configurationFingerprint: fingerprint, configurationRevision: session.configuration_revision || entry?.configurationRevision || 1, ...(codeEpoch ? { codeEpoch } : {}) };
      }
    }
    const deployment = normalizeDeploymentProvenance(parseJson(row.deployment_provenance_json, undefined));
    const roomConfiguration = this.readRoomConfiguration();
    return {
      messages,
      sessions,
      settings,
      roster,
      status: row.status === "working" || row.status === "error" ? row.status : "idle",
      ...(isAgentId(row.active_agent) ? { activeAgent: row.active_agent } : {}),
      ...(row.error ? { error: row.error } : {}),
      ...(deployment ? { deployment } : {}),
      ...(roomConfiguration ? { roomConfiguration } : {}),
    };
  }

  private insertMessage(message: RoomMessage) {
    this.database.prepare(`
      INSERT INTO messages(
        id, room_id, speaker, speaker_name, human_id, text, kind, style_json,
        burst_id, burst_sequence, client_message_id, created_at, mentions_json, continuation_request_json, recipient_human_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      message.id,
      this.roomId,
      message.speaker,
      message.speakerName || null,
      message.humanId || null,
      message.text,
      message.kind || null,
      message.style ? JSON.stringify(message.style) : null,
      message.burstId || null,
      message.sequence ?? null,
      message.clientMessageId || null,
      message.timestamp,
      message.mentions?.length ? JSON.stringify(message.mentions) : null,
      message.continuationRequest ? JSON.stringify(message.continuationRequest) : null,
      message.recipientHumanId || null,
    );
  }

  private persistSettings(settings: RoomSettings) {
    this.database.prepare(`
      UPDATE rooms SET
        name = ?, topic = ?, writable_agent = ?, conversation_energy = ?, project_path = ?,
        participant_styles_json = ?, updated_at = ?
      WHERE id = ?
    `).run(
      settings.roomName,
      settings.topic,
      settings.writableAgent,
      settings.conversationEnergy,
      settings.projectPath,
      JSON.stringify(settings.participantStyles),
      new Date().toISOString(),
      this.roomId,
    );
  }

  private readRoomConfiguration(): RoomConfiguration | undefined {
    const row = this.database.prepare("SELECT * FROM room_settings WHERE room_id = ?").get(this.roomId) as unknown as RoomSettingsRow | undefined;
    if (!row) return undefined;
    return normalizeRoomConfiguration({
      configurationRevision: row.configuration_revision,
      basePromptRevision: row.base_prompt_revision,
      basePromptText: row.base_prompt_text,
      summarizerModel: parseJson(row.summarizer_model, null),
      summarizerPromptText: row.summarizer_prompt_text,
      summarizerPromptRevision: row.summarizer_prompt_revision,
      featureFlags: parseJson(row.feature_flags_json, {}),
      preflightMode: row.preflight_mode,
      updatedAt: row.updated_at,
    });
  }

  private persistRoomConfiguration(configuration: RoomConfiguration) {
    this.database.prepare(`
      INSERT INTO room_settings(room_id, configuration_revision, base_prompt_revision, base_prompt_text, summarizer_model, summarizer_prompt_text, summarizer_prompt_revision, feature_flags_json, preflight_mode, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(room_id) DO UPDATE SET
        configuration_revision = excluded.configuration_revision,
        base_prompt_revision = excluded.base_prompt_revision,
        base_prompt_text = excluded.base_prompt_text,
        summarizer_model = excluded.summarizer_model,
        summarizer_prompt_text = excluded.summarizer_prompt_text,
        summarizer_prompt_revision = excluded.summarizer_prompt_revision,
        feature_flags_json = excluded.feature_flags_json,
        preflight_mode = excluded.preflight_mode,
        updated_at = excluded.updated_at
    `).run(this.roomId, configuration.configurationRevision, configuration.basePromptRevision, configuration.basePromptText, configuration.summarizerModel ? JSON.stringify(configuration.summarizerModel) : null, configuration.summarizerPromptText, configuration.summarizerPromptRevision, JSON.stringify(configuration.featureFlags), configuration.preflightMode, configuration.updatedAt || new Date().toISOString());
  }

  private upsertSession(agent: AgentId, id: string, permission: "read-only" | "writable", fingerprint?: string, configurationRevision?: number, codeEpoch?: string) {
    const lane = permission === "read-only" ? "room-conversation" : "implementation";
    this.database.prepare(`
      INSERT INTO agent_sessions(room_id, agent_id, provider_session_id, permission, configuration_fingerprint, configuration_revision, code_epoch, lane, invalidated_at, invalidation_reason, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)
      ON CONFLICT(room_id, agent_id) DO UPDATE SET
        provider_session_id = excluded.provider_session_id,
        permission = excluded.permission,
        configuration_fingerprint = excluded.configuration_fingerprint,
        configuration_revision = excluded.configuration_revision,
        code_epoch = excluded.code_epoch,
        lane = excluded.lane,
        invalidated_at = NULL,
        invalidation_reason = NULL,
        updated_at = excluded.updated_at
    `).run(this.roomId, agent, id, permission, fingerprint || null, configurationRevision || null, normalizeDeploymentEpoch(codeEpoch) || null, lane, new Date().toISOString());
  }

  private upsertInvalidatedSession(agent: AgentId, id: string, fingerprint: string | undefined, configurationRevision: number | undefined, codeEpoch: string | undefined, at: string) {
    this.database.prepare(`
      INSERT INTO agent_sessions(room_id,agent_id,provider_session_id,permission,configuration_fingerprint,configuration_revision,code_epoch,lane,invalidated_at,invalidation_reason,updated_at)
      VALUES (?,?,?,?,?,?,?,'legacy-invalidated',?,'legacy-writable-session-invalidated',?)
      ON CONFLICT(room_id,agent_id) DO UPDATE SET provider_session_id=excluded.provider_session_id,permission='writable',
        configuration_fingerprint=excluded.configuration_fingerprint,configuration_revision=excluded.configuration_revision,
        code_epoch=excluded.code_epoch,lane='legacy-invalidated',invalidated_at=excluded.invalidated_at,
        invalidation_reason=excluded.invalidation_reason,updated_at=excluded.updated_at
    `).run(this.roomId, agent, id, "writable", fingerprint || null, configurationRevision || null, normalizeDeploymentEpoch(codeEpoch) || null, at, at);
  }

  private upsertRosterAgent(entry: RoomAgentRosterEntry) {
    const now = new Date().toISOString();
    this.database.prepare(`INSERT INTO agents(id, display_name, provider, model_id, configuration_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name, provider = excluded.provider, model_id = excluded.model_id, configuration_json = excluded.configuration_json, updated_at = excluded.updated_at`)
      .run(entry.agentId, entry.conversationalName || entry.agentId, "opencode", entry.modelId || "configured", JSON.stringify(entry), now, now);
  }

  private invalidateAgentContextSummaries() {
    this.database.prepare("DELETE FROM agent_context_summaries WHERE room_id = ?").run(this.roomId);
  }

  private insertImprovementEvent(event: ImprovementEvent) {
    this.database.prepare(`
      INSERT INTO canonical_improvement_events(
        room_id, improvement_id, revision, actor_id, occurred_at, change_json, snapshot_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      this.roomId,
      event.improvementId,
      event.revision,
      event.actorId,
      event.at,
      JSON.stringify(event.change),
      JSON.stringify(event.snapshot),
    );
  }

  private insertImprovementLedgerRevision(
    snapshot: Improvement,
    actorId: string,
    eventKind: "CREATED" | "REVISED",
    eventId: string,
    details: unknown = "CREATE",
  ) {
    const snapshotJson = JSON.stringify(snapshot);
    this.database.prepare(`
      INSERT INTO canonical_improvement_revisions(
        room_id, improvement_id, revision, lifecycle_state, status_contract_json, snapshot_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      this.roomId,
      snapshot.id,
      snapshot.revision,
      snapshot.state,
      JSON.stringify(snapshot.statusContract),
      snapshotJson,
      snapshot.updatedAt,
    );
    this.database.prepare(`
      INSERT INTO canonical_improvement_audit_history(
        room_id, improvement_id, event_id, revision, event_kind, actor_id, occurred_at, details_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      this.roomId,
      snapshot.id,
      eventId,
      snapshot.revision,
      eventKind,
      actorId,
      snapshot.updatedAt,
      JSON.stringify(details),
    );
  }
}

function assignmentFromRow(row: Record<string, unknown>) {
  return normalizeAssignmentRecord({
    assignmentId: row.assignment_id,
    improvementId: row.improvement_id,
    developerMemberId: row.developer_member_id,
    developerMemberConfigRevision: Number(row.developer_member_config_revision),
    agent: row.agent_id,
    fencingToken: Number(row.fencing_token),
    manifestRevision: Number(row.manifest_revision),
    pinnedBaseSha: row.pinned_base_sha,
    branch: row.branch_name,
    observedHeadSha: row.observed_head_sha,
    workspacePath: row.workspace_path,
    lifecycleStatus: row.lifecycle_status,
    lifecycleRevision: Number(row.lifecycle_revision || 1),
    cancelledAt: row.cancelled_at ?? null,
    disposedAt: row.disposed_at ?? null,
    lastOperationKey: row.last_operation_key ?? null,
    recovery: parseJson(row.recovery_json as string, undefined),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function durableServerFromRow(row: Record<string, unknown>): DurableServerRecord {
  return { schemaVersion: 1, serverId: String(row.server_id), revision: Number(row.revision), createdAt: String(row.created_at), updatedAt: String(row.updated_at) };
}

function durableRoomFromRow(row: Record<string, unknown>): DurableRoomRecord {
  return { schemaVersion: 1, roomId: String(row.id), serverId: String(row.server_id), revision: Number(row.identity_revision),
    projectId: row.project_id === null ? null : String(row.project_id), createdAt: String(row.created_at), updatedAt: String(row.updated_at) };
}

function durableProjectFromRow(row: Record<string, unknown>): DurableProjectRecord {
  return { schemaVersion: 1, projectId: String(row.project_id), serverId: String(row.server_id), revision: Number(row.revision), name: String(row.name), repositoryCapacity: Number(row.repository_capacity) === 0 ? 0 : 1,
    repositoryReferenceId: row.repository_reference_id === null ? null : String(row.repository_reference_id), createdAt: String(row.created_at), updatedAt: String(row.updated_at) };
}

function repositoryReferenceFromRow(row: Record<string, unknown>): RepositoryReferenceRecord {
  return { schemaVersion: 1, repositoryReferenceId: String(row.repository_reference_id), projectId: String(row.project_id), revision: Number(row.revision),
    state: "unverified-legacy-placeholder", localPath: String(row.local_path), sanitizedRemoteIdentity: row.sanitized_remote_identity === null ? null : String(row.sanitized_remote_identity),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at) };
}

function sourceWorkBindingFromRow(row: Record<string, unknown>): SourceWorkBinding {
  return { schemaVersion: 1, kind: row.work_kind as SourceWorkKind, workId: String(row.work_id), roomId: String(row.room_id),
    projectId: row.project_id === null ? null : String(row.project_id), repositoryReferenceId: row.repository_reference_id === null ? null : String(row.repository_reference_id),
    repositoryReferenceRevision: row.repository_reference_revision === null ? null : Number(row.repository_reference_revision),
    originTaskId: row.origin_task_id === null ? null : String(row.origin_task_id), originTaskRevision: row.origin_task_revision === null ? null : Number(row.origin_task_revision),
    implementationJobId: row.implementation_job_id === null ? null : String(row.implementation_job_id), implementationWorkerId: row.implementation_worker_id === null ? null : String(row.implementation_worker_id),
    state: row.reconciliation_state as SourceWorkBinding["state"], reasonCode: row.reason_code === null ? null : String(row.reason_code),
    evidence: parseJson(String(row.evidence_json), {}), revision: Number(row.revision), createdAt: String(row.created_at), updatedAt: String(row.updated_at) };
}

function identityEvidenceFromRow(row: Record<string, unknown>): IdentityMigrationEvidence {
  return { schemaVersion: 1, migrationVersion: "durable-identities/v1", sourceKind: row.source_kind as IdentityMigrationEvidence["sourceKind"],
    sourceDigest: String(row.source_digest), counts: parseJson(String(row.counts_json), {}), identityDigest: String(row.identity_digest),
    backupPath: row.backup_path === null ? null : String(row.backup_path), completedAt: String(row.completed_at) };
}
function commandSubmissionFromRow(roomId: string, row: Record<string, string>): CommandSubmission { return { submissionId: row.submission_id!, roomId, clientSubmissionId: row.client_submission_id!, command: row.command_name as CommandSubmission["command"], invocation: parseJson(row.invocation_json!, undefined as never), invoker: { kind: row.invoker_kind as "human" | "agent", id: row.invoker_id!, displayName: row.invoker_display_name! }, createdAt: row.created_at! }; }
function attemptFromRow(row: Record<string, unknown>): CommandAttempt { return { attemptId: String(row.attempt_id), roomId: String(row.room_id), submissionId: String(row.submission_id), attempt: Number(row.attempt), agentId: row.agent_id as ActiveAgentId, generationId: row.generation_id === null ? null : String(row.generation_id), status: row.status as CommandAttempt["status"], reason: row.reason === null ? null : String(row.reason), ...(row.delivery_messages_json==null?{}:{deliveryMessages:parseJson(String(row.delivery_messages_json),[])}), ...(row.delivery_result_json==null?{}:{deliveryResult:parseJson(String(row.delivery_result_json),{})}), ...(row.room_epoch==null?{}:{roomEpoch:String(row.room_epoch)}), ...(row.roster_revision==null?{}:{rosterRevision:Number(row.roster_revision)}), ...(row.agent_configuration_revision==null?{}:{agentConfigurationRevision:Number(row.agent_configuration_revision)}), createdAt: String(row.created_at), updatedAt: String(row.updated_at) }; }
function validAttemptTransition(from: CommandAttempt["status"], to: CommandAttempt["status"]) { return from === "queued" && ["active","failed","superseded"].includes(to) || from === "active" && ["delivery-pending","completed","failed","superseded"].includes(to) || from === "delivery-pending" && to === "completed"; }
function pollFromRow(row: Record<string, unknown>): CommandPoll { return { pollId: String(row.poll_id), roomId: String(row.room_id), submissionId: String(row.submission_id), question: String(row.question), options: parseJson(String(row.options_json), []) as unknown as CommandPoll["options"], creatorKind: row.creator_kind as CommandPoll["creatorKind"], creatorId:String(row.creator_id),state:row.state as CommandPoll["state"],revision:Number(row.revision),closedAt:row.closed_at==null?null:String(row.closed_at),closerKind:row.closer_kind==null?null:row.closer_kind as CommandPoll["closerKind"],closerId:row.closer_id==null?null:String(row.closer_id),closeMutationId:row.close_mutation_id==null?null:String(row.close_mutation_id),finalTallies:row.final_tallies_json==null?null:parseJson(String(row.final_tallies_json),[]),finalTotalVotes:row.final_total_votes==null?null:Number(row.final_total_votes),createdAt: String(row.created_at) }; }
function voteFromRow(row: Record<string, unknown>): CommandVote { return { roomId: String(row.room_id), pollId: String(row.poll_id), voterId: String(row.voter_id), mutationId:String(row.mutation_id), optionIndex: Number(row.option_index), createdAt: String(row.created_at) }; }
function auditFromRow(row: Record<string, unknown>): CommandAuditIdentity { return { auditId: String(row.audit_id), roomId: String(row.room_id), submissionId: String(row.submission_id), command: row.command_name as CommandAuditIdentity["command"], invokerKind: row.invoker_kind as CommandAuditIdentity["invokerKind"], invokerId: String(row.invoker_id), targetAgentIds: parseJson(String(row.target_agent_ids_json), []), createdAt: String(row.created_at) }; }
function povExecutionFromRow(row:Record<string,unknown>):CommandPovExecution{return{executionId:String(row.execution_id),roomId:String(row.room_id),submissionId:String(row.submission_id),targetAgentIds:parseJson(String(row.target_agent_ids_json),[]),processedTargetAgentIds:parseJson(String(row.processed_target_agent_ids_json),[]),...(row.current_target_agent_id==null?{}:{currentTargetAgentId:String(row.current_target_agent_id) as ActiveAgentId}),...(row.generation_id==null?{}:{generationId:String(row.generation_id)}),...(row.delivery_messages_json==null?{}:{deliveryMessages:parseJson(String(row.delivery_messages_json),[])}),...(row.delivery_result_json==null?{}:{deliveryResult:parseJson(String(row.delivery_result_json),{})}),...(row.room_epoch==null?{}:{roomEpoch:String(row.room_epoch)}),...(row.roster_revision==null?{}:{rosterRevision:Number(row.roster_revision)}),...(row.agent_configuration_revision==null?{}:{agentConfigurationRevision:Number(row.agent_configuration_revision)}),status:row.status as CommandPovExecution["status"],reason:row.reason==null?null:String(row.reason),createdAt:String(row.created_at),updatedAt:String(row.updated_at)};}
function ghExecutionFromRow(row:Record<string,unknown>):CommandGhExecution{return{executionId:String(row.execution_id),roomId:String(row.room_id),submissionId:String(row.submission_id),status:row.status as CommandGhExecution["status"],deliveryStatus:row.delivery_status as CommandGhExecution["deliveryStatus"],projection:row.projection_json==null?null:parseJson(String(row.projection_json),null),renderedText:row.rendered_text==null?null:String(row.rendered_text),failureKind:row.failure_kind==null?null:row.failure_kind as CommandGhExecution["failureKind"],diagnostics:parseJson(String(row.diagnostics_json),[]),createdAt:String(row.created_at),updatedAt:String(row.updated_at)};}
function diagnosticFromRow(row: Record<string, unknown>): DiagnosticRecord { return { recordId: String(row.record_id), roomId: String(row.room_id), agentId: row.agent_id as ActiveAgentId, attemptId: String(row.attempt_id), generationId: row.generation_id === null ? null : String(row.generation_id), correlationId: String(row.correlation_id), promptHead: row.prompt_head === null ? null : String(row.prompt_head), promptFingerprint: String(row.prompt_fingerprint), reason: String(row.reason), metadata: parseJson(String(row.metadata_json), {}), diagnosticText: row.diagnostic_text === null ? null : String(row.diagnostic_text), createdAt: String(row.created_at) }; }
function capacityArchiveAudit(record: ContinuationRecord, fromStatus: ContinuationRecord["status"], at: string): ContinuationAuditEvent { return finalizeContinuationAudit(record, { schemaVersion: 1, eventId: `archive-${record.jobId}-${record.jobRevision}`, jobId: record.jobId, jobRevision: record.jobRevision, attempt: record.usage.attempts, trigger: record.trigger, policyRevision: record.policyRevision, provenanceHash: continuationProvenanceHash(record), at, action: "INBOX_ARCHIVED", fromStatus, toStatus: record.status, usage: record.usage, attemptUsage: { elapsedMs: 0, tokens: 0, toolCalls: 0 }, result: "Inbox result archived by bounded retention policy.", nextEligibilityAt: record.nextEligibilityAt }); }

function samePersistedRoomState(left: RoomState, right: RoomState) {
  return JSON.stringify(left.messages) === JSON.stringify(right.messages)
    && JSON.stringify(left.sessions) === JSON.stringify(right.sessions)
    && JSON.stringify(left.settings) === JSON.stringify(right.settings)
    && sameDeploymentIdentity(left.deployment, right.deployment)
    && JSON.stringify(normalizeRoomAgentRoster(left.roster)) === JSON.stringify(normalizeRoomAgentRoster(right.roster))
    && left.status === right.status
    && left.activeAgent === right.activeAgent
    && left.error === right.error;
}

function sameDeploymentIdentity(left: RoomState["deployment"], right: RoomState["deployment"]) {
  if (!left || !right) return left === right;
  return left.schemaVersion === right.schemaVersion
    && left.commitSha === right.commitSha
    && JSON.stringify(left.reference) === JSON.stringify(right.reference)
    && left.worktree === right.worktree
    && left.epoch === right.epoch
    && left.unavailableReason === right.unavailableReason;
}

function normalizeMilestoneInput(milestone: { readonly id: string; readonly state: ImprovementMilestoneState; readonly summary: string }) {
  const id = milestone.id.trim();
  const summary = milestone.summary.trim().replace(/\s+/g, " ");
  if (!id || !summary || !["PENDING", "ACHIEVED", "BLOCKED", "CANCELED"].includes(milestone.state)) return undefined;
  return { id, state: milestone.state, summary } as const;
}

function milestoneFromRow(improvementId: string, row: LedgerMilestoneRow): StoredImprovementMilestone {
  return {
    improvementId,
    id: row.milestone_id,
    introducedRevision: row.introduced_revision,
    state: row.state,
    summary: row.summary,
    recordedAt: row.recorded_at,
  };
}
