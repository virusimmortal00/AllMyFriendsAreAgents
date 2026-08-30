import { useCallback, useEffect, useState } from "react";
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
import { DialogFrame } from "./dialog-frame";
import { VIEWS } from "./view-registry";

type ControlStatus = { claimed: boolean; bootstrapConfigured: boolean };

// GitHub mark from Primer Octicons: https://primer.style/octicons/icon/mark-github-24/
function GitHubMark({ size = 24 }: { size?: number }) {
  return <svg aria-hidden="true" className="github-mark" width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <path d="M10.226 17.284c-2.965-.36-5.054-2.493-5.054-5.256 0-1.123.404-2.336 1.078-3.144-.292-.741-.247-2.314.09-2.965.898-.112 2.111.36 2.83 1.01.853-.269 1.752-.404 2.853-.404 1.1 0 1.999.135 2.807.382.696-.629 1.932-1.1 2.83-.988.315.606.36 2.179.067 2.942.72.854 1.101 2 1.101 3.167 0 2.763-2.089 4.852-5.098 5.234.763.494 1.28 1.572 1.28 2.807v2.336c0 .674.561 1.056 1.235.786 4.066-1.55 7.255-5.615 7.255-10.646C23.5 6.188 18.334 1 11.978 1 5.62 1 .5 6.188.5 12.545c0 4.986 3.167 9.12 7.435 10.669.606.225 1.19-.18 1.19-.786V20.63a2.9 2.9 0 0 1-1.078.224c-1.483 0-2.359-.808-2.987-2.313-.247-.607-.517-.966-1.034-1.033-.27-.023-.359-.135-.359-.27 0-.27.45-.471.898-.471.652 0 1.213.404 1.797 1.235.45.651.921.943 1.483.943.561 0 .92-.202 1.437-.719.382-.381.674-.718.944-.943" />
  </svg>;
}

export function GitHubIntegrationDialog({ returnFocusTo, onClose }: { returnFocusTo: HTMLElement | null; onClose: () => void }) {
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
  const projectRepository = project?.binding?.repository || project?.repository.repository;
  const projectRepositoryPath = projectRepository?.replace(/^(?:https?:\/\/)?github\.com\//i, "");
  const repositoryCount = catalog?.repositories.length || 0;
  const requestClose = () => { if (!working) onClose(); };
  const currentView = authentication === "required" && controlStatus
    ? controlStatus.claimed ? VIEWS.githubAdminSignIn : VIEWS.githubClaimOwner
    : authorization?.state === "authorizing"
      ? VIEWS.githubDeviceAuth
      : !readyConnection
        ? VIEWS.githubConnect
        : project?.repository.configured
          ? VIEWS.githubConfiguredRepo
          : project && repositoryCount === 0
            ? VIEWS.githubEmptyRepo
            : VIEWS.githubChooseRepo;

  return <DialogFrame title="GitHub" closeLabel="Close GitHub integration" closeDisabled={working} className="github-integration-window" backdropClassName="room-settings-backdrop" bodyClassName="github-integration-body" returnFocusTo={returnFocusTo} onClose={requestClose} view={currentView} actions={<button type="button" className="classic-button" disabled={working} onClick={requestClose}>Close</button>}>
        {loading || authentication === "checking" ? <p role="status">Loading GitHub integration…</p> : null}
        {error ? <p role="alert" className="room-settings-error">{error}</p> : null}
        {authentication === "required" && controlStatus ? <form className="github-control-login" onSubmit={(event) => { event.preventDefault(); if (authenticationReady) void authenticate(); }}>
          <h3>{controlStatus.claimed ? "Server administrator sign in" : "Claim server owner"}</h3>
          <p>{controlStatus.claimed ? "Sign in to manage this server's GitHub connection." : "Create the administrator account that will manage this server."}</p>
          {!controlStatus.claimed ? <label>Local bootstrap secret<input type="password" autoComplete="off" value={bootstrapSecret} onChange={(event) => setBootstrapSecret(event.target.value)} disabled={!controlStatus.bootstrapConfigured} /></label> : null}
          <label>Username<input autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} /></label>
          <label>Password<input type="password" autoComplete={controlStatus.claimed ? "current-password" : "new-password"} value={password} onChange={(event) => setPassword(event.target.value)} /></label>
          {!controlStatus.claimed && !controlStatus.bootstrapConfigured ? <p role="alert">A local operator must configure the one-time owner bootstrap secret before this server can be claimed.</p> : null}
          <button type="submit" className="classic-button" disabled={!authenticationReady || working}>{working ? "Authenticating…" : controlStatus.claimed ? "Sign in" : "Claim owner"}</button>
        </form> : null}
        {authentication === "ready" && integration ? <>
          <fieldset className="github-integration-card classic-group">
            <legend>GitHub account</legend>
            <div className="github-account-summary">
              <span className="github-brand-mark"><GitHubMark size={32} /></span>
              <span className="github-account-copy"><h3>{readyConnection ? "GitHub connected" : "Connect GitHub"}</h3><p>{readyConnection ? <>Signed in as <strong>@{readyConnection.githubUser.login}</strong></> : "Connect your account to choose a repository for this project."}</p></span>
              {readyConnection ? <span className="classic-status">Connected</span> : integration.app ? <button type="button" className="classic-button github-connect-button" disabled={working} onClick={() => void connect()}>{working ? "Starting…" : "Connect GitHub"}</button> : null}
            </div>
            {!integration.app ? <p role="alert">GitHub connections are unavailable in this build.</p> : null}
            {integration.app && readyConnection ? <a className="classic-link github-secondary-link" href={`https://github.com/apps/${integration.app.slug}/installations/new`} target="_blank" rel="noreferrer">Manage repository access</a> : null}
            {authorization?.state === "authorizing" && authorization.challenge ? <div className="github-device-challenge" role="status">
              <span><strong>Enter code {authorization.challenge.userCode}</strong><small>Enter this code only at github.com. This window updates automatically.</small></span>
              <a className="classic-button" href={authorization.challenge.verificationUri} target="_blank" rel="noreferrer">Continue on GitHub</a>
            </div> : authorization && authorization.state !== "ready" ? <p role="alert">GitHub connection {authorization.state.replaceAll("-", " ")}.</p> : null}
          </fieldset>
          {readyConnection && project ? <fieldset className="github-integration-card classic-group">
            <legend>Project repository</legend>
            {!project.repository.configured ? <div className="github-card-heading"><small>{repositoryCount} {repositoryCount === 1 ? "repository" : "repositories"} available</small><button type="button" className="classic-button github-refresh-button" disabled={working} onClick={() => void refreshCatalog(readyConnection)}>{working ? "Refreshing…" : "Refresh"}</button></div> : null}
            {project.repository.configured && projectRepositoryPath ? <div className="github-repository-summary classic-summary">
              <span className="github-repository-icon" aria-hidden="true" />
              <span><a className="classic-link" href={`https://github.com/${projectRepositoryPath}`} target="_blank" rel="noreferrer">{projectRepositoryPath}</a><small>Used by every room in this project.</small></span>
              <span className="classic-status">Configured</span>
            </div> : catalog?.repositories.length ? <>
              <label>Repository<select value={selectedRepositoryId} onChange={(event) => setSelectedRepositoryId(event.target.value)}>{catalog.repositories.map((repository) => <option key={repository.githubRepositoryId} value={repository.githubRepositoryId}>{repository.owner}/{repository.name} · {repository.visibility}</option>)}</select></label>
              {!project.defaults ? <p role="alert">This project is not ready to configure a repository.</p> : null}
              <button type="button" className="classic-button github-use-repository-button" disabled={!selectedRepository || !project.defaults || working} onClick={() => void configureProject()}>{working ? "Configuring…" : "Use repository"}</button>
            </> : <div className="github-empty-repositories classic-summary"><p><strong>No repositories available.</strong><small>Choose which repositories this app can access, then refresh.</small></p>{integration.app ? <a className="classic-button" href={`https://github.com/apps/${integration.app.slug}/installations/new`} target="_blank" rel="noreferrer">Choose repositories on GitHub</a> : null}</div>}
          </fieldset> : null}
        </> : null}
  </DialogFrame>;
}
