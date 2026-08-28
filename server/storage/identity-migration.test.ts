import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readdir, realpath, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { CANONICAL_ROOM_ID } from "./room-repository.js";
import { DEFAULT_SQLITE_MIGRATIONS_DIRECTORY, runSqliteMigrations } from "./sqlite-migrations.js";
import { SqliteRoomRepository } from "./sqlite-room-repository.js";

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("durable identity migration", () => {
  it("keeps an invalid legacy checkout as a general room without repository authority", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "amfaa-general-room-")); roots.push(root);
    const databasePath = path.join(root, "amfaa.sqlite");
    const store = await SqliteRoomRepository.open(root, databasePath);
    expect(await store.getDurableRoom(CANONICAL_ROOM_ID)).toMatchObject({ roomId: CANONICAL_ROOM_ID, projectId: null });
    expect(await store.getStorageScope(CANONICAL_ROOM_ID)).toMatchObject({ projectId: null, repositoryReferenceId: null });
    store.close();
  });

  it("binds repository instances to one room and one project without cross-scope reads", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "amfaa-room-isolation-")); roots.push(root);
    await exec("git", ["-C", root, "init", "-b", "main"]);
    const databasePath = path.join(root, "amfaa.sqlite");
    const canonical = await SqliteRoomRepository.open(root, databasePath);
    const server = await canonical.getDurableServer();
    const canonicalScope = await canonical.getStorageScope(CANONICAL_ROOM_ID);
    canonical.close();

    const roomId = "00000000-0000-4000-8000-000000000002";
    const projectId = "00000000-0000-4000-8000-000000000102";
    const repositoryReferenceId = "00000000-0000-4000-8000-000000000202";
    const now = "2026-08-28T12:00:00.000Z";
    const raw = new DatabaseSync(databasePath, { enableForeignKeyConstraints: true });
    raw.prepare("INSERT INTO durable_projects(project_id,server_id,revision,name,repository_capacity,repository_reference_id,created_at,updated_at) VALUES (?,?,?,?,1,?,?,?)")
      .run(projectId, server.serverId, 1, "Second project", repositoryReferenceId, now, now);
    raw.prepare("INSERT INTO repository_references(repository_reference_id,project_id,revision,state,local_path,sanitized_remote_identity,created_at,updated_at) VALUES (?,?,1,'unverified-legacy-placeholder',?,NULL,?,?)")
      .run(repositoryReferenceId, projectId, root, now, now);
    raw.prepare(`INSERT INTO rooms(id,slug,name,topic,writable_agent,conversation_energy,project_path,participant_styles_json,status,created_at,updated_at,server_id,project_id,identity_revision)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1)`).run(roomId, "second-room", "Second room", "Isolated", "nobody", "balanced", root, "{}", "idle", now, now, server.serverId, projectId);
    raw.prepare(`INSERT INTO room_agents(room_id,agent_id,enabled,position,configuration_json,last_seen_message_id,created_at,updated_at)
      SELECT ?,agent_id,enabled,position,configuration_json,NULL,?,? FROM room_agents WHERE room_id=?`)
      .run(roomId, now, now, CANONICAL_ROOM_ID);
    raw.close();

    const first = await SqliteRoomRepository.open(root, databasePath, { roomId: CANONICAL_ROOM_ID });
    const second = await SqliteRoomRepository.open(root, databasePath, { roomId });
    await first.addMessage("system", "canonical-only");
    await second.addMessage("system", "second-only");

    expect(first.snapshot().messages.some((message) => message.text === "second-only")).toBe(false);
    expect(second.snapshot().messages.some((message) => message.text === "canonical-only")).toBe(false);
    expect(await first.getStorageScope(roomId)).toBeUndefined();
    expect(await second.getStorageScope(CANONICAL_ROOM_ID)).toBeUndefined();
    expect(await first.getDurableProject(projectId)).toBeUndefined();
    expect(await second.getDurableProject(canonicalScope!.projectId!)).toBeUndefined();
    expect(await second.getStorageScope(roomId)).toMatchObject({ roomId, projectId, repositoryReferenceId });
    expect(await first.listPendingCommandAttempts(roomId)).toEqual([]);
    const secondScope = (await second.getStorageScope(roomId))!;
    const binding = (scope: typeof secondScope) => ({
      schemaVersion: 1 as const, kind: "assignment" as const, workId: "same-work-id", roomId: scope.roomId,
      projectId: scope.projectId, repositoryReferenceId: scope.repositoryReferenceId,
      repositoryReferenceRevision: scope.repositoryReferenceRevision, originTaskId: null, originTaskRevision: null,
      implementationJobId: null, implementationWorkerId: null, state: "needs-reconciliation" as const,
      reasonCode: "room-scoped-test", evidence: {}, revision: 1, createdAt: now, updatedAt: now,
    });
    await first.putSourceWorkBinding(binding(canonicalScope!));
    await second.putSourceWorkBinding(binding(secondScope));
    expect((await first.getSourceWorkBinding("assignment", "same-work-id"))?.roomId).toBe(CANONICAL_ROOM_ID);
    expect((await second.getSourceWorkBinding("assignment", "same-work-id"))?.roomId).toBe(roomId);
    const firstPeer = await SqliteRoomRepository.open(root, databasePath, { roomId: CANONICAL_ROOM_ID });
    const current = (await first.getSourceWorkBinding("assignment", "same-work-id"))!;
    const competing = await Promise.allSettled([
      first.putSourceWorkBinding({ ...current, revision: 2, reasonCode: "first-writer", updatedAt: "2026-08-28T12:01:00.000Z" }),
      firstPeer.putSourceWorkBinding({ ...current, revision: 2, reasonCode: "second-writer", updatedAt: "2026-08-28T12:01:01.000Z" }),
    ]);
    expect(competing.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(competing.filter(({ status }) => status === "rejected")).toHaveLength(1);
    expect((await first.getSourceWorkBinding("assignment", "same-work-id"))?.revision).toBe(2);
    firstPeer.close();
    first.close();
    second.close();
  });

  it("backs up v24, preserves the canonical room, creates only an unverified repository placeholder, and invalidates legacy writable authority idempotently", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "amfaa-identity-migration-")); roots.push(root);
    await exec("git", ["-C", root, "init", "-b", "main"]);
    const migrations = path.join(root, "legacy-migrations");
    await mkdir(migrations);
    for (const file of (await readdir(DEFAULT_SQLITE_MIGRATIONS_DIRECTORY)).filter((file) => Number(file.slice(0, 4)) <= 24)) {
      await copyFile(path.join(DEFAULT_SQLITE_MIGRATIONS_DIRECTORY, file), path.join(migrations, file));
    }
    const databasePath = path.join(root, "state", "amfaa.sqlite");
    await mkdir(path.dirname(databasePath), { recursive: true });
    const database = new DatabaseSync(databasePath, { enableForeignKeyConstraints: true });
    await runSqliteMigrations(database, migrations);
    const now = "2026-08-28T12:00:00.000Z";
    database.prepare(`INSERT INTO rooms(id,slug,name,topic,writable_agent,conversation_energy,project_path,participant_styles_json,status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(CANONICAL_ROOM_ID, "legacy", "Legacy Room", "Identity migration", "nobody", "balanced", root, "{}", "idle", now, now);
    for (const [agent, permission] of [["codex-sol", "read-only"], ["claude-sonnet", "writable"]] as const) {
      database.prepare("INSERT INTO agent_sessions(room_id,agent_id,provider_session_id,permission,updated_at) VALUES (?,?,?,?,?)")
        .run(CANONICAL_ROOM_ID, agent, `${agent}-session`, permission, now);
    }
    database.prepare(`INSERT INTO assignment_records(room_id,assignment_id,improvement_id,developer_member_id,developer_member_config_revision,agent_id,fencing_token,manifest_revision,pinned_base_sha,branch_name,observed_head_sha,workspace_path,lifecycle_status,recovery_json,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(CANONICAL_ROOM_ID, "legacy-assignment", "imp", "builder", 1, "codex-sol", 1, 1, "a".repeat(40), "amfaa/legacy", "b".repeat(40), path.join(root, "worktree"), "RECOVERABLE", "{}", now, now);
    database.close();

    const migrated = await SqliteRoomRepository.open(root, databasePath);
    const server = await migrated.getDurableServer();
    const room = await migrated.getDurableRoom(CANONICAL_ROOM_ID);
    expect(room).toMatchObject({ roomId: CANONICAL_ROOM_ID, serverId: server.serverId, revision: 1 });
    const project = await migrated.getDurableProject(room!.projectId!);
    const repository = await migrated.getRepositoryReference(project!.repositoryReferenceId!);
    expect(await migrated.getStorageScope(CANONICAL_ROOM_ID)).toMatchObject({ serverId: server.serverId, roomId: CANONICAL_ROOM_ID, projectId: project!.projectId, repositoryReferenceId: repository!.repositoryReferenceId, repositoryReferenceRevision: 1 });
    expect(repository).toMatchObject({ state: "unverified-legacy-placeholder", localPath: await realpath(root), sanitizedRemoteIdentity: null, revision: 1 });
    expect(await migrated.getSourceWorkBinding("assignment", "legacy-assignment")).toMatchObject({
      roomId: CANONICAL_ROOM_ID, state: "needs-reconciliation", reasonCode: "legacy-missing-implementation-job-worker",
      implementationJobId: null, implementationWorkerId: null,
    });
    const evidence = await migrated.identityMigrationEvidence();
    expect(evidence).toMatchObject({ sourceKind: "sqlite-in-place", migrationVersion: "durable-identities/v1", backupPath: `${databasePath}.pre-durable-identities-v1.bak` });
    migrated.close();

    const raw = new DatabaseSync(databasePath);
    expect(raw.prepare("SELECT permission,lane,invalidated_at,invalidation_reason FROM agent_sessions ORDER BY permission").all()).toEqual([
      { permission: "read-only", lane: "room-conversation", invalidated_at: null, invalidation_reason: null },
      { permission: "writable", lane: "legacy-invalidated", invalidated_at: expect.any(String), invalidation_reason: "legacy-writable-session-invalidated" },
    ]);
    raw.close();
    expect((await stat(`${databasePath}.pre-durable-identities-v1.bak`)).mode & 0o777).toBe(0o600);

    const reopened = await SqliteRoomRepository.open(root, databasePath);
    expect((await reopened.getDurableServer()).serverId).toBe(server.serverId);
    expect((await reopened.identityMigrationEvidence())?.identityDigest).toBe(evidence?.identityDigest);
    reopened.close();
  }, 15_000);
});
