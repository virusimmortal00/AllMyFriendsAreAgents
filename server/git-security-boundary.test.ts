import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createImprovement, type DomainActor } from "../shared/improvement-domain.js";
import { AssignmentLifecycleService } from "./assignment-lifecycle.js";
import { DeveloperBridgeService } from "./developer-bridge.js";
import { DeveloperTeamRegistry, hashToken, type DeveloperTeamMemberRevision } from "./developer-team.js";
import { AssignmentGitBroker, claimsFor, type AssignmentGitClaims, type AssignmentGitRequest } from "./git-security-boundary.js";
import { AssignmentGitBrokerServer, parseGitArguments } from "./git-broker-server.js";
import { RoomStore } from "./room-store.js";
import { confinedWriterInvocation, resolveGitExecutablePath, resolveGitExecutablePaths, verifyWriterConfinement, WRITER_BOUNDARY_REVISION, type ConfinedWriterGrant } from "./writer-confinement.js";
import { legacyDefaultRoomAgentRoster } from "../shared/roster.js";

const exec = promisify(execFile);
const directories: string[] = [];
const brokerServers: AssignmentGitBrokerServer[] = [];
const token = "security-boundary-builder-token-over-thirty-two-characters";
const actor: DomainActor = { id: "human-author", role: "AUTHOR", human: true };
const member: DeveloperTeamMemberRevision = {
  memberId: "builder", revision: 7, displayName: "Boundary Builder", roles: ["AUTHOR", "OPERATOR"],
  capabilities: ["IMPROVEMENT_READ", "IMPROVEMENT_CLAIM", "ASSIGNMENT_WRITE"],
  tokenHash: hashToken(token), createdAt: "2026-08-21T12:00:00.000Z",
};

afterEach(async () => {
  await Promise.all(brokerServers.splice(0).map((server) => server.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function git(cwd: string, ...args: string[]) {
  return (await exec("git", ["-C", cwd, ...args], { encoding: "utf8" })).stdout.trim();
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "amfaa-git-boundary-")); directories.push(root);
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.email", "test@example.com"); await git(root, "config", "user.name", "Test");
  await writeFile(path.join(root, "tracked.txt"), "base\n"); await git(root, "add", "tracked.txt"); await git(root, "commit", "-m", "base");
  const base = await git(root, "rev-parse", "HEAD");
  const state = path.join(root, ".state"); const worktrees = path.join(state, "worktrees");
  const store = await RoomStore.open(root, state); await store.updateRoster(1, legacyDefaultRoomAgentRoster().entries); await store.updateSettings({ writableAgent: "codex-sol" });
  await store.createImprovement(createImprovement({ id: "imp-1", risk: "LOW", author: actor, now: "2099-01-01T00:00:00.000Z" }));
  const registry = new DeveloperTeamRegistry([member]);
  const bridge = new DeveloperBridgeService(store, registry, () => "2099-01-01T00:01:00.000Z");
  await bridge.acquireClaim(`Bearer ${token}`, {
    improvementId: "imp-1", expectedRevision: 1, idempotencyKey: "claim:boundary", leaseExpiresAt: "2099-01-01T01:00:00.000Z",
    manifest: { model: "gpt-test", harness: "codex", promptReference: "prompt://boundary", effectiveToolGrants: ["read", "edit", "test"], policyRevision: 1, repositoryBaseCommit: base, environmentId: "assignment" },
  });
  const lifecycle = new AssignmentLifecycleService(store, store, registry, root, worktrees, () => "2099-01-01T00:02:00.000Z", false);
  const first = await lifecycle.create(`Bearer ${token}`, { assignmentId: "assignment-one", improvementId: "imp-1", agent: "codex-sol", fencingToken: 1, manifestRevision: 1 });
  const second = await lifecycle.create(`Bearer ${token}`, { assignmentId: "assignment-two", improvementId: "imp-1", agent: "codex-sol", fencingToken: 1, manifestRevision: 1 });
  if (first.kind !== "ok" || second.kind !== "ok") throw new Error("fixture assignment creation failed");
  const auditPath = path.join(state, "git-broker-audit.jsonl");
  const broker = new AssignmentGitBroker(first.value.assignmentId, store, store, registry, root, worktrees, auditPath, () => "2099-01-01T00:03:00.000Z");
  return { root, state, store, registry, worktrees, base, assignment: first.value, other: second.value, broker, auditPath };
}

function request(claims: AssignmentGitClaims, operation: AssignmentGitRequest["operation"], extra: Partial<AssignmentGitRequest> = {}): AssignmentGitRequest {
  return { requestId: `request-${Math.random()}`, claims, operation, ...extra };
}

async function protectedState(root: string, assignmentBranch: string) {
  return {
    main: await git(root, "rev-parse", "refs/heads/main"),
    assignment: await git(root, "rev-parse", `refs/heads/${assignmentBranch}`),
    refs: await git(root, "show-ref"),
    config: await readFile(path.join(root, ".git", "config"), "utf8"),
    remotes: await git(root, "remote", "-v"),
    hooks: await Promise.all(["pre-commit", "post-commit"].map(async (name) => readFile(path.join(root, ".git", "hooks", name)).catch(() => Buffer.from("missing")))),
    live: await readFile(path.join(root, "tracked.txt")),
  };
}

describe("assignment-scoped Git broker", () => {
  it("supports only documented assignment operations and rotates the observed head after a brokered commit", async () => {
    const { assignment, broker, store, auditPath } = await fixture();
    let claims = claimsFor(assignment);
    await writeFile(path.join(assignment.workspacePath, "owned.txt"), "owned\n");
    expect(await broker.execute(request(claims, "status"))).toMatchObject({ kind: "ok", output: expect.stringContaining("owned.txt") });
    const staged = await broker.execute(request(claims, "stage", { paths: ["owned.txt"] }));
    if (staged.kind !== "ok") throw new Error(staged.reason);
    const committed = await broker.execute(request(claims, "commit", { message: "Brokered assignment commit" }));
    expect(committed).toMatchObject({ kind: "ok", claims: { assignmentId: assignment.assignmentId } });
    if (committed.kind !== "ok") throw new Error(committed.reason);
    expect(committed.claims.headSha).not.toBe(claims.headSha);
    expect((await store.getAssignment(assignment.assignmentId))?.observedHeadSha).toBe(committed.claims.headSha);
    expect(await broker.execute(request(claims, "status"))).toMatchObject({ kind: "rejected", reason: expect.stringContaining("stale") });
    const audit = (await readFile(auditPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(audit).toHaveLength(4);
    expect(audit.map(({ outcome }) => outcome)).toEqual(["ok", "ok", "ok", "rejected"]);
    expect(audit[1].previousHash).toBe(audit[0].entryHash);
  });

  it("serializes operations so concurrent stale-head commits cannot both succeed", async () => {
    const { assignment, broker } = await fixture(); const claims = claimsFor(assignment);
    await writeFile(path.join(assignment.workspacePath, "serialized.txt"), "serialized\n");
    expect(await broker.execute(request(claims, "stage", { paths: ["serialized.txt"] }))).toMatchObject({ kind: "ok" });
    const results = await Promise.all([
      broker.execute(request(claims, "commit", { message: "first serialized commit" })),
      broker.execute(request(claims, "commit", { message: "second serialized commit" })),
    ]);
    expect(results.map(({ kind }) => kind).sort()).toEqual(["ok", "rejected"]);
  });

  it("rejects identity, assignment, manifest, head, branch, workspace, and environment bypasses without changing protected state", async () => {
    const { root, assignment, other, broker } = await fixture();
    const claims = claimsFor(assignment); const before = await protectedState(root, assignment.branch);
    const attempts: AssignmentGitRequest[] = [
      request({ ...claims, developerMemberId: "intruder" }, "status"),
      request(claimsFor(other), "status"),
      request({ ...claims, manifestRevision: 999 }, "status"),
      request({ ...claims, headSha: "f".repeat(40) }, "status"),
      request({ ...claims, branch: "main" }, "status"),
      request({ ...claims, workspacePath: root }, "status"),
      request(claims, "status", { environment: { GIT_DIR: path.join(root, ".git") } }),
      request(claims, "status", { environment: { GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(root, ".git", "objects") } }),
      request(claims, "status", { environment: { GIT_CONFIG_GLOBAL: path.join(root, ".git", "config") } }),
      request(claims, "diff", { paths: ["--output=/tmp/stolen"] }),
      { ...request(claims, "status"), operation: "update-ref" as never },
    ];
    for (const attempt of attempts) expect(await broker.execute(attempt)).toMatchObject({ kind: "rejected" });
    expect(await protectedState(root, assignment.branch)).toEqual(before);
  });

  it("rejects traversal, Git metadata, option injection, and symlink escapes byte-for-byte", async () => {
    const { root, assignment, broker } = await fixture(); const claims = claimsFor(assignment);
    const outside = path.join(root, "outside.txt"); await writeFile(outside, "protected\n");
    await symlink(outside, path.join(assignment.workspacePath, "escape"));
    const before = await protectedState(root, assignment.branch);
    for (const candidate of ["../tracked.txt", ".git/config", "--all", "escape"]) {
      expect(await broker.execute(request(claims, "stage", { paths: [candidate] }))).toMatchObject({ kind: "rejected" });
    }
    expect(await readFile(outside, "utf8")).toBe("protected\n");
    expect(await protectedState(root, assignment.branch)).toEqual(before);
  });

  it("rejects alternate worktrees, the live checkout, and noncanonical symlink aliases", async () => {
    const { root, state, assignment, broker } = await fixture(); const claims = claimsFor(assignment);
    const alternate = path.join(state, "alternate"); await git(root, "worktree", "add", "--detach", alternate, assignment.pinnedBaseSha);
    const alias = path.join(state, "workspace-alias"); await symlink(assignment.workspacePath, alias);
    for (const workspacePath of [alternate, root, alias]) {
      expect(await broker.execute(request({ ...claims, workspacePath }, "status"))).toMatchObject({ kind: "rejected" });
    }
  });

  it("exposes only the allowlisted protocol through the assignment Git shim", async () => {
    const { root, state, assignment, broker, auditPath } = await fixture();
    const server = await new AssignmentGitBrokerServer(broker, assignment, path.join(state, "broker.sock"), path.join(state, "bin")).start();
    brokerServers.push(server);
    const shim = path.join(server.shimDirectory, "git");
    const env = { ...process.env, ALL_MY_FRIENDS_ARE_AGENTS_GIT_BROKER_SOCKET: server.socketPath, ALL_MY_FRIENDS_ARE_AGENTS_GIT_BROKER_TOKEN: server.token };
    const before = await protectedState(root, assignment.branch);
    expect((await exec(shim, ["status", "--short"], { cwd: assignment.workspacePath, env, encoding: "utf8" })).stdout).toContain(assignment.branch);
    const doubled = `${JSON.stringify({ token: server.token, args: ["status", "--short"] })}\n${JSON.stringify({ token: server.token, args: ["status", "--short"] })}\n`;
    expect((await rawBrokerRequest(server.socketPath, doubled)).trim().split("\n")).toHaveLength(1);
    for (const args of [
      ["update-ref", "refs/heads/main", assignment.pinnedBaseSha],
      ["config", "core.hooksPath", "/tmp/hooks"],
      ["remote", "add", "evil", "https://example.invalid/repo"],
      ["push", "evil", "main"],
      ["-c", "credential.helper=!steal", "status"],
    ]) await expect(exec(shim, args, { cwd: assignment.workspacePath, env, encoding: "utf8" })).rejects.toMatchObject({ code: 126 });
    await rawBrokerRequest(server.socketPath, `${JSON.stringify({ token: "wrong", args: ["status"] })}\n`);
    await rawBrokerRequest(server.socketPath, "not-json\n");
    await rawBrokerRequest(server.socketPath, "x".repeat(70_000));
    expect(await protectedState(root, assignment.branch)).toEqual(before);
    const audit = (await readFile(auditPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(audit).toHaveLength(10);
    expect(audit.slice(-3).map(({ outcome }) => outcome)).toEqual(["rejected", "rejected", "rejected"]);
    expect(audit.every((entry, index) => index === 0 || entry.previousHash === audit[index - 1].entryHash)).toBe(true);
  });

  it("closes promptly when a client connects without dispatching a request", async () => {
    const { state, assignment, broker } = await fixture();
    const server = await new AssignmentGitBrokerServer(broker, assignment, path.join(state, "idle.sock"), path.join(state, "idle-bin")).start();
    const socket = createConnection(server.socketPath);
    await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    await expect(Promise.race([
      server.close().then(() => "closed"),
      new Promise((resolve) => setTimeout(() => resolve("timeout"), 1_000)),
    ])).resolves.toBe("closed");
  });

  it("serializes connection claims and rejects malformed add paths before broker execution", async () => {
    const { state, assignment, broker } = await fixture();
    const server = await new AssignmentGitBrokerServer(broker, assignment, path.join(state, "serialized.sock"), path.join(state, "serialized-bin")).start();
    brokerServers.push(server);
    await writeFile(path.join(assignment.workspacePath, "serialized.txt"), "serialized\n");
    const encode = (args: string[]) => `${JSON.stringify({ token: server.token, args })}\n`;
    expect(JSON.parse(await rawBrokerRequest(server.socketPath, encode(["add", "--", "serialized.txt"])))).toMatchObject({ kind: "ok" });
    const commit = rawBrokerRequest(server.socketPath, encode(["commit", "-m", "serialized server commit"]));
    await new Promise((resolve) => setTimeout(resolve, 10));
    const status = rawBrokerRequest(server.socketPath, encode(["status", "--short"]));
    await expect(Promise.all([commit, status]).then((outputs) => outputs.map((output) => JSON.parse(output).kind))).resolves.toEqual(["ok", "ok"]);
    const claims = claimsFor(assignment);
    for (const args of [["add"], ["add", "--", "../escape"], ["add", "/tmp/escape"], ["add", "--all"]]) {
      expect(() => parseGitArguments(claims, args)).toThrow("outside the assignment broker allowlist");
    }
  });
});

function rawBrokerRequest(socketPath: string, payload: string) {
  return new Promise<string>((resolve, reject) => {
    const socket = createConnection(socketPath); let output = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(payload));
    socket.on("data", (chunk) => { output += chunk; });
    socket.on("end", () => resolve(output)); socket.on("error", reject);
  });
}

describe("confined writer startup", () => {
  async function grantFixture() {
    const { root, state, store, assignment, broker } = await fixture();
    const boundaryRoot = path.join(state, "boundary");
    const server = await new AssignmentGitBrokerServer(broker, assignment, path.join(boundaryRoot, "broker.sock"), path.join(boundaryRoot, "bin")).start();
    brokerServers.push(server);
    const common = await realpath(path.join(root, ".git"));
    const grant: ConfinedWriterGrant = {
      revision: WRITER_BOUNDARY_REVISION, claims: claimsFor(assignment), repositoryPath: root, gitCommonDirectory: common,
      brokerSocketPath: server.socketPath, brokerToken: server.token, brokerRootPath: boundaryRoot,
      gitShimDirectory: server.shimDirectory, gitShimDigest: server.shimDigest,
      gitExecutablePath: await resolveGitExecutablePath(),
    };
    return { root, state, store, assignment, server, grant };
  }

  it("fails closed without explicit activation, broker availability, ownership, or confinement", async () => {
    const { grant } = await grantFixture();
    await expect(verifyWriterConfinement(grant, {}, "darwin")).rejects.toThrow("not explicitly active");
    await expect(verifyWriterConfinement({ ...grant, brokerSocketPath: `${grant.brokerSocketPath}.missing` }, { ALL_MY_FRIENDS_ARE_AGENTS_GIT_SECURITY_BOUNDARY: "assignment-git-broker/v1" }, "darwin")).rejects.toThrow("broker is unavailable");
    await expect(verifyWriterConfinement({ ...grant, claims: { ...grant.claims, workspacePath: grant.repositoryPath } }, { ALL_MY_FRIENDS_ARE_AGENTS_GIT_SECURITY_BOUNDARY: "assignment-git-broker/v1" }, "darwin")).rejects.toThrow("ownership");
    const regularEndpoint = path.join(grant.brokerRootPath, "regular.sock"); await writeFile(regularEndpoint, "not a socket", { mode: 0o600 });
    await expect(verifyWriterConfinement({ ...grant, brokerSocketPath: regularEndpoint }, { PATH: process.env.PATH, ALL_MY_FRIENDS_ARE_AGENTS_GIT_SECURITY_BOUNDARY: "assignment-git-broker/v1" }, "darwin")).rejects.toThrow("type");
    await expect(verifyWriterConfinement({ ...grant, gitShimDigest: "f".repeat(64) }, { PATH: process.env.PATH, ALL_MY_FRIENDS_ARE_AGENTS_GIT_SECURITY_BOUNDARY: "assignment-git-broker/v1" }, "darwin")).rejects.toThrow("shim identity");
    const shimPath = path.join(grant.gitShimDirectory, "git"); await chmod(shimPath, 0o755);
    await expect(verifyWriterConfinement(grant, { PATH: process.env.PATH, ALL_MY_FRIENDS_ARE_AGENTS_GIT_SECURITY_BOUNDARY: "assignment-git-broker/v1" }, "darwin")).rejects.toThrow("mode");
    await chmod(shimPath, 0o700);
    await expect(verifyWriterConfinement({ ...grant, brokerToken: "b".repeat(64) }, { PATH: process.env.PATH, ALL_MY_FRIENDS_ARE_AGENTS_GIT_SECURITY_BOUNDARY: "assignment-git-broker/v1" }, "darwin")).rejects.toThrow("liveness");
    await expect(verifyWriterConfinement(grant, { ALL_MY_FRIENDS_ARE_AGENTS_GIT_SECURITY_BOUNDARY: "assignment-git-broker/v1" }, "win32")).rejects.toThrow("No supported");
  });

  it("makes raw Git unavailable and produces a profile that protects the repository and common Git directory", async () => {
    const { root, state, grant } = await grantFixture();
    await expect(confinedWriterInvocation("/usr/bin/git", ["update-ref", "refs/heads/main", "deadbeef"], grant)).rejects.toThrow("Direct Git invocation");
    const fakeBin = path.join(state, "fake-sandbox-bin"); await mkdir(fakeBin);
    const alternateGit = path.join(fakeBin, "git"); await writeFile(alternateGit, "#!/bin/sh\nexit 0\n", { mode: 0o700 }); await chmod(alternateGit, 0o700);
    if (process.platform !== "darwin") {
      const fakeSandbox = path.join(fakeBin, "sandbox-exec");
      await writeFile(fakeSandbox, "#!/bin/sh\nexit 0\n", { mode: 0o700 }); await chmod(fakeSandbox, 0o700);
    }
    const executablePath = `${fakeBin}${path.delimiter}${process.env.PATH}`;
    const invocation = await confinedWriterInvocation("/usr/bin/true", [], grant, {
      PATH: executablePath, HOME: process.env.HOME,
      ALL_MY_FRIENDS_ARE_AGENTS_GIT_SECURITY_BOUNDARY: "assignment-git-broker/v1",
    }, "darwin");
    expect(invocation.command).toBe("sandbox-exec");
    expect(invocation.args.join(" ")).toContain(`deny file-write* (subpath ${JSON.stringify(await realpath(root))})`);
    expect(invocation.args.join(" ")).toContain(JSON.stringify(grant.gitCommonDirectory));
    expect(invocation.args.join(" ")).toContain(JSON.stringify(await realpath(alternateGit)));
    expect(invocation.args.join(" ")).toContain(JSON.stringify(await realpath(grant.gitExecutablePath)));
    expect(JSON.parse(await readFile(path.join(grant.gitShimDirectory, "package.json"), "utf8"))).toEqual({ type: "commonjs" });
    expect(invocation.args.join(" ")).toContain(`deny file-read* file-write* (literal ${JSON.stringify(path.join(grant.claims.workspacePath, ".git"))})`);
    expect(invocation.cwd).toBe(grant.claims.workspacePath);
    expect(invocation.env).not.toHaveProperty("GIT_DIR");
  });

  it("fails startup when persisted assignment or manifest claims change before authenticated liveness", async () => {
    const { store, assignment, grant } = await grantFixture();
    await store.putAssignment({ ...assignment, manifestRevision: assignment.manifestRevision + 1 });
    await expect(verifyWriterConfinement(grant, {
      PATH: process.env.PATH,
      ALL_MY_FRIENDS_ARE_AGENTS_GIT_SECURITY_BOUNDARY: "assignment-git-broker/v1",
    }, "darwin")).rejects.toThrow("liveness");
  });

  it.skipIf(process.platform !== "darwin")("enforces the generated boundary against raw Git and live-checkout writes", async () => {
    const { root, grant } = await grantFixture();
    const environment = {
      PATH: process.env.PATH, HOME: process.env.HOME,
      ALL_MY_FRIENDS_ARE_AGENTS_GIT_SECURITY_BOUNDARY: "assignment-git-broker/v1",
    };
    const confinement = await verifyWriterConfinement(grant, environment, "darwin");
    await expect(exec(confinement.command, [...confinement.prefix, "/usr/bin/git", "-C", grant.claims.workspacePath, "status"], { encoding: "utf8" })).rejects.toBeTruthy();
    const gitPointer = path.join(grant.claims.workspacePath, ".git"); const pointerBefore = await readFile(gitPointer);
    await expect(exec(confinement.command, [...confinement.prefix, "/bin/sh", "-c", `rm -f .git; mkdir .git; /usr/bin/git init`], { cwd: grant.claims.workspacePath, encoding: "utf8" })).rejects.toBeTruthy();
    await expect(exec(confinement.command, [...confinement.prefix, "/bin/sh", "-c", `cp ${JSON.stringify(grant.gitExecutablePath)} ./copied-git && ./copied-git init nested`], { cwd: grant.claims.workspacePath, encoding: "utf8" })).rejects.toBeTruthy();
    expect(await readFile(gitPointer)).toEqual(pointerBefore);
    const liveProbe = path.join(root, "forbidden-writer-probe");
    await expect(exec(confinement.command, [...confinement.prefix, "/usr/bin/touch", liveProbe], { encoding: "utf8" })).rejects.toBeTruthy();
    await expect(readFile(liveProbe)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("builds the Linux boundary with the worktree Git pointer hidden by a read-only mount", async () => {
    const { state, grant } = await grantFixture();
    const fakeBin = path.join(state, "fake-bin"); await mkdir(fakeBin);
    const fakeBwrap = path.join(fakeBin, "bwrap"); await writeFile(fakeBwrap, "#!/bin/sh\nexit 0\n", { mode: 0o700 }); await chmod(fakeBwrap, 0o700);
    const confinement = await verifyWriterConfinement(grant, {
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
      ALL_MY_FRIENDS_ARE_AGENTS_GIT_SECURITY_BOUNDARY: "assignment-git-broker/v1",
    }, "linux");
    expect(confinement.backend).toBe("bwrap");
    expect(confinement.prefix).toEqual(expect.arrayContaining(["--ro-bind", "/dev/null", path.join(grant.claims.workspacePath, ".git")]));
    expect(confinement.prefix).toEqual(expect.arrayContaining(["--ro-bind", "/dev/null", await realpath(grant.gitExecutablePath)]));
  });

  it("uses the injected platform when resolving Git executable names", async () => {
    const { state } = await grantFixture();
    const windowsBin = path.join(state, "windows-bin"); await mkdir(windowsBin);
    const windowsGit = path.join(windowsBin, "git.exe"); await writeFile(windowsGit, "stub", { mode: 0o700 }); await chmod(windowsGit, 0o700);
    expect(await resolveGitExecutablePaths({ PATH: windowsBin }, "win32")).toEqual([await realpath(windowsGit)]);
    expect(await resolveGitExecutablePaths({ PATH: windowsBin }, "linux")).toEqual([]);
  });

  it.skipIf(process.platform !== "linux")("enforces the Linux boundary against Git-pointer replacement and live-checkout writes", async () => {
    const { root, grant } = await grantFixture();
    const environment = { ...process.env, ALL_MY_FRIENDS_ARE_AGENTS_GIT_SECURITY_BOUNDARY: "assignment-git-broker/v1" };
    const confinement = await verifyWriterConfinement(grant, environment, "linux");
    await expect(exec(confinement.command, [...confinement.prefix, "/usr/bin/git", "-C", grant.claims.workspacePath, "status"], { encoding: "utf8" })).rejects.toBeTruthy();
    await expect(exec(confinement.command, [...confinement.prefix, "/bin/sh", "-c", "rm -f .git; mkdir .git; /usr/bin/git init"], { cwd: grant.claims.workspacePath, encoding: "utf8" })).rejects.toBeTruthy();
    await expect(exec(confinement.command, [...confinement.prefix, "/bin/sh", "-c", `cp ${JSON.stringify(grant.gitExecutablePath)} ./copied-git && ./copied-git init nested`], { cwd: grant.claims.workspacePath, encoding: "utf8" })).rejects.toBeTruthy();
    const liveProbe = path.join(root, "forbidden-linux-writer-probe");
    await expect(exec(confinement.command, [...confinement.prefix, "/usr/bin/touch", liveProbe], { encoding: "utf8" })).rejects.toBeTruthy();
    await expect(readFile(liveProbe)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
