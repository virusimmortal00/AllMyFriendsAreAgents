import { createHash } from "node:crypto";
import type { GhSelector } from "../shared/command-domain.js";
import { GitHubReadAdapter, GitHubReadFailure, type GitHubEndpointFamily, type GitHubReadFetch } from "./github-read-adapter.js";
import { GitHubReadService, githubReadFailureText } from "./github-read-service.js";
import { GitHubReadStore, type GitHubReadCacheEvent } from "./github-read-store.js";
import type { GitHubCredentialProvider } from "./github-credential-provider.js";
import type { ProjectRepositoryConnection, ProjectRepositoryConnectionService } from "./project-repository-connection.js";
import type { IdentityRepository } from "./storage/identity-domain.js";

export interface RoomBoundGitHubReadOptions {
  readonly fetcher?: GitHubReadFetch;
  readonly operationLog?: (event: GitHubReadCacheEvent) => Promise<unknown> | unknown;
  readonly ttlMs?: number;
  readonly maxEntries?: number;
  readonly maxActive?: number;
  readonly maxQueued?: number;
}

type GitHubIdentityReader=Pick<IdentityRepository,"getStorageScope"|"getDurableProject"|"getRepositoryReference">;

interface AuthorizedBinding { readonly cacheScope: string; readonly authorizationLease: string; readonly connection: ProjectRepositoryConnection; readonly token: string }

/** Resolves every read from server-owned room state before reaching the shared sanitized cache. */
export class RoomBoundGitHubReadService {
  private readonly store: GitHubReadStore;
  constructor(
    private readonly identities: GitHubIdentityReader|((roomId:string)=>GitHubIdentityReader|Promise<GitHubIdentityReader>),
    private readonly connectionForProject: (projectId: string) => ProjectRepositoryConnectionService,
    private readonly credentials: GitHubCredentialProvider,
    private readonly options: RoomBoundGitHubReadOptions = {},
  ) { this.store = new GitHubReadStore(undefined, { ttlMs: options.ttlMs, maxEntries: options.maxEntries, maxActive: options.maxActive,
    maxQueued: options.maxQueued, operationLog: options.operationLog }); }

  async authorize(roomId: string) { return (await this.resolve(roomId)).authorizationLease; }

  async validateLease(roomId:string,authorizationLease:string|null|undefined){
    if(!authorizationLease||authorizationLease==="legacy-static")throw new GitHubReadFailure("connection-stale","none");
    const current=await this.resolve(roomId);if(current.authorizationLease!==authorizationLease)throw new GitHubReadFailure("connection-stale","none");
  }

  async execute(roomId: string, selector: GhSelector, authorizationLease?:string|null) {
    const binding = await this.resolve(roomId);
    if(authorizationLease&&binding.authorizationLease!==authorizationLease)throw new GitHubReadFailure("connection-stale","none");
    const validate=()=>this.validateBinding(roomId,binding);
    await validate();
    const connection = binding.connection;
    const adapter = new GitHubReadAdapter({ owner: connection.remote.owner, repository: connection.remote.repository,
      defaultBranch: connection.defaultBranch, token: binding.token }, this.options.fetcher);
    const service = new GitHubReadService({ get: (query) => this.store.getScoped(binding.cacheScope, adapter, query, validate) }, `${connection.remote.owner}/${connection.remote.repository}`);
    const result=await service.execute(selector);await validate();return Object.defineProperty({...result},"authorizationLease",{value:binding.authorizationLease,enumerable:false}) as typeof result&{authorizationLease:string};
  }

  failure(error: unknown, fallbackFamily: GitHubEndpointFamily = "recent-pulls") {
    const failure = error instanceof GitHubReadFailure ? error : new GitHubReadFailure("upstream", "none");
    return { kind: failure.kind, text: githubReadFailureText(failure.kind), diagnostic: { endpointFamily: failure.endpointFamily || fallbackFamily,
      cacheOutcome: "miss" as const, queueDelayMs: 0, rateLimited: failure.kind === "rate-limited", truncated: false,
      failureKind: failure.kind, statusClass: failure.statusClass, correlationId: `failure:${failure.kind}` } };
  }

  inspect() { return this.store.inspect(); }

  private async resolve(roomId: string): Promise<AuthorizedBinding> {
    const identities=typeof this.identities==="function"?await this.identities(roomId):this.identities;
    const scope = await identities.getStorageScope(roomId);
    if (!scope || scope.roomId !== roomId) throw new GitHubReadFailure("room-not-found", "none");
    if (!scope.projectId) throw new GitHubReadFailure("general-room", "none");
    const project = await identities.getDurableProject(scope.projectId);
    if (!project || project.projectId !== scope.projectId || project.serverId !== scope.serverId) throw new GitHubReadFailure("project-not-found", "none");
    const service = this.connectionForProject(project.projectId);
    const connection = service.inspectServer();
    if (!connection) {
      if (!project.repositoryReferenceId) throw new GitHubReadFailure("connection-missing", "none");
      const reference = await identities.getRepositoryReference(project.repositoryReferenceId);
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
    const credential = await this.credentials.resolve({
      projectId: project.projectId,
      credentialReference: connection.credentialReference,
      connectionId: connection.connectionId,
      connectionRevision: connection.revision,
      repository: connection.remote.canonical,
    });
    if (!credential) throw new GitHubReadFailure("credential-missing", "none");
    const cacheScope = `${project.projectId}:${connection.connectionId}:${connection.revision}:${connection.remote.canonical}`;
    const authorizationLease=`sha256:${createHash("sha256").update(JSON.stringify({serverId:scope.serverId,roomId:scope.roomId,roomAttachmentRevision:scope.roomAttachmentRevision??0,
      projectId:project.projectId,projectRevision:project.revision,connectionId:connection.connectionId,connectionRevision:connection.revision,
      repository:connection.remote.canonical,identityDigest:connection.identityDigest,credentialReference:connection.credentialReference,
      credentialProvider:credential.provider,credentialAuthorityRevision:credential.authorityRevision})).digest("hex")}`;
    return { cacheScope, authorizationLease, connection, token:credential.token };
  }

  private async validateBinding(roomId:string,binding:AuthorizedBinding){const current=await this.resolve(roomId);if(current.authorizationLease!==binding.authorizationLease||current.cacheScope!==binding.cacheScope)throw new GitHubReadFailure("connection-stale","none");}
}
