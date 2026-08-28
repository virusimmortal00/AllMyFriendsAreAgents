import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  GitHubCredentialHealth,
  GitHubCredentialProvider,
  GitHubCredentialProviderKind,
  GitHubCredentialResolutionRequest,
  ResolvedGitHubCredential,
  SecretVaultReader,
} from "./github-credential-provider.js";
import type { GitHubInstallationCatalogEntry, GitHubRepositoryCatalogDiscovery, GitHubRepositoryCatalogEntry } from "./github-repository-catalog.js";

export type { SecretVaultReader } from "./github-credential-provider.js";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const GITHUB_REPOSITORY = /^github\.com\/[a-z0-9](?:[a-z0-9-]{0,38})\/[a-z0-9_.-]{1,100}$/;
const GITHUB_REPOSITORY_NAME = /^[a-z0-9_.-]{1,100}$/;
const GITHUB_BRANCH = /^(?![-./])(?!.*(?:\.\.|\/\/|@\{|\\|\s|[~^:?*\[]))[A-Za-z0-9._/-]{1,240}$/;

export type ServerGitHubConnectionState = "ready" | "degraded" | "revoked";
export type ServerGitHubAuthMode = Extract<GitHubCredentialProviderKind, "github-device-user" | "github-app-installation">;

export interface ServerGitHubConnection {
  readonly schemaVersion: 1;
  readonly connectionId: string;
  readonly revision: number;
  readonly authMode: ServerGitHubAuthMode;
  readonly state: ServerGitHubConnectionState;
  readonly githubUser: { readonly id: number; readonly login: string };
  /** Opaque vault pointer. It is never included in a public projection. */
  readonly secretReference: string;
  readonly connectedAt: string;
  readonly lastValidatedAt: string;
  readonly updatedAt: string;
}

export interface PublicServerGitHubConnection {
  readonly connectionId: string;
  readonly revision: number;
  readonly authMode: ServerGitHubAuthMode;
  readonly state: ServerGitHubConnectionState;
  readonly githubUser: { readonly id: number; readonly login: string };
  readonly connectedAt: string;
  readonly lastValidatedAt: string;
  readonly updatedAt: string;
}

export interface ProjectGitHubBinding {
  readonly schemaVersion: 1;
  readonly bindingId: string;
  readonly projectId: string;
  readonly revision: number;
  readonly state: "ready" | "revoked";
  readonly connectionId: string;
  readonly installationId: number;
  readonly githubRepositoryId: number;
  readonly repository: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface GitHubRepositoryCatalogSnapshot {
  readonly schemaVersion: 1;
  readonly connectionId: string;
  readonly revision: number;
  readonly connectionRevision: number;
  readonly observedAt: string;
  readonly installations: readonly GitHubInstallationCatalogEntry[];
  readonly repositories: readonly GitHubRepositoryCatalogEntry[];
}

interface GitHubIntegrationState {
  readonly schemaVersion: 1;
  readonly connections: readonly ServerGitHubConnection[];
  readonly bindings: readonly ProjectGitHubBinding[];
  readonly catalogs: readonly GitHubRepositoryCatalogSnapshot[];
}

export type GitHubIntegrationMutationResult<T> =
  | { readonly kind: "ok"; readonly value: T }
  | { readonly kind: "conflict"; readonly actualRevision: number }
  | { readonly kind: "rejected"; readonly reason: string };

export interface SaveServerGitHubConnectionInput {
  readonly expectedRevision: number;
  readonly connectionId: string;
  readonly authMode: ServerGitHubAuthMode;
  readonly state: ServerGitHubConnectionState;
  readonly githubUser: { readonly id: number; readonly login: string };
  readonly secretReference: string;
  readonly connectedAt: string;
  readonly lastValidatedAt: string;
}

export interface BindProjectToGitHubInput {
  readonly expectedRevision: number;
  readonly projectId: string;
  readonly connectionId: string;
  readonly installationId: number;
  readonly githubRepositoryId: number;
  readonly repository: string;
}

export interface RevokeProjectGitHubBindingInput {
  readonly expectedRevision: number;
  readonly projectId: string;
}

export interface ReplaceGitHubRepositoryCatalogInput {
  readonly expectedRevision: number;
  readonly connectionId: string;
  readonly connectionRevision: number;
  readonly discovery: GitHubRepositoryCatalogDiscovery;
}

const EMPTY: GitHubIntegrationState = { schemaVersion: 1, connections: [], bindings: [], catalogs: [] };

/** Persists non-secret server connection metadata and project-to-repository bindings. */
export class GitHubIntegrationStore {
  private queue: Promise<void> = Promise.resolve();

  private constructor(readonly filePath: string, private state: GitHubIntegrationState) {}

  static async open(dataDirectory: string) {
    await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
    await chmod(dataDirectory, 0o700);
    const filePath = path.join(dataDirectory, "github-integrations.json");
    const parsed = await readFile(filePath, "utf8")
      .then((raw) => JSON.parse(raw) as unknown)
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return EMPTY;
        throw error;
      });
    const state = normalizeState(parsed);
    if (!state) throw new Error("GitHub integration store is not canonical.");
    return new GitHubIntegrationStore(filePath, state);
  }

  connection(connectionId: string) {
    const value = this.state.connections.find((record) => record.connectionId === connectionId);
    return value ? structuredClone(value) : undefined;
  }

  connections(): readonly PublicServerGitHubConnection[] {
    return this.state.connections.map(publicConnection);
  }

  bindingForProject(projectId: string) {
    const value = this.state.bindings.find((record) => record.projectId === projectId);
    return value ? structuredClone(value) : undefined;
  }

  bindings(): readonly ProjectGitHubBinding[] {
    return structuredClone(this.state.bindings);
  }

  catalog(connectionId: string) {
    const value = this.state.catalogs.find((record) => record.connectionId === connectionId);
    return value ? structuredClone(value) : undefined;
  }

  replaceCatalog(input: ReplaceGitHubRepositoryCatalogInput): Promise<GitHubIntegrationMutationResult<GitHubRepositoryCatalogSnapshot>> {
    return this.mutate(async () => {
      const current = this.state.catalogs.find((record) => record.connectionId === input.connectionId);
      if (!validExpectedRevision(input.expectedRevision)) return { kind: "rejected", reason: "Expected revision must be a non-negative integer." };
      if ((current?.revision ?? 0) !== input.expectedRevision) return { kind: "conflict", actualRevision: current?.revision ?? 0 };
      const connection = this.state.connections.find((record) => record.connectionId === input.connectionId);
      if (!connection || connection.state !== "ready" || connection.revision !== input.connectionRevision) {
        return { kind: "rejected", reason: "A current ready server GitHub connection is required." };
      }
      const candidate: GitHubRepositoryCatalogSnapshot = { schemaVersion: 1, connectionId: input.connectionId,
        revision: input.expectedRevision + 1, connectionRevision: input.connectionRevision, observedAt: input.discovery.observedAt,
        installations: structuredClone(input.discovery.installations), repositories: structuredClone(input.discovery.repositories) };
      if (!normalizeCatalog(candidate)) return { kind: "rejected", reason: "GitHub repository catalog is not canonical." };
      if (current && Date.parse(candidate.observedAt) <= Date.parse(current.observedAt)) {
        return { kind: "rejected", reason: "GitHub repository catalog observation must advance." };
      }
      const state = { ...this.state, catalogs: [...this.state.catalogs.filter((record) => record.connectionId !== input.connectionId), candidate] };
      await this.persist(state);
      return { kind: "ok", value: structuredClone(candidate) };
    });
  }

  saveConnection(input: SaveServerGitHubConnectionInput): Promise<GitHubIntegrationMutationResult<ServerGitHubConnection>> {
    return this.mutate(async () => {
      const current = this.state.connections.find((record) => record.connectionId === input.connectionId);
      if (!validExpectedRevision(input.expectedRevision)) return { kind: "rejected", reason: "Expected revision must be a non-negative integer." };
      if ((current?.revision ?? 0) !== input.expectedRevision) return { kind: "conflict", actualRevision: current?.revision ?? 0 };
      const candidate: ServerGitHubConnection = {
        schemaVersion: 1,
        connectionId: input.connectionId,
        revision: input.expectedRevision + 1,
        authMode: input.authMode,
        state: input.state,
        githubUser: structuredClone(input.githubUser),
        secretReference: input.secretReference,
        connectedAt: current?.connectedAt ?? input.connectedAt,
        lastValidatedAt: input.lastValidatedAt,
        updatedAt: input.lastValidatedAt,
      };
      if (!normalizeConnection(candidate)) return { kind: "rejected", reason: "GitHub connection metadata is not canonical." };
      if (current && (current.authMode !== candidate.authMode || current.githubUser.id !== candidate.githubUser.id || current.connectedAt !== candidate.connectedAt)) {
        return { kind: "rejected", reason: "Immutable GitHub connection identity changed." };
      }
      const state = {
        ...this.state,
        connections: [...this.state.connections.filter((record) => record.connectionId !== candidate.connectionId), candidate],
      };
      await this.persist(state);
      return { kind: "ok", value: structuredClone(candidate) };
    });
  }

  bindProject(input: BindProjectToGitHubInput): Promise<GitHubIntegrationMutationResult<ProjectGitHubBinding>> {
    return this.mutate(async () => {
      const current = this.state.bindings.find((record) => record.projectId === input.projectId);
      if (!validExpectedRevision(input.expectedRevision)) return { kind: "rejected", reason: "Expected revision must be a non-negative integer." };
      if ((current?.revision ?? 0) !== input.expectedRevision) return { kind: "conflict", actualRevision: current?.revision ?? 0 };
      const connection = this.state.connections.find((record) => record.connectionId === input.connectionId);
      if (!connection || connection.state !== "ready") return { kind: "rejected", reason: "A ready server GitHub connection is required." };
      const catalog = this.state.catalogs.find((record) => record.connectionId === input.connectionId);
      if (!catalog || catalog.connectionRevision !== connection.revision) return { kind: "rejected", reason: "A current repository catalog is required." };
      if (!catalog.repositories.some((record) => record.githubRepositoryId === input.githubRepositoryId && record.installationId === input.installationId
        && record.canonical === input.repository)) return { kind: "rejected", reason: "Repository is not present in the current server catalog." };
      const timestamp = new Date().toISOString();
      const candidate: ProjectGitHubBinding = {
        schemaVersion: 1,
        bindingId: current?.bindingId ?? `github-binding:${randomUUID()}`,
        projectId: input.projectId,
        revision: input.expectedRevision + 1,
        state: "ready",
        connectionId: input.connectionId,
        installationId: input.installationId,
        githubRepositoryId: input.githubRepositoryId,
        repository: input.repository,
        createdAt: current?.createdAt ?? timestamp,
        updatedAt: timestamp,
      };
      if (!normalizeBinding(candidate)) return { kind: "rejected", reason: "Project GitHub binding is not canonical." };
      const state = {
        ...this.state,
        bindings: [...this.state.bindings.filter((record) => record.projectId !== candidate.projectId), candidate],
      };
      await this.persist(state);
      return { kind: "ok", value: structuredClone(candidate) };
    });
  }

  revokeBinding(input: RevokeProjectGitHubBindingInput): Promise<GitHubIntegrationMutationResult<ProjectGitHubBinding>> {
    return this.mutate(async () => {
      if (!validExpectedRevision(input.expectedRevision) || !SAFE_ID.test(input.projectId)) {
        return { kind: "rejected", reason: "Project binding revocation is not canonical." };
      }
      const current = this.state.bindings.find((record) => record.projectId === input.projectId);
      if (!current) return { kind: "rejected", reason: "Project GitHub binding does not exist." };
      if (current.revision !== input.expectedRevision) return { kind: "conflict", actualRevision: current.revision };
      const candidate: ProjectGitHubBinding = {
        ...current,
        revision: current.revision + 1,
        state: "revoked",
        updatedAt: new Date().toISOString(),
      };
      const state = {
        ...this.state,
        bindings: [...this.state.bindings.filter((record) => record.projectId !== candidate.projectId), candidate],
      };
      await this.persist(state);
      return { kind: "ok", value: structuredClone(candidate) };
    });
  }

  private mutate<T>(work: () => Promise<GitHubIntegrationMutationResult<T>>): Promise<GitHubIntegrationMutationResult<T>> {
    const operation = this.queue.then(work);
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async persist(state: GitHubIntegrationState) {
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.filePath);
    await chmod(this.filePath, 0o600);
    this.state = structuredClone(state);
  }
}

/** Resolves project-local binding references through server-owned connection metadata and a secret vault. */
export class BoundGitHubCredentialProvider implements GitHubCredentialProvider {
  readonly #integrations: GitHubIntegrationStore;
  readonly #vault: SecretVaultReader;

  constructor(integrations: GitHubIntegrationStore, vault: SecretVaultReader) {
    this.#integrations = integrations;
    this.#vault = vault;
  }

  available(projectId: string, credentialReference: string) {
    const binding = this.#integrations.bindingForProject(projectId);
    if (!binding || binding.state !== "ready" || binding.bindingId !== credentialReference) return false;
    const connection = this.#integrations.connection(binding.connectionId);
    const catalog = this.#integrations.catalog(binding.connectionId);
    return connection?.state === "ready" && catalog?.connectionRevision === connection.revision
      && catalog.repositories.some((record) => record.githubRepositoryId === binding.githubRepositoryId && record.installationId === binding.installationId
        && record.canonical === binding.repository) && this.#vault.available(connection.secretReference);
  }

  health(projectId: string, credentialReference: string): GitHubCredentialHealth {
    const binding = this.#integrations.bindingForProject(projectId);
    if (!binding || binding.bindingId !== credentialReference) return { state: "missing", reason: "binding-missing" };
    const connection = this.#integrations.connection(binding.connectionId);
    if (!connection) return { state: "missing", reason: "connection-missing" };
    if (binding.state === "revoked") return { state: "revoked", provider: connection.authMode, reason: "binding-revoked" };
    if (connection.state === "revoked") return { state: "revoked", provider: connection.authMode, reason: "connection-revoked" };
    if (connection.state === "degraded") return { state: "degraded", provider: connection.authMode, reason: "connection-degraded" };
    const catalog = this.#integrations.catalog(binding.connectionId);
    if (!catalog || catalog.connectionRevision !== connection.revision || !catalog.repositories.some((record) => record.githubRepositoryId === binding.githubRepositoryId
      && record.installationId === binding.installationId && record.canonical === binding.repository)) {
      return { state: "degraded", provider: connection.authMode, reason: "catalog-stale" };
    }
    if (!this.#vault.available(connection.secretReference)) return { state: "missing", provider: connection.authMode, reason: "credential-missing" };
    return { state: "ready", provider: connection.authMode, reason: "ready" };
  }

  async resolve(request: GitHubCredentialResolutionRequest): Promise<ResolvedGitHubCredential | undefined> {
    if (!canonicalResolutionRequest(request)) return undefined;
    const binding = this.#integrations.bindingForProject(request.projectId);
    if (!binding || binding.state !== "ready" || binding.bindingId !== request.credentialReference || binding.repository !== request.repository) return undefined;
    const connection = this.#integrations.connection(binding.connectionId);
    if (!connection || connection.state !== "ready") return undefined;
    const catalog = this.#integrations.catalog(binding.connectionId);
    if (!catalog || catalog.connectionRevision !== connection.revision || !catalog.repositories.some((record) => record.githubRepositoryId === binding.githubRepositoryId
      && record.installationId === binding.installationId && record.canonical === binding.repository)) return undefined;
    const secret = await this.#vault.read(connection.secretReference);
    if (!secret?.token || secret.provider !== connection.authMode) return undefined;
    return {
      token: secret.token,
      provider: connection.authMode,
      authorityRevision: `${connection.connectionId}:${connection.revision}:${binding.bindingId}:${binding.revision}:${secret.revision}`,
    };
  }
}

function publicConnection(connection: ServerGitHubConnection): PublicServerGitHubConnection {
  const { secretReference: _secretReference, schemaVersion: _schemaVersion, ...publicValue } = connection;
  return structuredClone(publicValue);
}

function normalizeState(value: unknown): GitHubIntegrationState | undefined {
  if (!value || typeof value !== "object") return undefined;
  const state = value as Partial<GitHubIntegrationState>;
  if (state.schemaVersion !== 1 || !Array.isArray(state.connections) || !Array.isArray(state.bindings)
    || (state.catalogs !== undefined && !Array.isArray(state.catalogs))) return undefined;
  const connections = state.connections.map(normalizeConnection);
  const bindings = state.bindings.map(normalizeBinding);
  const catalogs = (state.catalogs ?? []).map(normalizeCatalog);
  if (connections.some((record) => !record) || bindings.some((record) => !record) || catalogs.some((record) => !record)) return undefined;
  const canonicalConnections = connections as ServerGitHubConnection[];
  const canonicalBindings = bindings as ProjectGitHubBinding[];
  const canonicalCatalogs = catalogs as GitHubRepositoryCatalogSnapshot[];
  if (new Set(canonicalConnections.map((record) => record.connectionId)).size !== canonicalConnections.length
    || new Set(canonicalBindings.map((record) => record.projectId)).size !== canonicalBindings.length
    || new Set(canonicalBindings.map((record) => record.bindingId)).size !== canonicalBindings.length
    || new Set(canonicalCatalogs.map((record) => record.connectionId)).size !== canonicalCatalogs.length
    || canonicalBindings.some((binding) => !canonicalConnections.some((connection) => connection.connectionId === binding.connectionId))
    || canonicalCatalogs.some((catalog) => !canonicalConnections.some((connection) => connection.connectionId === catalog.connectionId))) return undefined;
  return { schemaVersion: 1, connections: canonicalConnections, bindings: canonicalBindings, catalogs: canonicalCatalogs };
}

function normalizeConnection(value: unknown): ServerGitHubConnection | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as ServerGitHubConnection;
  if (record.schemaVersion !== 1 || !SAFE_ID.test(record.connectionId) || !Number.isSafeInteger(record.revision) || record.revision < 1
    || !["github-device-user", "github-app-installation"].includes(record.authMode)
    || !["ready", "degraded", "revoked"].includes(record.state)
    || !record.githubUser || !Number.isSafeInteger(record.githubUser.id) || record.githubUser.id < 1 || !GITHUB_LOGIN.test(record.githubUser.login)
    || !SAFE_ID.test(record.secretReference) || !validTimestamp(record.connectedAt) || !validTimestamp(record.lastValidatedAt)
    || !validTimestamp(record.updatedAt)) return undefined;
  return structuredClone(record);
}

function normalizeBinding(value: unknown): ProjectGitHubBinding | undefined {
  if (!value || typeof value !== "object") return undefined;
  const source = value as ProjectGitHubBinding & { readonly state?: "ready" | "revoked" };
  const record: ProjectGitHubBinding = { ...source, state: source.state ?? "ready" };
  if (record.schemaVersion !== 1 || !SAFE_ID.test(record.bindingId) || !SAFE_ID.test(record.projectId)
    || !Number.isSafeInteger(record.revision) || record.revision < 1 || !["ready", "revoked"].includes(record.state) || !SAFE_ID.test(record.connectionId)
    || !Number.isSafeInteger(record.installationId) || record.installationId < 1 || !Number.isSafeInteger(record.githubRepositoryId)
    || record.githubRepositoryId < 1 || !GITHUB_REPOSITORY.test(record.repository)
    || !validTimestamp(record.createdAt) || !validTimestamp(record.updatedAt)) return undefined;
  return structuredClone(record);
}

function normalizeCatalog(value: unknown): GitHubRepositoryCatalogSnapshot | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as GitHubRepositoryCatalogSnapshot;
  if (record.schemaVersion !== 1 || !SAFE_ID.test(record.connectionId) || !Number.isSafeInteger(record.revision) || record.revision < 1
    || !Number.isSafeInteger(record.connectionRevision) || record.connectionRevision < 1 || !validTimestamp(record.observedAt)
    || !Array.isArray(record.installations) || !Array.isArray(record.repositories)) return undefined;
  const installations = record.installations.map(normalizeInstallation);
  const repositories = record.repositories.map(normalizeCatalogRepository);
  if (installations.some((entry) => !entry) || repositories.some((entry) => !entry)) return undefined;
  const canonicalInstallations = installations as GitHubInstallationCatalogEntry[];
  const canonicalRepositories = repositories as GitHubRepositoryCatalogEntry[];
  if (new Set(canonicalInstallations.map((entry) => entry.installationId)).size !== canonicalInstallations.length
    || new Set(canonicalRepositories.map((entry) => entry.githubRepositoryId)).size !== canonicalRepositories.length
    || new Set(canonicalRepositories.map((entry) => entry.canonical)).size !== canonicalRepositories.length
    || canonicalRepositories.some((entry) => !canonicalInstallations.some((installation) => installation.installationId === entry.installationId
      && installation.account.login.toLowerCase() === entry.owner))) return undefined;
  return { ...structuredClone(record), installations: canonicalInstallations, repositories: canonicalRepositories };
}

function normalizeInstallation(value: unknown): GitHubInstallationCatalogEntry | undefined {
  if (!value || typeof value !== "object") return undefined;
  const entry = value as GitHubInstallationCatalogEntry;
  if (!Number.isSafeInteger(entry.installationId) || entry.installationId < 1 || !entry.account || !Number.isSafeInteger(entry.account.id)
    || entry.account.id < 1 || !GITHUB_LOGIN.test(entry.account.login) || !["User", "Organization"].includes(entry.account.type)
    || !["all", "selected"].includes(entry.repositorySelection)) return undefined;
  return structuredClone(entry);
}

function normalizeCatalogRepository(value: unknown): GitHubRepositoryCatalogEntry | undefined {
  if (!value || typeof value !== "object") return undefined;
  const entry = value as GitHubRepositoryCatalogEntry;
  if (!Number.isSafeInteger(entry.githubRepositoryId) || entry.githubRepositoryId < 1 || !Number.isSafeInteger(entry.installationId)
    || entry.installationId < 1 || !GITHUB_LOGIN.test(entry.owner) || entry.owner !== entry.owner.toLowerCase()
    || !GITHUB_REPOSITORY_NAME.test(entry.name) || entry.name !== entry.name.toLowerCase()
    || entry.canonical !== `github.com/${entry.owner}/${entry.name}` || !["public", "private", "internal"].includes(entry.visibility)
    || !GITHUB_BRANCH.test(entry.defaultBranch)) return undefined;
  return structuredClone(entry);
}

function validExpectedRevision(value: number) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validTimestamp(value: string) {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

function canonicalResolutionRequest(request: GitHubCredentialResolutionRequest) {
  return SAFE_ID.test(request.projectId)
    && SAFE_ID.test(request.credentialReference)
    && SAFE_ID.test(request.connectionId)
    && Number.isSafeInteger(request.connectionRevision)
    && request.connectionRevision > 0
    && GITHUB_REPOSITORY.test(request.repository);
}
