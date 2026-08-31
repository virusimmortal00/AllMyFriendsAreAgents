import path from "node:path";
import { defaultGitHubCredentialKeyPath, loadBundledGitHubAppConfiguration, type BundledGitHubAppConfiguration } from "./github-app-configuration.js";
import { EncryptedGitHubCredentialVault, type OpenEncryptedGitHubCredentialVaultInput } from "./github-credential-vault.js";
import { GitHubDeviceAuthorizationCoordinator } from "./github-device-authorization.js";
import { GitHubDeviceFlowClient } from "./github-device-flow.js";
import { BoundGitHubCredentialProvider, GitHubIntegrationStore } from "./github-integration-store.js";
import { GitHubRepositoryCatalogClient } from "./github-repository-catalog.js";
import { GitHubRepositoryCatalogService } from "./github-repository-catalog-service.js";

export interface GitHubIntegrationRuntime {
  readonly configuration: BundledGitHubAppConfiguration;
  readonly integrations: GitHubIntegrationStore;
  readonly vault: EncryptedGitHubCredentialVault;
  readonly credentials: BoundGitHubCredentialProvider;
  readonly authorizations: GitHubDeviceAuthorizationCoordinator;
  readonly catalogs: GitHubRepositoryCatalogService;
}

/** Opens the complete App integration only when a reviewed public client identity is bundled. */
export async function openGitHubIntegrationRuntime(input: {
  readonly projectRoot: string;
  readonly dataDirectory: string;
  readonly configurationPath?: string;
  readonly credentialKeyPath?: string;
  readonly onRefreshEvent?: OpenEncryptedGitHubCredentialVaultInput["onRefreshEvent"];
}): Promise<GitHubIntegrationRuntime | undefined> {
  const configuration = await loadBundledGitHubAppConfiguration(input.configurationPath ?? path.join(input.projectRoot, "config/github-app.json"));
  if (!configuration) return undefined;
  const integrations = await GitHubIntegrationStore.open(input.dataDirectory);
  const deviceFlow = new GitHubDeviceFlowClient(configuration.clientId);
  const vault = await EncryptedGitHubCredentialVault.open({
    vaultPath: path.join(input.dataDirectory, "github-credentials.enc"),
    keyPath: input.credentialKeyPath ?? defaultGitHubCredentialKeyPath(input.projectRoot),
    refresh: (token) => deviceFlow.refresh(token),
    onRefreshEvent: input.onRefreshEvent,
  });
  const credentials = new BoundGitHubCredentialProvider(integrations, vault);
  const authorizations = new GitHubDeviceAuthorizationCoordinator(deviceFlow, integrations, vault);
  const catalogs = new GitHubRepositoryCatalogService(integrations, vault, new GitHubRepositoryCatalogClient());
  return { configuration, integrations, vault, credentials, authorizations, catalogs };
}
