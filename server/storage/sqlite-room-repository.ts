import { chmod, mkdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_PARTICIPANT_STYLES, normalizeParticipantStyles, sanitizeChatStyle, type ChatStyle, type StyledParticipant } from "../../shared/chat-style.js";
import { isConversationEnergy } from "../../shared/conversation-energy.js";
import {
  applyImprovementChange as applyDomainImprovementChange,
  type DomainActor,
  type Improvement,
  type ImprovementChange,
} from "../../shared/improvement-domain.js";
import { AGENT_PROFILES, SUPPORTED_AGENT_IDS, isActiveAgentId, isAgentId, isParticipantId, normalizeWritableAgent } from "../../shared/participants.js";
import { defaultRoomAgentRoster, enabledRoomAgentIds, normalizeRoomAgentRoster, participantConfigurationFingerprint, roomAgentEntry, validateRosterEntries, type RoomAgentRosterEntry } from "../../shared/roster.js";
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
}

interface SessionRow {
  agent_id: string;
  provider_session_id: string;
  permission: AgentSession["permission"];
  configuration_fingerprint: string | null;
  configuration_revision: number | null;
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
  };
}

function messageFor(
  state: RoomState,
  speaker: RoomMessage["speaker"],
  text: string,
  kind: RoomMessage["kind"] = "chat",
  style?: ChatStyle,
  burst?: { burstId: string; sequence: number },
  human?: { id: string; name: string; clientMessageId?: string; mentions?: RoomMessage["mentions"] },
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
  };
}

export class SqliteRoomRepository implements RoomRepository {
  private state?: RoomState;

  private constructor(
    readonly databasePath: string,
    private readonly database: DatabaseSync,
    private readonly projectRoot: string,
  ) {}

  static async open(
    projectRoot: string,
    databasePath: string,
    options: { initializeDefaultRoom?: boolean; seedImprovements?: boolean } = {},
  ) {
    const databaseDirectory = path.dirname(databasePath);
    await mkdir(databaseDirectory, { recursive: true, mode: 0o700 });
    await chmod(databaseDirectory, 0o700);
    const database = new DatabaseSync(databasePath, { timeout: 5_000, enableForeignKeyConstraints: true });
    try {
      database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");
      await runSqliteMigrations(database);
      await restrictDatabaseFiles(databasePath);

      const repository = new SqliteRoomRepository(databasePath, database, projectRoot);
      repository.seedAgents();
      if (!repository.hasPersistedRoom() && options.initializeDefaultRoom !== false) {
        repository.replaceState(createDefaultRoomState(projectRoot));
      } else if (repository.hasPersistedRoom()) {
        repository.state = repository.loadState();
        repository.assertContinuationDurableState();
        repository.setStatusSync("idle");
      }
      if (options.seedImprovements && repository.hasPersistedRoom()) {
        seedWaveOneImprovements(database, DEFAULT_ROOM_ID);
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

  hasPersistedRoom() {
    return Boolean(this.database.prepare("SELECT 1 FROM rooms WHERE id = ?").get(DEFAULT_ROOM_ID));
  }

  snapshot(): RoomState {
    if (!this.state) throw new Error("The SQLite room has not been initialized.");
    return structuredClone(this.state);
  }

  replaceState(state: RoomState, options: { overwrite?: boolean } = {}) {
    if (this.hasPersistedRoom() && !options.overwrite) {
      throw new Error("The SQLite database already contains the default room. Pass overwrite=true to replace it.");
    }
    const now = new Date().toISOString();
    this.database.exec("SAVEPOINT replace_room_state");
    try {
      this.database.prepare(`
        INSERT INTO rooms(
          id, slug, name, topic, writable_agent, conversation_energy, project_path,
          participant_styles_json, status, active_agent, error, roster_revision, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          updated_at = excluded.updated_at
      `).run(
        DEFAULT_ROOM_ID,
        DEFAULT_ROOM_SLUG,
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
        now,
        now,
      );
      if (options.overwrite) this.clearGovernedStateForOverwrite();
      this.database.prepare("DELETE FROM messages WHERE room_id = ?").run(DEFAULT_ROOM_ID);
      this.database.prepare("DELETE FROM agent_sessions WHERE room_id = ?").run(DEFAULT_ROOM_ID);
      this.database.prepare("DELETE FROM room_agents WHERE room_id = ?").run(DEFAULT_ROOM_ID);
      for (const message of state.messages) this.insertMessage(message);
      for (const [agent, session] of Object.entries(state.sessions) as Array<[AgentId, AgentSession]>) {
        this.upsertSession(agent, session.id, session.permission, session.configurationFingerprint, session.configurationRevision);
      }
      normalizeRoomAgentRoster(state.roster).entries.forEach((entry, position) => {
        this.upsertRosterAgent(entry);
        this.database.prepare(`
        INSERT INTO room_agents(room_id, agent_id, enabled, position, configuration_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(DEFAULT_ROOM_ID, entry.agentId, entry.enabled ? 1 : 0, position, JSON.stringify(entry), now, now);
      });
      this.database.exec("RELEASE replace_room_state");
      this.state = structuredClone(state);
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
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (!this.hasPersistedRoom() || input.overwrite) this.replaceState(input.state, { overwrite: input.overwrite });
      else if (!samePersistedRoomState(this.snapshot(), input.state)) throw new Error("The SQLite database already contains a different default room. Pass overwrite=true to replace it.");
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
    human?: { id: string; name: string; clientMessageId?: string },
  ) {
    const state = this.snapshot();
    const message = messageFor(state, speaker, text, kind, style, burst, human);
    this.insertMessage(message);
    state.messages.push(message);
    this.state = state;
    return message;
  }

  async updateSettings(update: Partial<RoomSettings>) {
    const state = this.snapshot();
    state.settings = { ...state.settings, ...update };
    this.persistSettings(state.settings);
    this.state = state;
  }

  async updateRoster(expectedRevision: number, entries: readonly RoomAgentRosterEntry[]) {
    const validated = validateRosterEntries(entries);
    if (!validated) throw new Error("Invalid room roster entries.");
    const state = this.snapshot();
    const current = normalizeRoomAgentRoster(state.roster);
    if (current.revision !== expectedRevision) return { kind: "conflict" as const, expectedRevision, actualRevision: current.revision };
    const roster = { schemaVersion: 3 as const, revision: current.revision + 1, entries: structuredClone(validated.map((entry) => { const previous = current.entries.find((candidate) => candidate.agentId === entry.agentId); const changed = previous && participantConfigurationFingerprint(previous) !== participantConfigurationFingerprint(entry); if (!changed) return { ...entry, configurationRevision: previous?.configurationRevision || entry.configurationRevision || 1 }; const { selectionConfirmationRequired: _confirmation, ...confirmedEntry } = entry; return { ...confirmedEntry, configurationRevision: (previous.configurationRevision || 1) + 1, sessionInvalidationReason: "Model configuration changed; the previous OpenCode session was invalidated." }; })) };
    for (const entry of roster.entries) state.settings.participantStyles[entry.agentId] ||= structuredClone(DEFAULT_PARTICIPANT_STYLES["codex-sol"]);
    const enabled = new Set(enabledRoomAgentIds(roster));
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const now = new Date().toISOString();
      const updated = this.database.prepare("UPDATE rooms SET roster_revision = ?, updated_at = ? WHERE id = ? AND roster_revision = ?")
        .run(roster.revision, now, DEFAULT_ROOM_ID, expectedRevision);
      if (updated.changes !== 1) {
        const latest = this.database.prepare("SELECT roster_revision FROM rooms WHERE id = ?").get(DEFAULT_ROOM_ID) as { roster_revision: number };
        this.database.exec("ROLLBACK");
        return { kind: "conflict" as const, expectedRevision, actualRevision: latest.roster_revision };
      }
      this.database.prepare("DELETE FROM room_agents WHERE room_id = ?").run(DEFAULT_ROOM_ID);
      const insert = this.database.prepare("INSERT INTO room_agents(room_id, agent_id, enabled, position, configuration_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
      roster.entries.forEach((entry, position) => { this.upsertRosterAgent(entry); insert.run(DEFAULT_ROOM_ID, entry.agentId, entry.enabled ? 1 : 0, position, JSON.stringify(entry), now, now); });
      for (const agent of Object.keys(state.sessions) as AgentId[]) {
        const previous = current.entries.find((entry) => entry.agentId === agent); const updatedEntry = roster.entries.find((entry) => entry.agentId === agent);
        if (enabled.has(agent as never) && previous && updatedEntry && participantConfigurationFingerprint(previous) === participantConfigurationFingerprint(updatedEntry)) continue;
        this.database.prepare("DELETE FROM agent_sessions WHERE room_id = ? AND agent_id = ?").run(DEFAULT_ROOM_ID, agent);
        delete state.sessions[agent];
      }
      if (state.settings.writableAgent !== "nobody" && !enabled.has(state.settings.writableAgent)) {
        state.settings.writableAgent = "nobody";
      }
      this.persistSettings(state.settings);
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
        .run(topic, new Date().toISOString(), DEFAULT_ROOM_ID);
      this.database.prepare("DELETE FROM agent_sessions WHERE room_id = ?").run(DEFAULT_ROOM_ID);
      this.insertMessage(message);
      this.database.exec("COMMIT");
      state.settings.topic = topic;
      state.sessions = {};
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
    this.state = state;
  }

  async setSession(agent: AgentId, id: string, permission: "read-only" | "writable") {
    const state = this.snapshot();
    const entry = roomAgentEntry(state.roster, agent);
    const session = { id, permission, ...(entry ? { configurationFingerprint: participantConfigurationFingerprint(entry), configurationRevision: entry.configurationRevision || 1 } : {}) };
    this.upsertSession(agent, id, permission, session.configurationFingerprint, session.configurationRevision);
    state.sessions[agent] = session;
    this.state = state;
  }

  async clearSession(agent: AgentId) {
    this.database.prepare("DELETE FROM agent_sessions WHERE room_id = ? AND agent_id = ?").run(DEFAULT_ROOM_ID, agent);
    const state = this.snapshot();
    delete state.sessions[agent];
    this.state = state;
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
        .get(DEFAULT_ROOM_ID, improvement.id)) {
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
        DEFAULT_ROOM_ID,
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
    `).get(DEFAULT_ROOM_ID, id) as unknown as ImprovementRow | undefined;
    return row ? normalizeStoredImprovement(parseJson<Improvement>(row.projection_json, undefined as never)) : undefined;
  }

  async listImprovements(query: ImprovementListQuery = {}) {
    const rows = this.database.prepare(`
      SELECT projection_json FROM canonical_improvements WHERE room_id = ?
    `).all(DEFAULT_ROOM_ID) as unknown as ImprovementRow[];
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
      `).get(DEFAULT_ROOM_ID, id) as unknown as ImprovementRow | undefined;
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
        DEFAULT_ROOM_ID,
        id,
        expectedRevision,
      );
      if (updated.changes !== 1) {
        const actual = this.database.prepare(`
          SELECT revision FROM canonical_improvements WHERE room_id = ? AND id = ?
        `).get(DEFAULT_ROOM_ID, id) as { revision: number };
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
        `).run(DEFAULT_ROOM_ID, id, change.evidence.id, snapshot.revision, change.evidence.uri, change.evidence.description, now);
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
    `).all(DEFAULT_ROOM_ID, id, options.afterRevision ?? 0, limit) as unknown as ImprovementEventRow[];
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
    if (!this.database.prepare("SELECT 1 FROM canonical_improvements WHERE room_id = ? AND id = ?").get(DEFAULT_ROOM_ID, id)) {
      return undefined;
    }
    const revisions = this.database.prepare(`
      SELECT revision, lifecycle_state, status_contract_json, created_at
      FROM canonical_improvement_revisions
      WHERE room_id = ? AND improvement_id = ? ORDER BY revision
    `).all(DEFAULT_ROOM_ID, id) as unknown as LedgerRevisionRow[];
    const evidence = this.database.prepare(`
      SELECT evidence_id, introduced_revision, qualification, evidence_kind, uri, summary, recorded_at
      FROM canonical_improvement_evidence
      WHERE room_id = ? AND improvement_id = ? ORDER BY introduced_revision, evidence_id
    `).all(DEFAULT_ROOM_ID, id) as unknown as LedgerEvidenceRow[];
    const milestones = this.database.prepare(`
      SELECT milestone_id, introduced_revision, state, summary, recorded_at
      FROM canonical_improvement_milestone_records
      WHERE room_id = ? AND improvement_id = ? ORDER BY introduced_revision, milestone_id
    `).all(DEFAULT_ROOM_ID, id) as unknown as LedgerMilestoneRow[];
    const audit = this.database.prepare(`
      SELECT event_id, revision, event_kind, actor_id, occurred_at, details_json
      FROM canonical_improvement_audit_history
      WHERE room_id = ? AND improvement_id = ? ORDER BY revision, event_id
    `).all(DEFAULT_ROOM_ID, id) as unknown as LedgerAuditRow[];
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
      `).get(DEFAULT_ROOM_ID, id) as unknown as ImprovementRow | undefined;
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
      `).get(DEFAULT_ROOM_ID, id, normalized.id) as unknown as LedgerMilestoneRow | undefined;
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
      `).run(revision, now, JSON.stringify(snapshot), DEFAULT_ROOM_ID, id, expectedRevision);
      if (updated.changes !== 1) {
        const actual = this.database.prepare("SELECT revision FROM canonical_improvements WHERE room_id = ? AND id = ?")
          .get(DEFAULT_ROOM_ID, id) as { revision: number };
        this.database.exec("ROLLBACK");
        return { kind: "conflict", expectedRevision, actualRevision: actual.revision };
      }
      this.insertImprovementEvent({ improvementId: id, revision, actorId: actor.id, at: now, change, snapshot });
      this.insertImprovementLedgerRevision(snapshot, actor.id, "REVISED", `revision-${revision}`, change);
      this.database.prepare(`
        INSERT INTO canonical_improvement_milestone_records(
          room_id, improvement_id, milestone_id, introduced_revision, state, summary, recorded_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(DEFAULT_ROOM_ID, id, normalized.id, revision, normalized.state, normalized.summary, now);
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
      .get(DEFAULT_ROOM_ID) as { projection_json: string } | undefined;
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
      `).run(DEFAULT_ROOM_ID, next.revision, JSON.stringify(next), now, expectedRevision);
      this.database.prepare(`
        INSERT INTO emergency_stop_events(room_id, revision, actor_id, occurred_at, snapshot_json)
        VALUES (?, ?, ?, ?, ?)
      `).run(DEFAULT_ROOM_ID, next.revision, actor.id, now, JSON.stringify(next));
      this.database.exec("COMMIT");
      return { kind: "accepted", emergencyStop: structuredClone(next) };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  async listAssignments() {
    const rows = this.database.prepare("SELECT * FROM assignment_records WHERE room_id = ? ORDER BY created_at, assignment_id").all(DEFAULT_ROOM_ID) as unknown as Array<Record<string, unknown>>;
    return rows.map(assignmentFromRow).filter((record): record is AssignmentRecord => Boolean(record));
  }

  async getAssignment(assignmentId: string) {
    const row = this.database.prepare("SELECT * FROM assignment_records WHERE room_id = ? AND assignment_id = ?").get(DEFAULT_ROOM_ID, assignmentId) as unknown as Record<string, unknown> | undefined;
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
    `).run(DEFAULT_ROOM_ID, value.assignmentId, value.improvementId, value.developerMemberId,
      value.developerMemberConfigRevision, value.agent, value.fencingToken, value.manifestRevision,
      value.pinnedBaseSha, value.branch, value.observedHeadSha, value.workspacePath,
      value.lifecycleStatus, value.lifecycleRevision ?? 1, value.cancelledAt ?? null, value.disposedAt ?? null,
      value.lastOperationKey ?? null, JSON.stringify(value.recovery), value.createdAt, value.updatedAt);
  }

  async getContinuationPolicy() {
    const row = this.database.prepare("SELECT projection_json FROM continuation_policies WHERE room_id = ?").get(DEFAULT_ROOM_ID) as { projection_json: string } | undefined;
    return row ? normalizeContinuationPolicy(parseJson(row.projection_json, undefined)) : undefined;
  }
  async compareAndSetContinuationPolicy(expectedRevision: number, policy: ContinuationPolicy): Promise<CasResult<ContinuationPolicy>> {
    this.assertContinuationDurableState();
    const value = normalizeContinuationPolicy(policy); if (!value || value.roomId !== DEFAULT_ROOM_ID || value.revision !== expectedRevision + 1) throw new Error("Invalid continuation policy");
    const current = await this.getContinuationPolicy(); if (current && (current.roomId !== value.roomId || current.projectPathHash !== value.projectPathHash || current.policyVersion !== value.policyVersion)) throw new Error("Continuation policy provenance is immutable");
    if (expectedRevision === 0) {
      const result = this.database.prepare("INSERT OR IGNORE INTO continuation_policies(room_id, revision, projection_json, updated_at) VALUES (?, ?, ?, ?)").run(DEFAULT_ROOM_ID, value.revision, JSON.stringify(value), value.updatedAt);
      return result.changes ? { kind: "accepted", value: structuredClone(value) } : { kind: "conflict", actualRevision: (await this.getContinuationPolicy())?.revision };
    }
    const result = this.database.prepare("UPDATE continuation_policies SET revision = ?, projection_json = ?, updated_at = ? WHERE room_id = ? AND revision = ?").run(value.revision, JSON.stringify(value), value.updatedAt, DEFAULT_ROOM_ID, expectedRevision);
    return result.changes ? { kind: "accepted", value: structuredClone(value) } : { kind: "conflict", actualRevision: (await this.getContinuationPolicy())?.revision };
  }
  async listContinuations(owner?: AgentId) {
    const rows = (owner
      ? this.database.prepare("SELECT projection_json FROM continuation_jobs WHERE room_id = ? AND owner_agent_id = ? ORDER BY updated_at DESC, job_id").all(DEFAULT_ROOM_ID, owner)
      : this.database.prepare("SELECT projection_json FROM continuation_jobs WHERE room_id = ? ORDER BY updated_at DESC, job_id").all(DEFAULT_ROOM_ID)) as unknown as Array<{ projection_json: string }>;
    return rows.map((row) => normalizeContinuationRecord(parseJson(row.projection_json, undefined))).filter((value): value is ContinuationRecord => Boolean(value));
  }
  async getContinuation(jobId: string) { const row = this.database.prepare("SELECT projection_json FROM continuation_jobs WHERE room_id = ? AND job_id = ?").get(DEFAULT_ROOM_ID, jobId) as { projection_json: string } | undefined; return row ? normalizeContinuationRecord(parseJson(row.projection_json, undefined)) : undefined; }
  async createContinuation(record: ContinuationRecord, event: ContinuationAuditEvent): Promise<CasResult<ContinuationRecord>> {
    this.assertContinuationDurableState();
    const value = normalizeContinuationRecord(record); const audit = normalizeContinuationAuditEvent(event); if (!value || !continuationRecordIsCanonical(value, DEFAULT_ROOM_ID) || value.jobRevision !== 1 || value.status !== "QUEUED" || !continuationAuditMatches(null, value, audit)) throw new Error("Invalid initial continuation");
    this.database.exec("BEGIN IMMEDIATE"); try { this.database.prepare("INSERT INTO continuation_jobs(room_id, job_id, owner_agent_id, job_revision, status, projection_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(DEFAULT_ROOM_ID, value.jobId, value.owner, value.jobRevision, value.status, JSON.stringify(value), value.createdAt, value.updatedAt); this.insertContinuationAudit(audit!); this.database.exec("COMMIT"); return { kind: "accepted", value: structuredClone(value) }; }
    catch (error) { this.database.exec("ROLLBACK"); if (String(error).includes("UNIQUE constraint failed")) return { kind: "conflict" }; throw error; }
  }
  async compareAndSetContinuation(expectedRevision: number, record: ContinuationRecord, event: ContinuationAuditEvent): Promise<CasResult<ContinuationRecord>> {
    this.assertContinuationDurableState();
    const value = normalizeContinuationRecord(record); const audit = normalizeContinuationAuditEvent(event); if (!value || value.jobRevision !== expectedRevision + 1) throw new Error("Invalid continuation CAS revision");
    const before = await this.getContinuation(value.jobId); if (!before) return { kind: "not_found" }; if (before.jobRevision !== expectedRevision || !canTransitionContinuation(before.status, value.status)) return { kind: "conflict", actualRevision: before.jobRevision };
    if (!continuationRecordIsCanonical(value, DEFAULT_ROOM_ID) || !continuationRecordProvenanceMatches(before, value)) throw new Error("Continuation provenance is immutable");
    if (!continuationAuditMatches(before, value, audit)) throw new Error("Invalid continuation audit event");
    this.database.exec("BEGIN IMMEDIATE"); try { const result = this.database.prepare("UPDATE continuation_jobs SET job_revision = ?, status = ?, projection_json = ?, updated_at = ? WHERE room_id = ? AND job_id = ? AND job_revision = ?").run(value.jobRevision, value.status, JSON.stringify(value), value.updatedAt, DEFAULT_ROOM_ID, value.jobId, expectedRevision); if (!result.changes) { this.database.exec("ROLLBACK"); const existing = await this.getContinuation(value.jobId); return existing ? { kind: "conflict", actualRevision: existing.jobRevision } : { kind: "not_found" }; } this.insertContinuationAudit(audit!); this.database.exec("COMMIT"); return { kind: "accepted", value: structuredClone(value) }; }
    catch (error) { this.database.exec("ROLLBACK"); if (String(error).includes("UNIQUE constraint failed")) return { kind: "conflict" }; throw error; }
  }
  async completeContinuation(expectedRevision: number, record: ContinuationRecord, entry: ContinuationInboxEntry, maxEntries: number, event: ContinuationAuditEvent): Promise<CasResult<ContinuationRecord>> {
    this.assertContinuationDurableState();
    const job = normalizeContinuationRecord(record); const inbox = normalizeContinuationInboxEntry(entry); const audit = normalizeContinuationAuditEvent(event); if (!job || !inbox || !continuationRecordIsCanonical(job, DEFAULT_ROOM_ID) || inbox.roomId !== DEFAULT_ROOM_ID || !continuationInboxStartsJobResult(inbox, job) || job.jobRevision !== expectedRevision + 1) throw new Error("Invalid atomic completion");
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const beforeRow = this.database.prepare("SELECT projection_json FROM continuation_jobs WHERE room_id = ? AND job_id = ?").get(DEFAULT_ROOM_ID, job.jobId) as { projection_json: string } | undefined;
      const before = beforeRow ? normalizeContinuationRecord(parseJson(beforeRow.projection_json, undefined)) : undefined;
      if (!before || before.jobRevision !== expectedRevision || !canTransitionContinuation(before.status, job.status)) { this.database.exec("ROLLBACK"); return before ? { kind: "conflict", actualRevision: before.jobRevision } : { kind: "not_found" }; }
      if (!continuationRecordProvenanceMatches(before, job)) throw new Error("Continuation provenance is immutable");
      if (!continuationAuditMatches(before, job, audit)) throw new Error("Invalid completion audit event");
      const changed = this.database.prepare("UPDATE continuation_jobs SET job_revision = ?, status = ?, projection_json = ?, updated_at = ? WHERE room_id = ? AND job_id = ? AND job_revision = ?").run(job.jobRevision, job.status, JSON.stringify(job), job.updatedAt, DEFAULT_ROOM_ID, job.jobId, expectedRevision);
      if (!changed.changes) { const row = this.database.prepare("SELECT job_revision FROM continuation_jobs WHERE room_id = ? AND job_id = ?").get(DEFAULT_ROOM_ID, job.jobId) as { job_revision: number } | undefined; this.database.exec("ROLLBACK"); return row ? { kind: "conflict", actualRevision: row.job_revision } : { kind: "not_found" }; }
      this.database.prepare("INSERT INTO continuation_inbox(room_id, inbox_entry_id, job_id, owner_agent_id, inbox_revision, status, projection_json, created_at, updated_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(DEFAULT_ROOM_ID, inbox.inboxEntryId, inbox.jobId, inbox.owner, inbox.inboxRevision, inbox.status, JSON.stringify(inbox), inbox.createdAt, inbox.updatedAt, inbox.expiresAt);
      this.insertContinuationAudit(audit!);
      const rows = this.database.prepare("SELECT projection_json FROM continuation_inbox WHERE room_id = ? AND owner_agent_id = ? AND status IN ('UNREAD','ACKNOWLEDGED') ORDER BY created_at, inbox_entry_id").all(DEFAULT_ROOM_ID, inbox.owner) as unknown as Array<{ projection_json: string }>;
      for (const stale of rows.map((row) => normalizeContinuationInboxEntry(parseJson(row.projection_json, undefined))).filter((v): v is ContinuationInboxEntry => Boolean(v)).slice(0, Math.max(0, rows.length - Math.max(1, maxEntries)))) {
        const archived = { ...stale, inboxRevision: stale.inboxRevision + 1, status: "ARCHIVED" as const, updatedAt: inbox.createdAt, closedAt: inbox.createdAt };
        if (!continuationInboxMutationMatches(stale, archived, true)) throw new Error("Invalid capacity inbox archive");
        this.database.prepare("UPDATE continuation_inbox SET inbox_revision = ?, status = ?, projection_json = ?, updated_at = ? WHERE room_id = ? AND inbox_entry_id = ? AND inbox_revision = ?").run(archived.inboxRevision, archived.status, JSON.stringify(archived), archived.updatedAt, DEFAULT_ROOM_ID, archived.inboxEntryId, stale.inboxRevision);
        const staleJob = await this.getContinuation(stale.jobId);
        if (staleJob?.resultDisposition === "INBOX") {
          const archivedJob = { ...staleJob, jobRevision: staleJob.jobRevision + 1, resultDisposition: "ARCHIVED" as const, updatedAt: inbox.createdAt };
          const archiveEvent = capacityArchiveAudit(archivedJob, staleJob.status, inbox.createdAt);
          if (!continuationAuditMatches(staleJob, archivedJob, archiveEvent)) throw new Error("Invalid archived continuation projection");
          this.database.prepare("UPDATE continuation_jobs SET job_revision = ?, projection_json = ?, updated_at = ? WHERE room_id = ? AND job_id = ? AND job_revision = ?").run(archivedJob.jobRevision, JSON.stringify(archivedJob), archivedJob.updatedAt, DEFAULT_ROOM_ID, archivedJob.jobId, staleJob.jobRevision);
          this.insertContinuationAudit(archiveEvent);
        }
      }
      this.database.exec("COMMIT"); return { kind: "accepted", value: structuredClone(job) };
    } catch (error) { this.database.exec("ROLLBACK"); if (String(error).includes("UNIQUE constraint failed")) return { kind: "conflict" }; throw error; }
  }
  async listContinuationAudit(jobId: string) { const rows = this.database.prepare("SELECT projection_json FROM continuation_job_events WHERE room_id = ? AND job_id = ? ORDER BY job_revision").all(DEFAULT_ROOM_ID, jobId) as unknown as Array<{ projection_json: string }>; return rows.map((row) => normalizeContinuationAuditEvent(parseJson(row.projection_json, undefined))).filter((event): event is ContinuationAuditEvent => Boolean(event)); }
  async listContinuationInbox(owner: AgentId) { const rows = this.database.prepare("SELECT projection_json FROM continuation_inbox WHERE room_id = ? AND owner_agent_id = ? ORDER BY created_at DESC, inbox_entry_id").all(DEFAULT_ROOM_ID, owner) as unknown as Array<{ projection_json: string }>; return rows.map((row) => normalizeContinuationInboxEntry(parseJson(row.projection_json, undefined))).filter((value): value is ContinuationInboxEntry => Boolean(value)); }
  async getContinuationInboxEntry(inboxEntryId: string) { const row = this.database.prepare("SELECT projection_json FROM continuation_inbox WHERE room_id = ? AND inbox_entry_id = ?").get(DEFAULT_ROOM_ID, inboxEntryId) as { projection_json: string } | undefined; return row ? normalizeContinuationInboxEntry(parseJson(row.projection_json, undefined)) : undefined; }
  async compareAndSetContinuationInbox(expectedRevision: number, entry: ContinuationInboxEntry): Promise<CasResult<ContinuationInboxEntry>> {
    this.assertContinuationDurableState();
    const value = normalizeContinuationInboxEntry(entry); if (!value || value.inboxRevision !== expectedRevision + 1) throw new Error("Invalid inbox CAS revision");
    const before = await this.getContinuationInboxEntry(value.inboxEntryId); if (!before) return { kind: "not_found" }; if (before.inboxRevision !== expectedRevision || !canTransitionContinuationInbox(before.status, value.status) || value.status === "ARCHIVED") return { kind: "conflict", actualRevision: before.inboxRevision }; if (value.roomId !== DEFAULT_ROOM_ID || !continuationInboxMutationMatches(before, value, false)) throw new Error("Invalid continuation inbox mutation or immutable provenance");
    const changed = this.database.prepare("UPDATE continuation_inbox SET inbox_revision = ?, status = ?, projection_json = ?, updated_at = ?, expires_at = ? WHERE room_id = ? AND inbox_entry_id = ? AND inbox_revision = ?").run(value.inboxRevision, value.status, JSON.stringify(value), value.updatedAt, value.expiresAt, DEFAULT_ROOM_ID, value.inboxEntryId, expectedRevision);
    if (changed.changes) return { kind: "accepted", value: structuredClone(value) }; const existing = await this.getContinuationInboxEntry(value.inboxEntryId); return existing ? { kind: "conflict", actualRevision: existing.inboxRevision } : { kind: "not_found" };
  }
  async archiveContinuationInbox(expectedRevision: number, entry: ContinuationInboxEntry): Promise<CasResult<ContinuationInboxEntry>> {
    this.assertContinuationDurableState();
    const value = normalizeContinuationInboxEntry(entry); if (!value || value.status !== "ARCHIVED" || value.inboxRevision !== expectedRevision + 1) throw new Error("Invalid inbox archive");
    this.database.exec("BEGIN IMMEDIATE"); try { const before = await this.getContinuationInboxEntry(value.inboxEntryId); if (!before) { this.database.exec("ROLLBACK"); return { kind: "not_found" }; } if (before.inboxRevision !== expectedRevision) { this.database.exec("ROLLBACK"); return { kind: "conflict", actualRevision: before.inboxRevision }; } if (value.roomId !== DEFAULT_ROOM_ID || !continuationInboxMutationMatches(before, value, true)) throw new Error("Invalid continuation inbox archive or immutable provenance"); const job = await this.getContinuation(before.jobId); if (!job) { this.database.exec("ROLLBACK"); return { kind: "not_found" }; } if (!continuationInboxMatchesJob(value, job)) throw new Error("Continuation inbox provenance does not match its job"); const archivedJob = { ...job, jobRevision: job.jobRevision + 1, resultDisposition: "ARCHIVED" as const, updatedAt: value.updatedAt }; const archiveEvent = capacityArchiveAudit(archivedJob, job.status, value.updatedAt); if (!continuationAuditMatches(job, archivedJob, archiveEvent)) throw new Error("Invalid archived continuation projection"); this.database.prepare("UPDATE continuation_inbox SET inbox_revision = ?, status = ?, projection_json = ?, updated_at = ? WHERE room_id = ? AND inbox_entry_id = ? AND inbox_revision = ?").run(value.inboxRevision, value.status, JSON.stringify(value), value.updatedAt, DEFAULT_ROOM_ID, value.inboxEntryId, expectedRevision); this.database.prepare("UPDATE continuation_jobs SET job_revision = ?, projection_json = ?, updated_at = ? WHERE room_id = ? AND job_id = ? AND job_revision = ?").run(archivedJob.jobRevision, JSON.stringify(archivedJob), archivedJob.updatedAt, DEFAULT_ROOM_ID, archivedJob.jobId, job.jobRevision); this.insertContinuationAudit(archiveEvent); this.database.exec("COMMIT"); return { kind: "accepted", value: structuredClone(value) }; } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }
  importContinuations(policy: ContinuationPolicy | undefined, jobs: readonly ContinuationRecord[], inbox: readonly ContinuationInboxEntry[], events: readonly ContinuationAuditEvent[] = []) {
    this.assertContinuationDurableState();
    const normalizedPolicy = policy ? normalizeContinuationPolicy(policy) : undefined; if (policy && !normalizedPolicy) throw new Error("Invalid imported continuation policy");
    const normalizedJobs = jobs.map((raw) => { const value = normalizeContinuationRecord(raw); if (!value) throw new Error("Invalid imported continuation job"); return value; });
    const normalizedInbox = inbox.map((raw) => { const value = normalizeContinuationInboxEntry(raw); if (!value) throw new Error("Invalid imported continuation inbox entry"); return value; });
    const normalizedEvents = events.map((raw) => { const value = normalizeContinuationAuditEvent(raw); if (!value) throw new Error("Invalid imported continuation audit event"); return value; });
    validateContinuationDurableState(normalizedPolicy, normalizedJobs, normalizedInbox, normalizedEvents, DEFAULT_ROOM_ID);
    this.database.exec("SAVEPOINT import_continuations");
    try {
      if (normalizedPolicy) {
        const value = normalizedPolicy;
        const existing = this.database.prepare("SELECT projection_json FROM continuation_policies WHERE room_id = ?").get(DEFAULT_ROOM_ID) as { projection_json: string } | undefined;
        if (existing && existing.projection_json !== JSON.stringify(value)) throw new Error("Imported continuation policy diverges from SQLite");
        if (!existing) this.database.prepare("INSERT INTO continuation_policies(room_id, revision, projection_json, updated_at) VALUES (?, ?, ?, ?)").run(DEFAULT_ROOM_ID, value.revision, JSON.stringify(value), value.updatedAt);
      }
      for (const job of normalizedJobs) {
        const existing = this.database.prepare("SELECT projection_json FROM continuation_jobs WHERE room_id = ? AND job_id = ?").get(DEFAULT_ROOM_ID, job.jobId) as { projection_json: string } | undefined;
        if (existing && existing.projection_json !== JSON.stringify(job)) throw new Error(`Continuation ${job.jobId} diverges from SQLite`);
        if (!existing) this.database.prepare("INSERT INTO continuation_jobs(room_id, job_id, owner_agent_id, job_revision, status, projection_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(DEFAULT_ROOM_ID, job.jobId, job.owner, job.jobRevision, job.status, JSON.stringify(job), job.createdAt, job.updatedAt);
      }
      for (const entry of normalizedInbox) {
        const existing = this.database.prepare("SELECT projection_json FROM continuation_inbox WHERE room_id = ? AND inbox_entry_id = ?").get(DEFAULT_ROOM_ID, entry.inboxEntryId) as { projection_json: string } | undefined;
        if (existing && existing.projection_json !== JSON.stringify(entry)) throw new Error(`Inbox entry ${entry.inboxEntryId} diverges from SQLite`);
        if (!existing) this.database.prepare("INSERT INTO continuation_inbox(room_id, inbox_entry_id, job_id, owner_agent_id, inbox_revision, status, projection_json, created_at, updated_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(DEFAULT_ROOM_ID, entry.inboxEntryId, entry.jobId, entry.owner, entry.inboxRevision, entry.status, JSON.stringify(entry), entry.createdAt, entry.updatedAt, entry.expiresAt);
      }
      for (const event of normalizedEvents) { const existing = this.database.prepare("SELECT projection_json FROM continuation_job_events WHERE room_id = ? AND job_id = ? AND job_revision = ?").get(DEFAULT_ROOM_ID, event.jobId, event.jobRevision) as { projection_json: string } | undefined; if (existing && existing.projection_json !== JSON.stringify(event)) throw new Error(`Continuation audit ${event.eventId} diverges from SQLite`); if (!existing) this.insertContinuationAudit(event); }
      this.database.exec("RELEASE import_continuations");
    } catch (error) { this.database.exec("ROLLBACK TO import_continuations; RELEASE import_continuations;"); throw error; }
  }

  async createTask(task: Task): Promise<CreateTaskResult> {
    if (task.roomId !== DEFAULT_ROOM_ID) return { kind: "rejected", reason: `SQLite room repository only owns room ${DEFAULT_ROOM_ID}` };
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
    if (task.roomId !== DEFAULT_ROOM_ID) return { kind: "rejected", reason: `SQLite room repository only owns room ${DEFAULT_ROOM_ID}` };
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
    if (query.roomId && query.roomId !== DEFAULT_ROOM_ID) return { items: [], nextCursor: null };
    const rows = this.database.prepare("SELECT projection_json FROM canonical_tasks WHERE room_id = ?").all(DEFAULT_ROOM_ID) as unknown as TaskRow[];
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

  /** Imports canonical projections and append-only history without replacing newer local revisions. */
  importTasks(tasks: readonly Task[], events: readonly TaskEvent[]) {
    this.database.exec("SAVEPOINT import_tasks");
    try {
      const imported = new Set<string>();
      for (const task of tasks) {
        if (task.roomId !== DEFAULT_ROOM_ID) throw new Error(`Cannot import task ${task.taskId} from another room`);
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
        if (!imported.has(event.taskId)) continue;
        insertEvent.run(event.roomId, event.taskId, event.revision, event.actorId, event.at, JSON.stringify(event.change), JSON.stringify(event.snapshot));
      }
      this.database.exec("RELEASE import_tasks");
      return imported.size;
    } catch (error) { this.database.exec("ROLLBACK TO import_tasks; RELEASE import_tasks;"); throw error; }
  }

  private setStatusSync(status: RoomState["status"], activeAgent?: AgentId, error?: string) {
    this.database.prepare("UPDATE rooms SET status = ?, active_agent = ?, error = ?, updated_at = ? WHERE id = ?")
      .run(status, activeAgent || null, error || null, new Date().toISOString(), DEFAULT_ROOM_ID);
    const state = this.snapshot();
    state.status = status;
    state.activeAgent = activeAgent;
    state.error = error;
    this.state = state;
  }

  private taskRow(identity: TaskIdentity) {
    return this.database.prepare("SELECT projection_json FROM canonical_tasks WHERE room_id = ? AND task_id = ?").get(identity.roomId, identity.taskId) as unknown as TaskRow | undefined;
  }
  private assertContinuationDurableState() {
    const policyRows = this.database.prepare("SELECT projection_json FROM continuation_policies WHERE room_id = ?").all(DEFAULT_ROOM_ID) as unknown as Array<{ projection_json: string }>;
    const jobRows = this.database.prepare("SELECT projection_json FROM continuation_jobs WHERE room_id = ?").all(DEFAULT_ROOM_ID) as unknown as Array<{ projection_json: string }>;
    const inboxRows = this.database.prepare("SELECT projection_json FROM continuation_inbox WHERE room_id = ?").all(DEFAULT_ROOM_ID) as unknown as Array<{ projection_json: string }>;
    const eventRows = this.database.prepare("SELECT projection_json FROM continuation_job_events WHERE room_id = ?").all(DEFAULT_ROOM_ID) as unknown as Array<{ projection_json: string }>;
    const parsePolicy = (row: { projection_json: string }) => normalizeContinuationPolicy(parseJson(row.projection_json, undefined));
    const policies = policyRows.map(parsePolicy); const jobs = jobRows.map((row) => normalizeContinuationRecord(parseJson(row.projection_json, undefined))); const inbox = inboxRows.map((row) => normalizeContinuationInboxEntry(parseJson(row.projection_json, undefined))); const events = eventRows.map((row) => normalizeContinuationAuditEvent(parseJson(row.projection_json, undefined)));
    if (policies.some((value) => !value) || jobs.some((value) => !value) || inbox.some((value) => !value) || events.some((value) => !value)) throw new Error("Malformed SQLite continuation state");
    validateContinuationDurableState(policies[0], jobs as ContinuationRecord[], inbox as ContinuationInboxEntry[], events as ContinuationAuditEvent[], DEFAULT_ROOM_ID);
  }
  private clearGovernedStateForOverwrite() {
    this.database.prepare("DELETE FROM continuation_job_events WHERE room_id = ?").run(DEFAULT_ROOM_ID);
    this.database.prepare("DELETE FROM continuation_inbox WHERE room_id = ?").run(DEFAULT_ROOM_ID);
    this.database.prepare("DELETE FROM continuation_jobs WHERE room_id = ?").run(DEFAULT_ROOM_ID);
    this.database.prepare("DELETE FROM continuation_policies WHERE room_id = ?").run(DEFAULT_ROOM_ID);
    this.database.prepare("DELETE FROM canonical_task_links WHERE room_id = ?").run(DEFAULT_ROOM_ID);
    this.database.exec("DROP TRIGGER canonical_task_events_immutable_update; DROP TRIGGER canonical_task_events_immutable_delete;");
    this.database.prepare("DELETE FROM canonical_task_events WHERE room_id = ?").run(DEFAULT_ROOM_ID);
    this.database.prepare("DELETE FROM canonical_tasks WHERE room_id = ?").run(DEFAULT_ROOM_ID);
    this.database.exec(`
      CREATE TRIGGER canonical_task_events_immutable_update
      BEFORE UPDATE ON canonical_task_events BEGIN SELECT RAISE(ABORT, 'task events are immutable'); END;
      CREATE TRIGGER canonical_task_events_immutable_delete
      BEFORE DELETE ON canonical_task_events BEGIN SELECT RAISE(ABORT, 'task events are immutable'); END;
    `);
    this.database.prepare("DELETE FROM assignment_records WHERE room_id = ?").run(DEFAULT_ROOM_ID);
  }
  private insertContinuationAudit(event: ContinuationAuditEvent) { this.database.prepare("INSERT INTO continuation_job_events(room_id, job_id, job_revision, event_id, occurred_at, projection_json) VALUES (?, ?, ?, ?, ?, ?)").run(DEFAULT_ROOM_ID, event.jobId, event.jobRevision, event.eventId, event.at, JSON.stringify(event)); }

  private insertTask(task: Task) {
    this.database.prepare(`INSERT INTO canonical_tasks(room_id, task_id, revision, lifecycle_state, title, description, projection_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(task.roomId, task.taskId, task.revision, task.state, task.title, task.description, JSON.stringify(task), task.createdAt, task.updatedAt);
  }

  private insertTaskEvent(event: TaskEvent) {
    this.database.prepare(`INSERT INTO canonical_task_events(room_id, task_id, revision, actor_id, occurred_at, change_json, snapshot_json) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(event.roomId, event.taskId, event.revision, event.actorId, event.at, JSON.stringify(event.change), JSON.stringify(event.snapshot));
  }

  private replaceTaskLinks(task: Task) {
    this.database.prepare("DELETE FROM canonical_task_links WHERE room_id = ? AND task_id = ?").run(task.roomId, task.taskId);
    const insert = this.database.prepare("INSERT INTO canonical_task_links(room_id, task_id, link_kind, target_task_id) VALUES (?, ?, ?, ?)");
    for (const link of task.dependencies) insert.run(task.roomId, task.taskId, "dependency", link.taskId);
    for (const link of task.blockers) insert.run(task.roomId, task.taskId, "blocker", link.taskId);
  }

  private createsTaskDependencyCycle(source: TaskIdentity, target: TaskIdentity) {
    if (source.roomId !== target.roomId || source.taskId === target.taskId) return true;
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
    const row = this.database.prepare("SELECT * FROM rooms WHERE id = ?").get(DEFAULT_ROOM_ID) as unknown as RoomRow | undefined;
    if (!row) throw new Error("The SQLite default room does not exist.");
    const participantStyles = normalizeParticipantStyles(parseJson(row.participant_styles_json, {}));
    const configuredProjectPath = process.env.ALL_MY_FRIENDS_ARE_AGENTS_PROJECT_PATH || process.env.AGENTWIRE_PROJECT_PATH;
    const settings: RoomSettings = {
      roomName: row.name,
      topic: row.topic,
      writableAgent: normalizeWritableAgent(row.writable_agent),
      conversationEnergy: isConversationEnergy(row.conversation_energy) ? row.conversation_energy : "balanced",
      projectPath: configuredProjectPath || row.project_path || this.projectRoot,
      participantStyles,
    };
    const storedRosterEntries: Array<Record<string, unknown> & { agentId: string; enabled: boolean }> = (
      this.database.prepare("SELECT agent_id, enabled, configuration_json FROM room_agents WHERE room_id = ? ORDER BY position, agent_id").all(DEFAULT_ROOM_ID) as unknown as Array<{ agent_id: string; enabled: number; configuration_json: string }>
    ).map((entry) => ({ ...parseJson<Record<string, unknown>>(entry.configuration_json, {}), agentId: entry.agent_id, enabled: Boolean(entry.enabled) }));
    const roster = normalizeRoomAgentRoster({ revision: row.roster_revision, entries: storedRosterEntries });
    const enabledAgents = new Set(enabledRoomAgentIds(roster));
    if (settings.writableAgent !== "nobody" && !enabledAgents.has(settings.writableAgent)) settings.writableAgent = "nobody";
    const messages = (this.database.prepare("SELECT * FROM messages WHERE room_id = ? ORDER BY row_id").all(DEFAULT_ROOM_ID) as unknown as MessageRow[])
      .map((message) => messageFromRow(message, participantStyles));
    const sessions: Partial<Record<AgentId, AgentSession>> = {};
    for (const session of this.database.prepare("SELECT * FROM agent_sessions WHERE room_id = ?").all(DEFAULT_ROOM_ID) as unknown as SessionRow[]) {
      if (isActiveAgentId(session.agent_id) && enabledAgents.has(session.agent_id) && (session.permission === "read-only" || session.permission === "writable")) {
        const entry = roomAgentEntry(roster, session.agent_id);
        if (entry?.modelId === "configured") continue;
        const fingerprint = entry ? participantConfigurationFingerprint(entry) : undefined;
        const rawHarness = storedRosterEntries.find((candidate) => candidate.agentId === session.agent_id)?.harness;
        if (session.configuration_fingerprint !== fingerprint && (session.configuration_fingerprint || rawHarness !== "opencode")) continue;
        sessions[session.agent_id] = { id: session.provider_session_id, permission: session.permission, configurationFingerprint: fingerprint, configurationRevision: session.configuration_revision || entry?.configurationRevision || 1 };
      }
    }
    return {
      messages,
      sessions,
      settings,
      roster,
      status: row.status === "working" || row.status === "error" ? row.status : "idle",
      ...(isAgentId(row.active_agent) ? { activeAgent: row.active_agent } : {}),
      ...(row.error ? { error: row.error } : {}),
    };
  }

  private insertMessage(message: RoomMessage) {
    this.database.prepare(`
      INSERT INTO messages(
        id, room_id, speaker, speaker_name, human_id, text, kind, style_json,
        burst_id, burst_sequence, client_message_id, created_at, mentions_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      message.id,
      DEFAULT_ROOM_ID,
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
      DEFAULT_ROOM_ID,
    );
  }

  private upsertSession(agent: AgentId, id: string, permission: "read-only" | "writable", fingerprint?: string, configurationRevision?: number) {
    this.database.prepare(`
      INSERT INTO agent_sessions(room_id, agent_id, provider_session_id, permission, configuration_fingerprint, configuration_revision, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(room_id, agent_id) DO UPDATE SET
        provider_session_id = excluded.provider_session_id,
        permission = excluded.permission,
        configuration_fingerprint = excluded.configuration_fingerprint,
        configuration_revision = excluded.configuration_revision,
        updated_at = excluded.updated_at
    `).run(DEFAULT_ROOM_ID, agent, id, permission, fingerprint || null, configurationRevision || null, new Date().toISOString());
  }

  private upsertRosterAgent(entry: RoomAgentRosterEntry) {
    const now = new Date().toISOString();
    this.database.prepare(`INSERT INTO agents(id, display_name, provider, model_id, configuration_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name, provider = excluded.provider, model_id = excluded.model_id, configuration_json = excluded.configuration_json, updated_at = excluded.updated_at`)
      .run(entry.agentId, entry.conversationalName || entry.agentId, "opencode", entry.modelId || "configured", JSON.stringify(entry), now, now);
  }

  private insertImprovementEvent(event: ImprovementEvent) {
    this.database.prepare(`
      INSERT INTO canonical_improvement_events(
        room_id, improvement_id, revision, actor_id, occurred_at, change_json, snapshot_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      DEFAULT_ROOM_ID,
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
      DEFAULT_ROOM_ID,
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
      DEFAULT_ROOM_ID,
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
function capacityArchiveAudit(record: ContinuationRecord, fromStatus: ContinuationRecord["status"], at: string): ContinuationAuditEvent { return finalizeContinuationAudit(record, { schemaVersion: 1, eventId: `archive-${record.jobId}-${record.jobRevision}`, jobId: record.jobId, jobRevision: record.jobRevision, attempt: record.usage.attempts, trigger: record.trigger, policyRevision: record.policyRevision, provenanceHash: continuationProvenanceHash(record), at, action: "INBOX_ARCHIVED", fromStatus, toStatus: record.status, usage: record.usage, attemptUsage: { elapsedMs: 0, tokens: 0, toolCalls: 0 }, result: "Inbox result archived by bounded retention policy.", nextEligibilityAt: record.nextEligibilityAt }); }

function samePersistedRoomState(left: RoomState, right: RoomState) {
  return JSON.stringify(left.messages) === JSON.stringify(right.messages)
    && JSON.stringify(left.sessions) === JSON.stringify(right.sessions)
    && JSON.stringify(left.settings) === JSON.stringify(right.settings)
    && JSON.stringify(normalizeRoomAgentRoster(left.roster)) === JSON.stringify(normalizeRoomAgentRoster(right.roster))
    && left.status === right.status
    && left.activeAgent === right.activeAgent
    && left.error === right.error;
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
