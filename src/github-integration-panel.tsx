import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiRequestError,
  configureCurrentProjectGitHubRepository,
  loadCurrentProjectGitHubStatus,
  repairCurrentProjectGitHubRepository,
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
import { GitHubMark } from "./github-mark";
import { useControlSession } from "./control-session";
import { VIEWS, viewAttributes } from "./view-registry";
import type { RepairProjectRepositoryInput } from "../shared/project-repository-repair";

/**
 * GitHub's account/project-repository connection, as a section of the shared server-admin
 * Integrations page (`src/integrations.tsx`). Formerly a standalone modal dialog reached
 * from the Room menu; its content and control-session gate are unchanged, only the chrome.
 */
export function GitHubIntegrationPanel() {
  const { session, checked, error: sessionError } = useControlSession();
  const authentication = !checked ? "checking" : session ? "ready" : "required";
  const dashboardRequest = useRef(0);
  const [integration, setIntegration] = useState<GitHubIntegrationStatus>();
  const [catalog, setCatalog] = useState<GitHubRepositoryCatalog>();
  const [project, setProject] = useState<CurrentProjectGitHubStatus>();
  const [authorization, setAuthorization] = useState<GitHubDeviceAuthorization>();
  const [selectedRepositoryId, setSelectedRepositoryId] = useState("");
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [repairPaths, setRepairPaths] = useState({ checkoutPath: "", worktreeRoot: "" });
  const [repairRequest, setRepairRequest] = useState<RepairProjectRepositoryInput>();
  const [repairMessage, setRepairMessage] = useState("");
  const readyConnection = integration?.connections.find((connection) => connection.state === "ready");

  const loadDashboard = useCallback(async () => {
    const request = ++dashboardRequest.current;
    setPermissionDenied(false);
    setLoading(true);
    setError("");
    try {
      const nextIntegration = await loadGitHubIntegration();
      const connection = nextIntegration.connections.find((candidate) => candidate.state === "ready");
      const [nextProject, nextCatalog] = await Promise.all([
        loadCurrentProjectGitHubStatus().catch((failure) => failure instanceof ApiRequestError && failure.status === 404 ? undefined : Promise.reject(failure)),
        connection ? loadGitHubRepositoryCatalog(connection.connectionId).catch((failure) => failure instanceof ApiRequestError && failure.status === 404 ? undefined : Promise.reject(failure)) : Promise.resolve(undefined),
      ]);
      if (request !== dashboardRequest.current) return;
      setIntegration(nextIntegration);
      setProject(nextProject);
      setRepairPaths((current) => current.checkoutPath ? current : { checkoutPath: nextProject?.defaults?.checkoutPath || "", worktreeRoot: nextProject?.defaults?.worktreeRoot || "" });
      setCatalog(nextCatalog);
      setSelectedRepositoryId((current) => current || String(nextCatalog?.repositories[0]?.githubRepositoryId || ""));
    } catch (failure) {
      if (request === dashboardRequest.current) {
        setPermissionDenied(failure instanceof ApiRequestError && failure.status === 403);
        setError(failure instanceof Error ? failure.message : "GitHub integration settings could not be loaded.");
      }
    } finally { if (request === dashboardRequest.current) setLoading(false); }
  }, []);

  useEffect(() => {
    setIntegration(undefined); setCatalog(undefined); setProject(undefined); setAuthorization(undefined); setSelectedRepositoryId(""); setWorking(false);
    if (session) void loadDashboard();
    else setLoading(false);
    return () => { dashboardRequest.current++; };
  }, [session?.principal.id, session?.principal.revision, session?.expiresAt, loadDashboard]);

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

  async function connect() {
    if (working) return;
    setWorking(true);
    setError("");
    const request = dashboardRequest.current;
    try { const next = await startGitHubDeviceAuthorization(); if (request === dashboardRequest.current) setAuthorization(next); }
    catch (failure) { if (request === dashboardRequest.current) { setPermissionDenied(failure instanceof ApiRequestError && failure.status === 403); setError(failure instanceof Error ? failure.message : "GitHub authorization could not be started."); } }
    finally { setWorking(false); }
  }

  async function refreshCatalog(connection: GitHubIntegrationConnection) {
    if (working) return;
    setWorking(true);
    setError("");
    const request = dashboardRequest.current;
    try {
      const next = await refreshGitHubRepositoryCatalog(connection.connectionId, catalog?.revision || 0);
      if (request !== dashboardRequest.current) return;
      setCatalog(next);
      setSelectedRepositoryId((current) => current || String(next.repositories[0]?.githubRepositoryId || ""));
    } catch (failure) { if (request === dashboardRequest.current) { setPermissionDenied(failure instanceof ApiRequestError && failure.status === 403); setError(failure instanceof Error ? failure.message : "GitHub repositories could not be refreshed."); } }
    finally { setWorking(false); }
  }

  async function configureProject() {
    if (!readyConnection || !project?.defaults || !selectedRepositoryId || working) return;
    setWorking(true);
    setError("");
    const request = dashboardRequest.current;
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
      if (request === dashboardRequest.current) setProject({ ...next, defaults: project.defaults });
    } catch (failure) { if (request === dashboardRequest.current) { setPermissionDenied(failure instanceof ApiRequestError && failure.status === 403); setError(failure instanceof Error ? failure.message : "The project repository could not be configured."); } }
    finally { setWorking(false); }
  }

  async function repairProject() {
    if (working || !project?.binding || !project.repository.revision) return;
    const input = repairRequest || { ...repairPaths, expectedBindingRevision: project.binding.revision,
      expectedRepositoryRevision: project.repository.revision, idempotencyKey: crypto.randomUUID() };
    setRepairRequest(input);
    setWorking(true); setError(""); setRepairMessage("");
    const request = dashboardRequest.current;
    try {
      await repairCurrentProjectGitHubRepository(input);
      if (request !== dashboardRequest.current) return;
      setRepairRequest(undefined);
      setRepairMessage("Repository paths repaired. Start a new /gh request in the room.");
      await loadDashboard();
    } catch (failure) {
      if (request !== dashboardRequest.current) return;
      if (failure instanceof ApiRequestError && (failure.status === 409 || failure.status === 422)) {
        setRepairRequest(undefined);
        if (failure.status === 409) await loadDashboard();
      }
      setPermissionDenied(failure instanceof ApiRequestError && failure.status === 403);
      setError(failure instanceof Error ? failure.message : "Repair could not be confirmed. Retry the same repair request.");
    } finally { setWorking(false); }
  }

  const selectedRepository = catalog?.repositories.find((repository) => String(repository.githubRepositoryId) === selectedRepositoryId);
  const projectRepository = project?.binding?.repository || project?.repository.repository;
  const projectRepositoryPath = projectRepository?.replace(/^(?:https?:\/\/)?github\.com\//i, "");
  const repositoryCount = catalog?.repositories.length || 0;
  const currentView = authorization?.state === "authorizing"
      ? VIEWS.githubDeviceAuth
      : !readyConnection
        ? VIEWS.githubConnect
        : project?.repository.configured
          ? project.readiness?.authority === "unverified" ? VIEWS.githubRepairRepo : VIEWS.githubConfiguredRepo
          : project && repositoryCount === 0
            ? VIEWS.githubEmptyRepo
            : VIEWS.githubChooseRepo;

  return <section className="integrations-section github-integration-panel" aria-labelledby="integrations-github-heading" {...viewAttributes(currentView)}>
    <h3 id="integrations-github-heading" className="integrations-section__heading"><GitHubMark size={14} /> GitHub</h3>
    {loading || authentication === "checking" ? <p role="status">Loading GitHub integration…</p> : null}
    {error ? <p role="alert" className="room-settings-error">{error}</p> : null}
    {repairMessage ? <p role="status">{repairMessage}</p> : null}
    {authentication === "ready" && permissionDenied ? <p>Your administrator account does not have permission to manage GitHub. Ask the server owner.</p> : null}
    {sessionError ? <p role="alert">{sessionError}</p> : null}
    {authentication === "required" ? <p role="status">Server administrator sign-in required.</p> : null}
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
          <span className="github-brand-mark"><GitHubMark size={20} /></span>
          <span><a className="classic-link" href={`https://github.com/${projectRepositoryPath}`} target="_blank" rel="noreferrer">{projectRepositoryPath}</a><small>Used by every room in this project.</small></span>
          <span className="classic-status" data-attention={project.readiness?.authority === "unverified"}>{project.readiness?.authority === "verified" ? "Repository verified" : project.readiness?.authority === "unverified" ? "Needs repair" : "Configured"}</span>
        </div> : catalog?.repositories.length ? <>
          <label>Repository<select className="classic-select" value={selectedRepositoryId} onChange={(event) => setSelectedRepositoryId(event.target.value)}>{catalog.repositories.map((repository) => <option key={repository.githubRepositoryId} value={repository.githubRepositoryId}>{repository.owner}/{repository.name} · {repository.visibility}</option>)}</select></label>
          {!project.defaults ? <p role="alert">This project is not ready to configure a repository.</p> : null}
          <button type="button" className="classic-button github-use-repository-button" disabled={!selectedRepository || !project.defaults || working} onClick={() => void configureProject()}>{working ? "Configuring…" : "Use repository"}</button>
        </> : <div className="github-empty-repositories classic-summary"><p><strong>No repositories available.</strong><small>Choose which repositories this app can access, then refresh.</small></p>{integration.app ? <a className="classic-button" href={`https://github.com/apps/${integration.app.slug}/installations/new`} target="_blank" rel="noreferrer">Choose repositories on GitHub</a> : null}</div>}
        {project.repository.configured ? <div className="github-repair">
          {project.readiness?.authority === "unverified" ? <>
            <p role="status">The saved repository could not be verified. After a server move, repair its paths here. Signing in to GitHub does not update them.</p>
            {project.readiness.state === "available" ? <>
              <p>Use a standalone checkout on the configured default branch. These paths are on the server.</p>
              <label>Checkout path<input className="classic-input" value={repairPaths.checkoutPath} disabled={working || Boolean(repairRequest)} onChange={(event) => setRepairPaths({ ...repairPaths, checkoutPath: event.target.value })} /></label>
              <label>Assignment worktree root<input className="classic-input" value={repairPaths.worktreeRoot} disabled={working || Boolean(repairRequest)} onChange={(event) => setRepairPaths({ ...repairPaths, worktreeRoot: event.target.value })} /></label>
              {session?.principal.role === "OWNER" || session?.principal.capabilities.includes("PROJECT_REPOSITORY_CONFIGURE") ? <button type="button" className="classic-button" disabled={working || !repairPaths.checkoutPath || !repairPaths.worktreeRoot} onClick={() => void repairProject()}>{working ? "Repairing…" : repairRequest ? "Retry repair" : "Repair repository paths"}</button> : <p>An administrator with repository configuration permission must apply the repair.</p>}
              {repairRequest && !working ? <p>The outcome is unconfirmed. Retry uses the same paths and request.</p> : null}
            </> : <p role="alert">{project.readiness.state === "blocked" ? "Repair is blocked. Check GitHub credential availability and finish or reconcile outstanding repository work." : "Repair requires an enabled repository and its matching GitHub connection."}</p>}
          </> : null}
          <button type="button" className="classic-button" disabled={working || loading || Boolean(repairRequest)} onClick={() => void loadDashboard()}>Check repository status</button>
        </div> : null}
      </fieldset> : null}
    </> : null}
  </section>;
}
