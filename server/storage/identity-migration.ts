import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { access, chmod, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { backup, type DatabaseSync } from "node:sqlite";
import { CANONICAL_ROOM_ID } from "./room-repository.js";
import { IDENTITY_MIGRATION_VERSION, identityDigest, type IdentityMigrationEvidence } from "./identity-domain.js";

const execFileAsync = promisify(execFile);
const MIGRATION_VERSION = 25;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function tableExists(database: DatabaseSync, name: string) {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

function applied(database: DatabaseSync) {
  return tableExists(database, "schema_migrations") && Boolean(database.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(MIGRATION_VERSION));
}

export async function prepareDurableIdentityBackup(database: DatabaseSync, databasePath: string) {
  if (databasePath === ":memory:" || !tableExists(database, "rooms")) return null;
  const backupPath = `${databasePath}.pre-${IDENTITY_MIGRATION_VERSION.replaceAll("/", "-")}.bak`;
  if (applied(database)) {
    const completed = tableExists(database, "storage_identity_migrations") && Boolean(database.prepare("SELECT 1 FROM storage_identity_migrations WHERE migration_version=?").get(IDENTITY_MIGRATION_VERSION));
    if (completed) return null;
    return await access(backupPath).then(() => backupPath).catch(() => null);
  }
  const populated = Boolean(database.prepare("SELECT 1 FROM rooms LIMIT 1").get());
  if (!populated) return null;
  const exists = await access(backupPath).then(() => true).catch(() => false);
  if (!exists) {
    await backup(database, backupPath);
    await chmod(backupPath, 0o600);
  }
  return backupPath;
}

interface LegacyRoomRow { id: string; name: string; project_path: string; created_at: string; updated_at: string }
interface CheckoutPlaceholder { localPath: string }

async function legacyCheckout(rawPath: string): Promise<CheckoutPlaceholder | null> {
  if (!rawPath || !path.isAbsolute(rawPath)) return null;
  const directory = await stat(rawPath).then((value) => value.isDirectory()).catch(() => false);
  if (!directory) return null;
  try {
    const canonical = await realpath(rawPath);
    const inside = (await execFileAsync("git", ["-C", canonical, "rev-parse", "--is-inside-work-tree"], { timeout: 3_000, maxBuffer: 64 * 1024 })).stdout.trim();
    if (inside !== "true") return null;
    const top = (await execFileAsync("git", ["-C", canonical, "rev-parse", "--show-toplevel"], { timeout: 3_000, maxBuffer: 64 * 1024 })).stdout.trim();
    return { localPath: await realpath(top) };
  } catch {
    return null;
  }
}

function counts(database: DatabaseSync) {
  const tables = (database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>)
    .map(({ name }) => name).filter((name) => /^[a-z0-9_]+$/i.test(name));
  return Object.fromEntries(tables.map((name) => [name, Number((database.prepare(`SELECT COUNT(*) AS count FROM ${name}`).get() as { count: number }).count)]));
}

function sourceDigest(database: DatabaseSync, sourceCounts: Readonly<Record<string, number>>) {
  const migrationOwned = new Set(["schema_migrations", "durable_servers", "durable_projects", "repository_references",
    "source_work_bindings", "storage_identity_migrations", "storage_import_manifests"]);
  const tables = (database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>)
    .map(({ name }) => name).filter((name) => /^[a-z0-9_]+$/i.test(name) && !migrationOwned.has(name));
  const payload = Object.fromEntries(tables.map((name) => {
    const rows = database.prepare(`SELECT * FROM ${name}`).all().map((row) => JSON.stringify(row)).sort();
    return [name, createHash("sha256").update(rows.join("\n")).digest("hex")];
  }));
  return createHash("sha256").update(JSON.stringify({ counts: sourceCounts, tables: payload })).digest("hex");
}

async function loadLegacySidecars(directory: string) {
  const load = async (filename: string) => {
    try {
      const raw = await readFile(path.join(directory, filename), "utf8");
      return { raw, value: JSON.parse(raw) as Record<string, unknown> };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { raw: "", value: {} as Record<string, unknown> };
      throw new Error(`Legacy ${filename} cannot be verified for durable identity migration.`, { cause: error });
    }
  };
  const [investigations, contributions, github, serverIdentity, room] = await Promise.all([
    load("investigations.json"), load("contributions.json"), load("github-contribution-broker.json"), load("server-identity.json"), load("room.json"),
  ]);
  const investigationJobs = Object.values((investigations.value.jobs || {}) as Record<string, Record<string, unknown>>);
  const contributionRecords = Array.isArray(contributions.value.records) ? contributions.value.records as Array<Record<string, unknown>> : [];
  const githubRecords = Array.isArray(github.value.records) ? github.value.records as Array<Record<string, unknown>> : [];
  const legacyWritableSessions = Object.entries((room.value.sessions || {}) as Record<string, Record<string, unknown>>)
    .filter(([, session]) => session?.permission === "writable" && typeof session.id === "string" && session.id)
    .map(([agentId, session]) => ({ agentId, providerSessionId: String(session.id),
      configurationFingerprint: typeof session.configurationFingerprint === "string" ? session.configurationFingerprint : null,
      configurationRevision: Number.isSafeInteger(session.configurationRevision) ? Number(session.configurationRevision) : null,
      codeEpoch: typeof session.codeEpoch === "string" ? session.codeEpoch : null }));
  return { investigationJobs, contributionRecords, githubRecords, legacyWritableSessions,
    serverId: typeof serverIdentity.value.serverId === "string" && UUID.test(serverIdentity.value.serverId) ? serverIdentity.value.serverId : null,
    digests: { investigations: createHash("sha256").update(investigations.raw).digest("hex"), contributions: createHash("sha256").update(contributions.raw).digest("hex"), github: createHash("sha256").update(github.raw).digest("hex"), serverIdentity: createHash("sha256").update(serverIdentity.raw).digest("hex"), room: createHash("sha256").update(room.raw).digest("hex") } };
}

function taskOrigins(database: DatabaseSync) {
  const origins = new Map<string, Array<{ roomId: string; taskId: string; revision: number }>>();
  if (!tableExists(database, "canonical_tasks")) return origins;
  const rows = database.prepare("SELECT room_id,task_id,revision,projection_json FROM canonical_tasks").all() as Array<{ room_id: string; task_id: string; revision: number; projection_json: string }>;
  for (const row of rows) {
    let projection: { references?: Array<{ kind?: string; targetId?: string }> };
    try { projection = JSON.parse(row.projection_json); } catch { continue; }
    for (const reference of projection.references || []) {
      if (reference.kind !== "assignment" || !reference.targetId) continue;
      const values = origins.get(reference.targetId) || [];
      values.push({ roomId: row.room_id, taskId: row.task_id, revision: row.revision });
      origins.set(reference.targetId, values);
    }
  }
  return origins;
}

function assignmentOriginCandidates(origins: ReturnType<typeof taskOrigins>, assignmentId: string, roomId: string) {
  return (origins.get(assignmentId) || []).filter((candidate) => candidate.roomId === roomId);
}

function insertBinding(database: DatabaseSync, value: {
  kind: string; workId: string; roomId: string; projectId: string | null; repositoryReferenceId: string | null;
  originTaskId?: string | null; originTaskRevision?: number | null; state: "needs-reconciliation" | "terminal-history"; reasonCode: string; evidence?: Record<string, unknown>; now: string;
}) {
  database.prepare(`INSERT OR IGNORE INTO source_work_bindings(
    work_kind,work_id,room_id,project_id,repository_reference_id,repository_reference_revision,
    origin_task_id,origin_task_revision,implementation_job_id,implementation_worker_id,reconciliation_state,
    reason_code,evidence_json,revision,created_at,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,NULL,NULL,?,?,?,?,?,?)`).run(
    value.kind, value.workId, value.roomId, value.projectId, value.repositoryReferenceId, value.repositoryReferenceId ? 1 : null,
    value.originTaskId ?? null, value.originTaskRevision ?? null, value.state, value.reasonCode,
    JSON.stringify(value.evidence || {}), 1, value.now, value.now,
  );
}

/** Rebuilds only the room-scoped provenance overlay after an explicitly reviewed
 * JSON overwrite. Durable server/project/repository identities remain stable. */
export async function rebuildJsonImportSourceWorkBindings(database: DatabaseSync, roomId: string, legacyStateDirectory: string, now = () => new Date().toISOString()) {
  const evidence = database.prepare("SELECT source_kind FROM storage_identity_migrations WHERE migration_version=?").get(IDENTITY_MIGRATION_VERSION) as { source_kind: string } | undefined;
  if (!evidence || evidence.source_kind !== "sqlite-in-place") return false;
  const room = database.prepare(`SELECT r.project_id,p.repository_reference_id FROM rooms r
    LEFT JOIN durable_projects p ON p.project_id=r.project_id WHERE r.id=?`).get(roomId) as { project_id: string | null; repository_reference_id: string | null } | undefined;
  if (!room) throw new Error(`Cannot rebuild source-work bindings for missing room ${roomId}.`);
  const scope = { projectId: room.project_id, repositoryReferenceId: room.repository_reference_id };
  const timestamp = now();
  const origins = taskOrigins(database);
  const sidecars = await loadLegacySidecars(legacyStateDirectory);

  database.exec("BEGIN IMMEDIATE");
  try {
    database.prepare("DELETE FROM source_work_bindings WHERE room_id=?").run(roomId);
    const assignments = database.prepare("SELECT assignment_id,lifecycle_status,lifecycle_revision FROM assignment_records WHERE room_id=?").all(roomId) as Array<{ assignment_id: string; lifecycle_status: string; lifecycle_revision: number }>;
    for (const assignment of assignments) {
      const candidates = assignmentOriginCandidates(origins, assignment.assignment_id, roomId);
      const origin = candidates.length === 1 ? candidates[0] : undefined;
      const terminal = ["COMPLETED", "CANCELLED", "DISPOSED"].includes(assignment.lifecycle_status);
      insertBinding(database, { kind: "assignment", workId: assignment.assignment_id, roomId, ...scope,
        originTaskId: origin?.taskId, originTaskRevision: origin?.revision, state: terminal ? "terminal-history" : "needs-reconciliation",
        reasonCode: terminal ? "legacy-terminal-history" : "legacy-missing-implementation-job-worker",
        evidence: { priorLifecycleStatus: assignment.lifecycle_status, priorLifecycleRevision: assignment.lifecycle_revision || 1, originCandidates: candidates.length }, now: timestamp });
    }
    const jobs = database.prepare("SELECT job_id,status,projection_json FROM continuation_jobs WHERE room_id=?").all(roomId) as Array<{ job_id: string; status: string; projection_json: string }>;
    for (const job of jobs) {
      let projection: { task?: { taskId?: string }; taskRevision?: number; authority?: { assignmentId?: string } } = {};
      try { projection = JSON.parse(job.projection_json); } catch {}
      const terminal = ["COMPLETED", "FAILED", "CANCELLED", "ACKNOWLEDGED"].includes(job.status);
      insertBinding(database, { kind: "continuation", workId: job.job_id, roomId, ...scope,
        originTaskId: projection.task?.taskId || null, originTaskRevision: projection.taskRevision || null,
        state: terminal ? "terminal-history" : "needs-reconciliation", reasonCode: terminal ? "legacy-terminal-history" : "legacy-continuation-lacks-implementation-worker",
        evidence: { priorStatus: job.status, assignmentId: projection.authority?.assignmentId || null }, now: timestamp });
    }
    if (roomId === CANONICAL_ROOM_ID) {
      for (const investigation of sidecars.investigationJobs) {
        const id = typeof investigation.investigationId === "string" ? investigation.investigationId : ""; if (!id) continue;
        const terminal = ["COMPLETED", "FAILED", "CANCELLED", "ACKNOWLEDGED", "ARCHIVED"].includes(String(investigation.status));
        insertBinding(database, { kind: "investigation", workId: id, roomId, ...scope, state: terminal ? "terminal-history" : "needs-reconciliation",
          reasonCode: terminal ? "legacy-terminal-history" : "legacy-investigation-provider-session-invalidated",
          evidence: { priorStatus: String(investigation.status || "unknown"), hadProviderSession: Boolean(investigation.providerSessionId) }, now: timestamp });
      }
      for (const contribution of sidecars.contributionRecords) {
        const id = typeof contribution.contributionId === "string" ? contribution.contributionId : ""; if (!id) continue;
        const source = contribution.source && typeof contribution.source === "object" ? contribution.source as Record<string, unknown> : {};
        const terminal = String(contribution.stage) === "DEPLOYED";
        insertBinding(database, { kind: "contribution", workId: id, roomId, ...scope,
          originTaskId: typeof source.taskId === "string" ? source.taskId : null, originTaskRevision: Number.isSafeInteger(source.taskRevision) ? Number(source.taskRevision) : null,
          state: terminal ? "terminal-history" : "needs-reconciliation", reasonCode: terminal ? "legacy-terminal-history" : "legacy-contribution-binding-requires-reconciliation",
          evidence: { priorStage: String(contribution.stage || "unknown"), assignmentId: typeof source.assignmentId === "string" ? source.assignmentId : null }, now: timestamp });
      }
      for (const audit of sidecars.githubRecords) {
        const id = typeof audit.idempotencyKey === "string" ? audit.idempotencyKey : ""; if (!id) continue;
        const claims = audit.claims && typeof audit.claims === "object" ? audit.claims as Record<string, unknown> : {};
        insertBinding(database, { kind: "github-broker", workId: id, roomId, ...scope,
          originTaskId: typeof claims.taskId === "string" ? claims.taskId : null, originTaskRevision: Number.isSafeInteger(claims.taskRevision) ? Number(claims.taskRevision) : null,
          state: "needs-reconciliation", reasonCode: "legacy-github-replay-requires-reauthorization",
          evidence: { priorOutcome: String(audit.outcome || "unknown"), assignmentId: typeof claims.assignmentId === "string" ? claims.assignmentId : null }, now: timestamp });
      }
    }
    database.exec("COMMIT");
    return true;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export async function ensureDurableIdentityMigration(
  database: DatabaseSync,
  backupPath: string | null,
  now = () => new Date().toISOString(),
  sourceKind: IdentityMigrationEvidence["sourceKind"] = "sqlite-in-place",
  legacyStateDirectory?: string,
  jsonImportManifest?: { readonly sourceDigest: string; readonly manifest: Readonly<Record<string, unknown>> },
  allowJsonImportOverExistingIdentity = false,
): Promise<IdentityMigrationEvidence> {
  const existing = database.prepare("SELECT * FROM storage_identity_migrations WHERE migration_version=?").get(IDENTITY_MIGRATION_VERSION) as Record<string, unknown> | undefined;
  if (existing) {
    if (sourceKind === "json-import" && jsonImportManifest) {
      const replay = database.prepare("SELECT manifest_json FROM storage_import_manifests WHERE source_digest=?").get(jsonImportManifest.sourceDigest) as { manifest_json: string } | undefined;
      if (replay) {
        if (identityDigest(JSON.parse(replay.manifest_json)) !== identityDigest(jsonImportManifest.manifest)) throw new Error("JSON import manifest digest collision or corruption detected.");
      } else if (String(existing.source_kind) === "json-import") {
        throw new Error("JSON import source manifest changed after the verified migration; restore the original source or use an explicit reviewed migration.");
      } else if (allowJsonImportOverExistingIdentity) {
        database.prepare("INSERT INTO storage_import_manifests(source_digest,manifest_json,completed_at) VALUES (?,?,?)")
          .run(jsonImportManifest.sourceDigest, JSON.stringify(jsonImportManifest.manifest), now());
      } else {
        throw new Error(`Durable identity storage was initialized from ${String(existing.source_kind)} and cannot accept an unreviewed JSON import replay.`);
      }
    }
    return evidenceFromRow(existing);
  }

  const rooms = database.prepare("SELECT id,name,project_path,created_at,updated_at FROM rooms ORDER BY id").all() as unknown as LegacyRoomRow[];
  const classified = await Promise.all(rooms.map(async (room) => ({ room, checkout: await legacyCheckout(room.project_path) })));
  const sidecars = await loadLegacySidecars(legacyStateDirectory || process.cwd());
  const sourceCounts = { ...counts(database), sidecar_investigations: sidecars.investigationJobs.length, sidecar_contributions: sidecars.contributionRecords.length, sidecar_github_broker_records: sidecars.githubRecords.length };
  const digest = createHash("sha256").update(JSON.stringify({ sqlite: sourceDigest(database, sourceCounts), sidecars: sidecars.digests })).digest("hex");
  const timestamp = now();
  const serverId = sourceKind === "json-import" && sidecars.serverId ? sidecars.serverId : randomUUID();
  const projectByPath = new Map<string, { projectId: string; repositoryReferenceId: string }>();

  database.exec("BEGIN IMMEDIATE");
  try {
    database.prepare("INSERT INTO durable_servers(server_id,revision,created_at,updated_at) VALUES (?,1,?,?)").run(serverId, timestamp, timestamp);
    for (const { room, checkout } of classified) {
      let projectId: string | null = null;
      if (checkout) {
        let identity = projectByPath.get(checkout.localPath);
        if (!identity) {
          identity = { projectId: randomUUID(), repositoryReferenceId: randomUUID() };
          projectByPath.set(checkout.localPath, identity);
          database.prepare("INSERT INTO durable_projects(project_id,server_id,revision,name,repository_reference_id,created_at,updated_at) VALUES (?,?,1,?,?,?,?)")
            .run(identity.projectId, serverId, room.name || "Migrated project", identity.repositoryReferenceId, timestamp, timestamp);
          database.prepare("INSERT INTO repository_references(repository_reference_id,project_id,revision,state,local_path,sanitized_remote_identity,created_at,updated_at) VALUES (?,?,1,'unverified-legacy-placeholder',?,NULL,?,?)")
            .run(identity.repositoryReferenceId, identity.projectId, checkout.localPath, timestamp, timestamp);
        }
        projectId = identity.projectId;
      }
      database.prepare("UPDATE rooms SET server_id=?,project_id=?,identity_revision=1 WHERE id=?").run(serverId, projectId, room.id);
    }

    database.prepare("UPDATE agent_sessions SET lane='room-conversation' WHERE permission='read-only'").run();
    database.prepare("UPDATE agent_sessions SET lane='legacy-invalidated',invalidated_at=?,invalidation_reason='legacy-writable-session-invalidated' WHERE permission='writable'").run(timestamp);

    const roomBindings = new Map(classified.map(({ room, checkout }) => {
      const project = checkout ? projectByPath.get(checkout.localPath)! : undefined;
      return [room.id, { projectId: project?.projectId || null, repositoryReferenceId: project?.repositoryReferenceId || null }];
    }));
    const origins = taskOrigins(database);
    if (tableExists(database, "assignment_records")) {
      const assignments = database.prepare("SELECT room_id,assignment_id,lifecycle_status,lifecycle_revision FROM assignment_records").all() as Array<{ room_id: string; assignment_id: string; lifecycle_status: string; lifecycle_revision: number }>;
      for (const assignment of assignments) {
        const candidates = assignmentOriginCandidates(origins, assignment.assignment_id, assignment.room_id);
        const origin = candidates.length === 1 ? candidates[0] : undefined;
        const scope = roomBindings.get(assignment.room_id) || { projectId: null, repositoryReferenceId: null };
        const terminal = ["COMPLETED", "CANCELLED", "DISPOSED"].includes(assignment.lifecycle_status);
        insertBinding(database, { kind: "assignment", workId: assignment.assignment_id, roomId: assignment.room_id, ...scope,
          originTaskId: origin?.taskId, originTaskRevision: origin?.revision, state: terminal ? "terminal-history" : "needs-reconciliation",
          reasonCode: terminal ? "legacy-terminal-history" : "legacy-missing-implementation-job-worker",
          evidence: { priorLifecycleStatus: assignment.lifecycle_status, priorLifecycleRevision: assignment.lifecycle_revision || 1, originCandidates: candidates.length }, now: timestamp });
      }
    }
    if (tableExists(database, "continuation_jobs")) {
      const jobs = database.prepare("SELECT room_id,job_id,status,projection_json FROM continuation_jobs").all() as Array<{ room_id: string; job_id: string; status: string; projection_json: string }>;
      for (const job of jobs) {
        const scope = roomBindings.get(job.room_id) || { projectId: null, repositoryReferenceId: null };
        let projection: { task?: { taskId?: string }; taskRevision?: number; authority?: { assignmentId?: string } } = {};
        try { projection = JSON.parse(job.projection_json); } catch {}
        const terminal = ["COMPLETED", "FAILED", "CANCELLED", "ACKNOWLEDGED"].includes(job.status);
        insertBinding(database, { kind: "continuation", workId: job.job_id, roomId: job.room_id, ...scope,
          originTaskId: projection.task?.taskId || null, originTaskRevision: projection.taskRevision || null,
          state: terminal ? "terminal-history" : "needs-reconciliation", reasonCode: terminal ? "legacy-terminal-history" : "legacy-continuation-lacks-implementation-worker",
          evidence: { priorStatus: job.status, assignmentId: projection.authority?.assignmentId || null }, now: timestamp });
      }
    }
    if (tableExists(database, "command_attempts")) {
      const attempts = database.prepare("SELECT room_id,attempt_id,status,delivery_result_json FROM command_attempts WHERE delivery_result_json IS NOT NULL").all() as Array<{ room_id: string; attempt_id: string; status: string; delivery_result_json: string }>;
      for (const attempt of attempts) {
        let permission: string | undefined; try { permission = JSON.parse(attempt.delivery_result_json).permission; } catch {}
        if (permission !== "writable") continue;
        const scope = roomBindings.get(attempt.room_id) || { projectId: null, repositoryReferenceId: null };
        insertBinding(database, { kind: "command-delivery", workId: attempt.attempt_id, roomId: attempt.room_id, ...scope,
          state: "needs-reconciliation", reasonCode: "legacy-writable-delivery-session-invalidated", evidence: { priorStatus: attempt.status }, now: timestamp });
      }
    }
    if (tableExists(database, "command_pov_executions")) {
      const executions = database.prepare("SELECT room_id,execution_id,status,delivery_result_json FROM command_pov_executions WHERE delivery_result_json IS NOT NULL").all() as Array<{ room_id: string; execution_id: string; status: string; delivery_result_json: string }>;
      for (const execution of executions) {
        let permission: string | undefined; try { permission = JSON.parse(execution.delivery_result_json).permission; } catch {}
        if (permission !== "writable") continue;
        const scope = roomBindings.get(execution.room_id) || { projectId: null, repositoryReferenceId: null };
        insertBinding(database, { kind: "pov-delivery", workId: execution.execution_id, roomId: execution.room_id, ...scope,
          state: "needs-reconciliation", reasonCode: "legacy-writable-delivery-session-invalidated", evidence: { priorStatus: execution.status }, now: timestamp });
      }
    }
    const sidecarRoomId = roomBindings.has(CANONICAL_ROOM_ID) ? CANONICAL_ROOM_ID : classified.length === 1 ? classified[0]!.room.id : null;
    if (!sidecarRoomId && (sidecars.investigationJobs.length || sidecars.contributionRecords.length || sidecars.githubRecords.length)) {
      throw new Error("Legacy sidecar work cannot be attributed across multiple rooms; reconcile its room origin before migration.");
    }
    if (sourceKind === "json-import" && sidecarRoomId) {
      const insertInvalidatedSession = database.prepare(`INSERT INTO agent_sessions(
        room_id,agent_id,provider_session_id,permission,configuration_fingerprint,configuration_revision,code_epoch,
        lane,invalidated_at,invalidation_reason,updated_at
      ) VALUES (?,?,?,'writable',?,?,?,'legacy-invalidated',?,'legacy-writable-session-invalidated',?)
      ON CONFLICT(room_id,agent_id) DO UPDATE SET provider_session_id=excluded.provider_session_id,permission='writable',
        configuration_fingerprint=excluded.configuration_fingerprint,configuration_revision=excluded.configuration_revision,
        code_epoch=excluded.code_epoch,lane='legacy-invalidated',invalidated_at=excluded.invalidated_at,
        invalidation_reason=excluded.invalidation_reason,updated_at=excluded.updated_at`);
      for (const session of sidecars.legacyWritableSessions) {
        if (!database.prepare("SELECT 1 FROM agents WHERE id=?").get(session.agentId)) continue;
        insertInvalidatedSession.run(sidecarRoomId, session.agentId, session.providerSessionId, session.configurationFingerprint,
          session.configurationRevision, session.codeEpoch, timestamp, timestamp);
      }
    }
    const canonicalScope = sidecarRoomId ? roomBindings.get(sidecarRoomId)! : { projectId: null, repositoryReferenceId: null };
    for (const investigation of sidecars.investigationJobs) {
      const id = typeof investigation.investigationId === "string" ? investigation.investigationId : "";
      if (!id) continue;
      const terminal = ["COMPLETED", "FAILED", "CANCELLED", "ACKNOWLEDGED", "ARCHIVED"].includes(String(investigation.status));
      insertBinding(database, { kind: "investigation", workId: id, roomId: sidecarRoomId!, ...canonicalScope,
        state: terminal ? "terminal-history" : "needs-reconciliation", reasonCode: terminal ? "legacy-terminal-history" : "legacy-investigation-provider-session-invalidated",
        evidence: { priorStatus: String(investigation.status || "unknown"), hadProviderSession: Boolean(investigation.providerSessionId) }, now: timestamp });
    }
    for (const contribution of sidecars.contributionRecords) {
      const id = typeof contribution.contributionId === "string" ? contribution.contributionId : "";
      if (!id) continue;
      const source = contribution.source && typeof contribution.source === "object" ? contribution.source as Record<string, unknown> : {};
      const terminal = String(contribution.stage) === "DEPLOYED";
      insertBinding(database, { kind: "contribution", workId: id, roomId: sidecarRoomId!, ...canonicalScope,
        originTaskId: typeof source.taskId === "string" ? source.taskId : null, originTaskRevision: Number.isSafeInteger(source.taskRevision) ? Number(source.taskRevision) : null,
        state: terminal ? "terminal-history" : "needs-reconciliation", reasonCode: terminal ? "legacy-terminal-history" : "legacy-contribution-binding-requires-reconciliation",
        evidence: { priorStage: String(contribution.stage || "unknown"), assignmentId: typeof source.assignmentId === "string" ? source.assignmentId : null }, now: timestamp });
    }
    for (const audit of sidecars.githubRecords) {
      const id = typeof audit.idempotencyKey === "string" ? audit.idempotencyKey : "";
      if (!id) continue;
      const claims = audit.claims && typeof audit.claims === "object" ? audit.claims as Record<string, unknown> : {};
      insertBinding(database, { kind: "github-broker", workId: id, roomId: sidecarRoomId!, ...canonicalScope,
        originTaskId: typeof claims.taskId === "string" ? claims.taskId : null, originTaskRevision: Number.isSafeInteger(claims.taskRevision) ? Number(claims.taskRevision) : null,
        state: "needs-reconciliation", reasonCode: "legacy-github-replay-requires-reauthorization",
        evidence: { priorOutcome: String(audit.outcome || "unknown"), assignmentId: typeof claims.assignmentId === "string" ? claims.assignmentId : null }, now: timestamp });
    }

    const identityRows = {
      server: database.prepare("SELECT * FROM durable_servers ORDER BY server_id").all(),
      projects: database.prepare("SELECT * FROM durable_projects ORDER BY project_id").all(),
      rooms: database.prepare("SELECT id,server_id,project_id,identity_revision FROM rooms ORDER BY id").all(),
      repositories: database.prepare("SELECT * FROM repository_references ORDER BY repository_reference_id").all(),
      bindings: database.prepare("SELECT work_kind,work_id,room_id,project_id,repository_reference_id,reconciliation_state,reason_code,revision FROM source_work_bindings ORDER BY work_kind,work_id").all(),
    };
    const finalDigest = identityDigest(identityRows);
    database.prepare("INSERT INTO storage_identity_migrations(migration_version,source_kind,source_digest,counts_json,identity_digest,backup_path,completed_at) VALUES (?,?,?,?,?,?,?)")
      .run(IDENTITY_MIGRATION_VERSION, sourceKind, digest, JSON.stringify(sourceCounts), finalDigest, backupPath, timestamp);
    if (sourceKind === "json-import") database.prepare("INSERT OR IGNORE INTO storage_import_manifests(source_digest,manifest_json,completed_at) VALUES (?,?,?)")
      .run(digest, JSON.stringify({ schemaVersion: 1, migrationVersion: IDENTITY_MIGRATION_VERSION, counts: sourceCounts, identityDigest: finalDigest }), timestamp);
    if (sourceKind === "json-import" && jsonImportManifest) database.prepare("INSERT INTO storage_import_manifests(source_digest,manifest_json,completed_at) VALUES (?,?,?)")
      .run(jsonImportManifest.sourceDigest, JSON.stringify(jsonImportManifest.manifest), timestamp);
    const foreignKeys = database.prepare("PRAGMA foreign_key_check").all();
    if (foreignKeys.length) throw new Error("Durable identity migration left foreign-key violations; restore the pre-migration backup.");
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return evidenceFromRow(database.prepare("SELECT * FROM storage_identity_migrations WHERE migration_version=?").get(IDENTITY_MIGRATION_VERSION) as Record<string, unknown>);
}

function evidenceFromRow(row: Record<string, unknown>): IdentityMigrationEvidence {
  return {
    schemaVersion: 1,
    migrationVersion: IDENTITY_MIGRATION_VERSION,
    sourceKind: row.source_kind as IdentityMigrationEvidence["sourceKind"],
    sourceDigest: String(row.source_digest),
    counts: JSON.parse(String(row.counts_json)),
    identityDigest: String(row.identity_digest),
    backupPath: row.backup_path === null ? null : String(row.backup_path),
    completedAt: String(row.completed_at),
  };
}

export const __testing = { legacyCheckout, counts, sourceDigest, taskOrigins, assignmentOriginCandidates };
