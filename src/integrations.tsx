import { GitHubIntegrationPanel } from "./github-integration-panel";
import { OpenRouterIntegrationSection } from "./openrouter-integration-section";

/**
 * The server-admin "Integrations" workspace destination (`Window > Integrations`):
 * GitHub's account/project-repository connection and OpenRouter's account section,
 * in one place instead of a separate Room-menu dialog and Window destination. See #209.
 */
export function IntegrationsPage({ agentLabels, refreshKey, onOpenAdministration }: { agentLabels?: Readonly<Record<string, string>>; refreshKey?: number; onOpenAdministration: () => void }) {
  return <section className="workspace-view integrations-page classic-scrollbars" aria-label="Integrations">
    <header className="workspace-view__header"><h2>Connected accounts</h2><p>GitHub's project repository and OpenRouter's account balance are configured once per server; this room's own OpenRouter spend is below.</p></header>
    <div className="workspace-view__body integrations-body">
      <GitHubIntegrationPanel onOpenAdministration={onOpenAdministration} />
      <OpenRouterIntegrationSection agentLabels={agentLabels} refreshKey={refreshKey} onOpenAdministration={onOpenAdministration} />
    </div>
  </section>;
}
