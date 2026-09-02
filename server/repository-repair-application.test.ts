import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, unlink } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { defaultGitHubCredentialKeyPath } from "./github-app-configuration.js";
import { openGitHubIntegrationRuntime } from "./github-integration-runtime.js";
import { ProjectGitHubBindingService } from "./project-github-binding.js";
import { ProjectRepositoryConnectionStore, ProjectRepositoryServiceRegistry } from "./project-repository-connection.js";
import { RoomLifecycleStore } from "./room-lifecycle.js";
import { RoomStore } from "./room-store.js";
import { SqliteRoomRepository } from "./storage/sqlite-room-repository.js";
import type { AssignmentRecord } from "./assignment-record.js";
import { GitHubContributionStore } from "./github-contribution-store.js";
import type { GitHubBrokerAuditRecord, GitHubOperation } from "./github-contribution-record.js";
import type { ContributionRecord } from "./contribution-record.js";
import { ContributionStore } from "./contribution-store.js";

const exec = promisify(execFile);
const sourceRoot = path.resolve(import.meta.dirname, "..");
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function brokerAuditInput(operation: GitHubOperation): Omit<GitHubBrokerAuditRecord, "schemaVersion" | "sequence" | "brokerRevision" | "previousHash" | "recordHash"> {
  return { timestamp: new Date().toISOString(), idempotencyKey: `fixture-${operation}`, requestHash: "a".repeat(64), actorId: "fixture",
    operation, target: "example/repository", outcome: "PENDING", result: null, detail: "Fixture pending",
    claims: { repository: "example/repository", roomId: "main", taskId: "fixture-task", taskRevision: 1, assignmentId: "fixture-assignment",
      assignmentRevision: 1, memberId: "fixture", memberRevision: 1, fencingToken: 1, manifestRevision: 1, branch: "fixture-branch",
      baseSha: "a".repeat(40), headSha: "b".repeat(40), policyRevision: 1 } };
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exiting = once(child, "exit");
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
  try { await exiting; } finally { clearTimeout(timer); }
}

async function fixture(backend: "json" | "sqlite") {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "amfaa-repair-application-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const checkout = path.join(root, "checkout"), relocated = path.join(root, "relocated");
  const data = path.join(root, "data"), databasePath = path.join(data, "room.sqlite");
  const assignments = path.join(root, "assignments");
  await mkdir(checkout);
  const git = (args: string[]) => exec("git", ["-C", checkout, ...args], {
    env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
  });
  await git(["init", "-b", "main"]);
  await git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--allow-empty", "-m", "Fixture"]);
  await git(["remote", "add", "origin", "https://github.com/example/repository.git"]);
  const room = backend === "json" ? await RoomStore.open(checkout, data) : await SqliteRoomRepository.open(checkout, databasePath);
  const roster = room.snapshot().roster!;
  await room.updateRoster(roster.revision, roster.entries.map((entry) => ({ ...entry, enabled: false })));
  await room.addMessage("system", "Preserved fixture history");
  if (room instanceof SqliteRoomRepository) room.close();
  const runtime = (await openGitHubIntegrationRuntime({ projectRoot: sourceRoot, dataDirectory: data,
    credentialKeyPath: defaultGitHubCredentialKeyPath(sourceRoot, root) }))!;
  const now = new Date().toISOString();
  expect((await runtime.vault.put("fixture-vault", 0, { kind: "github-device-user", accessToken: "ghu_fixture_not_a_real_token",
    refreshToken: "ghr_fixture_not_a_real_token", accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    refreshTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString() })).kind).toBe("ok");
  expect((await runtime.integrations.saveConnection({ expectedRevision: 0, connectionId: "fixture-github", authMode: "github-device-user", state: "ready",
    githubUser: { id: 7, login: "fixture" }, secretReference: "fixture-vault", connectedAt: now, lastValidatedAt: now })).kind).toBe("ok");
  expect((await runtime.integrations.replaceCatalog({ expectedRevision: 0, connectionId: "fixture-github", connectionRevision: 1, discovery: { observedAt: now,
    installations: [{ installationId: 101, account: { id: 501, login: "Example", type: "Organization" }, repositorySelection: "selected" }],
    repositories: [{ githubRepositoryId: 201, installationId: 101, owner: "example", name: "repository", canonical: "github.com/example/repository", visibility: "private", defaultBranch: "main" }] } })).kind).toBe("ok");
  const bootstrap = randomUUID() + randomUUID(), password = randomUUID() + randomUUID();
  let initialized = false;
  async function start(projectPath = checkout) {
    const listener = net.createServer(); listener.listen(0, "127.0.0.1"); await once(listener, "listening");
    const port = (listener.address() as net.AddressInfo).port;
    await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
    const base = `http://127.0.0.1:${port}`;
    const child = spawn(process.execPath, ["--import", "tsx", "--import", "./server/fixtures/repository-repair-isolation.mjs", "server/index.ts"], {
      cwd: sourceRoot, stdio: ["ignore", "ignore", "ignore"], env: {
        PATH: process.env.PATH, NODE_ENV: "test", AMFAA_REPAIR_TEST_DIRECTORY: root,
        ALL_MY_FRIENDS_ARE_AGENTS_HOST: "127.0.0.1", ALL_MY_FRIENDS_ARE_AGENTS_PORT: String(port),
        ALL_MY_FRIENDS_ARE_AGENTS_STORAGE_BACKEND: backend, ALL_MY_FRIENDS_ARE_AGENTS_DATA_DIR: data,
        ALL_MY_FRIENDS_ARE_AGENTS_SQLITE_PATH: databasePath, ALL_MY_FRIENDS_ARE_AGENTS_PROJECT_PATH: projectPath,
        ALL_MY_FRIENDS_ARE_AGENTS_ASSIGNMENT_WORKTREES_DIR: assignments,
        ALL_MY_FRIENDS_ARE_AGENTS_GITHUB_READ_FAKE: "true", ALL_MY_FRIENDS_ARE_AGENTS_OWNER_BOOTSTRAP_SECRET: bootstrap,
        ALL_MY_FRIENDS_ARE_AGENTS_OPENCODE_COMMAND: "/bin/false",
      },
    });
    cleanups.push(() => stop(child));
    let ready = false;
    for (let attempt = 0; attempt < 200; attempt++) {
      if (child.exitCode !== null) throw new Error(`Repair fixture exited before readiness (${child.exitCode}).`);
      try { if ((await fetch(base + "/api/ready", { signal: AbortSignal.timeout(500) })).ok) { ready = true; break; } } catch {}
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!ready) throw new Error("Repair fixture readiness timed out.");
    const session = await fetch(base + (initialized ? "/api/control/login" : "/api/control/bootstrap"), { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ bootstrapSecret: bootstrap, username: "fixture-owner", password }) });
    expect(session.status).toBe(initialized ? 200 : 201); initialized = true;
    const cookie = session.headers.get("set-cookie")!.split(";")[0], csrf = (await session.json()).csrfToken;
    const call = (route: string, method = "GET", body?: unknown, authenticated = true, includeCsrf = true) => fetch(base + route, {
      method, headers: { "content-type": "application/json", ...(authenticated ? { cookie } : {}), ...(includeCsrf ? { "x-amfaa-csrf": csrf } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    async function readProject(projectId: string) {
      const human = await fetch(base + "/api/humans", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Fixture reader" }) });
      expect(human.status).toBe(201);
      const headers = { "content-type": "application/json", cookie: human.headers.get("set-cookie")!.split(";")[0] };
      const room = await fetch(base + "/api/rooms", { method: "POST", headers, body: JSON.stringify({ name: "Fixture read", projectId }) });
      expect(room.status).toBe(201);
      const roomId = (await room.json()).roomId;
      return fetch(`${base}/api/rooms/${roomId}/messages`, { method: "POST", headers, body: JSON.stringify({ text: "/gh pr 98", clientMessageId: randomUUID() }) });
    }
    return { call, readProject, stop: () => stop(child) };
  }
  const configure = { githubConnectionId: "fixture-github", githubRepositoryId: 201, expectedBindingRevision: 0,
    expectedRepositoryRevision: 0, checkoutPath: checkout, worktreeRoot: assignments, policyRevision: 7 };
  return { root, checkout, relocated, assignments, data, databasePath, runtime, start, configure };
}

describe("repository repair through application startup and HTTP routes", () => {
  it.each(["json", "sqlite"] as const)("keeps uncertain broker mutations blocking %s repair until recorded success", async (backend) => {
    const f = await fixture(backend); let app = await f.start();
    const route = "/api/control/projects/current/repository";
    expect((await app.call(route, "PUT", f.configure)).status).toBe(200);
    await app.stop();
    const brokerPath = path.join(f.data, "github-contribution-broker.json");
    const broker = await GitHubContributionStore.open(brokerPath);
    const record = brokerAuditInput("COMMENT");
    await broker.append(record);
    await broker.append({ ...record, outcome: "FAILED", detail: "retryable:Fixture response lost" });
    await rename(f.checkout, f.relocated);
    const body = { expectedBindingRevision: 1, expectedRepositoryRevision: 1, idempotencyKey: "uncertain-broker-repair", checkoutPath: f.relocated, worktreeRoot: f.assignments };
    for (const deniedRetry of [false, true]) {
      if (deniedRetry) await broker.append({ ...record, outcome: "REJECTED", claims: null, detail: "Assignment is no longer active" });
      app = await f.start(f.relocated);
      const rejected = await app.call(route + "/repair", "POST", body);
      expect(rejected.status).toBe(422);
      expect(await rejected.json()).toMatchObject({ reason: "Repository repair has 1 active or unreconciled durable reference(s)." });
      expect(await (await app.call(route + "/repair")).json()).toMatchObject({ repository: { revision: 1 }, repair: { state: "blocked" } });
      await app.stop();
    }
    await broker.append({ ...record, outcome: "SUCCEEDED", result: { id: "fixture-comment", url: "https://github.com/example/repository/issues/1#issuecomment-1" } });
    const auditBefore = await readFile(brokerPath, "utf8");
    for (let restart = 0; restart < 2; restart++) {
      app = await f.start(f.relocated);
      const repaired = await app.call(route + "/repair", "POST", body);
      expect(repaired.status).toBe(200);
      expect(await repaired.json()).toMatchObject({ repository: { revision: 2 }, binding: { revision: 1 } });
      await app.stop();
      expect(await readFile(brokerPath, "utf8")).toBe(auditBefore);
    }
  }, 30_000);

  it.each(["json", "sqlite"] as const)("permits %s relocation after interrupted read-only broker calls without dropping audit history", async (backend) => {
    const f = await fixture(backend); let app = await f.start();
    const route = "/api/control/projects/current/repository";
    expect((await app.call(route, "PUT", f.configure)).status).toBe(200);
    await app.stop();
    const brokerPath = path.join(f.data, "github-contribution-broker.json");
    const broker = await GitHubContributionStore.open(brokerPath);
    for (const operation of ["READ_ISSUE", "READ_PULL_REQUEST", "READ_CHECKS"] as const) await broker.append(brokerAuditInput(operation));
    const auditBefore = await readFile(brokerPath, "utf8");
    await rename(f.checkout, f.relocated);
    const body = { expectedBindingRevision: 1, expectedRepositoryRevision: 1, idempotencyKey: "interrupted-reads-repair", checkoutPath: f.relocated, worktreeRoot: f.assignments };
    for (let restart = 0; restart < 2; restart++) {
      app = await f.start(f.relocated);
      expect(await (await app.call(route + "/repair")).json()).toMatchObject({ repair: { state: "available" } });
      const repaired = await app.call(route + "/repair", "POST", body);
      expect(repaired.status).toBe(200);
      const state = await repaired.json();
      expect(state).toMatchObject({ repository: { revision: 2 }, binding: { revision: 1 } });
      if (backend === "sqlite") expect((await app.readProject(state.binding.projectId)).status).toBe(202);
      await app.stop();
      expect(await readFile(brokerPath, "utf8")).toBe(auditBefore);
    }
  }, 30_000);

  it.each(["json", "sqlite"] as const)("repairs after a local contribution rejection across %s restarts without rewriting its audit", async (backend) => {
    const f = await fixture(backend);
    let app = await f.start();
    const route = "/api/control/projects/current/repository";
    expect((await app.call(route, "PUT", f.configure)).status).toBe(200);
    const body = { expectedBindingRevision: 1, expectedRepositoryRevision: 1, idempotencyKey: "contribution-baseline-repair", checkoutPath: f.checkout, worktreeRoot: f.assignments };
    expect((await app.call(route + "/repair", "POST", body)).status).toBe(200);
    expect(await (await app.call(route + "/repair")).json()).toMatchObject({ repository: { revision: 2 }, repair: { state: "available" } });
    await app.stop();

    const records = await ContributionStore.open(path.join(f.data, "contributions.json"));
    const now = new Date().toISOString();
    const pending: ContributionRecord = {
      schemaVersion: 1, contributionId: "fixture-contribution", handoffKey: "fixture-handoff", handoffRequestDigest: "a".repeat(64), revision: 1, stage: "REVIEW_PENDING",
      source: { repository: "example/repository", taskId: "fixture-task", taskRevision: 1, improvementId: "fixture-improvement", improvementRevision: 1,
        assignmentId: "fixture-assignment", assignmentRevision: 1, authorId: "fixture-author", authorRevision: 1, fencingToken: 1, manifestRevision: 1,
        branch: "fixture-contribution", baseSha: "a".repeat(40), headSha: "b".repeat(40), manifestDigest: "c".repeat(64), brokerRevision: "fixture" },
      title: "Fixture contribution", description: "Rejected before publication",
      testEvidence: [{ command: "fixture-test", result: "PASSED", digest: "e".repeat(64), at: now }], unresolvedFindings: [], review: null,
      pullRequest: null, merged: null, deployed: null, approvals: [], blockedReason: null, createdAt: now, updatedAt: now,
    };
    await records.transact({ record: pending, action: "HANDOFF_CREATED", actorId: "fixture-author", detail: "Fixture handoff" });
    const blocked: ContributionRecord = { ...pending, revision: 2, stage: "BLOCKED", blockedReason: "Changes require revision",
      review: { reviewerId: "fixture-reviewer", reviewerRevision: 1, decision: "REJECTED", summary: "Changes require revision", sourceEvidenceDigest: "d".repeat(64), at: now } };
    await records.transact({ record: blocked, action: "REVIEW_REJECTED", actorId: "fixture-reviewer", detail: "Changes require revision" });
    const auditBefore = await readFile(path.join(f.data, "contributions.json"), "utf8");
    await rename(f.checkout, f.relocated);
    const repair = { ...body, expectedRepositoryRevision: 2, idempotencyKey: "blocked-contribution-repair", checkoutPath: f.relocated };
    for (let restart = 0; restart < 2; restart++) {
      app = await f.start(f.relocated);
      const inspection = await app.call(route + "/repair");
      expect(inspection.status).toBe(200);
      expect(await inspection.json()).toMatchObject({ repository: { revision: restart === 0 ? 2 : 3 }, repair: { state: "available" } });
      const response = await app.call(route + "/repair", "POST", repair);
      expect(response.status).toBe(200);
      const repaired = await response.json();
      expect(repaired).toMatchObject({ repository: { revision: 3 }, binding: { revision: 1 } });
      if (backend === "sqlite") expect((await app.readProject(repaired.binding.projectId)).status).toBe(202);
      await app.stop();
      expect((await ContributionStore.open(path.join(f.data, "contributions.json"))).get(blocked.contributionId)).toEqual(blocked);
      expect(await readFile(path.join(f.data, "contributions.json"), "utf8")).toBe(auditBefore);
    }
    // A separate failed publication must still block a new repair, despite the
    // safely terminated contribution above and absent publishing credentials.
    const failedHandoff = { ...pending, contributionId: "fixture-failed-contribution", handoffKey: "fixture-failed-handoff" };
    await records.transact({ record: failedHandoff, action: "HANDOFF_CREATED", actorId: "fixture-author", detail: "Fixture handoff" });
    const accepted: ContributionRecord = { ...failedHandoff, revision: 2, stage: "REVIEW_ACCEPTED", review: { ...blocked.review!, decision: "ACCEPTED" } };
    await records.transact({ record: accepted, action: "REVIEW_ACCEPTED", actorId: "fixture-reviewer", detail: "Fixture accepted" });
    const approved: ContributionRecord = { ...accepted, revision: 3, approvals: [{ approvalId: "fixture-approval", kind: "PUBLICATION", revision: 2,
      grantedBy: "fixture-human", grantedAt: now, repository: pending.source.repository, branch: pending.source.branch, baseSha: pending.source.baseSha, headSha: pending.source.headSha,
      pullNumber: null, mergedSha: null, environment: null, artifactDigest: null, consumedAt: null, externalResultId: null }] };
    await records.transact({ record: approved, action: "PUBLICATION_APPROVED", actorId: "fixture-human", detail: "Fixture approval" });
    await records.transact({ record: { ...approved, revision: 4, stage: "BLOCKED", blockedReason: "Fixture uncertain outcome" },
      action: "PUBLICATION_FAILED", actorId: "fixture-human", outcome: "FAILED", detail: "Fixture uncertain outcome" });
    app = await f.start(f.relocated);
    expect(await (await app.call(route + "/repair")).json()).toMatchObject({ repair: { state: "blocked" } });
    const denied = await app.call(route + "/repair", "POST", { ...repair, expectedRepositoryRevision: 3, idempotencyKey: "uncertain-contribution-repair" });
    expect(denied.status).toBe(422);
    expect(await denied.json()).toMatchObject({ reason: "Repository repair has 1 active or unreconciled durable reference(s)." });
  }, 30_000);

  it("retains pending broker blockers without publishing credentials and permits repair after reconciliation", async () => {
    const f = await fixture("json");
    let app = await f.start();
    const route = "/api/control/projects/current/repository";
    expect((await app.call(route, "PUT", f.configure)).status).toBe(200);
    await app.stop();
    const broker = await GitHubContributionStore.open(path.join(f.data, "github-contribution-broker.json"));
    const record = brokerAuditInput("PUBLISH_DRAFT_PULL_REQUEST");
    await broker.append({ ...record, outcome: "PENDING" });
    app = await f.start();
    const body = { expectedBindingRevision: 1, expectedRepositoryRevision: 1, idempotencyKey: "pending-broker-repair", checkoutPath: f.checkout, worktreeRoot: f.assignments };
    expect((await app.call(route + "/repair", "POST", body)).status).toBe(422);
    expect(await (await app.call(route + "/repair")).json()).toMatchObject({ repository: { revision: 1 }, repair: { state: "blocked" } });
    await app.stop();
    await broker.append({ ...record, outcome: "SUCCEEDED", result: { id: "fixture-pull", url: "https://github.com/example/repository/pull/1", number: 1 } });
    app = await f.start();
    expect((await app.call(route + "/repair", "POST", body)).status).toBe(200);
  }, 30_000);

  it("preserves an existing JSON project's key when upgrading after a checkout move", async () => {
    const f = await fixture("json");
    let app = await f.start();
    const route = "/api/control/projects/current/repository";
    const configured = await app.call(route, "PUT", f.configure);
    expect(configured.status).toBe(200);
    const projectId = (await configured.json()).binding.projectId;
    const integrationBefore = await readFile(path.join(f.data, "github-integrations.json"), "utf8");
    const vaultBefore = await readFile(path.join(f.data, "github-credentials.enc"), "utf8");
    await app.stop();
    // Simulate state written by a version that did not persist the legacy ID.
    await unlink(path.join(f.data, "project-identity.json")).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    await rename(f.checkout, f.relocated);
    app = await f.start(f.relocated);
    const inspection = await app.call(route + "/repair");
    expect.soft(await inspection.json()).toMatchObject({ binding: { projectId, revision: 1 }, repair: { authority: "unverified" } });
    expect.soft((await app.call(`/api/control/projects/${projectId}/repository/repair`)).status).toBe(200);
    const body = { expectedBindingRevision: 1, expectedRepositoryRevision: 1, idempotencyKey: "legacy-move", checkoutPath: f.relocated, worktreeRoot: f.assignments };
    const repaired = await app.call(route + "/repair", "POST", body);
    expect(repaired.status).toBe(200);
    expect(await repaired.json()).toMatchObject({ binding: { projectId, revision: 1 }, repository: { projectId, revision: 2 } });
    await app.stop(); app = await f.start(f.relocated);
    expect(await (await app.call(route + "/repair", "POST", body)).json()).toMatchObject({ repository: { projectId, revision: 2 } });
    expect(await readFile(path.join(f.data, "github-integrations.json"), "utf8")).toBe(integrationBefore);
    expect(await readFile(path.join(f.data, "github-credentials.enc"), "utf8")).toBe(vaultBefore);
    expect(JSON.parse(await readFile(path.join(f.data, "room.json"), "utf8")).messages.some((message: { text: string }) => message.text === "Preserved fixture history")).toBe(true);
  }, 30_000);

  it("repairs a SQLite project outside the startup room without changing room read boundaries", async () => {
    const f = await fixture("sqlite");
    const startup = await SqliteRoomRepository.open(f.checkout, f.databasePath);
    const startupProject = (await startup.getStorageScope(startup.roomId))!.projectId;
    const server = await startup.getDurableServer();
    const projectId = randomUUID(), now = new Date().toISOString();
    const database = new DatabaseSync(f.databasePath);
    try {
      database.prepare("INSERT INTO durable_projects(project_id,server_id,revision,name,repository_capacity,repository_reference_id,created_at,updated_at) VALUES (?,?,1,?,1,NULL,?,?)")
        .run(projectId, server.serverId, "Other project", now, now);
    } finally { database.close(); }
    const lifecycle = await RoomLifecycleStore.open(f.databasePath, f.checkout);
    const otherRoom = lifecycle.create("fixture-human", { name: "Other room", projectId });
    const siblingRoom = lifecycle.create("fixture-human", { name: "Archived sibling", projectId });
    lifecycle.archive(siblingRoom.roomId, "fixture-human", siblingRoom.revision);
    lifecycle.close();
    expect(await startup.getDurableProject(projectId)).toBeUndefined(); startup.close();
    const repositories = await ProjectRepositoryConnectionStore.open(f.data);
    const registry = new ProjectRepositoryServiceRegistry(repositories, () => ({}), undefined,
      (id, reference) => f.runtime.credentials.available(id, reference));
    const bindings = new ProjectGitHubBindingService(f.runtime.integrations, (id) => registry.forProject(id).connection);
    expect((await bindings.configure({ ...f.configure, projectId })).kind).toBe("ok");
    await rename(f.checkout, f.relocated);
    let app = await f.start(f.relocated);
    const route = `/api/control/projects/${projectId}/repository/repair`;
    expect.soft((await app.call(route)).status).toBe(200);
    expect((await app.readProject(projectId)).status).toBe(400);
    const body = { expectedBindingRevision: 1, expectedRepositoryRevision: 1, idempotencyKey: "other-project-move", checkoutPath: f.relocated, worktreeRoot: f.assignments };
    expect((await app.call(route, "POST", body, false)).status).toBe(401);
    expect((await app.call(route, "POST", body, true, false)).status).toBe(403);
    expect((await app.call("/api/control/projects/missing/repository/repair", "POST", body)).status).toBe(404);
    const sibling = await SqliteRoomRepository.open(f.relocated, f.databasePath, { roomId: siblingRoom.roomId });
    const assignment: AssignmentRecord = { assignmentId: "fixture-assignment", improvementId: "fixture-improvement", developerMemberId: "fixture-developer",
      developerMemberConfigRevision: 1, agent: "codex-sol", fencingToken: 1, manifestRevision: 1, pinnedBaseSha: "a".repeat(40),
      branch: "fixture-work", observedHeadSha: "a".repeat(40), workspacePath: path.join(f.root, "fixture-work"), lifecycleStatus: "ACTIVE",
      recovery: { classification: "clean", reconciledAt: now, previousStatus: null, detail: "Fixture" }, createdAt: now, updatedAt: now };
    try {
      await sibling.putAssignment(assignment);
      expect((await app.call(route, "POST", body)).status).toBe(422);
      expect(await (await app.call(route)).json()).toMatchObject({ repair: { state: "blocked" }, repository: { revision: 1 } });
      await sibling.putAssignment({ ...assignment, lifecycleStatus: "COMPLETED", recovery: { ...assignment.recovery, classification: "missing" } });
      expect((await app.call(route, "POST", body)).status).toBe(422);
      await sibling.putAssignment({ ...assignment, lifecycleStatus: "COMPLETED" });
    } finally { sibling.close(); }
    const repaired = await app.call(route, "POST", body);
    expect(repaired.status).toBe(200);
    expect(await repaired.json()).toMatchObject({ repository: { projectId, revision: 2 }, binding: { revision: 1 } });
    const recoveredRead = await app.readProject(projectId);
    expect(recoveredRead.status).toBe(202);
    expect(await recoveredRead.json()).toMatchObject({ result: { resultText: expect.stringContaining("GitHub PR #98") } });
    await app.stop(); app = await f.start(f.relocated);
    expect(await (await app.call(route, "POST", body)).json()).toMatchObject({ repository: { projectId, revision: 2 } });
    expect((await app.readProject(projectId)).status).toBe(202);
    const first = await SqliteRoomRepository.open(f.relocated, f.databasePath);
    const second = await SqliteRoomRepository.open(f.relocated, f.databasePath, { roomId: otherRoom.roomId });
    try {
      expect(await first.getDurableProject(projectId)).toBeUndefined();
      expect(await second.getDurableProject(startupProject!)).toBeUndefined();
      expect(await second.getStorageScope(otherRoom.roomId)).toMatchObject({ projectId });
    } finally { first.close(); second.close(); }
  }, 30_000);
});
