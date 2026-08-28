import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  GitHubCredentialHealth,
  GitHubCredentialProvider,
  GitHubCredentialProviderKind,
  GitHubCredentialResolutionRequest,
  ResolvedGitHubCredential,
} from "./github-credential-provider.js";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const GITHUB_REPOSITORY = /^github\.com\/[a-z0-9](?:[a-z0-9-]{0,38})\/[a-z0-9_.-]{1,100}$/;

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
  readonly connectionId: string;
  readonly installationId: number;
  readonly repository: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface GitHubIntegrationState {
  readonly schemaVersion: 1;
  readonly connections: readonly ServerGitHubConnection[];
  readonly bindings: readonly ProjectGitHubBinding[];
}

export interface SecretVaultReader {
  available(secretReference: string): boolean;
  read(secretReference: string): Promise<{ readonly token: string; readonly revision: string } | undefined>;
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
  readonly repository: string;
}

const EMPTY: GitHubIntegrationState = { schemaVersion: 1, connections: [], bindings: [] };

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
      const timestamp = new Date().toISOString();
      const candidate: ProjectGitHubBinding = {
        schemaVersion: 1,
        bindingId: current?.bindingId ?? `github-binding:${randomUUID()}`,
        projectId: input.projectId,
        revision: input.expectedRevision + 1,
        connectionId: input.connectionId,
        installationId: input.installationId,
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
    if (!binding || binding.bindingId !== credentialReference) return false;
    const connection = this.#integrations.connection(binding.connectionId);
    return connection?.state === "ready" && this.#vault.available(connection.secretReference);
  }

  health(projectId: string, credentialReference: string): GitHubCredentialHealth {
    const binding = this.#integrations.bindingForProject(projectId);
    if (!binding || binding.bindingId !== credentialReference) return { state: "missing", reason: "binding-missing" };
    const connection = this.#integrations.connection(binding.connectionId);
    if (!connection) return { state: "missing", reason: "connection-missing" };
    if (connection.state === "revoked") return { state: "revoked", provider: connection.authMode, reason: "connection-revoked" };
    if (connection.state === "degraded") return { state: "degraded", provider: connection.authMode, reason: "connection-degraded" };
    if (!this.#vault.available(connection.secretReference)) return { state: "missing", provider: connection.authMode, reason: "credential-missing" };
    return { state: "ready", provider: connection.authMode, reason: "ready" };
  }

  async resolve(request: GitHubCredentialResolutionRequest): Promise<ResolvedGitHubCredential | undefined> {
    if (!canonicalResolutionRequest(request)) return undefined;
    const binding = this.#integrations.bindingForProject(request.projectId);
    if (!binding || binding.bindingId !== request.credentialReference || binding.repository !== request.repository) return undefined;
    const connection = this.#integrations.connection(binding.connectionId);
    if (!connection || connection.state !== "ready") return undefined;
    const secret = await this.#vault.read(connection.secretReference);
    if (!secret?.token) return undefined;
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
  if (state.schemaVersion !== 1 || !Array.isArray(state.connections) || !Array.isArray(state.bindings)) return undefined;
  const connections = state.connections.map(normalizeConnection);
  const bindings = state.bindings.map(normalizeBinding);
  if (connections.some((record) => !record) || bindings.some((record) => !record)) return undefined;
  const canonicalConnections = connections as ServerGitHubConnection[];
  const canonicalBindings = bindings as ProjectGitHubBinding[];
  if (new Set(canonicalConnections.map((record) => record.connectionId)).size !== canonicalConnections.length
    || new Set(canonicalBindings.map((record) => record.projectId)).size !== canonicalBindings.length
    || new Set(canonicalBindings.map((record) => record.bindingId)).size !== canonicalBindings.length
    || canonicalBindings.some((binding) => !canonicalConnections.some((connection) => connection.connectionId === binding.connectionId))) return undefined;
  return { schemaVersion: 1, connections: canonicalConnections, bindings: canonicalBindings };
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
  const record = value as ProjectGitHubBinding;
  if (record.schemaVersion !== 1 || !SAFE_ID.test(record.bindingId) || !SAFE_ID.test(record.projectId)
    || !Number.isSafeInteger(record.revision) || record.revision < 1 || !SAFE_ID.test(record.connectionId)
    || !Number.isSafeInteger(record.installationId) || record.installationId < 1 || !GITHUB_REPOSITORY.test(record.repository)
    || !validTimestamp(record.createdAt) || !validTimestamp(record.updatedAt)) return undefined;
  return structuredClone(record);
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
