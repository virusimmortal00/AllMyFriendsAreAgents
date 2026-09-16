import { useCallback, useState } from "react";
import { useControlSession } from "./control-session";
import { DialogFrame } from "./dialog-frame";
import { Diagnostics } from "./diagnostics";
import { ExplorerLayout, type ExplorerPage } from "./explorer-layout";
import { IntegrationsPage } from "./integrations";
import { RoomsRepositories } from "./rooms-repositories";
import { ServerAdministration, type AdministrationDestination } from "./server-administration";
import { VIEWS } from "./view-registry";

export type AdministrationPage = "Session" | "Integrations" | "Rooms" | "Diagnostics";

export const ADMINISTRATION_PAGES: readonly ExplorerPage<AdministrationPage>[] = [
  { key: "Session", label: "Session", icon: "🔑", description: "Claim the server, sign in, or sign out." },
  { key: "Integrations", label: "Integrations", icon: "🔌", description: "GitHub account, project repository, and OpenRouter account balance." },
  { key: "Rooms", label: "Rooms & repositories", icon: "📁", description: "Which repository each room reads from." },
  { key: "Diagnostics", label: "Diagnostics", icon: "🩺", description: "Owner-only bounded diagnostic queries." },
];

/**
 * Server → Administration…: one top-level window over the chat window for everything
 * that needs server-administrator authority, like a Windows 95 Control Panel applet.
 */
export function AdministrationWindow({ page, destination, refreshKey, active = true, returnFocusTo = null, onSelectPage, onOpenAdministration, onContinue, onClose }: {
  page: AdministrationPage;
  destination: AdministrationDestination | null;
  refreshKey: number;
  active?: boolean;
  returnFocusTo?: HTMLElement | null;
  onSelectPage: (page: AdministrationPage) => void;
  onOpenAdministration: (destination: AdministrationDestination) => void;
  onContinue: (destination: AdministrationDestination) => void;
  onClose: () => void;
}) {
  // Check the administrator session once for the whole window, whichever page it opens on.
  useControlSession();
  const [roomsSummary, setRoomsSummary] = useState("");
  const openIntegrations = useCallback(() => onSelectPage("Integrations"), [onSelectPage]);
  return <DialogFrame title="Server Administration" closeLabel="Close server administration" active={active} className="administration-dialog" backdropClassName="administration-backdrop" bodyClassName="administration-dialog-body" returnFocusTo={returnFocusTo} view={VIEWS.serverAdministration} onClose={onClose}
    actions={<button type="button" className="classic-button" onClick={onClose}>Close</button>}>
    <ExplorerLayout label="Administration pages" pages={ADMINISTRATION_PAGES} selected={page} onSelect={onSelectPage} status={page === "Rooms" && roomsSummary ? roomsSummary : undefined}>
      {page === "Session" ? <ServerAdministration destination={destination} onContinue={onContinue} />
        : page === "Integrations" ? <IntegrationsPage refreshKey={refreshKey} onOpenAdministration={() => onOpenAdministration("Integrations")} />
          : page === "Rooms" ? <RoomsRepositories refreshKey={refreshKey} onOpenAdministration={() => onOpenAdministration("Rooms")} onOpenIntegrations={openIntegrations} onCountChange={setRoomsSummary} />
            : <Diagnostics onOpenAdministration={() => onOpenAdministration("Diagnostics")} />}
    </ExplorerLayout>
  </DialogFrame>;
}
