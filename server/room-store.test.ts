import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_PARTICIPANT_STYLES } from "../shared/chat-style.js";
import { RoomStore } from "./room-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("room style persistence", () => {
  it("persists participant profiles and snapshots them onto messages", async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), "all-my-friends-room-"));
    temporaryDirectories.push(projectRoot);
    const stateDirectory = path.join(projectRoot, "state");
    const store = await RoomStore.open(projectRoot, stateDirectory);
    const style = { ...DEFAULT_PARTICIPANT_STYLES.you, fontFamily: "Comic Sans MS" as const, fontSize: 21, bold: true };

    await store.updateParticipantStyle("you", style);
    await store.addMessage("you", "Styled hello", "chat", style);

    const reopened = await RoomStore.open(projectRoot, stateDirectory);
    expect(reopened.snapshot().settings.participantStyles.you).toEqual(style);
    expect(reopened.snapshot().messages.at(-1)?.style).toEqual(style);
  });

  it("serializes simultaneous message saves without dropping either response", async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), "all-my-friends-room-"));
    temporaryDirectories.push(projectRoot);
    const stateDirectory = path.join(projectRoot, "state");
    const store = await RoomStore.open(projectRoot, stateDirectory);

    await Promise.all([
      store.addMessage("codex", "Codex finished."),
      store.addMessage("claude", "Claude finished."),
    ]);

    const reopened = await RoomStore.open(projectRoot, stateDirectory);
    expect(reopened.snapshot().messages.slice(-2).map(({ speaker, text }) => ({ speaker, text }))).toEqual([
      { speaker: "codex", text: "Codex finished." },
      { speaker: "claude", text: "Claude finished." },
    ]);
  });

  it("starts fresh agent context while preserving visible history when the topic changes", async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), "all-my-friends-room-"));
    temporaryDirectories.push(projectRoot);
    const stateDirectory = path.join(projectRoot, "state");
    const store = await RoomStore.open(projectRoot, stateDirectory);
    await store.setSession("codex", "old-session", "read-only");
    await store.addMessage("you", "An earlier conversation");

    await store.changeTopic("Weekend cooking");

    const snapshot = store.snapshot();
    expect(snapshot.settings.topic).toBe("Weekend cooking");
    expect(snapshot.sessions).toEqual({});
    expect(snapshot.messages.some(({ text }) => text === "An earlier conversation")).toBe(true);
    expect(snapshot.messages.at(-1)).toMatchObject({
      speaker: "system",
      text: "Room topic: Weekend cooking",
      kind: "topic",
    });

    const reopened = await RoomStore.open(projectRoot, stateDirectory);
    expect(reopened.snapshot().settings.topic).toBe("Weekend cooking");
    expect(reopened.snapshot().sessions).toEqual({});
  });
});
