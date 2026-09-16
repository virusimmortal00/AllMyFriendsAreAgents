import { useCallback, useEffect, useState } from "react";
import { useControlSession } from "./control-session";
import { DialogFrame } from "./dialog-frame";
import { Diagnostics } from "./diagnostics";
import { ExplorerLayout, type ExplorerPage } from "./explorer-layout";
import { IntegrationsPage } from "./integrations";
import { RoomsRepositories } from "./rooms-repositories";
import { ServerAdministration, type AdministrationDestination } from "./server-administration";
import { VIEWS } from "./view-registry";

export type AdministrationPage = "Login" | "Integrations" | "Rooms" | "Diagnostics";

export const ADMINISTRATION_PAGES: readonly (ExplorerPage<AdministrationPage> & { readonly requiresAdministrator: boolean })[] = [
  { key: "Login", label: "Owner login", icon: "🔑", requiresAdministrator: false },
  { key: "Integrations", label: "Integrations", icon: "🔌", requiresAdministrator: true },
  { key: "Rooms", label: "Rooms & repositories", icon: "📁", requiresAdministrator: true },
  { key: "Diagnostics", label: "Diagnostics", icon: "🩺", requiresAdministrator: true },
];

/**
 * Server menu: one top-level window over the chat window for everything that needs
 * server-administrator authority, like a Windows 95 Control Panel applet. The window
 * owns sign-in: administrator pages are disabled until Owner login succeeds, and pages
 * themselves never render their own sign-in controls.
 */
export function AdministrationWindow({ page, destination, refreshKey, active = true, returnFocusTo = null, onSelectPage, onContinue, onClose }: {
  page: AdministrationPage;
  destination: AdministrationDestination | null;
  refreshKey: number;
  active?: boolean;
  returnFocusTo?: HTMLElement | null;
  onSelectPage: (page: AdministrationPage) => void;
  onContinue: (destination: AdministrationDestination) => void;
  onClose: () => void;
}) {
  const { session, checked } = useControlSession();
  const [roomsSummary, setRoomsSummary] = useState("");
  const openIntegrations = useCallback(() => onSelectPage("Integrations"), [onSelectPage]);
  const requested = ADMINISTRATION_PAGES.find((candidate) => candidate.key === page) ?? ADMINISTRATION_PAGES[0];
  // Administrator pages stay disabled until sign-in; a signed-out window always shows Owner login.
  const current = requested.requiresAdministrator && !session ? ADMINISTRATION_PAGES[0] : requested;
  useEffect(() => { if (checked && current.key !== page) onSelectPage(current.key); }, [checked, current.key, page, onSelectPage]);
  const signInState = session ? `Signed in as ${session.principal.username} (${session.principal.role})` : checked ? "Not signed in. Sign in to open the other pages." : "Checking sign-in…";
  const pages = ADMINISTRATION_PAGES.map((candidate) => ({ ...candidate, disabled: candidate.requiresAdministrator && !session }));

  return <DialogFrame title="Server Administration" closeLabel="Close server administration" active={active} className="administration-dialog" backdropClassName="administration-backdrop" bodyClassName="administration-dialog-body" returnFocusTo={returnFocusTo} view={VIEWS.serverAdministration} onClose={onClose}
    actions={<button type="button" className="classic-button" onClick={onClose}>Close</button>}>
    <ExplorerLayout label="Administration pages" pages={pages} selected={current.key} onSelect={onSelectPage} status={current.key === "Rooms" && roomsSummary ? `${signInState} · ${roomsSummary}` : signInState}>
      {current.key === "Login" ? <ServerAdministration destination={destination} onContinue={onContinue} />
        : current.key === "Integrations" ? <IntegrationsPage refreshKey={refreshKey} />
          : current.key === "Rooms" ? <RoomsRepositories refreshKey={refreshKey} onOpenIntegrations={openIntegrations} onCountChange={setRoomsSummary} />
            : <Diagnostics />}
    </ExplorerLayout>
  </DialogFrame>;
}
