import { GitHubIntegrationPanel } from "./github-integration-panel";
import { OpenRouterCreditsSection } from "./openrouter-integration-section";

/**
 * Server Administration → Integrations: GitHub's account/project-repository connection
 * and the OpenRouter account balance. This room's own spend is Room → Usage & spend….
 */
export function IntegrationsPage({ refreshKey }: { refreshKey?: number }) {
  return <div className="administration-page integrations-page" aria-label="Integrations">
    <header className="page-header"><h2>Integrations</h2><p>Connected accounts are configured once per server and shared by every room in a project.</p></header>
    <div className="integrations-body">
      <GitHubIntegrationPanel />
      <OpenRouterCreditsSection refreshKey={refreshKey} />
    </div>
  </div>;
}
