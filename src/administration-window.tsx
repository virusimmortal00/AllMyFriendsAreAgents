import { useCallback, useState } from "react";
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
 * owns sign-in: signed out, administrator pages open as disabled previews, and pages
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
  const current = ADMINISTRATION_PAGES.find((candidate) => candidate.key === page) ?? ADMINISTRATION_PAGES[0];
  // Signed out, administrator pages still open as read-only previews: every control is disabled.
  const preview = current.requiresAdministrator && !session;
  const signInState = session ? `Signed in as ${session.principal.username} (${session.principal.role})` : checked ? "Not signed in. Other pages are previews until you sign in on Owner login." : "Checking sign-in…";
  const content = current.key === "Integrations" ? <IntegrationsPage refreshKey={refreshKey} />
    : current.key === "Rooms" ? <RoomsRepositories refreshKey={refreshKey} onOpenIntegrations={openIntegrations} onCountChange={setRoomsSummary} />
      : <Diagnostics />;

  return <DialogFrame title="Server Administration" closeLabel="Close server administration" active={active} className="administration-dialog" backdropClassName="administration-backdrop" bodyClassName="administration-dialog-body" returnFocusTo={returnFocusTo} view={VIEWS.serverAdministration} onClose={onClose}
    actions={<button type="button" className="classic-button" onClick={onClose}>Close</button>}>
    <ExplorerLayout label="Administration pages" pages={ADMINISTRATION_PAGES} selected={current.key} onSelect={onSelectPage} status={current.key === "Rooms" && roomsSummary && !preview ? `${signInState} · ${roomsSummary}` : signInState}>
      {current.key === "Login" ? <ServerAdministration destination={destination} onContinue={onContinue} />
        : preview ? <fieldset className="administration-preview" disabled aria-describedby="administration-preview-note">
          <p id="administration-preview-note" className="administration-preview__note"><span aria-hidden="true">🔒</span> Preview only. Sign in on <strong>Owner login</strong> to use this page.</p>
          {content}
        </fieldset>
          : content}
    </ExplorerLayout>
  </DialogFrame>;
}
