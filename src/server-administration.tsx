import { useState } from "react";
import { bootstrapControlPlane, controlLogin, controlLogout } from "./api";
import { refreshControlSession, useControlSession } from "./control-session";
import { VIEWS, viewAttributes } from "./view-registry";

// Internal destinations only: never navigate to a caller-supplied URL.
export type AdministrationDestination = "Diagnostics" | "GitHub" | "Manage room agents" | "Room Properties";

export function AdministrationEntry({ onOpen, disabled = false }: { onOpen: () => void; disabled?: boolean }) {
  const { status, session, checked, error } = useControlSession();
  return <fieldset className="classic-group administration-entry">
    <legend>Server administration</legend>
    <p>{error || (!checked ? "Checking server administration…" : session ? <>Signed in as <strong>{session.principal.username}</strong> · {session.principal.role}</> : status?.claimed ? "Server claimed. You are signed out of server administration." : "This server has not been claimed.")}</p>
    <button type="button" className="classic-button" disabled={disabled} onClick={onOpen}>Open server administration</button>
  </fieldset>;
}

export function AdministrationSignIn({ onOpen }: { onOpen: () => void }) {
  return <button type="button" className="classic-button administration-sign-in" onClick={(event) => { event.currentTarget.focus(); onOpen(); }}>Sign in to server administration</button>;
}

export function ServerAdministration({ destination, onContinue }: { destination: AdministrationDestination | null; onContinue: (destination: AdministrationDestination) => void }) {
  const { status, session, checked, error: statusError } = useControlSession();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [bootstrapSecret, setBootstrapSecret] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const claimed = status?.claimed;
  const canAuthenticate = status && /^[A-Za-z0-9][A-Za-z0-9._-]{2,47}$/.test(username) && password.length >= 12 && password.length <= 256 && (claimed || (status.bootstrapConfigured && bootstrapSecret.trim()));

  async function authenticate() {
    if (!canAuthenticate || working) return;
    setWorking(true); setError("");
    try {
      const authenticated = claimed ? await controlLogin(username, password) : await bootstrapControlPlane(bootstrapSecret, username, password);
      if (destination && (destination !== "Diagnostics" || authenticated.principal.role === "OWNER")) onContinue(destination);
    } catch {
      setError("Could not sign in or claim the server. Check your credentials and server status, then try again.");
      await refreshControlSession();
    } finally { setPassword(""); setBootstrapSecret(""); setWorking(false); }
  }

  async function signOut() {
    setWorking(true); setError("");
    try { await controlLogout(); }
    catch {
      setError("Sign-out could not be confirmed. Check the session and try again.");
      await refreshControlSession();
    } finally { setWorking(false); }
  }

  return <section className="workspace-view administration-workspace classic-scrollbars" aria-label="Server administration" {...viewAttributes(VIEWS.serverAdministration)}>
    <header className="workspace-view__header"><h2>Server administration</h2><p>Manage this server using your durable administrator account. Your room name and membership are separate.</p></header>
    <div className="workspace-view__body"><div className="workspace-content administration-content">
      {!checked && !statusError ? <p role="status">Checking server administration…</p> : null}
      {statusError ? <p role="alert">{statusError}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {session ? <fieldset className="classic-group">
        <legend>Administrator session</legend>
        <p>Signed in as <strong>{session.principal.username}</strong></p>
        <p>Role: <strong>{session.principal.role}</strong></p>
        <p>Session expires at <time dateTime={session.expiresAt}>{new Date(session.expiresAt).toLocaleString()}</time>.</p>
        {destination === "Diagnostics" && session.principal.role !== "OWNER" ? <p role="alert">Diagnostics requires the OWNER role. Sign out and sign in with the owner account.</p> : null}
        <div className="administration-actions">
          <button type="button" className="classic-button" disabled={working} onClick={() => void signOut()}>{working ? "Signing out…" : "Sign out"}</button>
          {destination && (destination !== "Diagnostics" || session.principal.role === "OWNER") ? <button type="button" className="classic-button" onClick={() => onContinue(destination)}>Continue to {destination}</button> : null}
          {!destination && session.principal.role === "OWNER" ? <button type="button" className="classic-button" onClick={() => onContinue("Diagnostics")}>Open Diagnostics</button> : null}
        </div>
      </fieldset> : checked && status && !statusError ? <form onSubmit={(event) => { event.preventDefault(); void authenticate(); }}>
        <fieldset className="classic-group administration-form" disabled={working}>
          <legend>{claimed ? "Administrator sign in" : "Claim server owner"}</legend>
          <p>{claimed ? "This server is claimed. Sign in with your administrator username and password." : "This server is unclaimed. A local operator can create its first owner account using the configured bootstrap secret."}</p>
          {!claimed && !status.bootstrapConfigured ? <p role="alert">A local operator must configure the one-time owner bootstrap secret on the server before it can be claimed.</p> : null}
          {!claimed ? <label>Local bootstrap secret<input className="classic-input" type="password" autoComplete="off" value={bootstrapSecret} onChange={(event) => setBootstrapSecret(event.target.value)} disabled={!status.bootstrapConfigured} /></label> : null}
          <label>Username<input className="classic-input" autoComplete="username" value={username} maxLength={48} onChange={(event) => setUsername(event.target.value)} /></label>
          <label>Password<input className="classic-input" type="password" autoComplete={claimed ? "current-password" : "new-password"} value={password} maxLength={256} onChange={(event) => setPassword(event.target.value)} /></label>
          {!claimed ? <small>Use a 3–48 character username (letters, numbers, dots, underscores, or hyphens) and a 12–256 character password.</small> : null}
          <button type="submit" className="classic-button" disabled={!canAuthenticate}>{working ? "Authenticating…" : claimed ? "Sign in" : "Claim owner"}</button>
        </fieldset>
      </form> : null}
      <section className="classic-property-section"><h3>About administrator sessions</h3><p>Sessions last eight hours from sign-in. Activity does not extend them. Restarting the server ends all administrator sessions; sign in again to continue.</p><p>Signing out leaves the server claimed and keeps your room identity and membership. Ownership transfer and owner recovery remain separate local operator procedures.</p></section>
      <button type="button" className="classic-button" disabled={working} onClick={() => void refreshControlSession()}>Check session</button>
    </div></div>
  </section>;
}
