import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DEFAULT_PARTICIPANT_STYLES, normalizeParticipantStyles, sanitizeChatStyle, type ChatStyle, type StyledParticipant } from "../shared/chat-style.js";
import { DEFAULT_CONVERSATION_ENERGY, isConversationEnergy, migrateMaxRounds } from "../shared/conversation-energy.js";
import {
  applyImprovementChange as applyDomainImprovementChange,
  type ChangeResult,
  type DomainActor,
  type Improvement,
  type ImprovementChange,
} from "../shared/improvement-domain.js";
import { AGENT_PROFILES, isActiveAgentId, isParticipantId, migrateLegacyAgentId, normalizeWritableAgent } from "../shared/participants.js";
import {
  emergencyStopProjection,
  emptyJsonImprovementState,
  normalizeJsonImprovementState,
  paginateImprovements,
  type JsonImprovementState,
} from "./storage/improvement-storage.js";
import type {
  CreateImprovementResult,
  EmergencyStopChangeResult,
  ImprovementEvent,
  ImprovementListQuery,
  RoomRepository,
} from "./storage/room-repository.js";
import type { AgentId, AgentSession, RoomMessage, RoomSettings, RoomState, SpeakerId } from "./types.js";
import type { MessageMention } from "../shared/mentions.js";
import type { RoomContinuationWorkRequest } from "../shared/protocol.js";
import type {
  AddImprovementMilestoneResult,
  ImprovementLedgerRecords,
  ImprovementMilestoneState,
  StoredImprovementMilestone,
} from "../shared/governed-improvements.js";
import { normalizeAssignmentRecord, type AssignmentRecord } from "./assignment-record.js";
import {
  applyTaskChange as applyDomainTaskChange,
  forkTask as forkDomainTask,
  type Task,
  type TaskActor,
  type TaskChange,
  type TaskChangeResult,
  type TaskIdentity,
} from "../shared/task-domain.js";
import { emptyJsonTaskState, normalizeJsonTaskState, paginateTasks, type JsonTaskState } from "./storage/task-storage.js";
import { CANONICAL_ROOM_ID, type CreateTaskResult, type TaskEvent, type TaskListQuery } from "./storage/room-repository.js";
import { canTransitionContinuation, canTransitionContinuationInbox, continuationAuditMatches, continuationInboxMatchesJob, continuationInboxMutationMatches, continuationInboxStartsJobResult, continuationProjectionMatches, continuationProvenanceHash, continuationRecordIsCanonical, continuationRecordProvenanceMatches, finalizeContinuationAudit, normalizeContinuationAuditEvent, normalizeContinuationInboxEntry, normalizeContinuationPolicy, normalizeContinuationRecord, type CasResult, type ContinuationAuditEvent, type ContinuationInboxEntry, type ContinuationPolicy, type ContinuationRecord } from "./continuation-record.js";
import { emptyJsonContinuationState, hasActiveOwner, normalizeJsonContinuationState, type JsonContinuationState } from "./storage/continuation-storage.js";
import { defaultRoomAgentRoster, enabledRoomAgentIds, normalizeRoomAgentRoster, participantConfigurationFingerprint, participantConfigurationFingerprintMatches, roomAgentEntry, validateRosterEntries, type RoomAgentRosterEntry } from "../shared/roster.js";
import type { RosterChangeResult } from "./storage/room-repository.js";

export const DEFAULT_ROOM_TOPIC = "Open conversation";
export const DEFAULT_ROOM_NAME = "The Agent Room";
function styledParticipant(speaker: RoomMessage["speaker"]): StyledParticipant | undefined {
  return isParticipantId(speaker) ? speaker : undefined;
}

function migrateSpeaker(speaker: unknown): SpeakerId {
  if (speaker === "you" || speaker === "system") return speaker;
  return migrateLegacyAgentId(speaker) || "system";
}

function migrateSessions(input: unknown, roster = defaultRoomAgentRoster(), storedRoster?: unknown) {
  const value = input && typeof input === "object" ? input as Record<string, AgentSession> : {};
  const rawEntries = storedRoster && typeof storedRoster === "object" && Array.isArray((storedRoster as { entries?: unknown }).entries)
    ? (storedRoster as { entries: Array<{ agentId?: unknown; harness?: unknown }> }).entries
    : [];
  const sessions: Partial<Record<AgentId, AgentSession>> = {};
  for (const [rawAgent, session] of Object.entries(value)) {
    const agent = migrateLegacyAgentId(rawAgent);
    const entry = agent ? roomAgentEntry(roster, agent) : undefined;
    const fingerprint = entry ? participantConfigurationFingerprint(entry) : undefined;
    const rawHarness = rawEntries.find((candidate) => migrateLegacyAgentId(candidate.agentId) === agent)?.harness;
    const portableOpenCodeSession = Boolean(entry && participantConfigurationFingerprintMatches(session?.configurationFingerprint, entry))
      || !session?.configurationFingerprint && rawHarness === "opencode";
    if (agent && entry && portableOpenCodeSession && session?.id && (session.permission === "read-only" || session.permission === "writable") && entry.modelId !== "configured") {
      sessions[agent] = { ...session, configurationFingerprint: fingerprint, configurationRevision: entry.configurationRevision || 1 };
    }
  }
  return sessions;
}

function sameStyle(left: ChatStyle | undefined, right: ChatStyle) {
  if (!left) return false;
  return left.fontFamily === right.fontFamily
    && left.fontSize === right.fontSize
    && left.textColor === right.textColor
    && left.backgroundColor === right.backgroundColor
    && left.bold === right.bold
    && left.italic === right.italic
    && left.underline === right.underline;
}

function topicMessage(topic: string): RoomMessage {
  return {
    id: randomUUID(),
    speaker: "system",
    text: `Room topic: ${topic}`,
    timestamp: new Date().toISOString(),
    kind: "topic",
  };
}

export function createDefaultRoomState(projectRoot: string): RoomState {
  return {
    messages: [
      {
        id: randomUUID(),
        speaker: "system",
        text: "Welcome to AllMyFriendsAreAgents. Everyone is here—set a topic or start chatting.",
        timestamp: new Date().toISOString(),
        kind: "status",
      },
      topicMessage(DEFAULT_ROOM_TOPIC),
    ],
    sessions: {},
    settings: {
      roomName: DEFAULT_ROOM_NAME,
      topic: DEFAULT_ROOM_TOPIC,
      writableAgent: "nobody",
      conversationEnergy: DEFAULT_CONVERSATION_ENERGY,
      projectPath: process.env.ALL_MY_FRIENDS_ARE_AGENTS_PROJECT_PATH || process.env.AGENTWIRE_PROJECT_PATH || projectRoot,
      participantStyles: structuredClone(DEFAULT_PARTICIPANT_STYLES),
    },
    roster: defaultRoomAgentRoster(),
    status: "idle",
  };
}

export class RoomStore implements RoomRepository {
  readonly stateDirectory: string;
  readonly statePath: string;
  readonly improvementsPath: string;
  readonly assignmentsPath: string;
  readonly tasksPath: string;
  readonly continuationsPath: string;
  private state: RoomState;
  private improvementState: JsonImprovementState;
  private saveQueue: Promise<void> = Promise.resolve();
  private improvementQueue: Promise<void> = Promise.resolve();
  private assignmentQueue: Promise<void> = Promise.resolve();
  private taskQueue: Promise<void> = Promise.resolve();
  private continuationQueue: Promise<void> = Promise.resolve();
  private assignments: AssignmentRecord[];
  private taskState: JsonTaskState;
  private continuationState: JsonContinuationState;

  private constructor(stateDirectory: string, state: RoomState, improvementState: JsonImprovementState, assignments: AssignmentRecord[], taskState: JsonTaskState, continuationState: JsonContinuationState) {
    this.stateDirectory = stateDirectory;
    this.statePath = path.join(stateDirectory, "room.json");
    this.improvementsPath = path.join(stateDirectory, "canonical-improvements.json");
    this.assignmentsPath = path.join(stateDirectory, "assignments.json");
    this.tasksPath = path.join(stateDirectory, "tasks.json");
    this.continuationsPath = path.join(stateDirectory, "continuations.json");
    this.state = state;
    this.improvementState = improvementState;
    this.assignments = assignments;
    this.taskState = taskState;
    this.continuationState = continuationState;
  }

  static async open(projectRoot: string, stateDirectory = path.join(projectRoot, ".allmyfriendsareagents")) {
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    await chmod(stateDirectory, 0o700);
    const statePath = path.join(stateDirectory, "room.json");
    const improvementsPath = path.join(stateDirectory, "canonical-improvements.json");
    const assignmentsPath = path.join(stateDirectory, "assignments.json");
    const tasksPath = path.join(stateDirectory, "tasks.json");
    const continuationsPath = path.join(stateDirectory, "continuations.json");
    const defaultSettings = createDefaultRoomState(projectRoot).settings;
    const improvementState = await readFile(improvementsPath, "utf8")
      .then((contents) => normalizeJsonImprovementState(JSON.parse(contents)))
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return emptyJsonImprovementState();
        throw error;
      });
    const assignments = await readFile(assignmentsPath, "utf8")
      .then((contents) => {
        const parsed = JSON.parse(contents) as { schemaVersion?: unknown; assignments?: unknown } | unknown[];
        const values = Array.isArray(parsed) ? parsed : parsed.schemaVersion === 1 && Array.isArray(parsed.assignments) ? parsed.assignments : [];
        return values.map(normalizeAssignmentRecord).filter((record): record is AssignmentRecord => Boolean(record));
      })
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
    const taskState = await readFile(tasksPath, "utf8")
      .then((contents) => normalizeJsonTaskState(JSON.parse(contents)))
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return emptyJsonTaskState();
        throw error;
      });
    const continuationState = await readFile(continuationsPath, "utf8")
      .then((contents) => normalizeJsonContinuationState(JSON.parse(contents), CANONICAL_ROOM_ID))
      .catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return emptyJsonContinuationState(); throw error; });

    try {
      await chmod(statePath, 0o600);
      const stored = JSON.parse(await readFile(statePath, "utf8")) as RoomState;
      const configuredProjectPath = process.env.ALL_MY_FRIENDS_ARE_AGENTS_PROJECT_PATH || process.env.AGENTWIRE_PROJECT_PATH;
      const storedSettings = stored.settings as RoomSettings & { maxRounds?: unknown; conversationEnergy?: unknown; reviewMode?: unknown };
      const conversationEnergy = isConversationEnergy(storedSettings.conversationEnergy)
        ? storedSettings.conversationEnergy
        : migrateMaxRounds(storedSettings.maxRounds);
      const {
        maxRounds: _legacyMaxRounds,
        reviewMode: _legacyReviewMode,
        ...currentStoredSettings
      } = storedSettings;
      const storedProjectPathExists = await stat(stored.settings.projectPath)
        .then((entry) => entry.isDirectory())
        .catch(() => false);
      const participantStyles = normalizeParticipantStyles(stored.settings.participantStyles);
      const storedRoomName = typeof stored.settings.roomName === "string" && stored.settings.roomName.trim()
        ? stored.settings.roomName.trim()
        : DEFAULT_ROOM_NAME;
      const roomNameWasMissing = typeof stored.settings.roomName !== "string" || !stored.settings.roomName.trim();
      const storedTopic = typeof stored.settings.topic === "string" && stored.settings.topic.trim()
        ? stored.settings.topic.trim()
        : DEFAULT_ROOM_TOPIC;
      const topicWasMissing = typeof stored.settings.topic !== "string" || !stored.settings.topic.trim();
      const roster = normalizeRoomAgentRoster(stored.roster);
      const messages = stored.messages.map((message) => {
        const speaker = migrateSpeaker(message.speaker);
        const migratedMessage = speaker === message.speaker ? message : { ...message, speaker };
        const participant = styledParticipant(speaker);
        if (!participant) return migratedMessage;
        const style = sanitizeChatStyle(message.style, participantStyles[participant] || DEFAULT_PARTICIPANT_STYLES["codex-sol"]);
        const speakerName = speaker !== "you" ? message.speakerName || AGENT_PROFILES[speaker]?.conversationalName || speaker : message.speakerName;
        return sameStyle(message.style, style) && speakerName === message.speakerName ? migratedMessage : { ...migratedMessage, style, ...(speakerName ? { speakerName } : {}) };
      });
      if (topicWasMissing) messages.push(topicMessage(storedTopic));
      const enabledAgents = new Set(enabledRoomAgentIds(roster));
      const sessions = migrateSessions(stored.sessions, roster, stored.roster);
      for (const agent of Object.keys(sessions) as AgentId[]) if (!enabledAgents.has(agent as never)) delete sessions[agent];
      const writableAgent = normalizeWritableAgent(migrateLegacyAgentId(stored.settings.writableAgent) || stored.settings.writableAgent);
      const state: RoomState = {
        ...stored,
        messages,
        sessions: topicWasMissing ? {} : sessions,
        settings: {
          ...defaultSettings,
          ...currentStoredSettings,
          roomName: storedRoomName,
          topic: storedTopic,
          conversationEnergy,
          writableAgent: writableAgent !== "nobody" && enabledAgents.has(writableAgent) ? writableAgent : "nobody",
          projectPath: configuredProjectPath || (storedProjectPathExists ? stored.settings.projectPath : projectRoot),
          participantStyles,
        },
        roster,
        status: "idle",
        activeAgent: undefined,
        error: undefined,
      };
      const store = new RoomStore(stateDirectory, state, improvementState, assignments, taskState, continuationState);
      if (topicWasMissing
        || roomNameWasMissing
        || state.settings.projectPath !== stored.settings.projectPath
        || !stored.settings.participantStyles
        || storedSettings.maxRounds !== undefined
        || storedSettings.reviewMode !== undefined
        || storedSettings.conversationEnergy !== conversationEnergy
        || JSON.stringify(state.sessions) !== JSON.stringify(stored.sessions)
        || state.settings.writableAgent !== stored.settings.writableAgent
        || JSON.stringify(roster) !== JSON.stringify(stored.roster)
        || messages.some((message, index) => message !== stored.messages[index])) {
        await store.save();
      }
      return store;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const store = new RoomStore(stateDirectory, createDefaultRoomState(projectRoot), improvementState, assignments, taskState, continuationState);
      await store.save();
      return store;
    }
  }

  snapshot(): RoomState {
    return structuredClone(this.state);
  }

  async addMessage(
    speaker: RoomMessage["speaker"],
    text: string,
    kind: RoomMessage["kind"] = "chat",
    style?: ChatStyle,
    burst?: { burstId: string; sequence: number },
    human?: { id: string; name: string; clientMessageId?: string; mentions?: MessageMention[]; continuationRequest?: RoomContinuationWorkRequest },
  ) {
    const participant = styledParticipant(speaker);
    const messageStyle = participant
      ? sanitizeChatStyle(style, this.state.settings.participantStyles[participant] || DEFAULT_PARTICIPANT_STYLES["codex-sol"])
      : undefined;
    const message: RoomMessage = {
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
    this.state.messages.push(message);
    await this.save();
    return message;
  }

  async updateSettings(update: Partial<RoomSettings>) {
    this.state.settings = { ...this.state.settings, ...update };
    await this.save();
  }

  async updateRoster(expectedRevision: number, entries: readonly RoomAgentRosterEntry[]): Promise<RosterChangeResult> {
    const validated = validateRosterEntries(entries);
    if (!validated) throw new Error("Invalid room roster entries.");
    const current = normalizeRoomAgentRoster(this.state.roster);
    if (current.revision !== expectedRevision) return { kind: "conflict", expectedRevision, actualRevision: current.revision };
    const nextEntries = validated.map((entry) => {
      const previous = current.entries.find((candidate) => candidate.agentId === entry.agentId);
      if (!previous) return entry;
      const changed = participantConfigurationFingerprint(previous) !== participantConfigurationFingerprint(entry);
      if (!changed) return { ...entry, configurationRevision: previous.configurationRevision || 1 };
      const { selectionConfirmationRequired: _confirmation, ...confirmedEntry } = entry;
      return { ...confirmedEntry, configurationRevision: (previous.configurationRevision || 1) + 1, sessionInvalidationReason: "Model configuration changed; the previous OpenCode session was invalidated." };
    });
    const next = { schemaVersion: 3 as const, revision: current.revision + 1, entries: structuredClone(nextEntries) };
    for (const entry of next.entries) this.state.settings.participantStyles[entry.agentId] ||= structuredClone(DEFAULT_PARTICIPANT_STYLES["codex-sol"]);
    const enabled = new Set(enabledRoomAgentIds(next));
    for (const agent of Object.keys(this.state.sessions) as AgentId[]) {
      const previous = current.entries.find((entry) => entry.agentId === agent);
      const updated = next.entries.find((entry) => entry.agentId === agent);
      if (!enabled.has(agent as never) || !previous || !updated || participantConfigurationFingerprint(previous) !== participantConfigurationFingerprint(updated)) delete this.state.sessions[agent];
    }
    if (this.state.settings.writableAgent !== "nobody" && !enabled.has(this.state.settings.writableAgent)) this.state.settings.writableAgent = "nobody";
    this.state.roster = next;
    await this.save();
    return { kind: "accepted", roster: structuredClone(next) };
  }

  async changeTopic(topic: string) {
    if (topic === this.state.settings.topic) return;
    this.state.settings.topic = topic;
    this.state.sessions = {};
    this.state.messages.push(topicMessage(topic));
    await this.save();
  }

  async updateParticipantStyle(participant: StyledParticipant, style: ChatStyle) {
    this.state.settings.participantStyles[participant] = sanitizeChatStyle(style, this.state.settings.participantStyles[participant]);
    await this.save();
  }

  async setSession(agent: AgentId, id: string, permission: "read-only" | "writable") {
    const entry = roomAgentEntry(this.state.roster, agent);
    this.state.sessions[agent] = { id, permission, ...(entry ? { configurationFingerprint: participantConfigurationFingerprint(entry), configurationRevision: entry.configurationRevision || 1 } : {}) };
    await this.save();
  }

  async clearSession(agent: AgentId) {
    delete this.state.sessions[agent];
    await this.save();
  }

  async setStatus(status: RoomState["status"], activeAgent?: AgentId, error?: string) {
    this.state.status = status;
    this.state.activeAgent = activeAgent;
    this.state.error = error;
    await this.save();
  }

  async createImprovement(improvement: Improvement): Promise<CreateImprovementResult> {
    if (improvement.revision !== 1 || improvement.attribution.at(-1)?.revision !== 1) {
      throw new Error("A newly persisted improvement must be at revision 1.");
    }
    return this.mutateImprovements<CreateImprovementResult>(async (state) => {
      if (state.improvements[improvement.id]) return { result: { kind: "conflict", id: improvement.id } };
      const snapshot = structuredClone(improvement);
      const event: ImprovementEvent = {
        improvementId: snapshot.id,
        revision: 1,
        actorId: snapshot.authorId,
        at: snapshot.createdAt,
        change: "CREATE",
        snapshot,
      };
      return {
        next: {
          ...state,
          improvements: { ...state.improvements, [snapshot.id]: snapshot },
          events: [...state.events, event],
        },
        result: { kind: "created", improvement: structuredClone(snapshot) },
      };
    });
  }

  async getImprovement(id: string) {
    await this.improvementQueue;
    const improvement = this.improvementState.improvements[id];
    return improvement ? structuredClone(improvement) : undefined;
  }

  async listImprovements(query: ImprovementListQuery = {}) {
    await this.improvementQueue;
    return paginateImprovements(Object.values(this.improvementState.improvements), query);
  }

  async applyImprovementChange(
    id: string,
    expectedRevision: number,
    change: ImprovementChange,
    actor: DomainActor,
    now: string,
  ): Promise<ChangeResult> {
    return this.mutateImprovements<ChangeResult>(async (state) => {
      const current = state.improvements[id];
      if (!current) return { result: { kind: "rejected" as const, reason: `Improvement ${id} does not exist` } };
      const result = applyDomainImprovementChange(current, expectedRevision, change, actor, now);
      if (result.kind !== "accepted") return { result };
      if (result.improvement.revision === current.revision) {
        return { result: { kind: "accepted" as const, improvement: structuredClone(current) } };
      }
      const snapshot = structuredClone(result.improvement);
      const event: ImprovementEvent = {
        improvementId: id,
        revision: snapshot.revision,
        actorId: actor.id,
        at: now,
        change: structuredClone(change),
        snapshot,
      };
      return {
        next: {
          ...state,
          improvements: { ...state.improvements, [id]: snapshot },
          events: [...state.events, event],
        },
        result: { kind: "accepted" as const, improvement: structuredClone(snapshot) },
      };
    });
  }

  async listImprovementEvents(id: string, options: { readonly afterRevision?: number; readonly limit?: number } = {}) {
    await this.improvementQueue;
    const limit = Math.max(1, Math.min(100, Math.trunc(options.limit ?? 50)));
    return structuredClone(this.improvementState.events
      .filter((event) => event.improvementId === id && event.revision > (options.afterRevision ?? 0))
      .sort((left, right) => left.revision - right.revision)
      .slice(0, limit));
  }

  async getImprovementLedgerRecords(id: string): Promise<ImprovementLedgerRecords | undefined> {
    await this.improvementQueue;
    const improvement = this.improvementState.improvements[id];
    if (!improvement) return undefined;
    const events = this.improvementState.events
      .filter((event) => event.improvementId === id)
      .sort((left, right) => left.revision - right.revision);
    const introducedEvidence = new Map<string, number>();
    for (const event of events) {
      for (const evidence of event.snapshot.evidence) {
        if (!introducedEvidence.has(evidence.id)) introducedEvidence.set(evidence.id, event.revision);
      }
    }
    return {
      revisions: events.map((event) => ({
        revision: event.revision,
        state: event.snapshot.state,
        status: structuredClone(event.snapshot.statusContract),
        createdAt: event.at,
      })),
      evidence: improvement.evidence.map((evidence) => ({
        id: evidence.id,
        introducedRevision: introducedEvidence.get(evidence.id) ?? improvement.revision,
        sourceClass: "UNQUALIFIED" as const,
        kind: "REFERENCE",
        uri: evidence.uri,
        summary: evidence.description,
        recordedAt: evidence.addedAt,
      })),
      milestones: structuredClone(this.improvementState.milestones.filter((milestone) => milestone.improvementId === id)),
      audit: events.map((event) => ({
        eventId: `revision-${event.revision}`,
        revision: event.revision,
        eventKind: event.revision === 1 ? "CREATED" : "REVISED",
        actorId: event.actorId,
        occurredAt: event.at,
        details: structuredClone(event.change),
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
    return this.mutateImprovements<AddImprovementMilestoneResult>(async (state) => {
      const current = state.improvements[id];
      if (!current) return { result: { kind: "missing_item", canonicalId: id } };
      const previous = state.milestones.findLast((entry) => entry.improvementId === id && entry.id === normalized.id);
      if (previous && previous.state === normalized.state && previous.summary === normalized.summary) {
        return { result: { kind: "accepted", created: false, revision: current.revision, milestone: structuredClone(previous) } };
      }
      if (current.revision !== expectedRevision) {
        return { result: { kind: "conflict", expectedRevision, actualRevision: current.revision } };
      }
      const revision = current.revision + 1;
      const snapshot: Improvement = {
        ...current,
        revision,
        updatedAt: now,
        attribution: [...current.attribution, { actorId: actor.id, at: now, change: `RECORD_MILESTONE:${normalized.id}`, revision }],
      };
      const stored: StoredImprovementMilestone = { improvementId: id, ...normalized, introducedRevision: revision, recordedAt: now };
      const event: ImprovementEvent = {
        improvementId: id,
        revision,
        actorId: actor.id,
        at: now,
        change: { kind: "RECORD_MILESTONE", milestoneId: normalized.id, state: normalized.state, summary: normalized.summary },
        snapshot,
      };
      return {
        next: {
          ...state,
          improvements: { ...state.improvements, [id]: snapshot },
          events: [...state.events, event],
          milestones: [...state.milestones, stored],
        },
        result: { kind: "accepted", created: true, revision, milestone: structuredClone(stored) },
      };
    });
  }

  async getEmergencyStop() {
    await this.improvementQueue;
    return structuredClone(this.improvementState.emergencyStop);
  }

  async updateEmergencyStop(
    expectedRevision: number,
    update: { readonly active: boolean; readonly reason?: string },
    actor: DomainActor,
    now: string,
  ): Promise<EmergencyStopChangeResult> {
    if (!actor.id.trim()) throw new Error("Actor ID must not be empty");
    return this.mutateImprovements<EmergencyStopChangeResult>(async (state) => {
      if (state.emergencyStop.revision !== expectedRevision) {
        return { result: { kind: "conflict", expectedRevision, actualRevision: state.emergencyStop.revision } };
      }
      const emergencyStop = emergencyStopProjection(state.emergencyStop, update, actor.id, now);
      return {
        next: {
          ...state,
          emergencyStop,
          emergencyStopEvents: [
            ...state.emergencyStopEvents,
            { revision: emergencyStop.revision, actorId: actor.id, at: now, snapshot: emergencyStop },
          ],
        },
        result: { kind: "accepted", emergencyStop: structuredClone(emergencyStop) },
      };
    });
  }

  async listAssignments() {
    await this.assignmentQueue;
    return structuredClone(this.assignments);
  }

  async getAssignment(assignmentId: string) {
    await this.assignmentQueue;
    const assignment = this.assignments.find((candidate) => candidate.assignmentId === assignmentId);
    return assignment ? structuredClone(assignment) : undefined;
  }

  async putAssignment(assignment: AssignmentRecord) {
    const normalized = normalizeAssignmentRecord(assignment);
    if (!normalized) throw new Error("Invalid assignment record");
    const operation = this.assignmentQueue.then(async () => {
      const next = this.assignments.filter((candidate) => candidate.assignmentId !== normalized.assignmentId);
      next.push(normalized);
      const temporaryPath = `${this.assignmentsPath}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify({ schemaVersion: 1, assignments: next }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporaryPath, this.assignmentsPath);
      await chmod(this.assignmentsPath, 0o600);
      this.assignments = next;
    });
    this.assignmentQueue = operation.catch(() => undefined);
    await operation;
  }

  async createTask(task: Task): Promise<CreateTaskResult> {
    if (task.roomId !== CANONICAL_ROOM_ID) return { kind: "rejected", reason: `Room repository only owns room ${CANONICAL_ROOM_ID}` };
    if (task.revision !== 1 || task.lifecycleHistory[0]?.operation !== "create") {
      return { kind: "rejected", reason: "A newly persisted task must be a canonical revision 1 task" };
    }
    return this.mutateTasks<CreateTaskResult>((state) => {
      const key = taskKey(task);
      if (state.tasks[key]) return { result: { kind: "conflict" as const, identity: { roomId: task.roomId, taskId: task.taskId } } };
      const snapshot = structuredClone(task);
      const event: TaskEvent = { roomId: task.roomId, taskId: task.taskId, revision: 1, actorId: task.attribution[0]!.actorId, at: task.createdAt, change: "create", snapshot };
      return { next: { schemaVersion: 1, tasks: { ...state.tasks, [key]: snapshot }, events: [...state.events, event] }, result: { kind: "created" as const, task: structuredClone(snapshot) } };
    });
  }

  async createTaskWithChanges(task: Task, changes: readonly TaskChange[], actor: TaskActor, now: string): Promise<CreateTaskResult> {
    if (task.roomId !== CANONICAL_ROOM_ID) return { kind: "rejected", reason: `Room repository only owns room ${CANONICAL_ROOM_ID}` };
    if (task.revision !== 1 || task.lifecycleHistory[0]?.operation !== "create" || task.attribution[0]?.actorId !== actor.id) return { kind: "rejected", reason: "Atomic task creation requires a canonical revision 1 task from the same actor" };
    return this.mutateTasks<CreateTaskResult>((state) => {
      const key = taskKey(task);
      if (state.tasks[key]) return { result: { kind: "conflict" as const, identity: { roomId: task.roomId, taskId: task.taskId } } };
      let current = structuredClone(task);
      const events: TaskEvent[] = [{ roomId: task.roomId, taskId: task.taskId, revision: 1, actorId: actor.id, at: task.createdAt, change: "create", snapshot: structuredClone(task) }];
      for (const change of changes) {
        if (change.kind === "add_dependency" || change.kind === "add_blocker") {
          if (!state.tasks[taskKey(change.task)]) return { result: { kind: "rejected" as const, reason: `Linked task ${change.task.taskId} does not exist in room ${change.task.roomId}` } };
          if (change.kind === "add_dependency" && createsDependencyCycle({ ...state.tasks, [key]: current }, task, change.task)) return { result: { kind: "rejected" as const, reason: "Task dependency would create a direct or transitive cycle" } };
        }
        const changed = applyDomainTaskChange(current, current.revision, change, actor, now);
        if (changed.kind !== "accepted") return { result: { kind: "rejected" as const, reason: changed.kind === "rejected" ? changed.reason : "Atomic task creation conflicted" } };
        current = structuredClone(changed.task);
        events.push({ roomId: task.roomId, taskId: task.taskId, revision: current.revision, actorId: actor.id, at: now, change: structuredClone(change), snapshot: current });
      }
      return { next: { schemaVersion: 1, tasks: { ...state.tasks, [key]: current }, events: [...state.events, ...events] }, result: { kind: "created" as const, task: structuredClone(current) } };
    });
  }

  async getTask(identity: TaskIdentity) {
    await this.taskQueue;
    const task = this.taskState.tasks[taskKey(identity)];
    return task ? structuredClone(task) : undefined;
  }

  async listTasks(query: TaskListQuery = {}) {
    await this.taskQueue;
    return paginateTasks(Object.values(this.taskState.tasks), query);
  }

  async applyTaskChange(identity: TaskIdentity, expectedRevision: number, change: TaskChange, actor: TaskActor, now: string): Promise<TaskChangeResult> {
    return this.applyTaskChanges(identity, expectedRevision, [change], actor, now);
  }

  async applyTaskChanges(identity: TaskIdentity, expectedRevision: number, changes: readonly TaskChange[], actor: TaskActor, now: string): Promise<TaskChangeResult> {
    return this.mutateTasks<TaskChangeResult>((state) => {
      let current = state.tasks[taskKey(identity)];
      if (!current) return { result: { kind: "rejected" as const, reason: `Task ${identity.taskId} does not exist in room ${identity.roomId}` } };
      if (!changes.length) return { result: { kind: "rejected" as const, reason: "At least one task change is required" } };
      const events: TaskEvent[] = [];
      let stagedTasks = state.tasks;
      let revision = expectedRevision;
      for (const change of changes) {
        if (change.kind === "add_dependency" || change.kind === "add_blocker") {
          if (!stagedTasks[taskKey(change.task)]) return { result: { kind: "rejected" as const, reason: `Linked task ${change.task.taskId} does not exist in room ${change.task.roomId}` } };
          if (change.kind === "add_dependency" && createsDependencyCycle(stagedTasks, identity, change.task)) return { result: { kind: "rejected" as const, reason: "Task dependency would create a direct or transitive cycle" } };
        }
        const result = applyDomainTaskChange(current, revision, change, actor, now);
        if (result.kind !== "accepted") return { result };
        current = structuredClone(result.task);
        revision = current.revision;
        stagedTasks = { ...stagedTasks, [taskKey(identity)]: current };
        events.push({ roomId: identity.roomId, taskId: identity.taskId, revision: current.revision, actorId: actor.id, at: now, change: structuredClone(change), snapshot: current });
      }
      return { next: { schemaVersion: 1, tasks: stagedTasks, events: [...state.events, ...events] }, result: { kind: "accepted" as const, task: structuredClone(current) } };
    });
  }

  async listTaskEvents(identity: TaskIdentity, options: { readonly afterRevision?: number; readonly limit?: number } = {}) {
    await this.taskQueue;
    const limit = Math.max(1, Math.min(100, Math.trunc(options.limit ?? 50)));
    return structuredClone(this.taskState.events.filter((event) => event.roomId === identity.roomId && event.taskId === identity.taskId && event.revision > (options.afterRevision ?? 0)).sort((a, b) => a.revision - b.revision).slice(0, limit));
  }

  async getTaskDependencies(identity: TaskIdentity) {
    await this.taskQueue;
    const task = this.taskState.tasks[taskKey(identity)];
    if (!task) return undefined;
    const dependents = Object.values(this.taskState.tasks).filter((candidate) => candidate.dependencies.some((dependency) => dependency.roomId === identity.roomId && dependency.taskId === identity.taskId)).map(({ roomId, taskId }) => ({ roomId, taskId }));
    return { dependencies: structuredClone(task.dependencies), blockers: structuredClone(task.blockers), dependents };
  }

  async forkTask(source: TaskIdentity, expectedRevision: number, newTaskId: string, actor: TaskActor, now: string, title?: string): Promise<TaskChangeResult> {
    return this.mutateTasks<TaskChangeResult>((state) => {
      const current = state.tasks[taskKey(source)];
      if (!current) return { result: { kind: "rejected" as const, reason: `Task ${source.taskId} does not exist in room ${source.roomId}` } };
      if (current.revision !== expectedRevision) return { result: { kind: "conflict" as const, expectedRevision, actualRevision: current.revision } };
      const identity = { roomId: source.roomId, taskId: newTaskId };
      if (state.tasks[taskKey(identity)]) return { result: { kind: "rejected" as const, reason: `Task ${newTaskId} already exists` } };
      const result = forkDomainTask(current, expectedRevision, { taskId: newTaskId, title, actor, now });
      if (result.kind !== "accepted") return { result };
      const snapshot = structuredClone(result.task);
      const event: TaskEvent = { roomId: snapshot.roomId, taskId: snapshot.taskId, revision: 1, actorId: actor.id, at: now, change: { kind: "fork", source }, snapshot };
      return { next: { schemaVersion: 1, tasks: { ...state.tasks, [taskKey(snapshot)]: snapshot }, events: [...state.events, event] }, result: { kind: "accepted" as const, task: structuredClone(snapshot) } };
    });
  }

  async getContinuationPolicy() { await this.continuationQueue; return this.continuationState.policy ? structuredClone(this.continuationState.policy) : undefined; }
  async compareAndSetContinuationPolicy(expectedRevision: number, policy: ContinuationPolicy): Promise<CasResult<ContinuationPolicy>> {
    const value = normalizeContinuationPolicy(policy); if (!value || value.roomId !== CANONICAL_ROOM_ID || value.revision !== expectedRevision + 1) throw new Error("Invalid continuation policy");
    return this.mutateContinuations<CasResult<ContinuationPolicy>>((state) => {
      const actual = state.policy?.revision ?? 0; if (actual !== expectedRevision) return { result: { kind: "conflict" as const, actualRevision: actual } };
      if (state.policy && (state.policy.roomId !== value.roomId || state.policy.projectPathHash !== value.projectPathHash || state.policy.policyVersion !== value.policyVersion)) throw new Error("Continuation policy provenance is immutable");
      return { next: { ...state, policy: value }, result: { kind: "accepted" as const, value: structuredClone(value) } };
    });
  }
  async listContinuations(owner?: AgentId) { await this.continuationQueue; return structuredClone(Object.values(this.continuationState.jobs).filter((job) => !owner || job.owner === owner).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.jobId.localeCompare(b.jobId))); }
  async getContinuation(jobId: string) { await this.continuationQueue; const job = this.continuationState.jobs[jobId]; return job ? structuredClone(job) : undefined; }
  async createContinuation(record: ContinuationRecord, event: ContinuationAuditEvent): Promise<CasResult<ContinuationRecord>> {
    const value = normalizeContinuationRecord(record); const audit = normalizeContinuationAuditEvent(event); if (!value || !continuationRecordIsCanonical(value, CANONICAL_ROOM_ID) || value.jobRevision !== 1 || value.status !== "QUEUED" || !continuationAuditMatches(null, value, audit)) throw new Error("Invalid initial continuation");
    return this.mutateContinuations<CasResult<ContinuationRecord>>((state) => {
      if (state.jobs[value.jobId] || hasActiveOwner(state, value.owner)) return { result: { kind: "conflict" as const } };
      return { next: { ...state, jobs: { ...state.jobs, [value.jobId]: value }, events: [...state.events, audit!] }, result: { kind: "accepted" as const, value: structuredClone(value) } };
    });
  }
  async compareAndSetContinuation(expectedRevision: number, record: ContinuationRecord, event: ContinuationAuditEvent): Promise<CasResult<ContinuationRecord>> {
    const value = normalizeContinuationRecord(record); const audit = normalizeContinuationAuditEvent(event); if (!value || value.jobRevision !== expectedRevision + 1) throw new Error("Invalid continuation CAS revision");
    return this.mutateContinuations<CasResult<ContinuationRecord>>((state) => {
      const current = state.jobs[value.jobId]; if (!current) return { result: { kind: "not_found" as const } };
      if (current.jobRevision !== expectedRevision) return { result: { kind: "conflict" as const, actualRevision: current.jobRevision } };
      if (!continuationRecordIsCanonical(value, CANONICAL_ROOM_ID) || !continuationRecordProvenanceMatches(current, value)) throw new Error("Continuation provenance is immutable");
      if (!canTransitionContinuation(current.status, value.status)) return { result: { kind: "conflict" as const, actualRevision: current.jobRevision } };
      if (!continuationAuditMatches(current, value, audit)) throw new Error("Invalid continuation audit event");
      if (hasActiveOwner(state, value.owner, value.jobId) && ["QUEUED", "RUNNING", "WAITING_TOOL", "BLOCKED"].includes(value.status)) return { result: { kind: "conflict" as const } };
      return { next: { ...state, jobs: { ...state.jobs, [value.jobId]: value }, events: [...state.events, audit!] }, result: { kind: "accepted" as const, value: structuredClone(value) } };
    });
  }
  async completeContinuation(expectedRevision: number, record: ContinuationRecord, entry: ContinuationInboxEntry, maxEntries: number, event: ContinuationAuditEvent): Promise<CasResult<ContinuationRecord>> {
    const job = normalizeContinuationRecord(record); const inbox = normalizeContinuationInboxEntry(entry); const audit = normalizeContinuationAuditEvent(event);
    if (!job || !inbox || !continuationRecordIsCanonical(job, CANONICAL_ROOM_ID) || inbox.roomId !== CANONICAL_ROOM_ID || !continuationInboxStartsJobResult(inbox, job) || job.jobRevision !== expectedRevision + 1) throw new Error("Invalid atomic completion");
    return this.mutateContinuations<CasResult<ContinuationRecord>>((state) => {
      const current = state.jobs[job.jobId]; if (!current) return { result: { kind: "not_found" as const } };
      if (current.jobRevision !== expectedRevision || state.inbox[inbox.inboxEntryId]) return { result: { kind: "conflict" as const, actualRevision: current.jobRevision } };
      if (!continuationRecordProvenanceMatches(current, job)) throw new Error("Continuation provenance is immutable");
      if (!canTransitionContinuation(current.status, job.status)) return { result: { kind: "conflict" as const, actualRevision: current.jobRevision } };
      if (!continuationAuditMatches(current, job, audit)) throw new Error("Invalid completion audit event");
      const nextInbox = { ...state.inbox, [inbox.inboxEntryId]: inbox };
      const nextJobs = { ...state.jobs, [job.jobId]: job };
      const nextEvents = [...state.events, audit!];
      const live = Object.values(nextInbox).filter((item) => item.owner === inbox.owner && (item.status === "UNREAD" || item.status === "ACKNOWLEDGED")).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.inboxEntryId.localeCompare(b.inboxEntryId));
      for (const stale of live.slice(0, Math.max(0, live.length - Math.max(1, maxEntries)))) { const archivedInbox = { ...stale, inboxRevision: stale.inboxRevision + 1, status: "ARCHIVED" as const, updatedAt: inbox.createdAt, closedAt: inbox.createdAt }; if (!continuationInboxMutationMatches(stale, archivedInbox, true)) throw new Error("Invalid capacity inbox archive"); nextInbox[stale.inboxEntryId] = archivedInbox; const staleJob = nextJobs[stale.jobId]; if (staleJob?.resultDisposition === "INBOX") { const archivedJob = { ...staleJob, jobRevision: staleJob.jobRevision + 1, resultDisposition: "ARCHIVED" as const, updatedAt: inbox.createdAt }; const archiveEvent = capacityArchiveAudit(archivedJob, staleJob.status, inbox.createdAt); if (!continuationAuditMatches(staleJob, archivedJob, archiveEvent)) throw new Error("Invalid archived continuation projection"); nextJobs[stale.jobId] = archivedJob; nextEvents.push(archiveEvent); } }
      return { next: { ...state, jobs: nextJobs, inbox: nextInbox, events: nextEvents }, result: { kind: "accepted" as const, value: structuredClone(job) } };
    });
  }
  async listContinuationAudit(jobId: string) { await this.continuationQueue; return structuredClone(this.continuationState.events.filter((event) => event.jobId === jobId).sort((a, b) => a.jobRevision - b.jobRevision || a.eventId.localeCompare(b.eventId))); }
  async listContinuationInbox(owner: AgentId) { await this.continuationQueue; return structuredClone(Object.values(this.continuationState.inbox).filter((entry) => entry.owner === owner).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.inboxEntryId.localeCompare(b.inboxEntryId))); }
  async getContinuationInboxEntry(inboxEntryId: string) { await this.continuationQueue; const entry = this.continuationState.inbox[inboxEntryId]; return entry ? structuredClone(entry) : undefined; }
  async compareAndSetContinuationInbox(expectedRevision: number, entry: ContinuationInboxEntry): Promise<CasResult<ContinuationInboxEntry>> {
    const value = normalizeContinuationInboxEntry(entry); if (!value || value.inboxRevision !== expectedRevision + 1) throw new Error("Invalid inbox CAS revision");
    return this.mutateContinuations<CasResult<ContinuationInboxEntry>>((state) => { const current = state.inbox[value.inboxEntryId]; if (!current) return { result: { kind: "not_found" as const } }; if (current.inboxRevision !== expectedRevision || !canTransitionContinuationInbox(current.status, value.status) || value.status === "ARCHIVED") return { result: { kind: "conflict" as const, actualRevision: current.inboxRevision } }; if (value.roomId !== CANONICAL_ROOM_ID || !continuationInboxMutationMatches(current, value, false)) throw new Error("Invalid continuation inbox mutation or immutable provenance"); return { next: { ...state, inbox: { ...state.inbox, [value.inboxEntryId]: value } }, result: { kind: "accepted" as const, value: structuredClone(value) } }; });
  }
  async archiveContinuationInbox(expectedRevision: number, entry: ContinuationInboxEntry): Promise<CasResult<ContinuationInboxEntry>> {
    const value = normalizeContinuationInboxEntry(entry); if (!value || value.status !== "ARCHIVED" || value.inboxRevision !== expectedRevision + 1) throw new Error("Invalid inbox archive");
    return this.mutateContinuations<CasResult<ContinuationInboxEntry>>((state) => { const current = state.inbox[value.inboxEntryId]; if (!current) return { result: { kind: "not_found" as const } }; if (current.inboxRevision !== expectedRevision) return { result: { kind: "conflict" as const, actualRevision: current.inboxRevision } }; if (value.roomId !== CANONICAL_ROOM_ID || !continuationInboxMutationMatches(current, value, true)) throw new Error("Invalid continuation inbox archive or immutable provenance"); const job = state.jobs[current.jobId]; if (!job) return { result: { kind: "not_found" as const } }; if (!continuationInboxMatchesJob(value, job)) throw new Error("Continuation inbox provenance does not match its job"); const archivedJob = { ...job, jobRevision: job.jobRevision + 1, resultDisposition: "ARCHIVED" as const, updatedAt: value.updatedAt }; const archiveEvent = capacityArchiveAudit(archivedJob, job.status, value.updatedAt); if (!continuationAuditMatches(job, archivedJob, archiveEvent)) throw new Error("Invalid archived continuation projection"); return { next: { ...state, inbox: { ...state.inbox, [value.inboxEntryId]: value }, jobs: { ...state.jobs, [job.jobId]: archivedJob }, events: [...state.events, archiveEvent] }, result: { kind: "accepted" as const, value: structuredClone(value) } }; });
  }

  private async mutateImprovements<T>(
    mutation: (state: JsonImprovementState) => Promise<{ next?: JsonImprovementState; result: T }>,
  ): Promise<T> {
    let resolveResult!: (result: T) => void;
    let rejectResult!: (error: unknown) => void;
    const result = new Promise<T>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    const operation = this.improvementQueue.then(async () => {
      try {
        const mutationResult = await mutation(this.improvementState);
        if (mutationResult.next) {
          const temporaryPath = `${this.improvementsPath}.tmp`;
          await writeFile(temporaryPath, `${JSON.stringify(mutationResult.next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
          await rename(temporaryPath, this.improvementsPath);
          await chmod(this.improvementsPath, 0o600);
          this.improvementState = mutationResult.next;
        }
        resolveResult(mutationResult.result);
      } catch (error) {
        rejectResult(error);
        throw error;
      }
    });
    this.improvementQueue = operation.catch(() => undefined);
    return result;
  }

  private async mutateTasks<T>(mutation: (state: JsonTaskState) => { next?: JsonTaskState; result: T }): Promise<T> {
    let resolveResult!: (result: T) => void;
    let rejectResult!: (error: unknown) => void;
    const result = new Promise<T>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
    const operation = this.taskQueue.then(async () => {
      try {
        const mutationResult = mutation(this.taskState);
        if (mutationResult.next) {
          const temporaryPath = `${this.tasksPath}.tmp`;
          await writeFile(temporaryPath, `${JSON.stringify(mutationResult.next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
          await rename(temporaryPath, this.tasksPath);
          await chmod(this.tasksPath, 0o600);
          this.taskState = mutationResult.next;
        }
        resolveResult(mutationResult.result);
      } catch (error) { rejectResult(error); throw error; }
    });
    this.taskQueue = operation.catch(() => undefined);
    return result;
  }

  private async mutateContinuations<T>(mutation: (state: JsonContinuationState) => { next?: JsonContinuationState; result: T }): Promise<T> {
    let resolveResult!: (result: T) => void; let rejectResult!: (error: unknown) => void;
    const result = new Promise<T>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
    const operation = this.continuationQueue.then(async () => { try { const changed = mutation(this.continuationState); if (changed.next) { const next = normalizeJsonContinuationState(changed.next, CANONICAL_ROOM_ID); const temporaryPath = `${this.continuationsPath}.tmp`; await writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 }); await rename(temporaryPath, this.continuationsPath); await chmod(this.continuationsPath, 0o600); this.continuationState = next; } resolveResult(changed.result); } catch (error) { rejectResult(error); throw error; } });
    this.continuationQueue = operation.catch(() => undefined); return result;
  }

  private async save() {
    const operation = this.saveQueue.then(async () => {
      const temporaryPath = `${this.statePath}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify(this.state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporaryPath, this.statePath);
      await chmod(this.statePath, 0o600);
    });
    this.saveQueue = operation.catch(() => undefined);
    await operation;
  }
}

function taskKey(identity: TaskIdentity) { return `${identity.roomId}\u0000${identity.taskId}`; }
function capacityArchiveAudit(record: ContinuationRecord, fromStatus: ContinuationRecord["status"], at: string): ContinuationAuditEvent { return finalizeContinuationAudit(record, { schemaVersion: 1, eventId: `archive-${record.jobId}-${record.jobRevision}`, jobId: record.jobId, jobRevision: record.jobRevision, attempt: record.usage.attempts, trigger: record.trigger, policyRevision: record.policyRevision, provenanceHash: continuationProvenanceHash(record), at, action: "INBOX_ARCHIVED", fromStatus, toStatus: record.status, usage: record.usage, attemptUsage: { elapsedMs: 0, tokens: 0, toolCalls: 0 }, result: "Inbox result archived by bounded retention policy.", nextEligibilityAt: record.nextEligibilityAt }); }

function createsDependencyCycle(tasks: Record<string, Task>, source: TaskIdentity, target: TaskIdentity) {
  if (source.roomId !== target.roomId || source.taskId === target.taskId) return true;
  const visited = new Set<string>();
  const visit = (identity: TaskIdentity): boolean => {
    const key = taskKey(identity);
    if (key === taskKey(source)) return true;
    if (visited.has(key)) return false;
    visited.add(key);
    return (tasks[key]?.dependencies ?? []).some(visit);
  };
  return visit(target);
}

function normalizeMilestoneInput(milestone: { readonly id: string; readonly state: ImprovementMilestoneState; readonly summary: string }) {
  const id = milestone.id.trim();
  const summary = milestone.summary.trim().replace(/\s+/g, " ");
  if (!id || !summary || !["PENDING", "ACHIEVED", "BLOCKED", "CANCELED"].includes(milestone.state)) return undefined;
  return { id, state: milestone.state, summary } as const;
}
