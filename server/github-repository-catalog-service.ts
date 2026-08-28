import type { SecretVaultReader } from "./github-credential-provider.js";
import type { GitHubIntegrationMutationResult, GitHubIntegrationStore, GitHubRepositoryCatalogSnapshot } from "./github-integration-store.js";
import type { GitHubRepositoryCatalogClient } from "./github-repository-catalog.js";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

type IntegrationCatalogStore = Pick<GitHubIntegrationStore, "connection" | "catalog" | "replaceCatalog">;
type CatalogDiscovery = Pick<GitHubRepositoryCatalogClient, "discover">;

/** Refreshes catalog metadata without exposing a user token outside the server. */
export class GitHubRepositoryCatalogService {
  constructor(private readonly integrations: IntegrationCatalogStore, private readonly vault: SecretVaultReader, private readonly client: CatalogDiscovery) {}

  inspect(connectionId: string) {
    return SAFE_ID.test(connectionId) ? this.integrations.catalog(connectionId) : undefined;
  }

  async refresh(connectionId: string, expectedRevision: number): Promise<GitHubIntegrationMutationResult<GitHubRepositoryCatalogSnapshot>> {
    if (!SAFE_ID.test(connectionId) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      return { kind: "rejected", reason: "Catalog refresh request is not canonical." };
    }
    const connection = this.integrations.connection(connectionId);
    if (!connection || connection.state !== "ready") return { kind: "rejected", reason: "A ready GitHub connection is required." };
    let secret;
    try { secret = await this.vault.read(connection.secretReference); }
    catch { return { kind: "rejected", reason: "A device-user credential is unavailable." }; }
    if (!secret || secret.provider !== "github-device-user") return { kind: "rejected", reason: "A device-user credential is unavailable." };
    let discovery;
    try { discovery = await this.client.discover(secret.token); }
    catch { return { kind: "rejected", reason: "GitHub repository discovery failed." }; }
    const latest = this.integrations.connection(connectionId);
    if (!latest || latest.state !== "ready" || latest.revision !== connection.revision || latest.secretReference !== connection.secretReference) {
      return { kind: "rejected", reason: "GitHub connection changed during catalog discovery." };
    }
    return this.integrations.replaceCatalog({ expectedRevision, connectionId, connectionRevision: connection.revision, discovery });
  }
}
