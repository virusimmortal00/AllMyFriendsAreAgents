import { useCallback, useState } from "react";
import { Diagnostics } from "./diagnostics";
import { ExplorerLayout, type ExplorerPage } from "./explorer-layout";
import { IntegrationsPage } from "./integrations";
import { RoomsRepositories } from "./rooms-repositories";
import { ServerAdministration, type AdministrationDestination } from "./server-administration";
import { VIEWS, viewAttributes } from "./view-registry";

export type AdministrationPage = "Session" | "Integrations" | "Rooms" | "Diagnostics";

const PAGES: readonly ExplorerPage<AdministrationPage>[] = [
  { key: "Session", label: "Session", icon: "🔑", description: "Claim the server, sign in, or sign out." },
  { key: "Integrations", label: "Integrations", icon: "🔌", description: "GitHub account, project repository, and OpenRouter account balance." },
  { key: "Rooms", label: "Rooms & repositories", icon: "📁", description: "Which repository each room reads from." },
  { key: "Diagnostics", label: "Diagnostics", icon: "🩺", description: "Owner-only bounded diagnostic queries." },
];

/** One Explorer-style window for everything that needs server administrator authority. */
export function AdministrationWindow({ page, destination, refreshKey, onSelectPage, onOpenAdministration, onContinue }: {
  page: AdministrationPage;
  destination: AdministrationDestination | null;
  refreshKey: number;
  onSelectPage: (page: AdministrationPage) => void;
  onOpenAdministration: (destination: AdministrationDestination) => void;
  onContinue: (destination: AdministrationDestination) => void;
}) {
  const [roomsSummary, setRoomsSummary] = useState("");
  const openIntegrations = useCallback(() => onSelectPage("Integrations"), [onSelectPage]);
  return <section className="workspace-view administration-window" aria-label="Server administration" {...viewAttributes(VIEWS.serverAdministration)}>
    <ExplorerLayout label="Administration pages" pages={PAGES} selected={page} onSelect={onSelectPage} status={page === "Rooms" && roomsSummary ? roomsSummary : undefined}>
      {page === "Session" ? <ServerAdministration destination={destination} onContinue={onContinue} />
        : page === "Integrations" ? <IntegrationsPage refreshKey={refreshKey} onOpenAdministration={() => onOpenAdministration("Integrations")} />
          : page === "Rooms" ? <RoomsRepositories refreshKey={refreshKey} onOpenAdministration={() => onOpenAdministration("Rooms")} onOpenIntegrations={openIntegrations} onCountChange={setRoomsSummary} />
            : <Diagnostics onOpenAdministration={() => onOpenAdministration("Diagnostics")} />}
    </ExplorerLayout>
  </section>;
}
