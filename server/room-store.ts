import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DEFAULT_PARTICIPANT_STYLES, normalizeParticipantStyles, sanitizeChatStyle, type ChatStyle, type StyledParticipant } from "../shared/chat-style.js";
import type { AgentId, RoomMessage, RoomSettings, RoomState } from "./types.js";

const DEFAULT_MESSAGES: RoomMessage[] = [
  {
    id: randomUUID(),
    speaker: "system",
    text: "Welcome to AllMyFriendsAreAgents. Both agent CLIs were detected and reviews are read-only.",
    timestamp: new Date().toISOString(),
    kind: "status",
  },
];

export class RoomStore {
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
    await mkdir(stateDirectory, { recursive: true });
    const statePath = path.join(stateDirectory, "room.json");
    const defaultSettings: RoomSettings = {
      writableAgent: "nobody",
      reviewMode: "read-only",
      maxRounds: 3,
      projectPath: process.env.ALL_MY_FRIENDS_ARE_AGENTS_PROJECT_PATH || process.env.AGENTWIRE_PROJECT_PATH || projectRoot,
      participantStyles: structuredClone(DEFAULT_PARTICIPANT_STYLES),
    };

    try {
      const stored = JSON.parse(await readFile(statePath, "utf8")) as RoomState;
      const configuredProjectPath = process.env.ALL_MY_FRIENDS_ARE_AGENTS_PROJECT_PATH || process.env.AGENTWIRE_PROJECT_PATH;
      const storedProjectPathExists = await stat(stored.settings.projectPath)
        .then((entry) => entry.isDirectory())
        .catch(() => false);
      const participantStyles = normalizeParticipantStyles(stored.settings.participantStyles);
      const messages = stored.messages.map((message) => {
        if (message.style || !(["you", "codex", "claude"] as const).includes(message.speaker as StyledParticipant)) return message;
        return { ...message, style: participantStyles[message.speaker as StyledParticipant] };
      });
      const state: RoomState = {
        ...stored,
        messages,
        settings: {
          ...defaultSettings,
          ...stored.settings,
          projectPath: configuredProjectPath || (storedProjectPathExists ? stored.settings.projectPath : projectRoot),
          participantStyles,
        },
        status: "idle",
        activeAgent: undefined,
        error: undefined,
      };
      const store = new RoomStore(stateDirectory, state);
      if (state.settings.projectPath !== stored.settings.projectPath || !stored.settings.participantStyles || messages.some((message, index) => message !== stored.messages[index])) {
        await store.save();
      }
      return store;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const store = new RoomStore(stateDirectory, {
        messages: DEFAULT_MESSAGES,
        sessions: {},
        settings: defaultSettings,
        status: "idle",
      });
      await store.save();
      return store;
    }
  }

  snapshot(): RoomState {
    return structuredClone(this.state);
  }

  async addMessage(speaker: RoomMessage["speaker"], text: string, kind: RoomMessage["kind"] = "chat", style?: ChatStyle) {
    const message: RoomMessage = {
      id: randomUUID(),
      speaker,
      text: text.trim(),
      timestamp: new Date().toISOString(),
      kind,
      ...(style ? { style: sanitizeChatStyle(style, style) } : {}),
    };
    this.state.messages.push(message);
    await this.save();
    return message;
  }

  async updateSettings(update: Partial<RoomSettings>) {
    this.state.settings = { ...this.state.settings, ...update };
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

  async setStatus(status: RoomState["status"], activeAgent?: AgentId, error?: string) {
    this.state.status = status;
    this.state.activeAgent = activeAgent;
    this.state.error = error;
    await this.save();
  }

  private async save() {
    const operation = this.saveQueue.then(async () => {
      const temporaryPath = `${this.statePath}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
      await rename(temporaryPath, this.statePath);
    });
    this.saveQueue = operation.catch(() => undefined);
    await operation;
  }
}
