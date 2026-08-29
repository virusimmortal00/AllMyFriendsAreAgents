import { randomUUID } from "node:crypto";
import type { EncryptedGitHubCredentialVault } from "./github-credential-vault.js";
import { publicGitHubDeviceChallenge, type GitHubDeviceAuthorization, type GitHubDeviceFlowTransport, type GitHubDeviceUserToken } from "./github-device-flow.js";
import type { GitHubIntegrationStore, PublicServerGitHubConnection } from "./github-integration-store.js";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const GITHUB_USER_ENDPOINT = "https://api.github.com/user";
const MAX_RESPONSE_BYTES = 32 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_ACTIVE_FLOWS_PER_PRINCIPAL = 3;

export type GitHubUserFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;
export type GitHubDeviceAuthorizationState = "authorizing" | "ready" | "denied" | "expired" | "failed";

export interface PublicGitHubDeviceAuthorization {
  readonly flowId: string;
  readonly state: GitHubDeviceAuthorizationState;
  readonly challenge?: ReturnType<typeof publicGitHubDeviceChallenge>;
  readonly expiresAt: string;
  readonly nextPollAt?: string;
  readonly connection?: PublicServerGitHubConnection;
  readonly failureReason?: "github-unavailable" | "invalid-credential" | "storage-failed";
}

interface PendingAuthorization {
  readonly flowId: string;
  readonly principalId: string;
  readonly connectionId: string;
  readonly secretReference: string;
  readonly authorization: GitHubDeviceAuthorization;
  readonly expiresAtMs: number;
  readonly createdAt: string;
  intervalSeconds: number;
  nextPollAtMs: number;
  state: GitHubDeviceAuthorizationState;
  connection?: PublicServerGitHubConnection;
  failureReason?: PublicGitHubDeviceAuthorization["failureReason"];
}

type IntegrationWriter = Pick<GitHubIntegrationStore, "saveConnection" | "connections">;
type CredentialWriter = Pick<EncryptedGitHubCredentialVault, "put" | "delete">;

/** Orchestrates device authorization without returning OAuth credentials to callers. */
export class GitHubDeviceAuthorizationCoordinator {
  readonly #flows = new Map<string, PendingAuthorization>();
  readonly #deviceFlow: GitHubDeviceFlowTransport;
  readonly #integrations: IntegrationWriter;
  readonly #vault: CredentialWriter;
  readonly #userFetch: GitHubUserFetch;
  readonly #now: () => number;
  readonly #queues = new Map<string, Promise<void>>();

  constructor(
    deviceFlow: GitHubDeviceFlowTransport,
    integrations: IntegrationWriter,
    vault: CredentialWriter,
    userFetch: GitHubUserFetch = fetch,
    now: () => number = Date.now,
  ) {
    this.#deviceFlow = deviceFlow;
    this.#integrations = integrations;
    this.#vault = vault;
    this.#userFetch = userFetch;
    this.#now = now;
  }

  start(principalId: string): Promise<PublicGitHubDeviceAuthorization> {
    return this.serialize(`principal:${principalId}`, async () => {
      if (!SAFE_ID.test(principalId)) throw new GitHubDeviceAuthorizationFailure("not-found");
      this.sweepExpired();
      if ([...this.#flows.values()].filter((flow) => flow.principalId === principalId && flow.state === "authorizing").length >= MAX_ACTIVE_FLOWS_PER_PRINCIPAL) {
        throw new GitHubDeviceAuthorizationFailure("limit-exceeded");
      }
      const authorization = await this.#deviceFlow.start();
      const nowMs = this.#now();
      const flow: PendingAuthorization = {
        flowId: `github-device-flow:${randomUUID()}`,
        principalId,
        connectionId: `github-connection:${randomUUID()}`,
        secretReference: `github-secret:${randomUUID()}`,
        authorization,
        expiresAtMs: nowMs + authorization.expiresInSeconds * 1_000,
        createdAt: new Date(nowMs).toISOString(),
        intervalSeconds: authorization.intervalSeconds,
        nextPollAtMs: nowMs + authorization.intervalSeconds * 1_000,
        state: "authorizing",
      };
      this.#flows.set(flow.flowId, flow);
      return project(flow);
    });
  }

  status(flowId: string, principalId: string) {
    const flow = this.ownedFlow(flowId, principalId);
    this.expire(flow);
    const result = project(flow);
    if (flow.state !== "authorizing") this.#flows.delete(flow.flowId);
    this.sweepExpired();
    return result;
  }

  poll(flowId: string, principalId: string): Promise<PublicGitHubDeviceAuthorization> {
    return this.serialize(`flow:${flowId}`, async () => {
      const flow = this.ownedFlow(flowId, principalId);
      this.expire(flow);
      if (flow.state !== "authorizing") return this.finish(flow);
      const nowMs = this.#now();
      if (nowMs < flow.nextPollAtMs) return project(flow);
      let result;
      try { result = await this.#deviceFlow.poll(flow.authorization.deviceCode, flow.intervalSeconds); }
      catch {
        flow.state = "failed";
        flow.failureReason = "github-unavailable";
        return this.finish(flow);
      }
      if (result.kind === "pending" || result.kind === "slow-down") {
        flow.intervalSeconds = result.retryAfterSeconds;
        flow.nextPollAtMs = nowMs + result.retryAfterSeconds * 1_000;
      } else if (result.kind === "denied") {
        flow.state = "denied";
      } else if (result.kind === "expired") {
        flow.state = "expired";
      } else {
        await this.complete(flow, result.credential);
      }
      return this.finish(flow);
    });
  }

  private async complete(flow: PendingAuthorization, credential: GitHubDeviceUserToken) {
    if (!credential.expiresInSeconds || !credential.refreshToken || !credential.refreshTokenExpiresInSeconds) {
      flow.state = "failed";
      flow.failureReason = "invalid-credential";
      return;
    }
    let githubUser: { id: number; login: string };
    try { githubUser = await fetchGitHubUser(credential.accessToken, this.#userFetch); }
    catch {
      flow.state = "failed";
      flow.failureReason = "github-unavailable";
      return;
    }
    const completedAtMs = this.#now();
    const completedAt = new Date(completedAtMs).toISOString();
    let stored;
    try {
      stored = await this.#vault.put(flow.secretReference, 0, {
        kind: "github-device-user",
        accessToken: credential.accessToken,
        refreshToken: credential.refreshToken,
        accessTokenExpiresAt: new Date(completedAtMs + credential.expiresInSeconds * 1_000).toISOString(),
        refreshTokenExpiresAt: new Date(completedAtMs + credential.refreshTokenExpiresInSeconds * 1_000).toISOString(),
      });
    } catch {
      flow.state = "failed";
      flow.failureReason = "storage-failed";
      return;
    }
    if (stored.kind !== "ok") {
      flow.state = "failed";
      flow.failureReason = "storage-failed";
      return;
    }
    let saved;
    try {
      saved = await this.#integrations.saveConnection({
        expectedRevision: 0,
        connectionId: flow.connectionId,
        authMode: "github-device-user",
        state: "ready",
        githubUser,
        secretReference: flow.secretReference,
        connectedAt: completedAt,
        lastValidatedAt: completedAt,
      });
    } catch {
      await this.compensate(flow.secretReference, stored.revision);
      flow.state = "failed";
      flow.failureReason = "storage-failed";
      return;
    }
    if (saved.kind !== "ok") {
      await this.compensate(flow.secretReference, stored.revision);
      flow.state = "failed";
      flow.failureReason = "storage-failed";
      return;
    }
    flow.connection = this.#integrations.connections().find((connection) => connection.connectionId === flow.connectionId);
    if (!flow.connection) {
      await this.compensate(flow.secretReference, stored.revision);
      flow.state = "failed";
      flow.failureReason = "storage-failed";
      return;
    }
    flow.state = "ready";
  }

  private ownedFlow(flowId: string, principalId: string) {
    if (!SAFE_ID.test(flowId) || !SAFE_ID.test(principalId)) throw new GitHubDeviceAuthorizationFailure("not-found");
    const flow = this.#flows.get(flowId);
    if (!flow || flow.principalId !== principalId) throw new GitHubDeviceAuthorizationFailure("not-found");
    return flow;
  }

  private expire(flow: PendingAuthorization) {
    if (flow.state === "authorizing" && this.#now() >= flow.expiresAtMs) flow.state = "expired";
  }

  private finish(flow: PendingAuthorization) {
    const result = project(flow);
    if (flow.state !== "authorizing") this.#flows.delete(flow.flowId);
    return result;
  }

  private sweepExpired() {
    const nowMs = this.#now();
    for (const [flowId, flow] of this.#flows) {
      if (flow.state !== "authorizing" || nowMs >= flow.expiresAtMs) this.#flows.delete(flowId);
    }
  }

  private async compensate(secretReference: string, revision: number) {
    try { await this.#vault.delete(secretReference, revision); } catch { /* The unreferenced secret remains inaccessible and can be reconciled on startup. */ }
  }

  private serialize<T>(key: string, work: () => Promise<T>): Promise<T> {
    const operation = (this.#queues.get(key) ?? Promise.resolve()).then(work);
    const release = operation.then(() => undefined, () => undefined);
    this.#queues.set(key, release);
    void release.then(() => { if (this.#queues.get(key) === release) this.#queues.delete(key); });
    return operation;
  }
}

export class GitHubDeviceAuthorizationFailure extends Error {
  constructor(readonly kind: "not-found" | "limit-exceeded") {
    super(kind === "not-found" ? "GitHub device authorization was not found." : "Too many GitHub device authorizations are active.");
    this.name = "GitHubDeviceAuthorizationFailure";
  }
}

function project(flow: PendingAuthorization): PublicGitHubDeviceAuthorization {
  return {
    flowId: flow.flowId,
    state: flow.state,
    ...(flow.state === "authorizing" ? { challenge: publicGitHubDeviceChallenge(flow.authorization) } : {}),
    expiresAt: new Date(flow.expiresAtMs).toISOString(),
    ...(flow.state === "authorizing" ? { nextPollAt: new Date(flow.nextPollAtMs).toISOString() } : {}),
    ...(flow.connection ? { connection: structuredClone(flow.connection) } : {}),
    ...(flow.failureReason ? { failureReason: flow.failureReason } : {}),
  };
}

async function fetchGitHubUser(accessToken: string, fetcher: GitHubUserFetch) {
  let response: Response;
  try {
    response = await fetcher(GITHUB_USER_ENDPOINT, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { accept: "application/vnd.github+json", authorization: `Bearer ${accessToken}`, "x-github-api-version": "2022-11-28" },
    });
  } catch { throw new Error("GitHub user validation failed."); }
  if (!response.ok) throw new Error("GitHub user validation failed.");
  let text: string;
  try { text = await response.text(); }
  catch { throw new Error("GitHub user validation failed."); }
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) throw new Error("GitHub user validation failed.");
  let payload: unknown;
  try { payload = JSON.parse(text); } catch { throw new Error("GitHub user validation failed."); }
  if (!payload || typeof payload !== "object") throw new Error("GitHub user validation failed.");
  const user = payload as { id?: unknown; login?: unknown };
  if (!Number.isSafeInteger(user.id) || (user.id as number) < 1 || typeof user.login !== "string" || !GITHUB_LOGIN.test(user.login)) {
    throw new Error("GitHub user validation failed.");
  }
  return { id: user.id as number, login: user.login };
}
