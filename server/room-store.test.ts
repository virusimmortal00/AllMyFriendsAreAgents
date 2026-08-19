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
  it("persists participant preferences while retaining each message's original snapshot", async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), "all-my-friends-room-"));
    temporaryDirectories.push(projectRoot);
    const stateDirectory = path.join(projectRoot, "state");
    const store = await RoomStore.open(projectRoot, stateDirectory);
    const firstStyle = { ...DEFAULT_PARTICIPANT_STYLES.you, fontFamily: "Comic Sans MS" as const, fontSize: 21, bold: true };
    const secondStyle = { ...firstStyle, fontFamily: "Georgia" as const, textColor: "#6c1739", backgroundColor: "#ececec", bold: false, italic: true };

    await store.updateParticipantStyle("you", firstStyle);
    await store.addMessage("you", "First look");
    await store.updateParticipantStyle("you", secondStyle);
    await store.addMessage("you", "Second look");

    const reopened = await RoomStore.open(projectRoot, stateDirectory);
    expect(reopened.snapshot().settings.participantStyles.you).toEqual(secondStyle);
    expect(reopened.snapshot().messages.slice(-2).map(({ style }) => style)).toEqual([firstStyle, secondStyle]);
  });

  it("automatically snapshots independent agent preferences onto their messages", async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), "all-my-friends-room-"));
    temporaryDirectories.push(projectRoot);
    const store = await RoomStore.open(projectRoot, path.join(projectRoot, "state"));
    const codexStyle = { ...DEFAULT_PARTICIPANT_STYLES.codex, fontFamily: "Courier New" as const, underline: true };
    const claudeStyle = { ...DEFAULT_PARTICIPANT_STYLES.claude, fontFamily: "Times New Roman" as const, backgroundColor: "#fefe78" };

    await store.updateParticipantStyle("codex", codexStyle);
    await store.updateParticipantStyle("claude", claudeStyle);
    await store.addMessage("codex", "Codex body");
    await store.addMessage("claude", "Claude body");

    expect(store.snapshot().messages.slice(-2).map(({ speaker, style }) => ({ speaker, style }))).toEqual([
      { speaker: "codex", style: codexStyle },
      { speaker: "claude", style: claudeStyle },
    ]);
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
