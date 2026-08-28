import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_BRANCH = /^(?![-./])(?!.*(?:\.\.|\/\/|@\{|\\|\s|[~^:?*\[]))[A-Za-z0-9._/-]{1,240}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

export type RepositoryConnectionState = "verified" | "disabled" | "identity-drift";

export interface CanonicalRemoteIdentity {
  readonly provider: "github";
  readonly owner: string;
  readonly repository: string;
  readonly canonical: string;
}

export interface ProjectRepositoryConnection {
  readonly schemaVersion: 1;
  readonly connectionId: string;
  readonly projectId: string;
  readonly revision: number;
  readonly state: RepositoryConnectionState;
  readonly remote: CanonicalRemoteIdentity;
  readonly checkoutMode: "existing-local";
  readonly checkoutPath: string;
  readonly commonDirectory: string;
  readonly defaultBranch: string;
  readonly protectedBranches: readonly string[];
  readonly policyRevision: number;
  readonly worktreeRoot: string;
  readonly validationCommands: readonly string[];
  readonly sensitivePaths: readonly string[];
  /** Server-held reference only. It is omitted from every public projection. */
  readonly credentialReference: string;
  readonly identityDigest: string;
  readonly validatedAt: string;
  readonly disabledAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PublicRepositoryConnectionStatus {
  readonly configured: boolean;
  readonly connectionId?: string;
  readonly projectId?: string;
  readonly revision?: number;
  readonly state?: RepositoryConnectionState;
  readonly repository?: string;
  readonly defaultBranch?: string;
  readonly protectedBranches?: readonly string[];
  readonly policyRevision?: number;
  readonly checkoutMode?: "existing-local";
  readonly validatedAt?: string;
}

export interface ConnectRepositoryInput {
  readonly expectedRevision: number;
  readonly checkoutPath: string;
  readonly worktreeRoot: string;
  readonly defaultBranch: string;
  readonly protectedBranches?: readonly string[];
  readonly policyRevision: number;
  readonly validationCommands?: readonly string[];
  readonly sensitivePaths?: readonly string[];
  readonly credentialReference: string;
}

export interface DurableRepositoryReference {
  readonly kind: "assignment" | "job" | "operation" | "contribution" | "merge" | "deployment";
  readonly id: string;
  readonly terminal: boolean;
  readonly reconciled: boolean;
}

export type RepositoryConnectionResult =
  | { readonly kind: "ok"; readonly connection: ProjectRepositoryConnection }
  | { readonly kind: "conflict"; readonly reason: string; readonly actualRevision: number }
  | { readonly kind: "rejected"; readonly reason: string };

interface StoredConnections { readonly schemaVersion: 1; readonly connections: readonly ProjectRepositoryConnection[] }

export class ProjectRepositoryConnectionStore {
  private queue: Promise<void> = Promise.resolve();
  private constructor(readonly filePath: string, private records: Map<string, ProjectRepositoryConnection>) {}

  static async open(dataDirectory: string) {
    await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
    await chmod(dataDirectory, 0o700);
    const filePath = path.join(dataDirectory, "project-repository-connections.json");
    const parsed = await readFile(filePath, "utf8").then((raw) => JSON.parse(raw) as StoredConnections)
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return { schemaVersion: 1 as const, connections: [] };
        throw error;
      });
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.connections)) throw new Error("Repository connection store is not canonical.");
    const records = new Map<string, ProjectRepositoryConnection>();
    for (const value of parsed.connections) {
      const record = normalizeConnection(value);
      if (!record || records.has(record.projectId)) throw new Error("Repository connection store contains an invalid or duplicate project record.");
      records.set(record.projectId, record);
    }
    return new ProjectRepositoryConnectionStore(filePath, records);
  }

  get(projectId: string) { const value = this.records.get(projectId); return value ? structuredClone(value) : undefined; }
  list() { return [...this.records.values()].map((value) => structuredClone(value)); }

  async compareAndSet(projectId: string, expectedRevision: number, next: ProjectRepositoryConnection): Promise<boolean> {
    let accepted = false;
    const operation = this.queue.then(async () => {
      const current = this.records.get(projectId);
      if ((current?.revision || 0) !== expectedRevision) return;
      this.records.set(projectId, structuredClone(next));
      await this.persist();
      accepted = true;
    });
    this.queue = operation.then(() => undefined, () => undefined);
    await operation;
    return accepted;
  }

  private async persist() {
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ schemaVersion: 1, connections: this.list() }, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.filePath);
    await chmod(this.filePath, 0o600);
  }
}

export class ProjectRepositoryConnectionService {
  private mutationQueue: Promise<void> = Promise.resolve();
  constructor(
    readonly projectId: string,
    private readonly store: ProjectRepositoryConnectionStore,
    private readonly references: () => Promise<readonly DurableRepositoryReference[]> = async () => [],
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly audit?: (event: Readonly<Record<string, unknown>>) => void | Promise<void>,
    private readonly credentialAvailable: (reference: string) => boolean = () => false,
  ) {
    if (!SAFE_ID.test(projectId)) throw new Error("Project ID is not canonical.");
  }

  inspect(): PublicRepositoryConnectionStatus { return publicRepositoryConnectionStatus(this.store.get(this.projectId)); }
  inspectServer(): ProjectRepositoryConnection | undefined { return this.store.get(this.projectId); }

  connect(input: ConnectRepositoryInput): Promise<RepositoryConnectionResult> {
    return this.serialize(() => this.connectLocked(input));
  }

  reconcile(expectedRevision: number): Promise<RepositoryConnectionResult> {
    return this.serialize(async () => {
      const current = this.store.get(this.projectId);
      if (!current || current.state === "disabled") return { kind: "rejected", reason: "No enabled repository connection exists." };
      if (current.revision !== expectedRevision) return conflict(current.revision);
      try {
        const evidence = await inspectCheckout(current.checkoutPath, current.worktreeRoot, current.defaultBranch);
        const reason = identityDifference(current, evidence);
        if (reason) return await this.recordDrift(current, reason);
        const timestamp = this.now();
        const next = { ...current, revision: current.revision + 1, state: "verified" as const, identityDigest: evidence.identityDigest, validatedAt: timestamp, updatedAt: timestamp };
        if (!await this.store.compareAndSet(this.projectId, current.revision, next)) return conflict(this.store.get(this.projectId)?.revision || 0);
        await this.log("reconcile", next, "accepted");
        return { kind: "ok", connection: next };
      } catch (error) {
        return await this.recordDrift(current, safeError(error));
      }
    });
  }

  disable(expectedRevision: number): Promise<RepositoryConnectionResult> {
    return this.serialize(async () => {
      const current = this.store.get(this.projectId);
      if (!current) return { kind: "rejected", reason: "No repository connection exists." };
      if (current.revision !== expectedRevision) return conflict(current.revision);
      const blockers = (await this.references()).filter((value) => !value.terminal || !value.reconciled);
      if (blockers.length) return { kind: "rejected", reason: `Repository connection has ${blockers.length} active or unreconciled durable reference(s).` };
      const timestamp = this.now();
      const next = { ...current, revision: current.revision + 1, state: "disabled" as const, disabledAt: timestamp, updatedAt: timestamp };
      if (!await this.store.compareAndSet(this.projectId, current.revision, next)) return conflict(this.store.get(this.projectId)?.revision || 0);
      await this.log("disable", next, "accepted");
      return { kind: "ok", connection: next };
    });
  }

  /** Required immediately before every state-changing repository operation. */
  async revalidateAuthority(expectedRevision: number): Promise<{ readonly kind: "ok"; readonly connection: ProjectRepositoryConnection } | { readonly kind: "rejected"; readonly reason: string }> {
    const current = this.store.get(this.projectId);
    if (!current || current.state !== "verified") return { kind: "rejected", reason: "Repository connection authority is disabled or unavailable." };
    if (current.revision !== expectedRevision) return { kind: "rejected", reason: "Repository connection revision is stale." };
    try {
      const evidence = await inspectCheckout(current.checkoutPath, current.worktreeRoot, current.defaultBranch);
      const difference = identityDifference(current, evidence);
      if (difference) return { kind: "rejected", reason: difference };
      return { kind: "ok", connection: current };
    } catch (error) { return { kind: "rejected", reason: safeError(error) }; }
  }

  private async connectLocked(input: ConnectRepositoryInput): Promise<RepositoryConnectionResult> {
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) return { kind: "rejected", reason: "Expected revision must be a non-negative integer." };
    const current = this.store.get(this.projectId);
    if ((current?.revision || 0) !== input.expectedRevision) return conflict(current?.revision || 0);
    if (current?.state !== "disabled" && current) return { kind: "rejected", reason: "The project already has an enabled repository connection." };
    if (!SAFE_ID.test(input.credentialReference)) return { kind: "rejected", reason: "Credential reference must be an opaque server-held identifier." };
    if (!this.credentialAvailable(input.credentialReference)) return { kind: "rejected", reason: "Credential reference is unavailable for this project." };
    if (!SAFE_BRANCH.test(input.defaultBranch) || !Number.isSafeInteger(input.policyRevision) || input.policyRevision < 1) return { kind: "rejected", reason: "Default branch and policy revision must be canonical." };
    const protectedBranches = uniqueStrings(input.protectedBranches || [input.defaultBranch], SAFE_BRANCH, 32);
    const validationCommands = uniqueStrings(input.validationCommands || [], /^.{1,500}$/, 32);
    const sensitivePaths = canonicalRelativePaths(input.sensitivePaths || []);
    if (!protectedBranches || !validationCommands || !sensitivePaths) return { kind: "rejected", reason: "Repository policy metadata is invalid or ambiguous." };
    const blockers = current ? (await this.references()).filter((value) => !value.terminal || !value.reconciled) : [];
    if (blockers.length) return { kind: "rejected", reason: `Repository rebind has ${blockers.length} active or unreconciled durable reference(s).` };
    try {
      const evidence = await inspectCheckout(input.checkoutPath, input.worktreeRoot, input.defaultBranch);
      for (const other of this.store.list()) {
        if (other.projectId === this.projectId || other.state === "disabled") continue;
        if (pathsOverlap(other.checkoutPath, evidence.checkoutPath) || pathsOverlap(other.worktreeRoot, evidence.worktreeRoot)) {
          return { kind: "rejected", reason: "Repository checkout or assignment root is already owned by another project." };
        }
        if (other.credentialReference === input.credentialReference) return { kind: "rejected", reason: "Credential reference is already assigned to another project." };
      }
      const timestamp = this.now();
      const next: ProjectRepositoryConnection = {
        schemaVersion: 1, connectionId: current?.connectionId || randomUUID(), projectId: this.projectId,
        revision: (current?.revision || 0) + 1, state: "verified", remote: evidence.remote, checkoutMode: "existing-local",
        checkoutPath: evidence.checkoutPath, commonDirectory: evidence.commonDirectory, defaultBranch: input.defaultBranch,
        protectedBranches, policyRevision: input.policyRevision, worktreeRoot: evidence.worktreeRoot, validationCommands,
        sensitivePaths, credentialReference: input.credentialReference, identityDigest: evidence.identityDigest,
        validatedAt: timestamp, disabledAt: null, createdAt: current?.createdAt || timestamp, updatedAt: timestamp,
      };
      if (!await this.store.compareAndSet(this.projectId, input.expectedRevision, next)) return conflict(this.store.get(this.projectId)?.revision || 0);
      await this.log(current ? "rebind" : "connect", next, "accepted");
      return { kind: "ok", connection: next };
    } catch (error) { return { kind: "rejected", reason: safeError(error) }; }
  }

  private async recordDrift(current: ProjectRepositoryConnection, reason: string): Promise<RepositoryConnectionResult> {
    const timestamp = this.now();
    const next = { ...current, revision: current.revision + 1, state: "identity-drift" as const, updatedAt: timestamp };
    if (!await this.store.compareAndSet(this.projectId, current.revision, next)) return conflict(this.store.get(this.projectId)?.revision || 0);
    await this.log("reconcile", next, "rejected", reason);
    return { kind: "rejected", reason: `Repository identity drift: ${reason}` };
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const operation = this.mutationQueue.then(work);
    this.mutationQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async log(operation: string, record: ProjectRepositoryConnection, outcome: string, reason?: string) {
    await this.audit?.({ operation, outcome, projectId: record.projectId, connectionId: record.connectionId, revision: record.revision,
      repository: record.remote.canonical, policyRevision: record.policyRevision, ...(reason ? { reason } : {}) });
  }
}

export interface ProjectScopedRepositoryServices<T> {
  readonly projectId: string;
  readonly connection: ProjectRepositoryConnectionService;
  readonly services: T;
  readonly writerSlot: Set<string>;
  readonly brokerAudit: readonly Readonly<Record<string, unknown>>[];
}

/** One lazy scope owns repository authority and every mutable service boundary for a project. */
export class ProjectRepositoryServiceRegistry<T> {
  private readonly scopes = new Map<string, ProjectScopedRepositoryServices<T>>();
  constructor(private readonly store: ProjectRepositoryConnectionStore, private readonly create: (projectId: string, connection: ProjectRepositoryConnectionService) => T,
    private readonly references?: (projectId: string) => Promise<readonly DurableRepositoryReference[]>,
    private readonly credentialAvailable: (projectId: string, reference: string) => boolean = () => false) {}
  forProject(projectId: string): ProjectScopedRepositoryServices<T> {
    const existing = this.scopes.get(projectId); if (existing) return existing;
    const audit: Array<Readonly<Record<string, unknown>>> = [];
    const connection = new ProjectRepositoryConnectionService(projectId, this.store, () => this.references?.(projectId) || Promise.resolve([]), undefined,
      (event) => { audit.push(event); }, (reference) => this.credentialAvailable(projectId, reference));
    const scope = { projectId, connection, services: this.create(projectId, connection), writerSlot: new Set<string>(), brokerAudit: audit };
    this.scopes.set(projectId, scope); return scope;
  }
}

/** Secrets remain memory-only; persisted records and projections contain only opaque references. */
export class ServerHeldRepositoryCredentials {
  private readonly values = new Map<string, string>();
  register(projectId: string, reference: string, credential: string) {
    if (!SAFE_ID.test(projectId) || !SAFE_ID.test(reference) || !credential) throw new Error("A canonical project, credential reference, and server-held credential are required.");
    const key = `${projectId}\0${reference}`; if (this.values.has(key)) throw new Error("Credential reference is already registered.");
    this.values.set(key, credential);
  }
  available(projectId: string, reference: string) { return this.values.has(`${projectId}\0${reference}`); }
  forServerOperation(projectId: string, reference: string) { return this.values.get(`${projectId}\0${reference}`); }
}

export function publicRepositoryConnectionStatus(connection?: ProjectRepositoryConnection): PublicRepositoryConnectionStatus {
  if (!connection) return { configured: false };
  return { configured: true, connectionId: connection.connectionId, projectId: connection.projectId, revision: connection.revision,
    state: connection.state, repository: connection.remote.canonical, defaultBranch: connection.defaultBranch,
    protectedBranches: connection.protectedBranches, policyRevision: connection.policyRevision, checkoutMode: connection.checkoutMode,
    validatedAt: connection.validatedAt };
}

/** Remove repository credentials and local authority paths before worker dispatch. */
export function repositorySafeWorkerEnvironment(environment: NodeJS.ProcessEnv) {
  const safe: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(environment)) {
    if (/(?:github|gitlab|bitbucket|credential|token|secret|repository|project_path|worktree)/i.test(key)
      || /^GIT_(?:ASKPASS|SSH_COMMAND|CONFIG|CREDENTIAL|TERMINAL_PROMPT)/i.test(key)) continue;
    safe[key] = value;
  }
  return safe;
}

async function inspectCheckout(checkoutInput: string, worktreeInput: string, defaultBranch: string) {
  if (!path.isAbsolute(checkoutInput) || !path.isAbsolute(worktreeInput)) throw new Error("Checkout and worktree root must be absolute canonical paths.");
  const checkoutPath = await realpath(checkoutInput);
  if (checkoutPath !== checkoutInput || !(await stat(checkoutPath)).isDirectory()) throw new Error("Checkout path must be the exact canonical directory path.");
  const worktreeRoot = await canonicalFuturePath(worktreeInput);
  if (worktreeRoot !== worktreeInput) throw new Error("Worktree root must be an exact canonical path.");
  if (pathsOverlap(checkoutPath, worktreeRoot)) throw new Error("Assignment worktree root must not overlap the canonical checkout.");
  const top = await git(checkoutPath, ["rev-parse", "--show-toplevel"]);
  if (await realpath(top) !== checkoutPath) throw new Error("Checkout must be the repository's canonical top-level worktree.");
  const commonRaw = await git(checkoutPath, ["rev-parse", "--git-common-dir"]);
  const commonDirectory = await realpath(path.resolve(checkoutPath, commonRaw));
  const expectedCommon = await realpath(path.join(checkoutPath, ".git"));
  if (commonDirectory !== expectedCommon) throw new Error("Canonical checkout has an invalid or linked common Git directory relationship.");
  const remotes = (await git(checkoutPath, ["remote"])).split("\n").map((value) => value.trim()).filter(Boolean);
  if (remotes.length !== 1) throw new Error("Repository must have exactly one configured remote.");
  const urls = (await git(checkoutPath, ["remote", "get-url", "--all", remotes[0]!])).split("\n").map((value) => value.trim()).filter(Boolean);
  const identities = [...new Map(urls.map((url) => { const identity = canonicalRemote(url); return [identity.canonical, identity]; })).values()];
  if (identities.length !== 1 || urls.length !== 1) throw new Error("Repository remote identity is ambiguous.");
  const remote = identities[0]!;
  await git(checkoutPath, ["show-ref", "--verify", "--quiet", `refs/heads/${defaultBranch}`]);
  const headBranch = await git(checkoutPath, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (headBranch !== defaultBranch) throw new Error("Canonical checkout branch does not match the configured default branch.");
  const identityDigest = digest({ checkoutPath, commonDirectory, remote: remote.canonical, defaultBranch, headBranch });
  return { checkoutPath, commonDirectory, worktreeRoot, remote, identityDigest };
}

function identityDifference(current: ProjectRepositoryConnection, evidence: Awaited<ReturnType<typeof inspectCheckout>>) {
  if (current.checkoutPath !== evidence.checkoutPath) return "canonical checkout path changed.";
  if (current.commonDirectory !== evidence.commonDirectory) return "common Git directory changed.";
  if (current.worktreeRoot !== evidence.worktreeRoot) return "assignment worktree root changed.";
  if (current.remote.canonical !== evidence.remote.canonical) return "immutable remote identity changed.";
  if (current.identityDigest !== evidence.identityDigest) return "checkout branch or identity evidence changed.";
  return null;
}

function canonicalRemote(value: string): CanonicalRemoteIdentity {
  const scp = /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/.exec(value);
  let owner: string; let repository: string;
  if (scp) { owner = scp[1]!; repository = scp[2]!; }
  else {
    let url: URL; try { url = new URL(value); } catch { throw new Error("Remote URL is not canonical GitHub HTTPS or SSH identity."); }
    if (!["https:", "ssh:"].includes(url.protocol) || url.hostname.toLowerCase() !== "github.com" || url.search || url.hash
      || url.username || url.password || url.port) throw new Error("Only canonical github.com HTTPS or SSH remotes are supported.");
    const parts = url.pathname.replace(/^\//, "").replace(/\.git$/, "").split("/");
    if (parts.length !== 2) throw new Error("Remote URL does not name one GitHub repository.");
    [owner, repository] = parts as [string, string];
  }
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner) || !/^[A-Za-z0-9_.-]{1,100}$/.test(repository)) throw new Error("Remote owner or repository is invalid.");
  const canonical = `github.com/${owner.toLowerCase()}/${repository.toLowerCase()}`;
  return { provider: "github", owner: owner.toLowerCase(), repository: repository.toLowerCase(), canonical };
}

async function canonicalFuturePath(value: string) {
  let existing = value; const suffix: string[] = [];
  while (!await stat(existing).then(() => true).catch(() => false)) {
    const parent = path.dirname(existing); if (parent === existing) throw new Error("Worktree root has no canonical ancestor.");
    suffix.unshift(path.basename(existing)); existing = parent;
  }
  return path.join(await realpath(existing), ...suffix);
}

function pathsOverlap(left: string, right: string) {
  const relative = path.relative(left, right);
  const reverse = path.relative(right, left);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..") || (!reverse.startsWith(`..${path.sep}`) && reverse !== "..");
}

async function git(repository: string, args: readonly string[]) {
  const result = await execFileAsync("git", ["-C", repository, ...args], { timeout: 5_000, maxBuffer: 128 * 1024,
    env: { ...repositorySafeWorkerEnvironment(process.env), GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" } });
  return result.stdout.trim();
}

function uniqueStrings(values: readonly string[], pattern: RegExp, maximum: number): readonly string[] | null {
  if (!Array.isArray(values) || values.length > maximum) return null;
  const normalized = values.map((value) => typeof value === "string" ? value.trim() : "");
  if (normalized.some((value) => !pattern.test(value)) || new Set(normalized).size !== normalized.length) return null;
  return normalized;
}

function canonicalRelativePaths(values: readonly string[]) {
  const normalized = uniqueStrings(values, /^.{1,500}$/, 128); if (!normalized) return null;
  if (normalized.some((value) => value.includes("\\") || path.isAbsolute(value) || value === "." || value.split("/").includes("..") || path.posix.normalize(value) !== value)) return null;
  return normalized;
}

function normalizeConnection(value: unknown): ProjectRepositoryConnection | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as ProjectRepositoryConnection;
  const remote = item.remote as Partial<CanonicalRemoteIdentity> | undefined;
  const protectedBranches = Array.isArray(item.protectedBranches) ? uniqueStrings(item.protectedBranches, SAFE_BRANCH, 32) : null;
  const validationCommands = Array.isArray(item.validationCommands) ? uniqueStrings(item.validationCommands, /^.{1,500}$/, 32) : null;
  const sensitivePaths = Array.isArray(item.sensitivePaths) ? canonicalRelativePaths(item.sensitivePaths) : null;
  if (item.schemaVersion !== 1 || !SAFE_ID.test(item.projectId) || !SAFE_ID.test(item.connectionId) || !Number.isSafeInteger(item.revision) || item.revision < 1
    || !["verified", "disabled", "identity-drift"].includes(item.state) || item.checkoutMode !== "existing-local" || !path.isAbsolute(item.checkoutPath)
    || !path.isAbsolute(item.commonDirectory) || !path.isAbsolute(item.worktreeRoot) || !SAFE_BRANCH.test(item.defaultBranch)
    || !Number.isSafeInteger(item.policyRevision) || item.policyRevision < 1 || !SAFE_ID.test(item.credentialReference) || !SHA256.test(item.identityDigest)
    || !validStoredRemote(remote)
    || !protectedBranches || !validationCommands || !sensitivePaths) return undefined;
  return structuredClone(item);
}

function validStoredRemote(remote: Partial<CanonicalRemoteIdentity> | undefined): remote is CanonicalRemoteIdentity {
  if (!remote || remote.provider !== "github" || typeof remote.owner !== "string" || typeof remote.repository !== "string" || typeof remote.canonical !== "string"
    || remote.owner !== remote.owner.toLowerCase() || remote.repository !== remote.repository.toLowerCase()
    || remote.canonical !== `github.com/${remote.owner}/${remote.repository}`) return false;
  try { return canonicalRemote(`https://${remote.canonical}`).canonical === remote.canonical; } catch { return false; }
}

function conflict(actualRevision: number): RepositoryConnectionResult { return { kind: "conflict", reason: "Repository connection revision is stale.", actualRevision }; }
function digest(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function safeError(error: unknown) { return error instanceof Error ? error.message.replace(/[\r\n]+/g, " ").slice(0, 500) : "Repository validation failed."; }
