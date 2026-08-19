import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentId, RoomMessage, RoomSettings, RoomState } from "./types.js";

const DEFAULT_MESSAGES: RoomMessage[] = [
  {
    id: randomUUID(),
    speaker: "system",
    text: "Welcome to AgentWire 98. Both agents are online and reviews are read-only.",
    timestamp: new Date().toISOString(),
    kind: "status",
  },
];

export class RoomStore {
  readonly stateDirectory: string;
  readonly statePath: string;
  private state: RoomState;

  private constructor(stateDirectory: string, state: RoomState) {
    this.stateDirectory = stateDirectory;
    this.statePath = path.join(stateDirectory, "room.json");
    this.state = state;
  }

  static async open(projectRoot: string, stateDirectory = path.join(projectRoot, ".agentwire")) {
    await mkdir(stateDirectory, { recursive: true });
    const statePath = path.join(stateDirectory, "room.json");
    const defaultSettings: RoomSettings = {
      writableAgent: "nobody",
      reviewMode: "read-only",
      maxRounds: 3,
      projectPath: process.env.AGENTWIRE_PROJECT_PATH || projectRoot,
    };

    try {
      const stored = JSON.parse(await readFile(statePath, "utf8")) as RoomState;
      return new RoomStore(stateDirectory, {
        ...stored,
        settings: { ...defaultSettings, ...stored.settings },
        status: "idle",
        activeAgent: undefined,
        error: undefined,
      });
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

  async addMessage(speaker: RoomMessage["speaker"], text: string, kind: RoomMessage["kind"] = "chat") {
    const message: RoomMessage = {
      id: randomUUID(),
      speaker,
      text: text.trim(),
      timestamp: new Date().toISOString(),
      kind,
    };
    this.state.messages.push(message);
    await this.save();
    return message;
  }

  async updateSettings(update: Partial<RoomSettings>) {
    this.state.settings = { ...this.state.settings, ...update };
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
    const temporaryPath = `${this.statePath}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
    await rename(temporaryPath, this.statePath);
  }
}

