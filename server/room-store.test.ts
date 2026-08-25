import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_PARTICIPANT_STYLES } from "../shared/chat-style.js";
import { createDefaultRoomState, RoomStore } from "./room-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("room style persistence", () => {
  it("persists revisioned live roster changes and clears deactivated authority", async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), "all-my-friends-roster-"));
    temporaryDirectories.push(projectRoot);
    const stateDirectory = path.join(projectRoot, "state");
    const store = await RoomStore.open(projectRoot, stateDirectory);
    await store.updateSettings({ writableAgent: "codex-sol" });
    await store.setSession("codex-sol", "active-session", "writable");

    const accepted = await store.updateRoster(1, [
      { agentId: "claude-opus", enabled: true },
      { agentId: "codex-sol", enabled: false },
    ]);
    expect(accepted).toMatchObject({ kind: "accepted", roster: { revision: 2 } });
    expect(store.snapshot().sessions).toEqual({});
    expect(store.snapshot().settings.writableAgent).toBe("nobody");
    expect(await store.updateRoster(1, [])).toEqual({ kind: "conflict", expectedRevision: 1, actualRevision: 2 });

    const reopened = await RoomStore.open(projectRoot, stateDirectory);
    expect(reopened.snapshot().roster).toEqual({ schemaVersion: 3, revision: 2, entries: [
      expect.objectContaining({ agentId: "claude-opus", enabled: true, providerId: "anthropic", modelId: "claude-opus-5" }),
      expect.objectContaining({ agentId: "codex-sol", enabled: false, providerId: "openai", modelId: "gpt-5.6-sol" }),
    ] });
  });

  it("invalidates only the reconfigured participant session while preserving identity and history", async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), "all-my-friends-model-change-"));
    temporaryDirectories.push(projectRoot);
    const store = await RoomStore.open(projectRoot, path.join(projectRoot, "state"));
    const first = { agentId: "agent-11111111-1111-4111-8111-111111111111", conversationalName: "Alpha", harness: "codex" as const, modelId: "gpt-5.6-sol", enabled: true, supportsProjectWrites: true, configurationRevision: 1 };
    const second = { agentId: "agent-22222222-2222-4222-8222-222222222222", conversationalName: "Beta", harness: "codex" as const, modelId: "gpt-5.6-terra", enabled: true, supportsProjectWrites: true, configurationRevision: 1 };
    await store.updateRoster(1, [first, second]);
    await store.setSession(first.agentId, "alpha-session", "read-only");
    await store.setSession(second.agentId, "beta-session", "read-only");
    await store.addMessage(first.agentId, "historical alpha");
    await store.updateRoster(2, [{ ...first, modelId: "gpt-5.6-luna" }, second]);
    const state = store.snapshot();
    expect(state.sessions[first.agentId]).toBeUndefined();
    expect(state.sessions[second.agentId]?.id).toBe("beta-session");
    expect(state.roster?.entries[0]).toMatchObject({ agentId: first.agentId, modelId: "gpt-5.6-luna", configurationRevision: 2, sessionInvalidationReason: expect.stringContaining("invalidated") });
    expect(state.messages.at(-1)).toMatchObject({ speaker: first.agentId, speakerName: "Alpha", text: "historical alpha" });
  });

  it("migrates legacy Codex and Claude history while invalidating nonportable sessions", async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), "all-my-friends-room-"));
    temporaryDirectories.push(projectRoot);
    const stateDirectory = path.join(projectRoot, "state");
    await mkdir(stateDirectory);
    const oldCodexStyle = { ...DEFAULT_PARTICIPANT_STYLES["codex-sol"], textColor: "#2a7238" };
    const oldClaudeStyle = { ...DEFAULT_PARTICIPANT_STYLES["claude-sonnet"], fontFamily: "Courier New" };
    await writeFile(path.join(stateDirectory, "room.json"), JSON.stringify({
      messages: [
        { id: "old-codex", speaker: "codex", text: "legacy Codex", timestamp: "2026-08-19T12:00:00Z", style: oldCodexStyle },
        { id: "old-claude", speaker: "claude", text: "legacy Claude", timestamp: "2026-08-19T12:00:01Z", style: oldClaudeStyle },
      ],
      sessions: {
        codex: { id: "codex-session", permission: "writable" },
        claude: { id: "claude-session", permission: "read-only" },
      },
      settings: {
        topic: "Open conversation",
        writableAgent: "codex",
        reviewMode: "read-only",
        maxRounds: 3,
        projectPath: projectRoot,
        participantStyles: { you: DEFAULT_PARTICIPANT_STYLES.you, codex: oldCodexStyle, claude: oldClaudeStyle },
      },
      status: "idle",
    }), "utf8");

    const snapshot = (await RoomStore.open(projectRoot, stateDirectory)).snapshot();
    expect(snapshot.messages).toEqual([
      expect.objectContaining({ speaker: "codex-sol", speakerName: "Sol", text: "legacy Codex", style: oldCodexStyle }),
      expect.objectContaining({ speaker: "claude-sonnet", speakerName: "Claude", text: "legacy Claude", style: oldClaudeStyle }),
    ]);
    expect(snapshot.sessions).toEqual({});
    expect(snapshot.roster?.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ agentId: "codex-sol", providerId: "openai", modelId: "gpt-5.6-sol", sessionInvalidationReason: expect.stringContaining("legacy harness") }),
      expect.objectContaining({ agentId: "claude-sonnet", providerId: "anthropic", modelId: "claude-sonnet-5", sessionInvalidationReason: expect.stringContaining("legacy harness") }),
    ]));
    expect(snapshot.settings.writableAgent).toBe("codex-sol");
    expect(snapshot.settings.roomName).toBe("The Agent Room");
    expect(snapshot.settings.conversationEnergy).toBe("balanced");
    expect(snapshot.settings.participantStyles["codex-sol"]).toEqual(oldCodexStyle);
    expect(snapshot.settings.participantStyles["claude-sonnet"]).toEqual(oldClaudeStyle);
    expect(snapshot.settings.participantStyles["codex-luna"]).toEqual(DEFAULT_PARTICIPANT_STYLES["codex-luna"]);
    expect(snapshot.settings.participantStyles["codex-terra"]).toEqual(DEFAULT_PARTICIPANT_STYLES["codex-terra"]);
    expect(snapshot.settings.participantStyles["claude-opus"]).toEqual(DEFAULT_PARTICIPANT_STYLES["claude-opus"]);
    const persisted = JSON.parse(await readFile(path.join(stateDirectory, "room.json"), "utf8")) as { settings: Record<string, unknown> };
    expect(persisted.settings.conversationEnergy).toBe("balanced");
    expect(persisted.settings).not.toHaveProperty("maxRounds");
    expect(persisted.settings).not.toHaveProperty("reviewMode");

    const confirmedEntries = snapshot.roster!.entries.map(({ selectionConfirmationRequired: _confirmation, sessionInvalidationReason: _reason, ...entry }) => entry);
    await expect((await RoomStore.open(projectRoot, stateDirectory)).updateRoster(snapshot.roster!.revision, confirmedEntries)).resolves.toMatchObject({ kind: "accepted" });
    const confirmed = (await RoomStore.open(projectRoot, stateDirectory)).snapshot();
    expect(confirmed.roster?.entries.every((entry) => !entry.selectionConfirmationRequired)).toBe(true);
  });

  it("does not resume an OpenCode session whose stored model fingerprint differs", async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), "all-my-friends-room-"));
    temporaryDirectories.push(projectRoot);
    const stateDirectory = path.join(projectRoot, "state");
    await mkdir(stateDirectory);
    await writeFile(path.join(stateDirectory, "room.json"), JSON.stringify({
      ...createDefaultRoomState(projectRoot),
      roster: { schemaVersion: 3, revision: 2, entries: [{ agentId: "agent-11111111-1111-4111-8111-111111111111", conversationalName: "Alpha", harness: "opencode", providerId: "openai", modelId: "gpt-5.6-sol", enabled: true, supportsProjectWrites: true, configurationRevision: 2 }] },
      sessions: { "agent-11111111-1111-4111-8111-111111111111": { id: "wrong-model-session", permission: "read-only", configurationFingerprint: "{\"providerId\":\"other\",\"modelId\":\"other\"}" } },
    }), "utf8");

    expect((await RoomStore.open(projectRoot, stateDirectory)).snapshot().sessions).toEqual({});
  });

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
    const codexStyle = { ...DEFAULT_PARTICIPANT_STYLES["codex-sol"], fontFamily: "Courier New" as const, underline: true };
    const claudeStyle = { ...DEFAULT_PARTICIPANT_STYLES["claude-sonnet"], fontFamily: "Times New Roman" as const, backgroundColor: "#fefe78" };

    await store.updateParticipantStyle("codex-sol", codexStyle);
    await store.updateParticipantStyle("claude-sonnet", claudeStyle);
    await store.addMessage("codex-sol", "Codex body");
    await store.addMessage("claude-sonnet", "Claude body");

    expect(store.snapshot().messages.slice(-2).map(({ speaker, style }) => ({ speaker, style }))).toEqual([
      { speaker: "codex-sol", style: codexStyle },
      { speaker: "claude-sonnet", style: claudeStyle },
    ]);
  });

  it("persists separate messages from one logical agent burst", async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), "all-my-friends-room-"));
    temporaryDirectories.push(projectRoot);
    const stateDirectory = path.join(projectRoot, "state");
    const store = await RoomStore.open(projectRoot, stateDirectory);

    await store.addMessage("codex-sol", "first", "chat", undefined, { burstId: "burst-1", sequence: 0 });
    await store.addMessage("codex-sol", "second", "chat", undefined, { burstId: "burst-1", sequence: 1 });

    const reopened = await RoomStore.open(projectRoot, stateDirectory);
    expect(reopened.snapshot().messages.slice(-2)).toEqual([
      expect.objectContaining({ text: "first", burstId: "burst-1", sequence: 0, style: DEFAULT_PARTICIPANT_STYLES["codex-sol"] }),
      expect.objectContaining({ text: "second", burstId: "burst-1", sequence: 1, style: DEFAULT_PARTICIPANT_STYLES["codex-sol"] }),
    ]);
  });

  it("serializes simultaneous message saves without dropping either response", async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), "all-my-friends-room-"));
    temporaryDirectories.push(projectRoot);
    const stateDirectory = path.join(projectRoot, "state");
    const store = await RoomStore.open(projectRoot, stateDirectory);

    await Promise.all([
      store.addMessage("codex-sol", "Codex finished."),
      store.addMessage("claude-sonnet", "Claude finished."),
    ]);

    const reopened = await RoomStore.open(projectRoot, stateDirectory);
    expect(reopened.snapshot().messages.slice(-2).map(({ speaker, text }) => ({ speaker, text }))).toEqual([
      { speaker: "codex-sol", text: "Codex finished." },
      { speaker: "claude-sonnet", text: "Claude finished." },
    ]);
  });

  it("starts fresh agent context while preserving visible history when the topic changes", async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), "all-my-friends-room-"));
    temporaryDirectories.push(projectRoot);
    const stateDirectory = path.join(projectRoot, "state");
    const store = await RoomStore.open(projectRoot, stateDirectory);
    await store.setSession("codex-sol", "old-session", "read-only");
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

  it("persists room renames without resetting conversation context", async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), "all-my-friends-room-"));
    temporaryDirectories.push(projectRoot);
    const stateDirectory = path.join(projectRoot, "state");
    const store = await RoomStore.open(projectRoot, stateDirectory);
    await store.setSession("codex-sol", "existing-session", "read-only");

    await store.updateSettings({ roomName: "Friday Night Agents" });

    const reopened = await RoomStore.open(projectRoot, stateDirectory);
    expect(reopened.snapshot().settings.roomName).toBe("Friday Night Agents");
    expect(reopened.snapshot().sessions["codex-sol"]?.id).toBe("existing-session");
  });

  it("restricts persisted room state to the current OS user", async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), "all-my-friends-room-"));
    temporaryDirectories.push(projectRoot);
    const stateDirectory = path.join(projectRoot, "state");

    const store = await RoomStore.open(projectRoot, stateDirectory);

    expect((await stat(stateDirectory)).mode & 0o777).toBe(0o700);
    expect((await stat(store.statePath)).mode & 0o777).toBe(0o600);
  });
});
