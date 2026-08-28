import { useCallback, useEffect, useId, useState } from "react";
import {
  ApiRequestError,
  bootstrapControlPlane,
  configureCurrentProjectGitHubRepository,
  controlLogin,
  loadControlMe,
  loadControlStatus,
  loadCurrentProjectGitHubStatus,
  loadGitHubIntegration,
  loadGitHubRepositoryCatalog,
  pollGitHubDeviceAuthorization,
  refreshGitHubRepositoryCatalog,
  startGitHubDeviceAuthorization,
  type CurrentProjectGitHubStatus,
  type GitHubDeviceAuthorization,
  type GitHubIntegrationConnection,
  type GitHubIntegrationStatus,
  type GitHubRepositoryCatalog,
} from "./api";
import { useModalOverlay } from "./overlay";

type ControlStatus = { claimed: boolean; bootstrapConfigured: boolean };

export function GitHubIntegrationDialog({ returnFocusTo, onClose }: { returnFocusTo: HTMLElement | null; onClose: () => void }) {
  const titleId = useId();
  const [authentication, setAuthentication] = useState<"checking" | "required" | "ready">("checking");
  const [controlStatus, setControlStatus] = useState<ControlStatus>();
  const [bootstrapSecret, setBootstrapSecret] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [integration, setIntegration] = useState<GitHubIntegrationStatus>();
  const [catalog, setCatalog] = useState<GitHubRepositoryCatalog>();
  const [project, setProject] = useState<CurrentProjectGitHubStatus>();
  const [authorization, setAuthorization] = useState<GitHubDeviceAuthorization>();
  const [selectedRepositoryId, setSelectedRepositoryId] = useState("");
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const { dialogRef, onDialogKeyDown, onBackdropMouseDown } = useModalOverlay(onClose, returnFocusTo);
  const readyConnection = integration?.connections.find((connection) => connection.state === "ready");

  const loadDashboard = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const nextIntegration = await loadGitHubIntegration();
      const connection = nextIntegration.connections.find((candidate) => candidate.state === "ready");
      const [nextProject, nextCatalog] = await Promise.all([
        loadCurrentProjectGitHubStatus().catch((failure) => failure instanceof ApiRequestError && failure.status === 404 ? undefined : Promise.reject(failure)),
        connection ? loadGitHubRepositoryCatalog(connection.connectionId).catch((failure) => failure instanceof ApiRequestError && failure.status === 404 ? undefined : Promise.reject(failure)) : Promise.resolve(undefined),
      ]);
      setIntegration(nextIntegration);
      setProject(nextProject);
      setCatalog(nextCatalog);
      setSelectedRepositoryId((current) => current || String(nextCatalog?.repositories[0]?.githubRepositoryId || ""));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "GitHub integration settings could not be loaded.");
    } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    let current = true;
    void loadControlMe().then(async () => {
      if (!current) return;
      setAuthentication("ready");
      await loadDashboard();
    }).catch(async (failure) => {
      if (!current) return;
      if (!(failure instanceof ApiRequestError) || failure.status !== 401) {
        setError(failure instanceof Error ? failure.message : "Server administration status could not be loaded.");
        setLoading(false);
        return;
      }
      try {
        const status = await loadControlStatus();
        if (!current) return;
        setControlStatus(status);
        setAuthentication("required");
      } catch (statusFailure) {
        if (current) setError(statusFailure instanceof Error ? statusFailure.message : "Server administration status could not be loaded.");
      } finally { if (current) setLoading(false); }
    });
    return () => { current = false; };
  }, [loadDashboard]);

  useEffect(() => {
    if (authorization?.state !== "authorizing" || !authorization.nextPollAt) return;
    let current = true;
    const delay = Math.max(250, new Date(authorization.nextPollAt).getTime() - Date.now() + 100);
    const timer = window.setTimeout(() => {
      void pollGitHubDeviceAuthorization(authorization.flowId).then(async (next) => {
        if (!current) return;
        setAuthorization(next);
        if (next.state === "ready") await loadDashboard();
      }).catch((failure) => { if (current) setError(failure instanceof Error ? failure.message : "GitHub authorization polling failed."); });
    }, delay);
    return () => { current = false; window.clearTimeout(timer); };
  }, [authorization, loadDashboard]);

  async function authenticate() {
    if (!controlStatus || working) return;
    setWorking(true);
    setError("");
    try {
      if (controlStatus.claimed) await controlLogin(username, password);
      else await bootstrapControlPlane(bootstrapSecret, username, password);
      setAuthentication("ready");
      await loadDashboard();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Server administrator authentication failed.");
    } finally { setWorking(false); }
  }

  async function connect() {
    if (working) return;
    setWorking(true);
    setError("");
    try { setAuthorization(await startGitHubDeviceAuthorization()); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "GitHub authorization could not be started."); }
    finally { setWorking(false); }
  }

  async function refreshCatalog(connection: GitHubIntegrationConnection) {
    if (working) return;
    setWorking(true);
    setError("");
    try {
      const next = await refreshGitHubRepositoryCatalog(connection.connectionId, catalog?.revision || 0);
      setCatalog(next);
      setSelectedRepositoryId((current) => current || String(next.repositories[0]?.githubRepositoryId || ""));
    } catch (failure) { setError(failure instanceof Error ? failure.message : "GitHub repositories could not be refreshed."); }
    finally { setWorking(false); }
  }

  async function configureProject() {
    if (!readyConnection || !project?.defaults || !selectedRepositoryId || working) return;
    setWorking(true);
    setError("");
    try {
      const next = await configureCurrentProjectGitHubRepository({
        githubConnectionId: readyConnection.connectionId,
        githubRepositoryId: Number(selectedRepositoryId),
        expectedBindingRevision: project.binding?.revision || 0,
        expectedRepositoryRevision: project.repository.revision || 0,
        checkoutPath: project.defaults.checkoutPath,
        worktreeRoot: project.defaults.worktreeRoot,
        policyRevision: project.defaults.policyRevision,
      });
      setProject({ ...next, defaults: project.defaults });
    } catch (failure) { setError(failure instanceof Error ? failure.message : "The project repository could not be configured."); }
    finally { setWorking(false); }
  }

  const authenticationReady = Boolean(controlStatus && username.trim().length >= 3 && password.length >= 12
    && (controlStatus.claimed || (controlStatus.bootstrapConfigured && bootstrapSecret.trim())));
  const selectedRepository = catalog?.repositories.find((repository) => String(repository.githubRepositoryId) === selectedRepositoryId);

  return <div className="modal-backdrop room-settings-backdrop" onMouseDown={onBackdropMouseDown}>
    <section ref={dialogRef} className="agent-settings-window github-integration-window" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onKeyDown={onDialogKeyDown}>
      <header className="agent-settings-titlebar"><h2 id={titleId}>GitHub Integration</h2><button type="button" aria-label="Close GitHub Integration" disabled={working} onClick={onClose}>×</button></header>
      <div className="github-integration-body">
        {loading || authentication === "checking" ? <p role="status">Loading GitHub integration…</p> : null}
        {error ? <p role="alert" className="room-settings-error">{error}</p> : null}
        {authentication === "required" && controlStatus ? <form className="github-control-login" onSubmit={(event) => { event.preventDefault(); if (authenticationReady) void authenticate(); }}>
          <h3>{controlStatus.claimed ? "Server administrator sign in" : "Claim server owner"}</h3>
          <p>GitHub connection and repository choices are server administration settings. Rooms inherit the selected project repository and never receive credentials.</p>
          {!controlStatus.claimed ? <label>Local bootstrap secret<input type="password" autoComplete="off" value={bootstrapSecret} onChange={(event) => setBootstrapSecret(event.target.value)} disabled={!controlStatus.bootstrapConfigured} /></label> : null}
          <label>Username<input autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} /></label>
          <label>Password<input type="password" autoComplete={controlStatus.claimed ? "current-password" : "new-password"} value={password} onChange={(event) => setPassword(event.target.value)} /></label>
          {!controlStatus.claimed && !controlStatus.bootstrapConfigured ? <p role="alert">A local operator must configure the one-time owner bootstrap secret before this server can be claimed.</p> : null}
          <button type="submit" className="classic-button" disabled={!authenticationReady || working}>{working ? "Authenticating…" : controlStatus.claimed ? "Sign in" : "Claim owner"}</button>
        </form> : null}
        {authentication === "ready" && integration ? <>
          <section className="github-integration-card" aria-labelledby="github-server-heading">
            <h3 id="github-server-heading">Server connection</h3>
            {integration.app ? <p><strong>{integration.app.name}</strong> is the reusable public App for this server. No client secret, private key, PAT, or room environment variable is required.</p> : <p role="alert">This build does not contain a reviewed GitHub App identity.</p>}
            {readyConnection ? <div className="github-status-row"><span><strong>Connected as {readyConnection.githubUser.login}</strong><small>Device-user token · encrypted locally · revision {readyConnection.revision}</small></span><span className="github-status-badge">Ready</span></div> : integration.app ? <button type="button" className="classic-button" disabled={working} onClick={() => void connect()}>{working ? "Starting…" : "Connect with GitHub"}</button> : null}
            {authorization?.state === "authorizing" && authorization.challenge ? <div className="github-device-challenge" role="status">
              <strong>Enter code {authorization.challenge.userCode}</strong>
              <a className="classic-button" href={authorization.challenge.verificationUri} target="_blank" rel="noreferrer">Open GitHub authorization</a>
              <small>This window will update automatically after GitHub approval. The code expires at {new Date(authorization.expiresAt).toLocaleTimeString()}.</small>
            </div> : authorization && authorization.state !== "ready" ? <p role="alert">GitHub authorization ended with state {authorization.state.replaceAll("-", " ")}.</p> : null}
          </section>
          {readyConnection ? <section className="github-integration-card" aria-labelledby="github-repositories-heading">
            <div className="github-card-heading"><span><h3 id="github-repositories-heading">Available repositories</h3><small>{catalog ? `${catalog.repositories.length} from ${catalog.installations.length} installation${catalog.installations.length === 1 ? "" : "s"}` : "Catalog not loaded"}</small></span><button type="button" className="classic-button" disabled={working} onClick={() => void refreshCatalog(readyConnection)}>{working ? "Refreshing…" : "Refresh"}</button></div>
            {catalog?.repositories.length ? <label>Repository<select value={selectedRepositoryId} onChange={(event) => setSelectedRepositoryId(event.target.value)} disabled={Boolean(project?.repository.configured)}>
              {catalog.repositories.map((repository) => <option key={repository.githubRepositoryId} value={repository.githubRepositoryId}>{repository.owner}/{repository.name} · {repository.visibility}</option>)}
            </select></label> : <p>Install the App on at least one repository, then refresh this catalog.</p>}
          </section> : null}
          {readyConnection && project ? <section className="github-integration-card" aria-labelledby="github-project-heading">
            <h3 id="github-project-heading">Current project</h3>
            {project.repository.configured ? <div className="github-status-row"><span><strong>{project.binding?.repository || project.repository.repository}</strong><small>Inherited by every room attached to this project. Rooms cannot override the repository or credential.</small></span><span className="github-status-badge">Verified</span></div> : <>
              <p>{selectedRepository ? `Verify this server checkout against ${selectedRepository.owner}/${selectedRepository.name}, then make it available to every room attached to the project.` : "Choose an available repository for this project."}</p>
              {project.defaults ? <dl className="github-project-defaults"><dt>Checkout</dt><dd>{project.defaults.checkoutPath}</dd><dt>Agent worktrees</dt><dd>{project.defaults.worktreeRoot}</dd></dl> : <p role="alert">This project does not publish server-derived checkout defaults yet.</p>}
              <button type="button" className="classic-button" disabled={!selectedRepository || !project.defaults || working} onClick={() => void configureProject()}>{working ? "Verifying…" : "Use for this project"}</button>
            </>}
          </section> : null}
        </> : null}
      </div>
      <footer className="agent-settings-actions"><button type="button" className="classic-button" disabled={working} onClick={onClose}>Close</button></footer>
    </section>
  </div>;
}
