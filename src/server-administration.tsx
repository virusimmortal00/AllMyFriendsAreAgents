import { useState, type ReactNode } from "react";
import { bootstrapControlPlane, controlLogin, controlLogout } from "./api";
import { refreshControlSession, useControlSession } from "./control-session";

// Dialogs outside the administration window that send the member to sign in and back.
// Internal destinations only: never navigate to a caller-supplied URL.
export type AdministrationDestination = "Manage room agents" | "Room Properties";

/**
 * The one notice shown outside the Server Administration window where an action needs
 * a server administrator. Its button opens the window's Owner login page.
 */
export function AdministratorRequired({ onSignIn, children }: { onSignIn: () => void; children?: ReactNode }) {
  return <div className="administrator-required">
    <span className="administrator-required__lock" aria-hidden="true">🔒</span>
    <span>{children ?? "Needs a server administrator."}</span>
    <button type="button" className="classic-button administration-sign-in" onClick={(event) => { event.currentTarget.focus(); onSignIn(); }}>Sign in…</button>
  </div>;
}

/** The single sign-in form: the Owner login page, and the gate on locked administration pages. */
export function ServerAdministration({ destination = null, onContinue, lockedPage }: { destination?: AdministrationDestination | null; onContinue?: (destination: AdministrationDestination) => void; lockedPage?: string }) {
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
      if (claimed) await controlLogin(username, password);
      else await bootstrapControlPlane(bootstrapSecret, username, password);
      if (destination) onContinue?.(destination);
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

  return <div className="administration-page administration-session">
    <header className="page-header">{lockedPage
      ? <><h2>🔒 {lockedPage} needs a server administrator</h2><p>Sign in with an administrator account to open this page. You stay in the room either way.</p></>
      : <><h2>Owner login</h2><p>Sign in with the server's administrator account. Your room name and membership are separate.</p></>}</header>
    <div className="administration-content">
      {!checked && !statusError ? <p role="status">Checking server administration…</p> : null}
      {statusError ? <p role="alert">{statusError}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {session ? <fieldset className="classic-group">
        <legend>Signed in</legend>
        <p>Signed in as <strong>{session.principal.username}</strong> · {session.principal.role}</p>
        <p>Session expires at <time dateTime={session.expiresAt}>{new Date(session.expiresAt).toLocaleString()}</time>.</p>
        <div className="administration-actions">
          <button type="button" className="classic-button" disabled={working} onClick={() => void signOut()}>{working ? "Signing out…" : "Sign out"}</button>
          {destination ? <button type="button" className="classic-button" onClick={() => onContinue?.(destination)}>Continue to {destination}</button> : null}
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
      {lockedPage ? null : <>
        <section className="classic-property-section"><h3>About administrator sessions</h3><p>Sessions last eight hours from sign-in. Activity does not extend them. Restarting the server ends all administrator sessions; sign in again to continue.</p><p>Signing out leaves the server claimed and keeps your room identity and membership. Ownership transfer and owner recovery remain separate local operator procedures.</p></section>
        <button type="button" className="classic-button" disabled={working} onClick={() => void refreshControlSession()}>Check session</button>
      </>}
    </div>
  </div>;
}
