import { chmod, mkdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { normalizeParticipantStyles, sanitizeChatStyle, type ChatStyle, type StyledParticipant } from "../../shared/chat-style.js";
import { isConversationEnergy } from "../../shared/conversation-energy.js";
import {
  applyImprovementChange as applyDomainImprovementChange,
  type DomainActor,
  type Improvement,
  type ImprovementChange,
} from "../../shared/improvement-domain.js";
import { AGENT_IDS, AGENT_PROFILES, isActiveAgentId, isAgentId, isParticipantId, normalizeWritableAgent } from "../../shared/participants.js";
import { createDefaultRoomState } from "../room-store.js";
import type { AgentId, AgentSession, RoomMessage, RoomSettings, RoomState, SpeakerId } from "../types.js";
import { CLEAR_EMERGENCY_STOP, emergencyStopProjection, paginateImprovements } from "./improvement-storage.js";
import type {
  CreateImprovementResult,
  EmergencyStopChangeResult,
  EmergencyStopProjection,
  ImprovementEvent,
  ImprovementListQuery,
  RoomRepository,
} from "./room-repository.js";
import { runSqliteMigrations } from "./sqlite-migrations.js";

export const DEFAULT_ROOM_ID = "00000000-0000-4000-8000-000000000001";
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
}

interface SessionRow {
  agent_id: string;
  provider_session_id: string;
  permission: AgentSession["permission"];
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
  };
}

function messageFor(
  state: RoomState,
  speaker: RoomMessage["speaker"],
  text: string,
  kind: RoomMessage["kind"] = "chat",
  style?: ChatStyle,
  burst?: { burstId: string; sequence: number },
  human?: { id: string; name: string; clientMessageId?: string },
): RoomMessage {
  const participant = isParticipantId(speaker) ? speaker : undefined;
  const messageStyle = participant
    ? sanitizeChatStyle(style, state.settings.participantStyles[participant])
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
    ...(human?.clientMessageId ? { clientMessageId: human.clientMessageId } : {}),
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
    options: { initializeDefaultRoom?: boolean } = {},
  ) {
    const databaseDirectory = path.dirname(databasePath);
    await mkdir(databaseDirectory, { recursive: true, mode: 0o700 });
    await chmod(databaseDirectory, 0o700);
    const database = new DatabaseSync(databasePath, { timeout: 5_000, enableForeignKeyConstraints: true });
    database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");
    await runSqliteMigrations(database);
    await restrictDatabaseFiles(databasePath);

    const repository = new SqliteRoomRepository(databasePath, database, projectRoot);
    repository.seedAgents();
    if (!repository.hasPersistedRoom() && options.initializeDefaultRoom !== false) {
      repository.replaceState(createDefaultRoomState(projectRoot));
    } else if (repository.hasPersistedRoom()) {
      repository.state = repository.loadState();
      repository.setStatusSync("idle");
    }
    return repository;
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
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`
        INSERT INTO rooms(
          id, slug, name, topic, writable_agent, conversation_energy, project_path,
          participant_styles_json, status, active_agent, error, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        now,
        now,
      );
      this.database.prepare("DELETE FROM messages WHERE room_id = ?").run(DEFAULT_ROOM_ID);
      this.database.prepare("DELETE FROM agent_sessions WHERE room_id = ?").run(DEFAULT_ROOM_ID);
      this.database.prepare("DELETE FROM room_agents WHERE room_id = ?").run(DEFAULT_ROOM_ID);
      for (const message of state.messages) this.insertMessage(message);
      for (const [agent, session] of Object.entries(state.sessions) as Array<[AgentId, AgentSession]>) {
        this.upsertSession(agent, session.id, session.permission);
      }
      AGENT_IDS.forEach((agent, position) => this.database.prepare(`
        INSERT INTO room_agents(room_id, agent_id, enabled, position, configuration_json, created_at, updated_at)
        VALUES (?, ?, 1, ?, '{}', ?, ?)
      `).run(DEFAULT_ROOM_ID, agent, position, now, now));
      this.database.exec("COMMIT");
      this.state = structuredClone(state);
    } catch (error) {
      this.database.exec("ROLLBACK");
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
    this.upsertSession(agent, id, permission);
    const state = this.snapshot();
    state.sessions[agent] = { id, permission };
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
          room_id, id, revision, state, risk, author_id, created_at, updated_at, projection_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      );
      this.insertImprovementEvent({
        improvementId: snapshot.id,
        revision: 1,
        actorId: snapshot.authorId,
        at: snapshot.createdAt,
        change: "CREATE",
        snapshot,
      });
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
    return row ? parseJson<Improvement>(row.projection_json, undefined as never) : undefined;
  }

  async listImprovements(query: ImprovementListQuery = {}) {
    const rows = this.database.prepare(`
      SELECT projection_json FROM canonical_improvements WHERE room_id = ?
    `).all(DEFAULT_ROOM_ID) as unknown as ImprovementRow[];
    return paginateImprovements(rows.map((row) => parseJson<Improvement>(row.projection_json, undefined as never)), query);
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
      const current = parseJson<Improvement>(row.projection_json, undefined as never);
      const result = applyDomainImprovementChange(current, expectedRevision, change, actor, now);
      if (result.kind !== "accepted") {
        this.database.exec("ROLLBACK");
        return result;
      }
      const snapshot = result.improvement;
      const updated = this.database.prepare(`
        UPDATE canonical_improvements SET
          revision = ?, state = ?, risk = ?, author_id = ?, updated_at = ?, projection_json = ?
        WHERE room_id = ? AND id = ? AND revision = ?
      `).run(
        snapshot.revision,
        snapshot.state,
        snapshot.risk,
        snapshot.authorId,
        snapshot.updatedAt,
        JSON.stringify(snapshot),
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
      snapshot: parseJson<Improvement>(row.snapshot_json, undefined as never),
    }));
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

  private setStatusSync(status: RoomState["status"], activeAgent?: AgentId, error?: string) {
    this.database.prepare("UPDATE rooms SET status = ?, active_agent = ?, error = ?, updated_at = ? WHERE id = ?")
      .run(status, activeAgent || null, error || null, new Date().toISOString(), DEFAULT_ROOM_ID);
    const state = this.snapshot();
    state.status = status;
    state.activeAgent = activeAgent;
    state.error = error;
    this.state = state;
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
    for (const agent of AGENT_IDS) {
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
    const messages = (this.database.prepare("SELECT * FROM messages WHERE room_id = ? ORDER BY row_id").all(DEFAULT_ROOM_ID) as unknown as MessageRow[])
      .map((message) => messageFromRow(message, participantStyles));
    const sessions: Partial<Record<AgentId, AgentSession>> = {};
    for (const session of this.database.prepare("SELECT * FROM agent_sessions WHERE room_id = ?").all(DEFAULT_ROOM_ID) as unknown as SessionRow[]) {
      if (isActiveAgentId(session.agent_id) && (session.permission === "read-only" || session.permission === "writable")) {
        sessions[session.agent_id] = { id: session.provider_session_id, permission: session.permission };
      }
    }
    return {
      messages,
      sessions,
      settings,
      status: row.status === "working" || row.status === "error" ? row.status : "idle",
      ...(isAgentId(row.active_agent) ? { activeAgent: row.active_agent } : {}),
      ...(row.error ? { error: row.error } : {}),
    };
  }

  private insertMessage(message: RoomMessage) {
    this.database.prepare(`
      INSERT INTO messages(
        id, room_id, speaker, speaker_name, human_id, text, kind, style_json,
        burst_id, burst_sequence, client_message_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

  private upsertSession(agent: AgentId, id: string, permission: "read-only" | "writable") {
    this.database.prepare(`
      INSERT INTO agent_sessions(room_id, agent_id, provider_session_id, permission, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(room_id, agent_id) DO UPDATE SET
        provider_session_id = excluded.provider_session_id,
        permission = excluded.permission,
        updated_at = excluded.updated_at
    `).run(DEFAULT_ROOM_ID, agent, id, permission, new Date().toISOString());
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
}
