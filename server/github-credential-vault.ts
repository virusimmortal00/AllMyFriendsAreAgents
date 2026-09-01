import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SecretVaultReader } from "./github-credential-provider.js";
import type { GitHubDeviceFlowTransport } from "./github-device-flow.js";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const USER_ACCESS_TOKEN = /^ghu_[A-Za-z0-9_]{10,1000}$/;
const REFRESH_TOKEN = /^ghr_[A-Za-z0-9_]{10,1000}$/;
const INSTALLATION_ACCESS_TOKEN = /^ghs_[A-Za-z0-9_]{10,1000}$/;
const KEY_PREFIX = "amfaa-github-vault-key-v1:";
const AAD_PREFIX = "amfaa:github-credential-vault:v1:";
const VAULT_MUTATION_QUEUES = new Map<string, Promise<void>>();

export interface GitHubDeviceUserVaultCredential {
  readonly kind: "github-device-user";
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly accessTokenExpiresAt: string;
  readonly refreshTokenExpiresAt: string;
}

export interface GitHubInstallationVaultCredential {
  readonly kind: "github-app-installation";
  readonly accessToken: string;
  readonly accessTokenExpiresAt: string;
}

export type GitHubVaultCredential = GitHubDeviceUserVaultCredential | GitHubInstallationVaultCredential;

interface StoredCredential {
  readonly reference: string;
  readonly revision: number;
  readonly credential: GitHubVaultCredential | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface PlaintextVaultState {
  readonly schemaVersion: 1;
  readonly credentials: readonly StoredCredential[];
}

interface EncryptedVaultEnvelope {
  readonly schemaVersion: 1;
  readonly algorithm: "aes-256-gcm";
  readonly keyId: string;
  readonly iv: string;
  readonly authenticationTag: string;
  readonly ciphertext: string;
}

export type CredentialVaultMutationResult =
  | { readonly kind: "ok"; readonly reference: string; readonly revision: number }
  | { readonly kind: "conflict"; readonly actualRevision: number }
  | { readonly kind: "rejected"; readonly reason: string };

/** Refresh audit evidence deliberately excludes tokens, vault references, and raw errors. */
export interface GitHubCredentialRefreshEvent {
  readonly correlationId: string;
  readonly outcome: "attempted" | "completed" | "failed";
  readonly reason: "upstream" | "invalid-response" | "storage-failed" | null;
  readonly credentialRevision: number;
}

export interface OpenEncryptedGitHubCredentialVaultInput {
  readonly vaultPath: string;
  readonly keyPath: string;
  readonly now?: () => string;
  readonly refresh?: GitHubDeviceFlowTransport["refresh"];
  readonly onRefreshEvent?: (event: GitHubCredentialRefreshEvent) => Promise<unknown> | unknown;
}

const EMPTY: PlaintextVaultState = { schemaVersion: 1, credentials: [] };

/**
 * Encrypted local credential storage for GitHub OAuth and installation tokens.
 *
 * The wrapping key path must be in a different directory from the encrypted
 * vault so normal data-directory backups can exclude key material.
 */
export class EncryptedGitHubCredentialVault implements SecretVaultReader {
  readonly #key: Buffer;
  readonly #keyId: string;
  readonly #now: () => string;
  readonly #refresh?: GitHubDeviceFlowTransport["refresh"];
  readonly #onRefreshEvent?: OpenEncryptedGitHubCredentialVaultInput["onRefreshEvent"];
  #state: PlaintextVaultState;

  private constructor(readonly vaultPath: string, readonly keyPath: string, key: Buffer, state: PlaintextVaultState, now: () => string, refresh?: GitHubDeviceFlowTransport["refresh"], onRefreshEvent?: OpenEncryptedGitHubCredentialVaultInput["onRefreshEvent"]) {
    this.#key = key;
    this.#keyId = createHash("sha256").update(key).digest("hex");
    this.#state = state;
    this.#now = now;
    this.#refresh = refresh;
    this.#onRefreshEvent = onRefreshEvent;
  }

  static async open(input: OpenEncryptedGitHubCredentialVaultInput) {
    validatePaths(input.vaultPath, input.keyPath);
    await Promise.all([secureDirectory(path.dirname(input.vaultPath)), secureDirectory(path.dirname(input.keyPath))]);
    const key = await loadOrCreateKey(input.keyPath);
    const keyId = createHash("sha256").update(key).digest("hex");
    const existing = await readRegularFile(input.vaultPath);
    const state = existing === undefined ? EMPTY : decryptState(existing, key, keyId);
    const vault = new EncryptedGitHubCredentialVault(input.vaultPath, input.keyPath, key, state, input.now ?? (() => new Date().toISOString()), input.refresh, input.onRefreshEvent);
    if (existing === undefined) await vault.persist(state);
    else await chmod(input.vaultPath, 0o600);
    return vault;
  }

  available(reference: string) {
    const credential = this.record(reference)?.credential;
    const now = Date.parse(canonicalNow(this.#now));
    return Boolean(credential && (Date.parse(credential.accessTokenExpiresAt) > now
      || credential.kind === "github-device-user" && this.#refresh && Date.parse(credential.refreshTokenExpiresAt) > now));
  }

  async read(reference: string) {
    if (!SAFE_ID.test(reference)) return undefined;
    // Reload and serialize with rotation/deletion, including other vault instances.
    // Refresh tokens are single-use; persist the replacement pair before returning it.
    return this.mutate(async () => {
      let record = this.record(reference);
      if (!record) return undefined;
      const now = Date.parse(canonicalNow(this.#now));
      if (Date.parse(record.credential.accessTokenExpiresAt) <= now) {
        const credential = record.credential;
        if (credential.kind !== "github-device-user" || !this.#refresh || Date.parse(credential.refreshTokenExpiresAt) <= now) return undefined;
        const startedAt = now;
        const correlationId = randomUUID();
        const credentialRevision = record.revision;
        await this.reportRefresh({ correlationId, outcome: "attempted", reason: null, credentialRevision: record.revision });
        const failed = async (reason: GitHubCredentialRefreshEvent["reason"]) => {
          await this.reportRefresh({ correlationId, outcome: "failed", reason, credentialRevision });
          return undefined;
        };
        let refreshed;
        try { refreshed = await this.#refresh(credential.refreshToken); }
        catch { return failed("upstream"); }
        if (!refreshed || !Number.isSafeInteger(refreshed.expiresInSeconds) || !refreshed.expiresInSeconds || refreshed.expiresInSeconds < 1 || refreshed.expiresInSeconds > 86_400
          || !refreshed.refreshToken || !Number.isSafeInteger(refreshed.refreshTokenExpiresInSeconds) || !refreshed.refreshTokenExpiresInSeconds
          || refreshed.refreshTokenExpiresInSeconds < 1 || refreshed.refreshTokenExpiresInSeconds > 366 * 86_400) return failed("invalid-response");
        const nextCredential: GitHubDeviceUserVaultCredential = {
          kind: "github-device-user", accessToken: refreshed.accessToken, refreshToken: refreshed.refreshToken,
          accessTokenExpiresAt: new Date(startedAt + refreshed.expiresInSeconds * 1_000).toISOString(),
          refreshTokenExpiresAt: new Date(startedAt + refreshed.refreshTokenExpiresInSeconds * 1_000).toISOString(),
        };
        if (!validCredential(nextCredential) || Date.parse(nextCredential.accessTokenExpiresAt) <= Date.parse(canonicalNow(this.#now))) return failed("invalid-response");
        const nextRecord = { ...record, revision: record.revision + 1, credential: nextCredential, updatedAt: canonicalNow(this.#now) };
        try { await this.persist({ schemaVersion: 1, credentials: this.#state.credentials.map((item) => item.reference === reference ? nextRecord : item) }); }
        catch { return failed("storage-failed"); }
        record = nextRecord;
        await this.reportRefresh({ correlationId, outcome: "completed", reason: null, credentialRevision: record.revision });
      }
      return { token: record.credential.accessToken, revision: `vault:${record.revision}`, provider: record.credential.kind };
    });
  }

  readCredential(reference: string) {
    const record = this.record(reference);
    return record?.credential ? structuredClone(record) as StoredCredential & { credential: GitHubVaultCredential } : undefined;
  }

  list() {
    return this.#state.credentials.map((record) => ({ reference: record.reference, revision: record.revision,
      state: record.credential ? "ready" as const : "deleted" as const, kind: record.credential?.kind, updatedAt: record.updatedAt }));
  }

  put(reference: string, expectedRevision: number, credential: GitHubVaultCredential): Promise<CredentialVaultMutationResult> {
    return this.mutate(async () => {
      const current = this.#state.credentials.find((record) => record.reference === reference);
      if (!SAFE_ID.test(reference) || !validExpectedRevision(expectedRevision) || !validCredential(credential)) {
        return { kind: "rejected", reason: "Credential record is not canonical." };
      }
      if ((current?.revision ?? 0) !== expectedRevision) return { kind: "conflict", actualRevision: current?.revision ?? 0 };
      if (current?.credential && current.credential.kind !== credential.kind) return { kind: "rejected", reason: "Credential provider kind cannot change in place." };
      const timestamp = canonicalNow(this.#now);
      const next: StoredCredential = {
        reference,
        revision: expectedRevision + 1,
        credential: structuredClone(credential),
        createdAt: current?.createdAt ?? timestamp,
        updatedAt: timestamp,
      };
      await this.persist({ schemaVersion: 1, credentials: [...this.#state.credentials.filter((record) => record.reference !== reference), next] });
      return { kind: "ok", reference, revision: next.revision };
    });
  }

  delete(reference: string, expectedRevision: number): Promise<CredentialVaultMutationResult> {
    return this.mutate(async () => {
      if (!SAFE_ID.test(reference) || !validExpectedRevision(expectedRevision)) return { kind: "rejected", reason: "Credential reference is not canonical." };
      const current = this.#state.credentials.find((record) => record.reference === reference);
      if ((current?.revision ?? 0) !== expectedRevision) return { kind: "conflict", actualRevision: current?.revision ?? 0 };
      if (!current || !current.credential) return { kind: "conflict", actualRevision: current?.revision ?? 0 };
      const timestamp = canonicalNow(this.#now);
      const tombstone: StoredCredential = { ...current, revision: current.revision + 1, credential: null, updatedAt: timestamp };
      await this.persist({ schemaVersion: 1, credentials: [...this.#state.credentials.filter((record) => record.reference !== reference), tombstone] });
      return { kind: "ok", reference, revision: tombstone.revision };
    });
  }

  private record(reference: string) {
    if (!SAFE_ID.test(reference)) return undefined;
    const record = this.#state.credentials.find((value) => value.reference === reference);
    return record?.credential ? record as StoredCredential & { credential: GitHubVaultCredential } : undefined;
  }

  private async reportRefresh(event: GitHubCredentialRefreshEvent) {
    try { await this.#onRefreshEvent?.(event); } catch { /* Logging failure must not change credential resolution. */ }
  }

  private mutate<T>(work: () => Promise<T>): Promise<T> {
    const queueKey = `${this.vaultPath}\u0000${this.keyPath}`;
    const previous = VAULT_MUTATION_QUEUES.get(queueKey) ?? Promise.resolve();
    const operation = previous.then(async () => {
      const latest = await readRegularFile(this.vaultPath);
      if (latest === undefined) throw new Error("GitHub credential vault is unavailable.");
      this.#state = decryptState(latest, this.#key, this.#keyId);
      return work();
    });
    const release = operation.then(() => undefined, () => undefined);
    VAULT_MUTATION_QUEUES.set(queueKey, release);
    void release.then(() => { if (VAULT_MUTATION_QUEUES.get(queueKey) === release) VAULT_MUTATION_QUEUES.delete(queueKey); });
    return operation;
  }

  private async persist(state: PlaintextVaultState) {
    const envelope = encryptState(state, this.#key, this.#keyId);
    const temporary = `${this.vaultPath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(envelope, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.vaultPath);
    await chmod(this.vaultPath, 0o600);
    this.#state = structuredClone(state);
  }
}

function encryptState(state: PlaintextVaultState, key: Buffer, keyId: string): EncryptedVaultEnvelope {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`${AAD_PREFIX}${keyId}`, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(state), "utf8"), cipher.final()]);
  return {
    schemaVersion: 1,
    algorithm: "aes-256-gcm",
    keyId,
    iv: iv.toString("base64"),
    authenticationTag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

function decryptState(raw: string, key: Buffer, keyId: string): PlaintextVaultState {
  try {
    const envelope = JSON.parse(raw) as EncryptedVaultEnvelope;
    if (envelope.schemaVersion !== 1 || envelope.algorithm !== "aes-256-gcm" || envelope.keyId !== keyId) throw new Error("invalid envelope");
    const iv = canonicalBase64(envelope.iv, 12);
    const authenticationTag = canonicalBase64(envelope.authenticationTag, 16);
    const ciphertext = canonicalBase64(envelope.ciphertext);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(Buffer.from(`${AAD_PREFIX}${keyId}`, "utf8"));
    decipher.setAuthTag(authenticationTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    const state = normalizeState(JSON.parse(plaintext));
    if (!state) throw new Error("invalid state");
    return state;
  } catch {
    throw new Error("GitHub credential vault could not be authenticated.");
  }
}

function normalizeState(value: unknown): PlaintextVaultState | undefined {
  if (!value || typeof value !== "object") return undefined;
  const state = value as Partial<PlaintextVaultState>;
  if (state.schemaVersion !== 1 || !Array.isArray(state.credentials)) return undefined;
  const credentials = state.credentials.map(normalizeRecord);
  if (credentials.some((record) => !record)) return undefined;
  const canonical = credentials as StoredCredential[];
  if (new Set(canonical.map((record) => record.reference)).size !== canonical.length) return undefined;
  return { schemaVersion: 1, credentials: canonical };
}

function normalizeRecord(value: unknown): StoredCredential | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as StoredCredential;
  if (!SAFE_ID.test(record.reference) || !Number.isSafeInteger(record.revision) || record.revision < 1 || (record.credential !== null && !validCredential(record.credential))
    || !validTimestamp(record.createdAt) || !validTimestamp(record.updatedAt)) return undefined;
  return structuredClone(record);
}

function validCredential(value: unknown): value is GitHubVaultCredential {
  if (!value || typeof value !== "object") return false;
  const credential = value as GitHubVaultCredential;
  if (credential.kind === "github-device-user") {
    return USER_ACCESS_TOKEN.test(credential.accessToken) && REFRESH_TOKEN.test(credential.refreshToken)
      && validTimestamp(credential.accessTokenExpiresAt) && validTimestamp(credential.refreshTokenExpiresAt);
  }
  if (credential.kind === "github-app-installation") {
    return INSTALLATION_ACCESS_TOKEN.test(credential.accessToken) && validTimestamp(credential.accessTokenExpiresAt);
  }
  return false;
}

function validatePaths(vaultPath: string, keyPath: string) {
  if (!path.isAbsolute(vaultPath) || !path.isAbsolute(keyPath) || path.normalize(vaultPath) !== vaultPath || path.normalize(keyPath) !== keyPath
    || vaultPath === keyPath || path.dirname(vaultPath) === path.dirname(keyPath)) {
    throw new Error("Credential vault and key paths must be distinct absolute canonical paths in separate directories.");
  }
}

async function secureDirectory(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
}

async function loadOrCreateKey(keyPath: string) {
  let raw = await readRegularFile(keyPath);
  if (raw === undefined) {
    const value = `${KEY_PREFIX}${randomBytes(32).toString("base64")}\n`;
    try { await writeFile(keyPath, value, { mode: 0o600, flag: "wx" }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    raw = await readRegularFile(keyPath);
  }
  if (raw === undefined) throw new Error("GitHub credential vault key is unavailable.");
  await chmod(keyPath, 0o600);
  if (!raw.endsWith("\n") || !raw.startsWith(KEY_PREFIX)) throw new Error("GitHub credential vault key is invalid.");
  const encoded = raw.slice(KEY_PREFIX.length, -1);
  const key = canonicalBase64(encoded, 32);
  return key;
}

async function readRegularFile(filePath: string) {
  try {
    const metadata = await lstat(filePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("Credential vault files must be regular files.");
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function canonicalBase64(value: unknown, expectedBytes?: number) {
  if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error("invalid base64");
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value || (expectedBytes !== undefined && decoded.length !== expectedBytes)) throw new Error("invalid base64");
  return decoded;
}

function validExpectedRevision(value: number) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validTimestamp(value: string) {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

function canonicalNow(now: () => string) {
  const value = now();
  if (!validTimestamp(value)) throw new Error("Credential vault clock returned a non-canonical timestamp.");
  return value;
}
