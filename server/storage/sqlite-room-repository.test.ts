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
  it("atomically persists ordering, disabled entries, empty rosters, and revision conflicts", async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), "amfaa-sqlite-roster-"));
    temporaryDirectories.push(projectRoot);
    const databasePath = path.join(projectRoot, "amfaa.sqlite");
    const store = await SqliteRoomRepository.open(projectRoot, databasePath);
    await store.setSession("codex-sol", "active-session", "read-only");
    expect(await store.updateRoster(1, [
      { agentId: "cursor-gemini", enabled: true },
      { agentId: "claude-opus", enabled: false },
    ])).toMatchObject({ kind: "accepted", roster: { revision: 2 } });
    expect(store.snapshot().sessions).toEqual({});
    expect(await store.updateRoster(1, [])).toEqual({ kind: "conflict", expectedRevision: 1, actualRevision: 2 });
    expect(await store.updateRoster(2, [])).toMatchObject({ kind: "accepted", roster: { revision: 3, entries: [] } });
    store.close();

    const reopened = await SqliteRoomRepository.open(projectRoot, databasePath);
    expect(reopened.snapshot().roster).toEqual({ revision: 3, entries: [] });
    reopened.close();
  });

  it("uses database compare-and-swap across concurrent repository instances", async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), "amfaa-sqlite-roster-cas-"));
    temporaryDirectories.push(projectRoot);
    const databasePath = path.join(projectRoot, "amfaa.sqlite");
    const first = await SqliteRoomRepository.open(projectRoot, databasePath);
    const stale = await SqliteRoomRepository.open(projectRoot, databasePath);
    expect(await first.updateRoster(1, [{ agentId: "claude-opus", enabled: true }])).toMatchObject({ kind: "accepted" });
    expect(await stale.updateRoster(1, [])).toEqual({ kind: "conflict", expectedRevision: 1, actualRevision: 2 });
    first.close(); stale.close();
    const reopened = await SqliteRoomRepository.open(projectRoot, databasePath);
    expect(reopened.snapshot().roster).toEqual({ revision: 2, entries: [{ agentId: "claude-opus", enabled: true }] });
    reopened.close();
  });


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
      clientMessageId: "message-12345678",
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
      clientMessageId: "message-12345678",
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
