import { useCallback, useState } from "react";
import { ConfirmationDialog } from "./components";
import { useControlSession } from "./control-session";
import { DialogFrame } from "./dialog-frame";
import { Diagnostics } from "./diagnostics";
import { ExplorerLayout, type ExplorerPage } from "./explorer-layout";
import { IntegrationsPage } from "./integrations";
import { RoomsRepositories } from "./rooms-repositories";
import { RoomConfigurationPanel } from "./room-configuration-dialog";
import { ServerAdministration, type AdministrationDestination } from "./server-administration";
import { VIEWS, viewAttributes } from "./view-registry";

export type AdministrationPage = "Login" | "Integrations" | "Rooms" | "RoomBehavior" | "Diagnostics";

export const ADMINISTRATION_PAGES = [
  { key: "Login", label: "Owner login", icon: "🔑", requiresAdministrator: false },
  { key: "Integrations", label: "Integrations", icon: "🔌", requiresAdministrator: true },
  { key: "Rooms", label: "Rooms & repositories", icon: "📁", requiresAdministrator: true },
  { key: "RoomBehavior", label: "Room behavior", icon: "🤖", requiresAdministrator: true },
  { key: "Diagnostics", label: "Diagnostics", icon: "🩺", requiresAdministrator: true },
] as const satisfies readonly [
  ExplorerPage<AdministrationPage> & { readonly requiresAdministrator: boolean },
  ...(ExplorerPage<AdministrationPage> & { readonly requiresAdministrator: boolean })[],
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
  const [roomBehaviorDirty, setRoomBehaviorDirty] = useState(false);
  const [pendingNavigation, setPendingNavigation] = useState<AdministrationPage | "close" | null>(null);
  const requestPage = useCallback((nextPage: AdministrationPage) => {
    if (nextPage === page) return;
    if (roomBehaviorDirty) {
      setPendingNavigation(nextPage);
      return;
    }
    onSelectPage(nextPage);
  }, [onSelectPage, page, roomBehaviorDirty]);
  const requestClose = useCallback(() => {
    if (roomBehaviorDirty) {
      setPendingNavigation("close");
      return;
    }
    onClose();
  }, [onClose, roomBehaviorDirty]);
  const discardAndContinue = useCallback(() => {
    const next = pendingNavigation;
    setPendingNavigation(null);
    setRoomBehaviorDirty(false);
    if (next === "close") onClose();
    else if (next) onSelectPage(next);
  }, [onClose, onSelectPage, pendingNavigation]);
  const openIntegrations = useCallback(() => requestPage("Integrations"), [requestPage]);
  const current = ADMINISTRATION_PAGES.find((candidate) => candidate.key === page) ?? ADMINISTRATION_PAGES[0];
  // Signed out, administrator pages still open as read-only previews: every control is disabled.
  const preview = current.requiresAdministrator && !session;
  const signInState = session ? `Signed in as ${session.principal.username} (${session.principal.role})` : checked ? "Not signed in · other pages are previews" : "Checking sign-in…";
  const content = current.key === "Integrations" ? <IntegrationsPage refreshKey={refreshKey} />
    : current.key === "Rooms" ? <RoomsRepositories refreshKey={refreshKey} onOpenIntegrations={openIntegrations} onCountChange={setRoomsSummary} />
      : current.key === "RoomBehavior" ? <section className="administration-page administration-room-behavior" {...viewAttributes(VIEWS.roomAgentBehavior)}>
        <header className="page-header"><h2>Room behavior</h2><p>Administrator-managed prompts, summarization, and agent routing for this room.</p></header>
        <RoomConfigurationPanel active onClose={requestClose} onSaved={onClose} onDirtyChange={setRoomBehaviorDirty} />
      </section>
      : <Diagnostics />;

  return <>
    <DialogFrame title="Server Administration" closeLabel="Close server administration" active={active} className="administration-dialog" backdropClassName="administration-backdrop" bodyClassName="administration-dialog-body" returnFocusTo={returnFocusTo} view={VIEWS.serverAdministration} onClose={requestClose}
      actions={<button type="button" className="classic-button" onClick={requestClose}>Close</button>}>
      <ExplorerLayout label="Administration pages" pages={ADMINISTRATION_PAGES} selected={current.key} onSelect={requestPage} status={current.key === "Rooms" && roomsSummary && !preview ? `${signInState} · ${roomsSummary}` : signInState}>
      {current.key === "Login" ? <ServerAdministration destination={destination} onContinue={onContinue} />
        : preview ? <fieldset className="administration-preview" disabled aria-describedby="administration-preview-note">
          <p id="administration-preview-note" className="administration-preview__note"><span aria-hidden="true">🔒</span> Preview only. Sign in on <strong>Owner login</strong> to use this page.</p>
          {content}
        </fieldset>
          : content}
      </ExplorerLayout>
    </DialogFrame>
    {pendingNavigation ? <ConfirmationDialog
      title="Discard room behavior changes?"
      description={<p>Your unsaved room behavior changes will be lost. Choose Cancel to keep editing.</p>}
      confirmLabel="Discard changes"
      returnFocusTo={null}
      view={VIEWS.unsavedChangesConfirmation}
      onConfirm={discardAndContinue}
      onCancel={() => setPendingNavigation(null)}
    /> : null}
  </>;
}
