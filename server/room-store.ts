import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DEFAULT_PARTICIPANT_STYLES, normalizeParticipantStyles, sanitizeChatStyle, type ChatStyle, type StyledParticipant } from "../shared/chat-style.js";
import { isConversationEnergy, migrateMaxRounds } from "../shared/conversation-energy.js";
import {
  applyImprovementChange as applyDomainImprovementChange,
  type ChangeResult,
  type DomainActor,
  type Improvement,
  type ImprovementChange,
} from "../shared/improvement-domain.js";
import { isActiveAgentId, isParticipantId, migrateLegacyAgentId, normalizeWritableAgent } from "../shared/participants.js";
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
import type {
  AddImprovementMilestoneResult,
  ImprovementLedgerRecords,
  ImprovementMilestoneState,
  StoredImprovementMilestone,
} from "../shared/governed-improvements.js";

export const DEFAULT_ROOM_TOPIC = "Open conversation";
export const DEFAULT_ROOM_NAME = "The Agent Room";
function styledParticipant(speaker: RoomMessage["speaker"]): StyledParticipant | undefined {
  return isParticipantId(speaker) ? speaker : undefined;
}

function migrateSpeaker(speaker: unknown): SpeakerId {
  if (speaker === "you" || speaker === "system") return speaker;
  return migrateLegacyAgentId(speaker) || "system";
}

function migrateSessions(input: unknown) {
  const value = input && typeof input === "object" ? input as Record<string, AgentSession> : {};
  const sessions: Partial<Record<AgentId, AgentSession>> = {};
  for (const [rawAgent, session] of Object.entries(value)) {
    const agent = migrateLegacyAgentId(rawAgent);
    if (agent && isActiveAgentId(agent) && session?.id && (session.permission === "read-only" || session.permission === "writable")) {
      sessions[agent] = session;
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
      conversationEnergy: "balanced",
      projectPath: process.env.ALL_MY_FRIENDS_ARE_AGENTS_PROJECT_PATH || process.env.AGENTWIRE_PROJECT_PATH || projectRoot,
      participantStyles: structuredClone(DEFAULT_PARTICIPANT_STYLES),
    },
    status: "idle",
  };
}

export class RoomStore implements RoomRepository {
  readonly stateDirectory: string;
  readonly statePath: string;
  readonly improvementsPath: string;
  private state: RoomState;
  private improvementState: JsonImprovementState;
  private saveQueue: Promise<void> = Promise.resolve();
  private improvementQueue: Promise<void> = Promise.resolve();

  private constructor(stateDirectory: string, state: RoomState, improvementState: JsonImprovementState) {
    this.stateDirectory = stateDirectory;
    this.statePath = path.join(stateDirectory, "room.json");
    this.improvementsPath = path.join(stateDirectory, "canonical-improvements.json");
    this.state = state;
    this.improvementState = improvementState;
  }

  static async open(projectRoot: string, stateDirectory = path.join(projectRoot, ".allmyfriendsareagents")) {
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    await chmod(stateDirectory, 0o700);
    const statePath = path.join(stateDirectory, "room.json");
    const improvementsPath = path.join(stateDirectory, "canonical-improvements.json");
    const defaultSettings = createDefaultRoomState(projectRoot).settings;
    const improvementState = await readFile(improvementsPath, "utf8")
      .then((contents) => normalizeJsonImprovementState(JSON.parse(contents)))
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return emptyJsonImprovementState();
        throw error;
      });

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
      const messages = stored.messages.map((message) => {
        const speaker = migrateSpeaker(message.speaker);
        const migratedMessage = speaker === message.speaker ? message : { ...message, speaker };
        const participant = styledParticipant(speaker);
        if (!participant) return migratedMessage;
        const style = sanitizeChatStyle(message.style, participantStyles[participant]);
        return sameStyle(message.style, style) ? migratedMessage : { ...migratedMessage, style };
      });
      if (topicWasMissing) messages.push(topicMessage(storedTopic));
      const state: RoomState = {
        ...stored,
        messages,
        sessions: topicWasMissing ? {} : migrateSessions(stored.sessions),
        settings: {
          ...defaultSettings,
          ...currentStoredSettings,
          roomName: storedRoomName,
          topic: storedTopic,
          conversationEnergy,
          writableAgent: normalizeWritableAgent(migrateLegacyAgentId(stored.settings.writableAgent) || stored.settings.writableAgent),
          projectPath: configuredProjectPath || (storedProjectPathExists ? stored.settings.projectPath : projectRoot),
          participantStyles,
        },
        status: "idle",
        activeAgent: undefined,
        error: undefined,
      };
      const store = new RoomStore(stateDirectory, state, improvementState);
      if (topicWasMissing
        || roomNameWasMissing
        || state.settings.projectPath !== stored.settings.projectPath
        || !stored.settings.participantStyles
        || storedSettings.maxRounds !== undefined
        || storedSettings.reviewMode !== undefined
        || storedSettings.conversationEnergy !== conversationEnergy
        || JSON.stringify(state.sessions) !== JSON.stringify(stored.sessions)
        || state.settings.writableAgent !== stored.settings.writableAgent
        || messages.some((message, index) => message !== stored.messages[index])) {
        await store.save();
      }
      return store;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const store = new RoomStore(stateDirectory, createDefaultRoomState(projectRoot), improvementState);
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
    human?: { id: string; name: string; clientMessageId?: string },
  ) {
    const participant = styledParticipant(speaker);
    const messageStyle = participant
      ? sanitizeChatStyle(style, this.state.settings.participantStyles[participant])
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
      ...(human?.clientMessageId ? { clientMessageId: human.clientMessageId } : {}),
    };
    this.state.messages.push(message);
    await this.save();
    return message;
  }

  async updateSettings(update: Partial<RoomSettings>) {
    this.state.settings = { ...this.state.settings, ...update };
    await this.save();
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
    this.state.sessions[agent] = { id, permission };
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

function normalizeMilestoneInput(milestone: { readonly id: string; readonly state: ImprovementMilestoneState; readonly summary: string }) {
  const id = milestone.id.trim();
  const summary = milestone.summary.trim().replace(/\s+/g, " ");
  if (!id || !summary || !["PENDING", "ACHIEVED", "BLOCKED", "CANCELED"].includes(milestone.state)) return undefined;
  return { id, state: milestone.state, summary } as const;
}
