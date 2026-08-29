import { randomUUID } from "node:crypto";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

export type GitHubCredentialProviderKind = "legacy-pat" | "github-device-user" | "github-app-installation";

export interface GitHubCredentialResolutionRequest {
  readonly projectId: string;
  readonly credentialReference: string;
  readonly connectionId: string;
  readonly connectionRevision: number;
  readonly repository: string;
}

export interface ResolvedGitHubCredential {
  /** Secret bearer token. This value must remain inside the GitHub adapter boundary. */
  readonly token: string;
  readonly provider: GitHubCredentialProviderKind;
  /** Non-secret provider revision used to invalidate an authorization lease. */
  readonly authorityRevision: string;
}

export interface GitHubCredentialHealth {
  readonly state: "ready" | "missing" | "degraded" | "revoked";
  readonly provider?: GitHubCredentialProviderKind;
  readonly reason: string;
}

export interface SecretVaultReader {
  available(secretReference: string): boolean;
  read(secretReference: string): Promise<{
    readonly token: string;
    readonly revision: string;
    readonly provider: Extract<GitHubCredentialProviderKind, "github-device-user" | "github-app-installation">;
  } | undefined>;
}

/** Runtime boundary shared by legacy PAT, device-user, and installation-token providers. */
export interface GitHubCredentialProvider {
  available(projectId: string, credentialReference: string): boolean;
  health(projectId: string, credentialReference: string): GitHubCredentialHealth;
  resolve(request: GitHubCredentialResolutionRequest): Promise<ResolvedGitHubCredential | undefined>;
}

/** Supports a fail-closed migration from legacy PATs to server-owned App credentials. */
export class CascadingGitHubCredentialProvider implements GitHubCredentialProvider {
  readonly #providers: readonly GitHubCredentialProvider[];

  constructor(providers: readonly GitHubCredentialProvider[]) {
    if (providers.length === 0) throw new Error("At least one GitHub credential provider is required.");
    this.#providers = [...providers];
  }

  available(projectId: string, credentialReference: string) {
    return this.#providers.some((provider) => provider.available(projectId, credentialReference));
  }

  health(projectId: string, credentialReference: string): GitHubCredentialHealth {
    for (const provider of this.#providers) {
      const health = provider.health(projectId, credentialReference);
      if (health.state !== "missing") return health;
    }
    return { state: "missing", reason: "credential-missing" };
  }

  async resolve(request: GitHubCredentialResolutionRequest) {
    for (const provider of this.#providers) {
      const credential = await provider.resolve(request);
      if (credential) return credential;
    }
    return undefined;
  }
}

interface LegacyCredentialRecord {
  readonly token: string;
  readonly authorityRevision: string;
}

/**
 * Compatibility provider for the environment-backed PAT path.
 *
 * Secrets remain memory-only and project-scoped. New authentication modes should
 * implement GitHubCredentialProvider instead of adding behavior to this class.
 */
export class LegacyPatGitHubCredentialProvider implements GitHubCredentialProvider {
  private readonly values = new Map<string, LegacyCredentialRecord>();

  register(projectId: string, reference: string, credential: string) {
    if (!SAFE_ID.test(projectId) || !SAFE_ID.test(reference) || !credential) {
      throw new Error("A canonical project, credential reference, and server-held credential are required.");
    }
    const key = this.key(projectId, reference);
    if (this.values.has(key)) throw new Error("Credential reference is already registered.");
    this.values.set(key, { token: credential, authorityRevision: `legacy:${randomUUID()}` });
  }

  available(projectId: string, reference: string) {
    return this.values.has(this.key(projectId, reference));
  }

  health(projectId: string, reference: string): GitHubCredentialHealth {
    return this.available(projectId, reference)
      ? { state: "ready", provider: "legacy-pat", reason: "ready" }
      : { state: "missing", reason: "credential-missing" };
  }

  async resolve(request: GitHubCredentialResolutionRequest): Promise<ResolvedGitHubCredential | undefined> {
    if (!this.canonicalRequest(request)) return undefined;
    const record = this.values.get(this.key(request.projectId, request.credentialReference));
    return record ? { token: record.token, provider: "legacy-pat", authorityRevision: record.authorityRevision } : undefined;
  }

  /** Compatibility-only inspection for existing server-side tests and callers. */
  forServerOperation(projectId: string, reference: string) {
    return this.values.get(this.key(projectId, reference))?.token;
  }

  private canonicalRequest(request: GitHubCredentialResolutionRequest) {
    return SAFE_ID.test(request.projectId)
      && SAFE_ID.test(request.credentialReference)
      && SAFE_ID.test(request.connectionId)
      && Number.isSafeInteger(request.connectionRevision)
      && request.connectionRevision > 0
      && /^github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(request.repository);
  }

  private key(projectId: string, reference: string) {
    return `${projectId}\0${reference}`;
  }
}
