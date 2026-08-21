import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DEFAULT_PARTICIPANT_STYLES, normalizeParticipantStyles, sanitizeChatStyle, type ChatStyle, type StyledParticipant } from "../shared/chat-style.js";
import { isConversationEnergy, migrateMaxRounds } from "../shared/conversation-energy.js";
import { isActiveAgentId, isParticipantId, migrateLegacyAgentId, normalizeWritableAgent } from "../shared/participants.js";
import type { RoomRepository } from "./storage/room-repository.js";
import type { AgentId, AgentSession, RoomMessage, RoomSettings, RoomState, SpeakerId } from "./types.js";

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
  private state: RoomState;
  private saveQueue: Promise<void> = Promise.resolve();

  private constructor(stateDirectory: string, state: RoomState) {
    this.stateDirectory = stateDirectory;
    this.statePath = path.join(stateDirectory, "room.json");
    this.state = state;
  }

  static async open(projectRoot: string, stateDirectory = path.join(projectRoot, ".allmyfriendsareagents")) {
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    await chmod(stateDirectory, 0o700);
    const statePath = path.join(stateDirectory, "room.json");
    const defaultSettings = createDefaultRoomState(projectRoot).settings;

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
      const store = new RoomStore(stateDirectory, state);
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
      const store = new RoomStore(stateDirectory, createDefaultRoomState(projectRoot));
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
    human?: { id: string; name: string },
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
