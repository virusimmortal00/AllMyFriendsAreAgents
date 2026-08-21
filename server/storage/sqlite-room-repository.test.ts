import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_PARTICIPANT_STYLES } from "../../shared/chat-style.js";
import { SqliteRoomRepository } from "./sqlite-room-repository.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("SQLite room repository", () => {
  it("persists messages, settings, styles, bursts, and sessions across restarts", async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), "amfaa-sqlite-room-"));
    temporaryDirectories.push(projectRoot);
    const databasePath = path.join(projectRoot, "data", "amfaa.sqlite");
    const store = await SqliteRoomRepository.open(projectRoot, databasePath);
    const humanStyle = { ...DEFAULT_PARTICIPANT_STYLES.you, fontFamily: "Georgia" as const, bold: true };

    await store.updateSettings({ roomName: "SQLite Room", writableAgent: "codex-sol" });
    await store.updateParticipantStyle("you", humanStyle);
    await store.addMessage("you", "Durable hello", "chat", humanStyle, { burstId: "human-burst", sequence: 0 }, {
      id: "human-12345678",
      name: "Robby",
    });
    await store.setSession("codex-sol", "sqlite-session", "writable");
    store.close();

    const reopened = await SqliteRoomRepository.open(projectRoot, databasePath);
    const snapshot = reopened.snapshot();
    expect(snapshot.settings.roomName).toBe("SQLite Room");
    expect(snapshot.settings.writableAgent).toBe("codex-sol");
    expect(snapshot.settings.participantStyles.you).toEqual(humanStyle);
    expect(snapshot.sessions["codex-sol"]).toEqual({ id: "sqlite-session", permission: "writable" });
    expect(snapshot.messages.at(-1)).toMatchObject({
      speaker: "you",
      speakerName: "Robby",
      humanId: "human-12345678",
      text: "Durable hello",
      burstId: "human-burst",
      sequence: 0,
      style: humanStyle,
    });
    expect((await stat(databasePath)).mode & 0o777).toBe(0o600);
    expect((await stat(`${databasePath}-wal`)).mode & 0o777).toBe(0o600);
    expect((await stat(`${databasePath}-shm`)).mode & 0o777).toBe(0o600);
    reopened.close();
  });

  it("clears provider sessions and appends a marker when the topic changes", async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), "amfaa-sqlite-topic-"));
    temporaryDirectories.push(projectRoot);
    const store = await SqliteRoomRepository.open(projectRoot, path.join(projectRoot, "amfaa.sqlite"));
    await store.setSession("claude-sonnet", "old-session", "read-only");

    await store.changeTopic("Durable storage");

    expect(store.snapshot().sessions).toEqual({});
    expect(store.snapshot().messages.at(-1)).toMatchObject({
      speaker: "system",
      kind: "topic",
      text: "Room topic: Durable storage",
    });
    store.close();
  });
});
