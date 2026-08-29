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
import { normalizeDeploymentEpoch, normalizeDeploymentProvenance, type DeploymentProvenance } from "./deployment-provenance.js";
import type { AgentContextSummaryKey } from "./transcript.js";
import { defaultRoomConfiguration, normalizeRoomConfiguration, type RoomConfigurationUpdate } from "./room-configuration.js";
import { emptyJsonCommandState, normalizeJsonCommandState, validAttempt, validAudit, validCommandAcceptance, validCommandReassignment, validDiagnostic, validGhExecution, validPoll, validPovExecution, validRoundRobin, validSubmission, validVote, type JsonCommandState } from "./storage/command-storage.js";
import { COMMAND_RECORD_RETENTION_MS, DIAGNOSTIC_RETENTION_MS, MAX_COMMAND_SUBMISSIONS_PER_ROOM, MAX_COMMAND_TOMBSTONES_PER_ROOM, MAX_DIAGNOSTICS_PER_ROOM_AGENT, MAX_DIAGNOSTIC_QUERY_LIMIT, MAX_DIAGNOSTIC_SEARCH_LENGTH, MAX_OPEN_POLLS_PER_ROOM, MAX_RECENT_POLLS, parseCommandPollCursor, type AcceptCommandResult, type CloseCommandPollResult, type CommandAcceptance, type CommandAttempt, type CommandAuditIdentity, type CommandGhExecution, type CommandInvoker, type CommandPoll, type CommandPovExecution, type CommandReassignment, type CommandSubmission, type CommandVote, type CreateCommandSubmissionResult, type CreateCommandVoteResult, type DiagnosticQuery, type DiagnosticRecord, type RoundRobinState } from "./command-record.js";
import type { SourceWorkKind } from "./storage/identity-domain.js";

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
    // Legacy writable sessions are authority-bearing and cannot survive the
    // durable-identity boundary. A trusted server flow must create a fresh one.
    if (agent && entry && portableOpenCodeSession && session?.id && session.permission === "read-only" && entry.modelId !== "configured") {
      const codeEpoch = normalizeDeploymentEpoch(session.codeEpoch);
      sessions[agent] = {
        id: session.id,
        permission: session.permission,
        configurationFingerprint: fingerprint,
        configurationRevision: entry.configurationRevision || 1,
        ...(codeEpoch ? { codeEpoch } : {}),
      };
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

function validAttemptTransition(from: CommandAttempt["status"], to: CommandAttempt["status"]) {
  return (from === "queued" && ["active", "failed", "superseded"].includes(to))
    || (from === "active" && ["delivery-pending", "completed", "failed", "superseded"].includes(to))
    || (from === "delivery-pending" && to === "completed");
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
    roomConfiguration: defaultRoomConfiguration(),
    status: "idle",
  };
}

export class RoomStore implements RoomRepository {
  readonly roomId = CANONICAL_ROOM_ID;
  private readonly bootSourceWork = new Set<string>();
  /** JSON remains a migration source and cannot attest source-work authority. */
  async getSourceWorkBinding(_kind: SourceWorkKind, _workId: string) { return undefined; }
  authorizeSourceWorkForCurrentBoot(kind: SourceWorkKind, workId: string) { this.bootSourceWork.add(`${kind}\0${workId}`); }
  sourceWorkAuthorizedForCurrentBoot(kind: SourceWorkKind, workId: string) { return this.bootSourceWork.has(`${kind}\0${workId}`); }
  readonly stateDirectory: string;
  readonly statePath: string;
  readonly improvementsPath: string;
  readonly assignmentsPath: string;
  readonly tasksPath: string;
  readonly continuationsPath: string;
  readonly commandsPath: string;
  private state: RoomState;
  private improvementState: JsonImprovementState;
  private saveQueue: Promise<void> = Promise.resolve();
  private improvementQueue: Promise<void> = Promise.resolve();
  private assignmentQueue: Promise<void> = Promise.resolve();
  private taskQueue: Promise<void> = Promise.resolve();
  private continuationQueue: Promise<void> = Promise.resolve();
  private readonly contextSummaries = new Map<string, string>();
  private commandQueue: Promise<void> = Promise.resolve();
  private assignments: AssignmentRecord[];
  private taskState: JsonTaskState;
  private continuationState: JsonContinuationState;
  private commandState: JsonCommandState;

  private constructor(stateDirectory: string, state: RoomState, improvementState: JsonImprovementState, assignments: AssignmentRecord[], taskState: JsonTaskState, continuationState: JsonContinuationState, commandState: JsonCommandState) {
    this.stateDirectory = stateDirectory;
    this.statePath = path.join(stateDirectory, "room.json");
    this.improvementsPath = path.join(stateDirectory, "canonical-improvements.json");
    this.assignmentsPath = path.join(stateDirectory, "assignments.json");
    this.tasksPath = path.join(stateDirectory, "tasks.json");
    this.continuationsPath = path.join(stateDirectory, "continuations.json");
    this.commandsPath = path.join(stateDirectory, "command-records.json");
    this.state = state;
    this.improvementState = improvementState;
    this.assignments = assignments;
    this.taskState = taskState;
    this.continuationState = continuationState;
    for (const entry of state.agentContextSummaries || []) {
      if (entry && typeof entry.summary === "string" && entry.summary && typeof entry.spanStartId === "string" && typeof entry.spanEndId === "string" && Number.isSafeInteger(entry.configRevision)) {
        this.contextSummaries.set(this.contextSummaryKey(entry), entry.summary);
      }
    }
    this.commandState = commandState;
  }

  static async open(projectRoot: string, stateDirectory = path.join(projectRoot, ".allmyfriendsareagents")) {
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    await chmod(stateDirectory, 0o700);
    const statePath = path.join(stateDirectory, "room.json");
    const improvementsPath = path.join(stateDirectory, "canonical-improvements.json");
    const assignmentsPath = path.join(stateDirectory, "assignments.json");
    const tasksPath = path.join(stateDirectory, "tasks.json");
    const continuationsPath = path.join(stateDirectory, "continuations.json");
    const commandsPath = path.join(stateDirectory, "command-records.json");
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
    const commandState = await readFile(commandsPath, "utf8")
      .then((contents) => normalizeJsonCommandState(JSON.parse(contents)))
      .catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return emptyJsonCommandState(); throw error; });

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
      const deployment = normalizeDeploymentProvenance(stored.deployment);
      const configurationRevisionWasMissing = !Number.isSafeInteger(
        (stored.roomConfiguration as { configurationRevision?: unknown } | undefined)?.configurationRevision,
      );
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
        ...(deployment ? { deployment } : {}),
        ...(stored.roomConfiguration ? { roomConfiguration: normalizeRoomConfiguration(stored.roomConfiguration) } : {}),
        ...(configurationRevisionWasMissing ? { agentContextSummaries: [] } : {}),
      };
      const store = new RoomStore(stateDirectory, state, improvementState, assignments, taskState, continuationState, commandState);
      if (topicWasMissing
        || roomNameWasMissing
        || state.settings.projectPath !== stored.settings.projectPath
        || !stored.settings.participantStyles
        || storedSettings.maxRounds !== undefined
        || storedSettings.reviewMode !== undefined
        || storedSettings.conversationEnergy !== conversationEnergy
        || JSON.stringify(state.sessions) !== JSON.stringify(stored.sessions)
        || state.settings.writableAgent !== stored.settings.writableAgent
        || configurationRevisionWasMissing && Boolean(stored.agentContextSummaries?.length)
        || JSON.stringify(roster) !== JSON.stringify(stored.roster)
        || messages.some((message, index) => message !== stored.messages[index])) {
        await store.save();
      }
      return store;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const store = new RoomStore(stateDirectory, createDefaultRoomState(projectRoot), improvementState, assignments, taskState, continuationState, commandState);
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

  async addCommandAuditMessageOnce(auditId: string, text: string) {
    const id = `command-audit:${auditId}`;
    const existing = this.state.messages.find((message) => message.id === id);
    if (existing) return structuredClone(existing);
    const message: RoomMessage = { id, speaker: "system", text: text.trim(), timestamp: new Date().toISOString(), kind: "status" };
    this.state.messages.push(message);
    await this.save();
    return structuredClone(message);
  }

  async addCommandDeliveryMessageOnce(attemptId: string, sequence: number, speaker: RoomMessage["speaker"], text: string, style?: ChatStyle, burst?: { burstId: string; sequence: number; kind?: RoomMessage["kind"] }) {
    const id = `command-delivery:${attemptId}:${sequence}`;
    const existing = this.state.messages.find((message) => message.id === id);
    if (existing) return structuredClone(existing);
    const participant = styledParticipant(speaker);
    const messageStyle = participant ? sanitizeChatStyle(style, this.state.settings.participantStyles[participant] || DEFAULT_PARTICIPANT_STYLES["codex-sol"]) : undefined;
    const message: RoomMessage = { id, speaker, text: text.trim(), timestamp: new Date().toISOString(), kind: burst?.kind || "chat", ...(messageStyle ? { style: messageStyle } : {}), ...(burst ? { burstId: burst.burstId, sequence: burst.sequence } : {}), ...(speaker !== "you" && speaker !== "system" ? { speakerName: AGENT_PROFILES[speaker]?.conversationalName || speaker } : {}) };
    this.state.messages.push(message); await this.save(); return structuredClone(message);
  }

  async addPrivateCommandResponseOnce(submissionId: string, humanId: string, text: string) {
    const id = `command-private:${submissionId}`;
    const existing = this.state.messages.find((message) => message.id === id);
    if (existing) { await this.save(); return structuredClone(existing); }
    const message: RoomMessage = { id, speaker: "system", text: text.trim(), timestamp: new Date().toISOString(), kind: "status", recipientHumanId: humanId };
    this.state.messages.push(message); await this.save(); return structuredClone(message);
  }

  async updateSettings(update: Partial<RoomSettings>) {
    this.state.settings = { ...this.state.settings, ...update };
    this.clearAgentContextSummaries();
    await this.save();
  }

  async getRoomConfiguration() {
    return normalizeRoomConfiguration(this.state.roomConfiguration);
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
    this.state.roomConfiguration = next;
    this.state.roomConfigurationAudit ||= [];
    this.state.roomConfigurationAudit.push({ id: randomUUID(), actorId, changeKind, basePromptRevision: next.basePromptRevision, summarizerPromptRevision: next.summarizerPromptRevision, at: now, snapshot: structuredClone(next) });
    this.clearAgentContextSummaries();
    await this.save();
    return structuredClone(next);
  }

  async updateRoster(expectedRevision: number, entries: readonly RoomAgentRosterEntry[]): Promise<RosterChangeResult> {
    const validated = validateRosterEntries(entries);
    if (!validated) throw new Error("Invalid room roster entries.");
    const current = normalizeRoomAgentRoster(this.state.roster);
    if (current.revision !== expectedRevision) return { kind: "conflict", expectedRevision, actualRevision: current.revision };
    const nextEntries = validated.map((entry) => {
      const previous = current.entries.find((candidate) => candidate.agentId === entry.agentId);
      if (!previous) return { ...entry, lastSeenMessageId: null };
      const changed = participantConfigurationFingerprint(previous) !== participantConfigurationFingerprint(entry);
      if (!changed) return { ...entry, configurationRevision: previous.configurationRevision || 1, lastSeenMessageId: previous.lastSeenMessageId ?? null };
      const { selectionConfirmationRequired: _confirmation, ...confirmedEntry } = entry;
      return { ...confirmedEntry, configurationRevision: (previous.configurationRevision || 1) + 1, sessionInvalidationReason: "Model configuration changed; the previous OpenCode session was invalidated.", lastSeenMessageId: previous.lastSeenMessageId ?? null };
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
    this.clearAgentContextSummaries();
    await this.save();
    return { kind: "accepted", roster: structuredClone(next) };
  }

  async changeTopic(topic: string) {
    if (topic === this.state.settings.topic) return;
    this.state.settings.topic = topic;
    this.state.sessions = {};
    this.state.roster = { ...normalizeRoomAgentRoster(this.state.roster), entries: normalizeRoomAgentRoster(this.state.roster).entries.map((entry) => ({ ...entry, lastSeenMessageId: null })) };
    this.clearAgentContextSummaries();
    this.state.messages.push(topicMessage(topic));
    await this.save();
  }

  async updateParticipantStyle(participant: StyledParticipant, style: ChatStyle) {
    this.state.settings.participantStyles[participant] = sanitizeChatStyle(style, this.state.settings.participantStyles[participant]);
    this.clearAgentContextSummaries();
    await this.save();
  }

  async setDeployment(provenance: DeploymentProvenance) {
    this.state.deployment = structuredClone(provenance);
    await this.save();
  }

  async setSession(agent: AgentId, id: string, permission: "read-only" | "writable", codeEpoch?: string) {
    const entry = roomAgentEntry(this.state.roster, agent);
    const normalizedEpoch = normalizeDeploymentEpoch(codeEpoch);
    this.state.sessions[agent] = { id, permission, ...(entry ? { configurationFingerprint: participantConfigurationFingerprint(entry), configurationRevision: entry.configurationRevision || 1 } : {}), ...(normalizedEpoch ? { codeEpoch: normalizedEpoch } : {}) };
    await this.save();
  }

  async setLastSeenMessageId(agent: AgentId, messageId: string | null) {
    if (messageId !== null && !this.state.messages.some((message) => message.id === messageId)) throw new Error("Cannot advance an agent cursor to an unknown room message.");
    const roster = normalizeRoomAgentRoster(this.state.roster);
    if (!roster.entries.some((entry) => entry.agentId === agent)) throw new Error("Cannot advance the cursor for an agent outside the room roster.");
    this.state.roster = { ...roster, entries: roster.entries.map((entry) => entry.agentId === agent ? { ...entry, lastSeenMessageId: messageId } : entry) };
    await this.save();
  }

  private contextSummaryKey(key: AgentContextSummaryKey) {
    return `${key.agentId}\u0000${key.spanStartId}\u0000${key.spanEndId}\u0000${key.configRevision}`;
  }

  async getAgentContextSummary(key: AgentContextSummaryKey) {
    return this.contextSummaries.get(this.contextSummaryKey(key));
  }

  async putAgentContextSummary(key: AgentContextSummaryKey, summary: string) {
    if (key.configRevision !== normalizeRoomConfiguration(this.state.roomConfiguration).configurationRevision) return;
    this.contextSummaries.set(this.contextSummaryKey(key), summary);
    this.state.agentContextSummaries = [...this.contextSummaries.entries()].map(([encoded, value]) => {
      const [agentId, spanStartId, spanEndId, configRevision] = encoded.split("\u0000");
      return { agentId: agentId as AgentId, spanStartId, spanEndId, configRevision: Number(configRevision), summary: value };
    });
    await this.save();
  }

  private clearAgentContextSummaries() {
    this.contextSummaries.clear();
    this.state.agentContextSummaries = [];
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

  async createCommandSubmission(submission: CommandSubmission) {
    assertJsonSingleRoom(submission.roomId);
    if (!validSubmission(submission)) throw new Error("Invalid command submission");
    return this.mutateCommands<CreateCommandSubmissionResult>((state) => { const duplicate = state.submissions.find((item) => item.roomId === submission.roomId && (item.submissionId === submission.submissionId || item.clientSubmissionId === submission.clientSubmissionId)); return duplicate ? { result: { kind: "duplicate" as const, submission: structuredClone(duplicate) } } : { next: { ...state, submissions: [...state.submissions, structuredClone(submission)] }, result: { kind: "created" as const, submission: structuredClone(submission) } }; });
  }
  async acceptCommand(acceptance: CommandAcceptance): Promise<AcceptCommandResult> {
    assertJsonSingleRoom(acceptance.submission.roomId);
    if (!validCommandAcceptance(acceptance)) throw new Error("Invalid command acceptance");
    return this.mutateCommands<AcceptCommandResult>((state) => {
      const duplicate = state.submissions.find((item) => item.roomId === acceptance.submission.roomId && (item.submissionId === acceptance.submission.submissionId || item.clientSubmissionId === acceptance.submission.clientSubmissionId));
      if (duplicate) return { result: { kind: "duplicate" as const, submission: structuredClone(duplicate) } };
      const tombstone=state.tombstones.find((item)=>item.roomId===acceptance.submission.roomId&&(item.submissionId===acceptance.submission.submissionId||item.clientSubmissionId===acceptance.submission.clientSubmissionId));
      if(tombstone)return{result:{kind:"compacted-duplicate" as const,tombstone:structuredClone(tombstone)}};
      if (acceptance.poll && state.polls.filter((poll) => poll.roomId === acceptance.poll!.roomId && poll.state === "OPEN").length >= MAX_OPEN_POLLS_PER_ROOM) {
        return { result: { kind: "rejected" as const, reason: `A room can have at most ${MAX_OPEN_POLLS_PER_ROOM} open polls.` } };
      }
      const actualRevision = state.roundRobin.find((item) => item.roomId === acceptance.submission.roomId)?.revision ?? 0;
      if (acceptance.roundRobin && actualRevision !== acceptance.roundRobin.expectedRevision) return { result: { kind: "conflict" as const, actualRevision } };
      return { next: { ...state, submissions: [...state.submissions, structuredClone(acceptance.submission)], audits: [...state.audits, structuredClone(acceptance.audit)], polls: acceptance.poll ? [...state.polls, structuredClone(acceptance.poll)] : state.polls, attempts: acceptance.attempt ? [...state.attempts, structuredClone(acceptance.attempt)] : state.attempts, povExecutions: acceptance.povExecution ? [...state.povExecutions, structuredClone(acceptance.povExecution)] : state.povExecutions, ghExecutions: acceptance.ghExecution ? [...state.ghExecutions, structuredClone(acceptance.ghExecution)] : state.ghExecutions, roundRobin: acceptance.roundRobin ? [...state.roundRobin.filter((item) => item.roomId !== acceptance.submission.roomId), structuredClone(acceptance.roundRobin.state)] : state.roundRobin }, result: { kind: "accepted" as const, acceptance: structuredClone(acceptance) } };
    });
  }
  async reassignCommandAttempt(value: CommandReassignment) {
    assertJsonSingleRoom(value.current.roomId); assertJsonSingleRoom(value.next.roomId);
    if (!validCommandReassignment(value)) throw new Error("Invalid command reassignment");
    return this.mutateCommands<{ kind: "accepted"; current: CommandAttempt; next: CommandAttempt } | { kind: "conflict" | "not-found" }>((state) => {
      const current = state.attempts.find((item) => item.roomId === value.current.roomId && item.attemptId === value.current.attemptId);
      if (!current) return { result: { kind: "not-found" as const } };
      const pointer = state.roundRobin.find((item) => item.roomId === value.current.roomId);
      const conflicts = current.updatedAt !== value.expectedUpdatedAt
        || current.submissionId !== value.current.submissionId
        || current.attempt !== value.current.attempt
        || current.agentId !== value.current.agentId
        || current.createdAt !== value.current.createdAt
        || !validAttemptTransition(current.status, value.current.status)
        || (pointer?.revision ?? 0) !== value.roundRobin.expectedRevision
        || state.attempts.some((item) => item.roomId === value.next.roomId && (item.attemptId === value.next.attemptId || item.submissionId === value.next.submissionId && item.attempt === value.next.attempt));
      if (conflicts) return { result: { kind: "conflict" as const } };
      return {
        next: {
          ...state,
          attempts: [...state.attempts.map((item) => item === current ? structuredClone(value.current) : item), structuredClone(value.next)],
          roundRobin: [...state.roundRobin.filter((item) => item.roomId !== value.current.roomId), structuredClone(value.roundRobin.state)],
        },
        result: { kind: "accepted" as const, current: structuredClone(value.current), next: structuredClone(value.next) },
      };
    });
  }
  async getCommandSubmission(roomId: string, submissionId: string) { await this.commandQueue; const value = this.commandState.submissions.find((item) => item.roomId === roomId && item.submissionId === submissionId); return value ? structuredClone(value) : undefined; }
  async getRoundRobinState(roomId: string) { await this.commandQueue; return structuredClone(this.commandState.roundRobin.find((item) => item.roomId === roomId) || { roomId, lastAssignedAgentId: null, revision: 0, updatedAt: new Date(0).toISOString() }); }
  async compareAndSetRoundRobinState(expectedRevision: number, value: RoundRobinState) { if (!validRoundRobin(value) || value.revision !== expectedRevision + 1) throw new Error("Invalid round-robin state"); return this.mutateCommands<{ kind: "accepted"; state: RoundRobinState } | { kind: "conflict"; actualRevision: number }>((state) => { const actualRevision = state.roundRobin.find((item) => item.roomId === value.roomId)?.revision ?? 0; return actualRevision !== expectedRevision ? { result: { kind: "conflict" as const, actualRevision } } : { next: { ...state, roundRobin: [...state.roundRobin.filter((item) => item.roomId !== value.roomId), structuredClone(value)] }, result: { kind: "accepted" as const, state: structuredClone(value) } }; }); }
  async createCommandAttempt(attempt: CommandAttempt) { if (!validAttempt(attempt)) throw new Error("Invalid command attempt"); return this.mutateCommands<{ kind: "created" | "duplicate"; attempt: CommandAttempt }>((state) => { const duplicate = state.attempts.find((item) => item.roomId === attempt.roomId && (item.attemptId === attempt.attemptId || item.submissionId === attempt.submissionId && item.attempt === attempt.attempt)); return duplicate ? { result: { kind: "duplicate" as const, attempt: structuredClone(duplicate) } } : { next: { ...state, attempts: [...state.attempts, structuredClone(attempt)] }, result: { kind: "created" as const, attempt: structuredClone(attempt) } }; }); }
  async listCommandAttempts(roomId: string, submissionId: string) { await this.commandQueue; return structuredClone(this.commandState.attempts.filter((item) => item.roomId === roomId && item.submissionId === submissionId).sort((a, b) => a.attempt - b.attempt)); }
  async listPendingCommandAttempts(roomId: string) { await this.commandQueue; return structuredClone(this.commandState.attempts.filter((item) => item.roomId === roomId && (item.status === "queued" || item.status === "active" || item.status === "delivery-pending")).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.attemptId.localeCompare(b.attemptId))); }
  async compareAndSetCommandAttempt(expectedUpdatedAt: string, attempt: CommandAttempt) { if (!validAttempt(attempt) || attempt.updatedAt === expectedUpdatedAt) throw new Error("Invalid command attempt transition"); return this.mutateCommands<{ kind: "accepted"; attempt: CommandAttempt } | { kind: "conflict" | "not-found" }>((state) => { const current = state.attempts.find((item) => item.roomId === attempt.roomId && item.attemptId === attempt.attemptId); if (!current) return { result: { kind: "not-found" as const } }; if (current.updatedAt !== expectedUpdatedAt || current.submissionId !== attempt.submissionId || current.attempt !== attempt.attempt || current.agentId !== attempt.agentId || current.createdAt !== attempt.createdAt || !validAttemptTransition(current.status, attempt.status)) return { result: { kind: "conflict" as const } }; return { next: { ...state, attempts: state.attempts.map((item) => item === current ? structuredClone(attempt) : item) }, result: { kind: "accepted" as const, attempt: structuredClone(attempt) } }; }); }
  async createCommandPoll(poll: CommandPoll) { if (!validPoll(poll)) throw new Error("Invalid command poll"); return this.mutateCommands<{ kind: "created" | "duplicate"; poll: CommandPoll }>((state) => { const duplicate = state.polls.find((item) => item.roomId === poll.roomId && (item.pollId === poll.pollId || item.submissionId === poll.submissionId)); return duplicate ? { result: { kind: "duplicate" as const, poll: structuredClone(duplicate) } } : { next: { ...state, polls: [...state.polls, structuredClone(poll)] }, result: { kind: "created" as const, poll: structuredClone(poll) } }; }); }
  async listCommandPolls(roomId: string,query:{limit?:number;before?:string;state?:CommandPoll["state"]}={}) { await this.commandQueue;const limit=Math.max(1,Math.min(MAX_RECENT_POLLS,query.limit||50));const before=parseCommandPollCursor(query.before); return structuredClone(this.commandState.polls.filter((poll) => poll.roomId === roomId&&(!query.state||poll.state===query.state)&&(!before||poll.createdAt<before.createdAt||poll.createdAt===before.createdAt&&poll.pollId<before.pollId)).sort((a,b) => b.createdAt.localeCompare(a.createdAt) || b.pollId.localeCompare(a.pollId)).slice(0,limit)); }
  async getCommandPoll(roomId: string, pollId: string) { await this.commandQueue; const poll = this.commandState.polls.find((item) => item.roomId === roomId && item.pollId === pollId); return poll ? structuredClone(poll) : undefined; }
  async createCommandVote(vote: CommandVote) { if (!validVote(vote)) throw new Error("Invalid command vote"); return this.mutateCommands<CreateCommandVoteResult>((state) => { const poll = state.polls.find((item) => item.roomId === vote.roomId && item.pollId === vote.pollId); if (!poll || vote.optionIndex >= poll.options.length) return { result: { kind: "rejected" as const, reason: "Poll or option does not exist in this room." } }; const duplicate = state.votes.find((item) => item.roomId === vote.roomId && item.pollId === vote.pollId && (item.voterId === vote.voterId || item.mutationId === vote.mutationId)); if (duplicate) return { result: { kind: "duplicate" as const, vote: structuredClone(duplicate) } }; if (poll.state !== "OPEN") return { result: { kind: "rejected" as const, reason: "This poll is closed." } }; return { next: { ...state, votes: [...state.votes, structuredClone(vote)] }, result: { kind: "created" as const, vote: structuredClone(vote) } }; }); }
  async closeCommandPoll(input: { roomId:string; pollId:string; expectedRevision:number; mutationId:string; closerKind:CommandInvoker["kind"]|"controller"; closerId:string; closedAt:string }) { return this.mutateCommands<CloseCommandPollResult>((state) => { const poll = state.polls.find((item) => item.roomId === input.roomId && item.pollId === input.pollId); if (!poll) return { result: { kind: "not-found" as const, reason: "Poll not found." } }; if (poll.state === "CLOSED") return { result: poll.closeMutationId === input.mutationId ? { kind: "duplicate" as const, poll: structuredClone(poll) } : { kind: "rejected" as const, reason: "This poll is already closed." } }; if (poll.revision !== input.expectedRevision) return { result: { kind: "conflict" as const, poll: structuredClone(poll) } }; const votes = state.votes.filter((vote) => vote.roomId === poll.roomId && vote.pollId === poll.pollId); const tallies = poll.options.map((_,index)=>votes.filter((vote)=>vote.optionIndex===index).length); const closed = { ...poll, state: "CLOSED" as const, revision: poll.revision + 1, closedAt: input.closedAt, closerKind: input.closerKind, closerId: input.closerId, closeMutationId: input.mutationId, finalTallies: tallies, finalTotalVotes: votes.length }; return { next: { ...state, polls: state.polls.map((item)=>item.roomId===poll.roomId&&item.pollId===poll.pollId?closed:item) }, result: { kind: "closed" as const, poll: structuredClone(closed) } }; }); }
  async listCommandVotes(roomId: string, pollId: string) { await this.commandQueue; return structuredClone(this.commandState.votes.filter((item) => item.roomId === roomId && item.pollId === pollId)); }
  async createCommandAuditIdentity(audit: CommandAuditIdentity) { if (!validAudit(audit)) throw new Error("Invalid command audit"); return this.mutateCommands<{ kind: "created" | "duplicate"; audit: CommandAuditIdentity }>((state) => { const duplicate = state.audits.find((item) => item.roomId === audit.roomId && (item.auditId === audit.auditId || item.submissionId === audit.submissionId)); return duplicate ? { result: { kind: "duplicate" as const, audit: structuredClone(duplicate) } } : { next: { ...state, audits: [...state.audits, structuredClone(audit)] }, result: { kind: "created" as const, audit: structuredClone(audit) } }; }); }
  async getCommandAuditIdentity(roomId: string, submissionId: string) { await this.commandQueue; const audit = this.commandState.audits.find((item) => item.roomId === roomId && item.submissionId === submissionId); return audit ? structuredClone(audit) : undefined; }
  async listCommandAuditIdentities(roomId: string) { await this.commandQueue; return structuredClone(this.commandState.audits.filter((item) => item.roomId === roomId).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.auditId.localeCompare(b.auditId))); }
  async listPendingPovExecutions(roomId: string) { await this.commandQueue; return structuredClone(this.commandState.povExecutions.filter((item) => item.roomId===roomId&&(item.status==="queued"||item.status==="active")).sort((a,b)=>a.createdAt.localeCompare(b.createdAt))); }
  async getPovExecution(roomId: string, submissionId: string) { await this.commandQueue; const value=this.commandState.povExecutions.find((item)=>item.roomId===roomId&&item.submissionId===submissionId);return value?structuredClone(value):undefined; }
  async compareAndSetPovExecution(expectedUpdatedAt:string,execution:CommandPovExecution){if(!validPovExecution(execution)||execution.updatedAt===expectedUpdatedAt)throw new Error("Invalid POV execution transition");return this.mutateCommands<{kind:"accepted";execution:CommandPovExecution}|{kind:"conflict"|"not-found"}>((state)=>{const current=state.povExecutions.find((item)=>item.roomId===execution.roomId&&item.executionId===execution.executionId);if(!current)return{result:{kind:"not-found" as const}};const valid=current.updatedAt===expectedUpdatedAt&&current.submissionId===execution.submissionId&&current.createdAt===execution.createdAt&&JSON.stringify(current.targetAgentIds)===JSON.stringify(execution.targetAgentIds)&&current.processedTargetAgentIds.every((agent)=>execution.processedTargetAgentIds.includes(agent))&&(current.status==="queued"&&["active","failed","cancelled"].includes(execution.status)||current.status==="active"&&["active","completed","failed","cancelled"].includes(execution.status));if(!valid)return{result:{kind:"conflict" as const}};return{next:{...state,povExecutions:state.povExecutions.map((item)=>item.executionId===execution.executionId&&item.roomId===execution.roomId?structuredClone(execution):item)},result:{kind:"accepted" as const,execution:structuredClone(execution)}};});}
  async getGhExecution(roomId:string,submissionId:string){await this.commandQueue;const value=this.commandState.ghExecutions.find((item)=>item.roomId===roomId&&item.submissionId===submissionId);return value?structuredClone(value):undefined;}
  async createGhExecution(execution:CommandGhExecution){if(!validGhExecution(execution))throw new Error("Invalid GitHub execution");return this.mutateCommands<{kind:"created"|"duplicate";execution:CommandGhExecution}>((state)=>{const existing=state.ghExecutions.find((item)=>item.roomId===execution.roomId&&(item.executionId===execution.executionId||item.submissionId===execution.submissionId));return existing?{result:{kind:"duplicate" as const,execution:structuredClone(existing)}}:{next:{...state,ghExecutions:[...state.ghExecutions,structuredClone(execution)]},result:{kind:"created" as const,execution:structuredClone(execution)}};});}
  async listPendingGhExecutions(roomId:string){await this.commandQueue;return structuredClone(this.commandState.ghExecutions.filter((item)=>item.roomId===roomId&&(item.status==="queued"||item.deliveryStatus==="pending")).sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.executionId.localeCompare(b.executionId)));}
  async adoptGhAuthorizationLease(roomId:string,executionId:string,expectedUpdatedAt:string,authorizationLease:string,updatedAt:string){if(!/^sha256:[a-f0-9]{64}$|^legacy-static$/.test(authorizationLease)||updatedAt===expectedUpdatedAt)throw new Error("Invalid GitHub authorization lease adoption");return this.mutateCommands<{kind:"accepted";execution:CommandGhExecution}|{kind:"conflict"|"not-found"}>((state)=>{const current=state.ghExecutions.find((item)=>item.roomId===roomId&&item.executionId===executionId);if(!current)return{result:{kind:"not-found" as const}};if(current.status!=="queued"||current.authorizationLease!=null||current.updatedAt!==expectedUpdatedAt)return{result:{kind:"conflict" as const}};const execution={...current,authorizationLease,updatedAt};return{next:{...state,ghExecutions:state.ghExecutions.map((item)=>item===current?execution:item)},result:{kind:"accepted" as const,execution:structuredClone(execution)}};});}
  async compareAndSetGhExecution(expectedUpdatedAt:string,execution:CommandGhExecution){if(!validGhExecution(execution)||execution.updatedAt===expectedUpdatedAt)throw new Error("Invalid GitHub execution transition");return this.mutateCommands<{kind:"accepted";execution:CommandGhExecution}|{kind:"conflict"|"not-found"}>((state)=>{const current=state.ghExecutions.find((item)=>item.roomId===execution.roomId&&item.executionId===execution.executionId);if(!current)return{result:{kind:"not-found" as const}};if(current.updatedAt!==expectedUpdatedAt||current.status!=="queued"||execution.status==="queued"||current.submissionId!==execution.submissionId||current.createdAt!==execution.createdAt||(current.authorizationLease??null)!==execution.authorizationLease)return{result:{kind:"conflict" as const}};return{next:{...state,ghExecutions:state.ghExecutions.map((item)=>item.roomId===execution.roomId&&item.executionId===execution.executionId?structuredClone(execution):item)},result:{kind:"accepted" as const,execution:structuredClone(execution)}};});}
  async markGhExecutionDelivered(roomId:string,executionId:string,expectedUpdatedAt:string,updatedAt:string){if(!updatedAt||updatedAt===expectedUpdatedAt)throw new Error("Invalid GitHub delivery transition");return this.mutateCommands<{kind:"accepted";execution:CommandGhExecution}|{kind:"conflict"|"not-found"}>((state)=>{const current=state.ghExecutions.find((item)=>item.roomId===roomId&&item.executionId===executionId);if(!current)return{result:{kind:"not-found" as const}};if(current.updatedAt!==expectedUpdatedAt||current.status==="queued"||current.deliveryStatus!=="pending")return{result:{kind:"conflict" as const}};const execution={...current,deliveryStatus:"delivered" as const,updatedAt};return{next:{...state,ghExecutions:state.ghExecutions.map((item)=>item.roomId===roomId&&item.executionId===executionId?execution:item)},result:{kind:"accepted" as const,execution:structuredClone(execution)}};});}
  async appendDiagnostic(record: DiagnosticRecord) { if (!validDiagnostic(record)) throw new Error("Invalid diagnostic record"); return this.mutateCommands<{ kind: "created" | "duplicate"; record: DiagnosticRecord }>((state) => { const duplicate = state.diagnostics.find((item) => item.roomId === record.roomId && (item.recordId === record.recordId || item.correlationId === record.correlationId)); if (duplicate) return { result: { kind: "duplicate" as const, record: structuredClone(duplicate) } }; const cutoff = Date.now() - DIAGNOSTIC_RETENTION_MS; const retained = state.diagnostics.filter((item) => Date.parse(item.createdAt) >= cutoff); const peers = retained.filter((item) => item.roomId === record.roomId && item.agentId === record.agentId).sort((a, b) => a.createdAt.localeCompare(b.createdAt)); const remove = new Set(peers.slice(0, Math.max(0, peers.length - MAX_DIAGNOSTICS_PER_ROOM_AGENT + 1)).map(({ recordId }) => recordId)); return { next: { ...state, diagnostics: [...retained.filter((item) => !remove.has(item.recordId)), structuredClone(record)] }, result: { kind: "created" as const, record: structuredClone(record) } }; }); }
  async getDiagnostic(roomId: string, agentId: AgentId, recordId: string) { await this.commandQueue; const record = this.commandState.diagnostics.find((item) => item.roomId === roomId && item.agentId === agentId && item.recordId === recordId); return record ? structuredClone(record) : undefined; }
  async listDiagnostics(roomId: string, input: AgentId | DiagnosticQuery, legacyLimit = 50) { await this.commandQueue; const query = typeof input === "string" ? { agentId: input, limit: legacyLimit } : input; const limit = Math.max(1, Math.min(MAX_DIAGNOSTIC_QUERY_LIMIT, query.limit || 50)); const search = query.search?.trim().toLocaleLowerCase().slice(0, MAX_DIAGNOSTIC_SEARCH_LENGTH); return structuredClone(this.commandState.diagnostics.filter((item) => item.roomId === roomId && item.agentId === query.agentId && (!query.reason || item.reason === query.reason) && (!search || `${item.reason}\n${item.promptHead || ""}\n${item.diagnosticText || ""}`.toLocaleLowerCase().includes(search))).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.recordId.localeCompare(a.recordId)).slice(0, limit)); }
  async compactCommandRecords(roomId:string,now:string){const cutoff=Date.parse(now)-COMMAND_RECORD_RETENTION_MS;await this.mutateCommands<void>((state)=>{const scoped=state.submissions.filter((item)=>item.roomId===roomId).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));const pending=new Set([...state.attempts.filter((item)=>item.roomId===roomId&&["queued","active","delivery-pending"].includes(item.status)),...state.povExecutions.filter((item)=>item.roomId===roomId&&(item.status==="queued"||item.status==="active")),...state.polls.filter((item)=>item.roomId===roomId&&item.state==="OPEN"),...state.ghExecutions.filter((item)=>item.roomId===roomId&&(item.status==="queued"||item.deliveryStatus==="pending"))].map((item)=>item.submissionId));const keep=new Set(scoped.filter((item,index)=>pending.has(item.submissionId)||(index<MAX_COMMAND_SUBMISSIONS_PER_ROOM&&Date.parse(item.createdAt)>=cutoff)).map((item)=>item.submissionId));const removed=scoped.filter((item)=>!keep.has(item.submissionId));if(!removed.length)return{result:undefined};const removedIds=new Set(removed.map((item)=>item.submissionId));const pollIds=new Set(state.polls.filter((item)=>item.roomId===roomId&&removedIds.has(item.submissionId)).map((item)=>item.pollId));const newTombstones=removed.map((item)=>({roomId,submissionId:item.submissionId,clientSubmissionId:item.clientSubmissionId,command:item.command,compactedAt:now}));const otherRoomTombstones=state.tombstones.filter((item)=>item.roomId!==roomId);const roomTombstones=[...state.tombstones.filter((item)=>item.roomId===roomId&&!removedIds.has(item.submissionId)),...newTombstones].sort((a,b)=>b.compactedAt.localeCompare(a.compactedAt)||b.submissionId.localeCompare(a.submissionId)).slice(0,MAX_COMMAND_TOMBSTONES_PER_ROOM);const inRemovedRoom=(item:{roomId:string;submissionId:string})=>item.roomId===roomId&&removedIds.has(item.submissionId);return{next:{...state,submissions:state.submissions.filter((item)=>!inRemovedRoom(item)),attempts:state.attempts.filter((item)=>!inRemovedRoom(item)),povExecutions:state.povExecutions.filter((item)=>!inRemovedRoom(item)),ghExecutions:state.ghExecutions.filter((item)=>!inRemovedRoom(item)),polls:state.polls.filter((item)=>!inRemovedRoom(item)),votes:state.votes.filter((item)=>!(item.roomId===roomId&&pollIds.has(item.pollId))),audits:state.audits.filter((item)=>!inRemovedRoom(item)),tombstones:[...otherRoomTombstones,...roomTombstones]},result:undefined};});}

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

  private async mutateCommands<T>(mutation: (state: JsonCommandState) => { next?: JsonCommandState; result: T }): Promise<T> {
    let resolveResult!: (result: T) => void; let rejectResult!: (error: unknown) => void;
    const result = new Promise<T>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
    const operation = this.commandQueue.then(async () => {
      try {
        const changed = mutation(this.commandState);
        if (changed.next) {
          const next = normalizeJsonCommandState(changed.next);
          assertJsonCommandStateSingleRoom(next);
          const temporaryPath = `${this.commandsPath}.tmp`;
          await writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
          await rename(temporaryPath, this.commandsPath);
          await chmod(this.commandsPath, 0o600);
          this.commandState = next;
        }
        resolveResult(changed.result);
      } catch (error) { rejectResult(error); throw error; }
    });
    this.commandQueue = operation.catch(() => undefined); return result;
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

function assertJsonSingleRoom(roomId: string) {
  if (roomId !== CANONICAL_ROOM_ID) throw new Error(`JSON storage is single-room compatibility mode and cannot mutate ${roomId}; run pnpm storage:import:sqlite before using additional rooms.`);
}

function assertJsonCommandStateSingleRoom(state: JsonCommandState) {
  const records = [state.submissions, state.tombstones, state.roundRobin, state.attempts, state.povExecutions, state.ghExecutions, state.polls, state.votes, state.audits, state.diagnostics].flat();
  for (const record of records) assertJsonSingleRoom(record.roomId);
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
