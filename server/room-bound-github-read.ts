import type { GhSelector } from "../shared/command-domain.js";
import { GitHubReadAdapter, GitHubReadFailure, type GitHubEndpointFamily, type GitHubReadFetch } from "./github-read-adapter.js";
import { GitHubReadService, githubReadFailureText } from "./github-read-service.js";
import { GitHubReadStore, type GitHubReadCacheEvent } from "./github-read-store.js";
import type { ProjectRepositoryConnection, ProjectRepositoryConnectionService, ServerHeldRepositoryCredentials } from "./project-repository-connection.js";
import type { IdentityRepository } from "./storage/identity-domain.js";

export interface RoomBoundGitHubReadOptions {
  readonly fetcher?: GitHubReadFetch;
  readonly operationLog?: (event: GitHubReadCacheEvent) => Promise<unknown> | unknown;
  readonly ttlMs?: number;
  readonly maxEntries?: number;
  readonly maxActive?: number;
  readonly maxQueued?: number;
}

interface AuthorizedBinding { readonly scopeKey: string; readonly connection: ProjectRepositoryConnection; readonly token: string }

/** Resolves every read from server-owned room state before reaching the shared sanitized cache. */
export class RoomBoundGitHubReadService {
  private readonly store: GitHubReadStore;
  constructor(
    private readonly identities: Pick<IdentityRepository, "getStorageScope" | "getDurableProject" | "getRepositoryReference">,
    private readonly connectionForProject: (projectId: string) => ProjectRepositoryConnectionService,
    private readonly credentials: ServerHeldRepositoryCredentials,
    private readonly options: RoomBoundGitHubReadOptions = {},
  ) { this.store = new GitHubReadStore(undefined, { ttlMs: options.ttlMs, maxEntries: options.maxEntries, maxActive: options.maxActive,
    maxQueued: options.maxQueued, operationLog: options.operationLog }); }

  async authorize(roomId: string) { return this.resolve(roomId); }

  async execute(roomId: string, selector: GhSelector) {
    const binding = await this.resolve(roomId);
    const connection = binding.connection;
    const adapter = new GitHubReadAdapter({ owner: connection.remote.owner, repository: connection.remote.repository,
      defaultBranch: connection.defaultBranch, token: binding.token }, this.options.fetcher);
    const service = new GitHubReadService({ get: (query) => this.store.getScoped(binding.scopeKey, adapter, query) }, `${connection.remote.owner}/${connection.remote.repository}`);
    return service.execute(selector);
  }

  failure(error: unknown, fallbackFamily: GitHubEndpointFamily = "recent-pulls") {
    const failure = error instanceof GitHubReadFailure ? error : new GitHubReadFailure("upstream", "none");
    return { kind: failure.kind, text: githubReadFailureText(failure.kind), diagnostic: { endpointFamily: failure.endpointFamily || fallbackFamily,
      cacheOutcome: "miss" as const, queueDelayMs: 0, rateLimited: failure.kind === "rate-limited", truncated: false,
      failureKind: failure.kind, statusClass: failure.statusClass, correlationId: `failure:${failure.kind}` } };
  }

  inspect() { return this.store.inspect(); }

  private async resolve(roomId: string): Promise<AuthorizedBinding> {
    const scope = await this.identities.getStorageScope(roomId);
    if (!scope || scope.roomId !== roomId) throw new GitHubReadFailure("room-not-found", "none");
    if (!scope.projectId) throw new GitHubReadFailure("general-room", "none");
    const project = await this.identities.getDurableProject(scope.projectId);
    if (!project || project.projectId !== scope.projectId || project.serverId !== scope.serverId) throw new GitHubReadFailure("project-not-found", "none");
    const service = this.connectionForProject(project.projectId);
    const connection = service.inspectServer();
    if (!connection) {
      if (!project.repositoryReferenceId) throw new GitHubReadFailure("connection-missing", "none");
      const reference = await this.identities.getRepositoryReference(project.repositoryReferenceId);
      if (!reference || reference.projectId !== project.projectId) throw new GitHubReadFailure("connection-stale", "none");
      throw new GitHubReadFailure("connection-unverified", "none");
    }
    if (connection.projectId !== project.projectId) throw new GitHubReadFailure("connection-stale", "none");
    if (connection.state === "disabled") throw new GitHubReadFailure("connection-disabled", "none");
    if (connection.state === "identity-drift") throw new GitHubReadFailure("connection-drift", "none");
    if (connection.state !== "verified") throw new GitHubReadFailure("connection-unverified", "none");
    const verified = await service.revalidateAuthority(connection.revision);
    if (verified.kind !== "ok") {
      if (/revision is stale/i.test(verified.reason)) throw new GitHubReadFailure("connection-stale", "none");
      if (/drift|identity|remote|checkout|branch/i.test(verified.reason)) throw new GitHubReadFailure("connection-drift", "none");
      throw new GitHubReadFailure("connection-unverified", "none");
    }
    const latest = service.inspectServer();
    if (!latest || latest.connectionId !== connection.connectionId || latest.revision !== connection.revision || latest.state !== "verified"
      || latest.remote.canonical !== connection.remote.canonical
      || verified.connection.connectionId !== connection.connectionId || verified.connection.revision !== connection.revision
      || verified.connection.remote.canonical !== connection.remote.canonical) throw new GitHubReadFailure("connection-stale", "none");
    const token = this.credentials.forServerOperation(project.projectId, connection.credentialReference);
    if (!token) throw new GitHubReadFailure("credential-missing", "none");
    const scopeKey = `${project.projectId}:${connection.connectionId}:${connection.revision}:${connection.remote.canonical}`;
    return { scopeKey, connection, token };
  }
}
