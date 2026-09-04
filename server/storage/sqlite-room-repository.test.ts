import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_PARTICIPANT_STYLES } from "../../shared/chat-style.js";
import { DEFAULT_ROOM_ID, SqliteRoomRepository } from "./sqlite-room-repository.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("SQLite room repository", () => {
  it("starts a fresh canonical room empty and keeps it empty across restart", async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), "amfaa-sqlite-empty-room-"));
    temporaryDirectories.push(projectRoot);
    const databasePath = path.join(projectRoot, "amfaa.sqlite");
    const store = await SqliteRoomRepository.open(projectRoot, databasePath);

    expect(store.snapshot().roster).toEqual({ schemaVersion: 3, revision: 1, entries: [] });
    expect(store.snapshot().sessions).toEqual({});
    store.close();

    const database = new DatabaseSync(databasePath);
    expect((database.prepare("SELECT count(*) AS total FROM room_agents WHERE room_id = ?").get(DEFAULT_ROOM_ID) as { total: number }).total).toBe(0);
    database.close();
    const reopened = await SqliteRoomRepository.open(projectRoot, databasePath);
    expect(reopened.snapshot().roster).toEqual({ schemaVersion: 3, revision: 1, entries: [] });
    reopened.close();
  });

  it("persists exactly one private command projection across restart", async () => {
    const projectRoot=await mkdtemp(path.join(os.tmpdir(),"amfaa-private-command-"));temporaryDirectories.push(projectRoot);const databasePath=path.join(projectRoot,"amfaa.sqlite");
    const store=await SqliteRoomRepository.open(projectRoot,databasePath);const first=await store.addPrivateCommandResponseOnce("submission-1","human-a","sanitized help");const duplicate=await store.addPrivateCommandResponseOnce("submission-1","human-a","changed");expect(duplicate).toEqual(first);store.close();
    const reopened=await SqliteRoomRepository.open(projectRoot,databasePath);expect(reopened.snapshot().messages.filter(({id})=>id===first.id)).toEqual([first]);reopened.close();
  });
  it("clears command-domain records during an explicit state overwrite",async()=>{const projectRoot=await mkdtemp(path.join(os.tmpdir(),"amfaa-sqlite-overwrite-"));temporaryDirectories.push(projectRoot);const store=await SqliteRoomRepository.open(projectRoot,path.join(projectRoot,"amfaa.sqlite"));const createdAt=new Date().toISOString();await store.createCommandSubmission({submissionId:"overwrite-command",roomId:DEFAULT_ROOM_ID,clientSubmissionId:"overwrite-client",command:"help",invocation:{command:"help"},invoker:{kind:"human",id:"human-1",displayName:"Ada"},createdAt});await store.appendDiagnostic({recordId:"overwrite-diagnostic",roomId:DEFAULT_ROOM_ID,agentId:"codex-sol",attemptId:"attempt-1",generationId:null,correlationId:"overwrite-correlation",promptHead:null,promptFingerprint:"sha256:prompt",reason:"test",metadata:{},diagnosticText:"safe",createdAt});store.replaceState(store.snapshot(),{overwrite:true});expect(await store.getCommandSubmission(DEFAULT_ROOM_ID,"overwrite-command")).toBeUndefined();expect(await store.listDiagnostics(DEFAULT_ROOM_ID,"codex-sol")).toEqual([]);store.close();});

  it("persists per-agent cursors and summary cache across restart while keeping cursors server-owned", async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), "amfaa-sqlite-context-cursor-"));
    temporaryDirectories.push(projectRoot);
    const databasePath = path.join(projectRoot, "amfaa.sqlite");
    const store = await SqliteRoomRepository.open(projectRoot, databasePath);
    await store.updateRoster(1, [{ agentId: "codex-sol", enabled: true }]);
    const message = await store.addMessage("you", "Cursor checkpoint");
    await store.setLastSeenMessageId("codex-sol", message.id);
    await store.putAgentContextSummary({ agentId: "codex-sol", spanStartId: store.snapshot().messages[0].id, spanEndId: message.id, configRevision: 0 }, "cached summary");
    store.close();

    const reopened = await SqliteRoomRepository.open(projectRoot, databasePath);
    expect(reopened.snapshot().roster?.entries.find(({ agentId }) => agentId === "codex-sol")?.lastSeenMessageId).toBe(message.id);
    expect(await reopened.getAgentContextSummary({ agentId: "codex-sol", spanStartId: reopened.snapshot().messages[0].id, spanEndId: message.id, configRevision: 0 })).toBe("cached summary");
    const suppliedCursor = reopened.snapshot().roster!.entries.map((entry) => ({ ...entry, lastSeenMessageId: "forged" }));
    expect(await reopened.updateRoster(2, suppliedCursor)).toMatchObject({ kind: "accepted" });
    expect(reopened.snapshot().roster?.entries.find(({ agentId }) => agentId === "codex-sol")?.lastSeenMessageId).toBe(message.id);
    await reopened.updateRoomConfiguration({ preflightMode: "shadow" }, "owner");
    expect(await reopened.getAgentContextSummary({ agentId: "codex-sol", spanStartId: reopened.snapshot().messages[0].id, spanEndId: message.id, configRevision: 0 })).toBeUndefined();
    await reopened.putAgentContextSummary({ agentId: "codex-sol", spanStartId: reopened.snapshot().messages[0].id, spanEndId: message.id, configRevision: 0 }, "late stale summary");
    expect(await reopened.getAgentContextSummary({ agentId: "codex-sol", spanStartId: reopened.snapshot().messages[0].id, spanEndId: message.id, configRevision: 0 })).toBeUndefined();
    expect(await reopened.getRoomConfiguration()).toMatchObject({ configurationRevision: 1, preflightMode: "shadow" });
    reopened.close();
  });

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
    expect(reopened.snapshot().roster).toEqual({ schemaVersion: 3, revision: 3, entries: [] });
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
    expect(reopened.snapshot().roster).toEqual({ schemaVersion: 3, revision: 2, entries: [expect.objectContaining({ agentId: "claude-opus", enabled: true, providerId: "anthropic", modelId: "claude-opus-5" })] });
    reopened.close();
  });

  it("persists administrator confirmation for migrated built-in selections across restart", async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), "amfaa-sqlite-confirmation-"));
    temporaryDirectories.push(projectRoot);
    const databasePath = path.join(projectRoot, "amfaa.sqlite");
    const store = await SqliteRoomRepository.open(projectRoot, databasePath);
    expect(await store.updateRoster(1, [{ agentId: "codex-sol", harness: "codex", enabled: true }])).toMatchObject({ kind: "accepted", roster: { revision: 2 } });
    const confirmed = store.snapshot().roster!.entries.map(({ selectionConfirmationRequired: _confirmation, sessionInvalidationReason: _reason, ...entry }) => entry);
    expect(store.snapshot().roster?.entries[0]).toMatchObject({ selectionConfirmationRequired: true });
    expect(await store.updateRoster(2, confirmed)).toMatchObject({ kind: "accepted" });
    store.close();

    const reopened = await SqliteRoomRepository.open(projectRoot, databasePath);
    expect(reopened.snapshot().roster?.entries.every((entry) => !entry.selectionConfirmationRequired)).toBe(true);
    reopened.close();
  });

  it("keeps matching legacy OpenCode fingerprints but permanently deletes rejected stale sessions", async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), "amfaa-sqlite-session-migration-"));
    temporaryDirectories.push(projectRoot);
    const databasePath = path.join(projectRoot, "amfaa.sqlite");
    const agentId = "agent-66666666-6666-4666-8666-666666666666";
    const firstSelection = { agentId, conversationalName: "Alpha", providerId: "openai", modelId: "first", enabled: true, supportsProjectWrites: true, configurationRevision: 1 };
    const secondSelection = { ...firstSelection, modelId: "second" };
    const store = await SqliteRoomRepository.open(projectRoot, databasePath);
    expect(await store.updateRoster(1, [firstSelection])).toMatchObject({ kind: "accepted" });
    await store.setSession(agentId, "portable-session", "read-only");
    store.close();

    const database = new DatabaseSync(databasePath);
    database.prepare("UPDATE agent_sessions SET configuration_fingerprint = ? WHERE agent_id = ?")
      .run(JSON.stringify({ harness: "opencode", providerId: "openai", modelId: "first" }), agentId);
    database.close();
    const portable = await SqliteRoomRepository.open(projectRoot, databasePath);
    expect(portable.snapshot().sessions[agentId]?.id).toBe("portable-session");
    expect(portable.snapshot().sessions[agentId]?.codeEpoch).toBeUndefined();
    expect(await portable.updateRoster(2, [secondSelection])).toMatchObject({ kind: "accepted" });
    await portable.setSession(agentId, "stale-session", "read-only");
    portable.close();

    const tampered = new DatabaseSync(databasePath);
    tampered.prepare("UPDATE agent_sessions SET configuration_fingerprint = ? WHERE agent_id = ?")
      .run(JSON.stringify({ providerId: "openai", modelId: "first" }), agentId);
    tampered.close();
    const rejected = await SqliteRoomRepository.open(projectRoot, databasePath);
    expect(rejected.snapshot().sessions[agentId]).toBeUndefined();
    expect(await rejected.updateRoster(3, [firstSelection])).toMatchObject({ kind: "accepted" });
    rejected.close();

    const reverted = await SqliteRoomRepository.open(projectRoot, databasePath);
    expect(reverted.snapshot().sessions[agentId]).toBeUndefined();
    reverted.close();
  });


  it("persists messages, settings, styles, bursts, and sessions across restarts", async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), "amfaa-sqlite-room-"));
    temporaryDirectories.push(projectRoot);
    const databasePath = path.join(projectRoot, "data", "amfaa.sqlite");
    const store = await SqliteRoomRepository.open(projectRoot, databasePath);
    await store.updateRoster(1, [{ agentId: "codex-sol", enabled: true }]);
    const humanStyle = { ...DEFAULT_PARTICIPANT_STYLES.you, fontFamily: "Georgia" as const, bold: true };

    await store.updateSettings({ roomName: "SQLite Room", writableAgent: "codex-sol" });
    await store.updateParticipantStyle("you", humanStyle);
    await store.addMessage("you", "Durable hello", "chat", humanStyle, { burstId: "human-burst", sequence: 0 }, {
      id: "human-12345678",
      name: "Robby",
      clientMessageId: "message-12345678",
    });
    const deployment = { schemaVersion: 1 as const, commitSha: "a".repeat(40), reference: { kind: "branch" as const, name: "main" }, worktree: "clean" as const, epoch: `deployment-v1:${"b".repeat(64)}`, observedAt: "2026-08-26T00:00:00.000Z" };
    await store.setDeployment(deployment);
    await store.setSession("codex-sol", "sqlite-session", "writable", deployment.epoch);
    store.close();

    const reopened = await SqliteRoomRepository.open(projectRoot, databasePath);
    const snapshot = reopened.snapshot();
    expect(snapshot.settings.roomName).toBe("SQLite Room");
    expect(snapshot.settings.writableAgent).toBe("codex-sol");
    expect(snapshot.settings.participantStyles.you).toEqual(humanStyle);
    expect(snapshot.deployment).toEqual(deployment);
    expect(snapshot.sessions["codex-sol"]).toEqual(expect.objectContaining({ id: "sqlite-session", permission: "writable", configurationRevision: 1, codeEpoch: deployment.epoch }));
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

  it("keeps OpenCode participant identities, models, styles, sessions, and attribution distinct across restart", async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), "amfaa-sqlite-dynamic-roster-"));
    temporaryDirectories.push(projectRoot);
    const databasePath = path.join(projectRoot, "amfaa.sqlite");
    const store = await SqliteRoomRepository.open(projectRoot, databasePath);
    const alpha = { agentId: "agent-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", conversationalName: "Alpha", providerId: "openai", modelId: "gpt-5.6-sol", enabled: true, supportsProjectWrites: true, configurationRevision: 1 };
    const beta = { agentId: "agent-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", conversationalName: "Beta", providerId: "openai", modelId: "gpt-5.6-terra", enabled: true, supportsProjectWrites: true, configurationRevision: 1 };
    expect(await store.updateRoster(1, [alpha, beta])).toMatchObject({ kind: "accepted" });
    const alphaStyle = { ...DEFAULT_PARTICIPANT_STYLES["codex-sol"], textColor: "#173874" };
    const betaStyle = { ...DEFAULT_PARTICIPANT_STYLES["codex-sol"], textColor: "#6c1739" };
    await store.updateParticipantStyle(alpha.agentId, alphaStyle);
    await store.updateParticipantStyle(beta.agentId, betaStyle);
    await store.updateSettings({ writableAgent: alpha.agentId });
    const epoch = `deployment-v1:${"d".repeat(64)}`;
    await store.setSession(alpha.agentId, "alpha-session", "read-only", epoch);
    await store.setSession(beta.agentId, "beta-session", "read-only", epoch);
    await store.addMessage(alpha.agentId, "Alpha history");
    await store.addMessage(beta.agentId, "Beta history");
    store.close();

    const reopened = await SqliteRoomRepository.open(projectRoot, databasePath);
    const snapshot = reopened.snapshot();
    expect(snapshot.roster?.entries).toEqual([expect.objectContaining(alpha), expect.objectContaining(beta)]);
    expect(snapshot.settings.participantStyles[alpha.agentId]).toEqual(alphaStyle);
    expect(snapshot.settings.participantStyles[beta.agentId]).toEqual(betaStyle);
    expect(snapshot.settings.writableAgent).toBe(alpha.agentId);
    expect(snapshot.sessions[alpha.agentId]).toMatchObject({ id: "alpha-session", codeEpoch: epoch });
    expect(snapshot.sessions[beta.agentId]).toMatchObject({ id: "beta-session", codeEpoch: epoch });
    expect(snapshot.messages.slice(-2)).toEqual([
      expect.objectContaining({ speaker: alpha.agentId, speakerName: "Alpha", text: "Alpha history" }),
      expect.objectContaining({ speaker: beta.agentId, speakerName: "Beta", text: "Beta history" }),
    ]);
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
