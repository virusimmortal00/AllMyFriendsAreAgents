import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  ApiRequestError,
  bootstrapControlPlane,
  controlLogin,
  initiateProviderSetup,
  loadControlMe,
  loadControlStatus,
  loadRoster,
  refreshModelDiscovery,
  updateRoster,
  type RosterCatalogEntry,
  type RosterResponse,
} from "./api";
import type { RoomAgentRoster, RoomAgentRosterEntry } from "../shared/roster";
import { selectedModelAvailability, type ModelDiscoveryResult } from "../shared/model-discovery";
import { friendlyModelName, modelAuthorId, providerDisplayName } from "../shared/model-presentation";
import { ConfirmationDialog } from "./components";
import { RichModelPicker } from "./model-picker";
import { ProviderMark } from "./provider-mark";
import { AGENT_LIST_SORT_OPTIONS, agentListGroupLabel, sortAgentListItems, type AgentListSort } from "./agent-list-sort";
import { COMMAND_CATALOG_REVISION, normalizeCommandPermissions, ROOM_COMMANDS, type RoomCommandName } from "../shared/command-domain";
import type { AgentCapabilityStatus } from "../shared/capabilities";
import { DialogFrame } from "./dialog-frame";
import { VIEWS, viewAttributes } from "./view-registry";

export function RosterManagerDialog({ initialRoster, initialSelectedAgentId, agentListSort = "room", onAgentListSortChange, returnFocusTo, onSaved, onClose }: {
  initialRoster: RoomAgentRoster;
  initialSelectedAgentId?: string;
  agentListSort?: AgentListSort;
  onAgentListSortChange?: (sort: AgentListSort) => void;
  returnFocusTo: HTMLElement | null;
  onSaved: (roster: RoomAgentRoster) => void;
  onClose: () => void;
}) {
  const [baseRevision, setBaseRevision] = useState(() => positiveRosterRevision(initialRoster.revision, 1));
  const [entries, setEntries] = useState<RoomAgentRosterEntry[]>(() => [...initialRoster.entries]);
  const [savedEntries, setSavedEntries] = useState<RoomAgentRosterEntry[]>(() => [...initialRoster.entries]);
  const [catalog, setCatalog] = useState<readonly RosterCatalogEntry[]>([]);
  const [modelDiscovery, setModelDiscovery] = useState<ModelDiscoveryResult>();
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(() => initialSelectedAgentId || initialRoster.entries[0]?.agentId || null);
  const [mobilePane, setMobilePane] = useState<"list" | "detail">(() => initialSelectedAgentId || initialRoster.entries.length === 0 ? "detail" : "list");
  const [changingModelForAgentId, setChangingModelForAgentId] = useState<string | null>(null);
  const [deleteRequest, setDeleteRequest] = useState<{ agentId: string; returnFocusTo: HTMLButtonElement } | null>(null);
  const [discardRequest, setDiscardRequest] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState<RosterResponse | null>(null);
  const [newName, setNewName] = useState("");
  const [newNameError, setNewNameError] = useState("");
  const [newProvider, setNewProvider] = useState("");
  const [newModel, setNewModel] = useState("");
  const [newVariant, setNewVariant] = useState("");
  const [draftCreatedAgentIds, setDraftCreatedAgentIds] = useState<ReadonlySet<string>>(() => new Set());
  const [refreshing, setRefreshing] = useState(false);
  const [controlStatus, setControlStatus] = useState<{ claimed: boolean; bootstrapConfigured: boolean } | null>(null);
  const [controlUsername, setControlUsername] = useState("");
  const [controlPassword, setControlPassword] = useState("");
  const [bootstrapSecret, setBootstrapSecret] = useState("");
  const [setupInstruction, setSetupInstruction] = useState("");
  const [capabilityStatuses, setCapabilityStatuses] = useState<Readonly<Record<string, AgentCapabilityStatus>>>({});
  const closed = useRef(false);
  const detailPaneRef = useRef<HTMLElement>(null);
  const newNameInputRef = useRef<HTMLInputElement>(null);
  const hasDraftChanges = useMemo(() => JSON.stringify(entries) !== JSON.stringify(savedEntries), [entries, savedEntries]);
  const requestClose = () => {
    if (saving) return;
    if (hasDraftChanges) setDiscardRequest(true);
    else onClose();
  };

  useEffect(() => {
    closed.current = false;
    void loadRoster().then(async (response) => {
      if (!response.access && response.modelDiscovery) await loadControlMe();
      if (closed.current) return;
      setBaseRevision((current) => positiveRosterRevision(response.roster.revision, current));
      setEntries([...response.roster.entries]);
      setSavedEntries([...response.roster.entries]);
      setSelectedAgentId((current) => current && response.roster.entries.some((entry) => entry.agentId === current) ? current : response.roster.entries[0]?.agentId || null);
      setCatalog(response.catalog);
      setModelDiscovery(response.modelDiscovery);
      setCapabilityStatuses(response.capabilityStatuses || {});
      setError("");
    }).catch((reason) => {
      if (closed.current) return;
      if (reason instanceof ApiRequestError && reason.status === 401) {
        void loadControlStatus().then(setControlStatus).catch(() => setError("The server control plane could not be loaded."));
      } else setError(reason instanceof Error ? reason.message : "The roster could not be loaded.");
    }).finally(() => { if (!closed.current) setLoading(false); });
    return () => { closed.current = true; };
  }, []);

  const catalogById = useMemo(() => new Map(catalog.map((entry) => [entry.agentId, entry])), [catalog]);
  const duplicateNames = useMemo(() => {
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const entry of entries) {
      const name = (entry.conversationalName || catalogById.get(entry.agentId)?.conversationalName || "").trim().toLocaleLowerCase();
      if (seen.has(name)) duplicates.add(name);
      else seen.add(name);
    }
    return duplicates;
  }, [entries, catalogById]);
  const displayedEntries = useMemo(() => sortAgentListItems(entries.map((entry) => {
    const profile = catalogById.get(entry.agentId);
    const providerId = entry.providerId || profile?.provider;
    const modelId = entry.modelId || profile?.modelId || "configured";
    return {
      entry,
      agentId: entry.agentId,
      alias: entry.conversationalName || profile?.conversationalName || entry.agentId,
      providerId,
      modelId,
      authorId: modelAuthorId(providerId, modelId),
    };
  }), agentListSort), [entries, catalogById, agentListSort]);
  const discoveredModels = modelDiscovery?.models || [];
  const newSelectedModel = discoveredModels.find((model) => model.modelId === newModel && (model.providerId || "") === newProvider);
  useEffect(() => {
    if (!newSelectedModel) return;
    detailPaneRef.current?.scrollTo?.({ top: 0, left: 0 });
    newNameInputRef.current?.focus({ preventScroll: true });
  }, [newSelectedModel?.modelId, newSelectedModel?.providerId]);
  const selectedIndex = selectedAgentId ? entries.findIndex((entry) => entry.agentId === selectedAgentId) : -1;
  const selectedEntry = selectedIndex >= 0 ? entries[selectedIndex] : undefined;
  const selectedProfile = selectedEntry ? catalogById.get(selectedEntry.agentId) : undefined;
  const selectedName = selectedEntry ? selectedEntry.conversationalName || selectedProfile?.conversationalName || selectedEntry.agentId : "";
  const selectedReference = selectedEntry ? {
    ...(selectedEntry.providerId ? { providerId: selectedEntry.providerId } : {}),
    modelId: selectedEntry.modelId || selectedProfile?.modelId || "",
    ...(selectedEntry.variant || selectedEntry.reasoningEffort ? { variant: selectedEntry.variant || selectedEntry.reasoningEffort } : {}),
  } : undefined;
  const selectedModel = selectedReference ? discoveredModels.find((model) => model.modelId === selectedReference.modelId && (model.providerId || "") === (selectedReference.providerId || "")) : undefined;
  const selectedModelAvailable = Boolean(modelDiscovery && selectedReference?.modelId && selectedModelAvailability(selectedReference, modelDiscovery).available);
  const selectedCommandPermissions = selectedEntry ? normalizeCommandPermissions(selectedEntry.commandPermissions) : undefined;
  const selectedCapabilityStatus = selectedEntry ? capabilityStatuses[selectedEntry.agentId] : undefined;
  const selectedGhGate = selectedCapabilityStatus?.commands?.gh;
  const selectedGhRequested = Boolean(selectedCommandPermissions && (selectedCommandPermissions.allowAll && selectedCommandPermissions.catalogRevision === COMMAND_CATALOG_REVISION || selectedCommandPermissions.allowed.includes("gh")));
  const controlAuthenticationReady = Boolean(controlStatus && controlUsername && controlPassword.length >= 12 && (controlStatus.claimed || bootstrapSecret));

  function replaceAt(index: number, entry: RoomAgentRosterEntry) {
    setEntries((current) => current.map((value, position) => position === index ? entry : value));
    setConflict(null);
  }

  function removeAgent(agentId: string) {
    const removedIndex = entries.findIndex((entry) => entry.agentId === agentId);
    const nextEntries = entries.filter((entry) => entry.agentId !== agentId);
    setEntries(nextEntries);
    setDraftCreatedAgentIds((current) => {
      if (!current.has(agentId)) return current;
      const next = new Set(current);
      next.delete(agentId);
      return next;
    });
    if (selectedAgentId === agentId) setSelectedAgentId(nextEntries[Math.min(Math.max(removedIndex, 0), nextEntries.length - 1)]?.agentId || null);
    setConflict(null);
  }

  function useLatest() {
    if (!conflict) return;
    setBaseRevision((current) => positiveRosterRevision(conflict.roster.revision, current));
    setEntries([...conflict.roster.entries]);
    setSavedEntries([...conflict.roster.entries]);
    setCatalog(conflict.catalog);
    setModelDiscovery(conflict.modelDiscovery);
    setCapabilityStatuses(conflict.capabilityStatuses || {});
    setSelectedAgentId(conflict.roster.entries[0]?.agentId || null);
    setChangingModelForAgentId(null);
    setConflict(null);
    setError("");
  }

  async function save() {
    if (saving) return;
    if (duplicateNames.size) { setError("Conversational names must be unique (case-insensitive)."); return; }
    setSaving(true);
    setError("");
    setConflict(null);
    try {
      const response = await updateRoster(baseRevision, entries);
      setBaseRevision((current) => positiveRosterRevision(response.roster.revision, current));
      setSavedEntries([...response.roster.entries]);
      onSaved(response.roster);
      onClose();
    } catch (reason) {
      if (reason instanceof ApiRequestError && reason.status === 409 && reason.body && typeof reason.body === "object") {
        const latest = reason.body as Partial<RosterResponse>;
        if (latest.roster && Array.isArray(latest.catalog)) {
          setConflict(latest as RosterResponse);
          setError("Someone else changed the roster. Your draft is preserved; load the latest roster before editing and saving again.");
          return;
        }
      }
      setError(reason instanceof Error ? reason.message : "The roster could not be saved.");
    } finally { setSaving(false); }
  }

  async function authenticateControl() {
    setSaving(true);
    setError("");
    try {
      if (controlStatus?.claimed) await controlLogin(controlUsername, controlPassword);
      else await bootstrapControlPlane(bootstrapSecret, controlUsername, controlPassword);
      const response = await loadRoster();
      setBaseRevision((current) => positiveRosterRevision(response.roster.revision, current));
      setEntries([...response.roster.entries]);
      setSavedEntries([...response.roster.entries]);
      setSelectedAgentId(response.roster.entries[0]?.agentId || null);
      setCatalog(response.catalog);
      setModelDiscovery(response.modelDiscovery);
      setCapabilityStatuses(response.capabilityStatuses || {});
      setControlStatus(null);
      setControlPassword("");
      setBootstrapSecret("");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Control-plane authentication failed."); }
    finally { setSaving(false); }
  }

  function createParticipant() {
    const normalizedName = newName.trim().toLocaleLowerCase();
    if (entries.some((entry) => (entry.conversationalName || catalogById.get(entry.agentId)?.conversationalName || "").trim().toLocaleLowerCase() === normalizedName)) {
      setNewNameError("Agent aliases must be unique (case-insensitive).");
      return;
    }
    const agentId = `agent-${crypto.randomUUID()}`;
    setEntries((current) => [...current, {
      agentId,
      conversationalName: newName.trim(),
      ...(newProvider ? { providerId: newProvider } : {}),
      modelId: newModel,
      ...(newVariant ? { variant: newVariant } : {}),
      enabled: true,
      supportsProjectWrites: true,
      configurationRevision: 1,
    }]);
    setDraftCreatedAgentIds((current) => new Set(current).add(agentId));
    setSelectedAgentId(agentId);
    setNewName("");
    setNewNameError("");
    setNewProvider("");
    setNewModel("");
    setNewVariant("");
    setError("");
  }

  return (
    <>
      <DialogFrame title="Manage room agents" closeLabel="Close roster manager" closeDisabled={saving} className="roster-window" backdropClassName="roster-backdrop" bodyClassName={`roster-body${controlStatus ? " roster-body--authentication" : ""}`} returnFocusTo={returnFocusTo} onClose={requestClose} dataPresentation={controlStatus ? "authentication" : "roster"} view={controlStatus ? VIEWS.manageAgentsSignIn : VIEWS.manageAgentsRoster} actionsClassName="roster-actions" actions={controlStatus
        ? <button type="button" className="classic-button" disabled={saving} onClick={requestClose}>Cancel</button>
        : <><span className={`roster-actions__status${hasDraftChanges ? " roster-actions__status--dirty" : ""}`}>{hasDraftChanges ? "Unsaved roster changes" : "No unsaved changes"}</span><button type="button" className="classic-button" disabled={saving} onClick={requestClose}>Cancel</button><button type="button" className="classic-button" disabled={saving || loading || !hasDraftChanges || Boolean(conflict) || duplicateNames.size > 0} onClick={() => void save()}>{saving ? "Saving…" : "Save roster"}</button></>}>
          {controlStatus ? (
            <form className="roster-control-form" onSubmit={(event) => { event.preventDefault(); if (controlAuthenticationReady && !saving) void authenticateControl(); }}>
              <fieldset className="roster-control-login">
                <legend>{controlStatus.claimed ? "Server administrator sign in" : "Claim server owner"}</legend>
                <p>This identity is durable and separate from your room screen name. Provider credentials remain in OpenCode or the server keychain.</p>
                {!controlStatus.claimed ? <label>Local bootstrap secret<input type="password" autoComplete="off" value={bootstrapSecret} onChange={(event) => setBootstrapSecret(event.target.value)} disabled={!controlStatus.bootstrapConfigured} /></label> : null}
                <label>Username<input autoComplete="username" value={controlUsername} onChange={(event) => setControlUsername(event.target.value)} /></label>
                <label>Password<input type="password" autoComplete={controlStatus.claimed ? "current-password" : "new-password"} value={controlPassword} onChange={(event) => setControlPassword(event.target.value)} /></label>
                {!controlStatus.claimed && !controlStatus.bootstrapConfigured ? <p role="alert">A local operator must set ALL_MY_FRIENDS_ARE_AGENTS_OWNER_BOOTSTRAP_SECRET on the server before owner bootstrap.</p> : null}
                <button type="submit" className="classic-button" disabled={saving || !controlAuthenticationReady}>{controlStatus.claimed ? "Sign in" : "Claim owner"}</button>
              </fieldset>
            </form>
          ) : (
            <div className="roster-workspace" data-mobile-pane={mobilePane}>
              <aside className="roster-rail" aria-label="Configured agents">
                <header className="roster-rail__header"><span><strong>Your agents</strong><small>{entries.filter((entry) => entry.enabled).length} active · {entries.length} configured</small></span><label>View<select aria-label="Agent list view" value={agentListSort} onChange={(event) => onAgentListSortChange?.(event.target.value as AgentListSort)}>{AGENT_LIST_SORT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select><small>Display only</small></label></header>
                {loading ? <p className="roster-empty" role="status">Loading roster…</p> : (
                  <div className="roster-editor classic-scroll-region" role="list" aria-label="Room agent roster">
                    {displayedEntries.map((item, index) => {
                      const { entry, alias: name, providerId, modelId, authorId } = item;
                      const modelName = friendlyModelName(modelId);
                      const routeName = providerDisplayName(providerId);
                      const isSelected = entry.agentId === selectedAgentId;
                      const groupLabel = agentListGroupLabel(item, agentListSort);
                      const previousGroupLabel = index > 0 ? agentListGroupLabel(displayedEntries[index - 1], agentListSort) : undefined;
                      return (
                        <Fragment key={entry.agentId}>
                        {groupLabel && groupLabel !== previousGroupLabel ? <div className="roster-group-label" role="presentation">{groupLabel}</div> : null}
                        <div className={`roster-editor-row presence-row${isSelected ? " presence-row--active" : ""}${entry.enabled ? "" : " roster-editor-row--disabled"}`} role="listitem">
                          <button type="button" className="roster-agent-select" aria-pressed={isSelected} aria-label={`View ${name} configuration`} onClick={() => { setSelectedAgentId(entry.agentId); setChangingModelForAgentId(null); setMobilePane("detail"); }}>
                            <span className={`presence-status${entry.enabled ? "" : " presence-status--offline"}`} aria-hidden="true" />
                            <ProviderMark authorId={authorId} accessProviderId={providerId} compact />
                            <span className="presence-identity"><strong className="speaker" title={name}>{name}</strong><small className="presence-model-label">{modelName}{providerId ? ` · via ${routeName}` : ""}</small><small className={`roster-agent-state${entry.enabled ? "" : " roster-agent-state--inactive"}`}>{entry.enabled ? "Active in room" : "Deactivated"}</small></span>
                            <span className="roster-row-chevron" aria-hidden="true">›</span>
                          </button>
                        </div>
                        </Fragment>
                      );
                    })}
                    {entries.length === 0 ? <div className="roster-empty roster-empty-journey"><strong>Create your first agent</strong><span><b>1.</b> Choose a model.</span><span><b>2.</b> Give the agent an alias.</span><span><b>3.</b> Save the roster to add it to the room.</span><button type="button" className="roster-explore-button roster-empty-journey__action" onClick={() => setMobilePane("detail")}>Choose a model →</button></div> : null}
                  </div>
                )}
                {entries.length > 0 ? <footer className="roster-rail__footer">{selectedAgentId === null
                  ? <button type="button" className="roster-explore-button roster-explore-button--secondary" onClick={() => { setSelectedAgentId(entries[0]?.agentId || null); setChangingModelForAgentId(null); }}>← Back to your agents</button>
                  : <button type="button" className="roster-explore-button" onClick={() => { setSelectedAgentId(null); setChangingModelForAgentId(null); setMobilePane("detail"); }}>＋ Add another agent</button>}
                </footer> : null}
              </aside>

              <div className="roster-detail-shell">
                <button type="button" className="roster-mobile-back" onClick={() => setMobilePane("list")}>← Your agents</button>
              <main ref={detailPaneRef} className="roster-detail-pane classic-scroll-region" {...viewAttributes(selectedEntry ? VIEWS.manageAgentsDetail : VIEWS.manageAgentsModelPicker)}>
                {selectedEntry && selectedReference ? (
                  <section className="roster-config-workspace" aria-label={`${selectedName} configuration`}>
                    {draftCreatedAgentIds.has(selectedEntry.agentId) ? <p className="roster-draft-notice" role="status"><strong>{selectedName} is ready in this draft.</strong> Review the settings, then choose <b>Save roster</b> to add this agent to the room.</p> : null}
                    <header className="roster-config-header">
                      <label className="roster-config-identity"><ProviderMark authorId={modelAuthorId(selectedReference.providerId || selectedProfile?.provider, selectedReference.modelId)} accessProviderId={selectedReference.providerId || selectedProfile?.provider} /><span id="roster-config-heading">Agent alias</span><input aria-labelledby="roster-config-heading" value={selectedName} maxLength={48} onChange={(event) => replaceAt(selectedIndex, { ...selectedEntry, conversationalName: event.target.value })} /></label>
                      <label className="roster-active-switch classic-check"><input type="checkbox" role="switch" checked={selectedEntry.enabled} disabled={saving} aria-label={`Active in room for ${selectedName}`} onChange={(event) => replaceAt(selectedIndex, { ...selectedEntry, enabled: event.target.checked })} /><span><strong>{selectedEntry.enabled ? "Active in room" : "Deactivated"}</strong><small>{selectedEntry.enabled ? "This agent can participate in conversations." : "The configuration is saved, but this agent will not participate."}</small></span></label>
                    </header>
                    <div className="roster-config-fields">
                      <section className="roster-current-model" aria-labelledby="current-model-heading">
                        <header><span><strong id="current-model-heading">Model</strong><small className="roster-current-model__identity">{friendlyModelName(selectedReference.modelId)} · by {providerDisplayName(modelAuthorId(selectedReference.providerId || selectedProfile?.provider, selectedReference.modelId))} · via {providerDisplayName(selectedReference.providerId || selectedProfile?.provider)}</small></span><button type="button" className="classic-button" aria-expanded={changingModelForAgentId === selectedEntry.agentId} onClick={() => setChangingModelForAgentId((current) => current === selectedEntry.agentId ? null : selectedEntry.agentId)}>{changingModelForAgentId === selectedEntry.agentId ? "Done" : "Change model"}</button></header>
                        {!selectedModel && selectedReference.modelId ? <p className="roster-model-unavailable">The configured model is not in the current catalog. Choose another model to change it.</p> : null}
                        {changingModelForAgentId === selectedEntry.agentId ? <RichModelPicker models={discoveredModels} providerId={selectedReference.providerId || ""} modelId={selectedReference.modelId} view={VIEWS.manageAgentsModelPicker} onChange={(model) => { replaceAt(selectedIndex, { ...selectedEntry, providerId: model.providerId || undefined, modelId: model.modelId, variant: undefined, reasoningEffort: undefined, sessionInvalidationReason: undefined, selectionConfirmationRequired: undefined }); setChangingModelForAgentId(null); }} /> : null}
                      </section>
                      <div className="roster-model-options"><label className="classic-property-row"><span>Variant / reasoning effort</span><select value={selectedEntry.variant || selectedEntry.reasoningEffort || ""} onChange={(event) => { const { reasoningEffort: _legacyEffort, ...entry } = selectedEntry; replaceAt(selectedIndex, { ...entry, variant: event.target.value || undefined }); }}><option value="">Default</option>{(selectedEntry.variant || selectedEntry.reasoningEffort) && !selectedModel?.variants?.some(({ id }) => id === (selectedEntry.variant || selectedEntry.reasoningEffort)) ? <option value={selectedEntry.variant || selectedEntry.reasoningEffort}>{selectedEntry.variant || selectedEntry.reasoningEffort} (currently unavailable)</option> : null}{selectedModel?.variants?.map(({ id, displayName }) => <option key={id} value={id}>{displayName}{selectedModel.capabilities?.reasoningEffort?.includes(id) ? " (reasoning effort)" : ""}</option>)}</select></label></div>
                      <section className="roster-capabilities" aria-label={`Effective capabilities for ${selectedName}`}>
                        <h4>Effective capabilities</h4>
                        {!selectedCapabilityStatus ? <p>Capability diagnostics are not available from this server version.</p> : Object.entries(selectedCapabilityStatus.capabilities).map(([name, status]) => { const github = name === "github_read"; const exclusion = github ? selectedGhGate?.exclusions[0] : undefined; return <div className={`roster-capability roster-capability--${status.effective ? "available" : "disabled"}`} key={name}><span><strong>{github ? "GitHub /gh" : name === "project_write" ? "Project writes" : "Conversation"}</strong><small>{github ? `Requested: ${selectedGhRequested ? "granted" : "not granted"} · Effective: ${status.effective ? "available" : "unavailable"}` : status.effective ? "Available" : "Unavailable"}{status.contract ? ` · ${status.contract}` : ""}</small></span><p>{status.effective ? "Configured and available at runtime." : `${(exclusion || status.reason).replaceAll("_", " ")}. ${status.guidance}`}</p></div>; })}
                      </section>
                      <fieldset className="roster-command-permissions">
                        <legend>Agent commands</legend>
                        <p>Choose which slash commands this agent may invoke. Human commands are controlled by the room server.</p>
                        <div className="roster-command-list" aria-label={`Command permissions for ${selectedName}`}>
                          <label className="roster-permission-toggle classic-check"><input type="checkbox" aria-label="Allow all commands" checked={selectedCommandPermissions?.allowAll === true && selectedCommandPermissions.catalogRevision === COMMAND_CATALOG_REVISION} disabled={saving} onChange={(event) => replaceAt(selectedIndex, { ...selectedEntry, commandPermissions: { allowAll: event.target.checked, allowed: [...ROOM_COMMANDS], catalogRevision: COMMAND_CATALOG_REVISION } })} /><span>All commands</span></label>
                          {ROOM_COMMANDS.map((command) => {
                            const currentAllowAll=selectedCommandPermissions?.allowAll===true&&selectedCommandPermissions.catalogRevision===COMMAND_CATALOG_REVISION;const checked = currentAllowAll || selectedCommandPermissions?.allowed.includes(command);
                            const capabilityDisabled = command === "gh" && selectedGhGate?.featureCompiled === false;
                            return <label key={command} className={`classic-check${command === "gh" ? " roster-command--detailed" : ""}`}><input type="checkbox" checked={checked} disabled={saving || currentAllowAll || capabilityDisabled} aria-label={command === "gh" ? `/gh requested ${checked ? "on" : "off"}; effective ${selectedGhGate?.effective ? "on" : "off"}` : undefined} aria-describedby={command === "gh" ? `capability-gh-${selectedEntry.agentId}` : undefined} onChange={(event) => {
                              const allowed = new Set(selectedCommandPermissions?.allowed || []);
                              if (event.target.checked) allowed.add(command); else allowed.delete(command);
                              replaceAt(selectedIndex, { ...selectedEntry, commandPermissions: { allowAll: false, allowed: [...allowed] as RoomCommandName[], catalogRevision: COMMAND_CATALOG_REVISION } });
                            }} /><span>/{command}</span></label>;
                          })}
                        </div>
                        <small className="roster-command-status" id={`capability-gh-${selectedEntry.agentId}`}>GitHub /gh: {selectedGhGate?.featureCompiled === false ? "feature unavailable in this server build" : `requested ${selectedGhRequested ? "on" : "off"}; effective ${selectedGhGate?.effective ? "on" : "off"}`}</small>
                      </fieldset>
                      {selectedEntry.sessionInvalidationReason ? <div className="roster-diagnostic"><p>{selectedEntry.sessionInvalidationReason}</p>{selectedEntry.selectionConfirmationRequired && selectedModelAvailable ? <button type="button" className="classic-button" onClick={() => replaceAt(selectedIndex, { ...selectedEntry, sessionInvalidationReason: "", selectionConfirmationRequired: undefined })}>Confirm selected OpenCode model</button> : null}</div> : null}
                    </div>
                    <section className="roster-danger-zone"><span><strong>Delete configuration</strong><small>Deactivation is reversible. Deleting removes this alias and its settings from the room.</small></span><button type="button" disabled={saving} onClick={(event) => setDeleteRequest({ agentId: selectedEntry.agentId, returnFocusTo: event.currentTarget })}>Delete agent…</button></section>
                  </section>
                ) : (
                  <section className="roster-discovery roster-discovery--workspace" aria-labelledby="roster-explore-heading">
                    {newSelectedModel ? (
                      <>
                        <header className="roster-journey-heading"><span className="roster-step-badge">Step 2 of 2</span><div><h3 id="roster-explore-heading">Create your agent</h3><p>Give this model a memorable name. You can change its model or deactivate it later.</p></div><button type="button" className="classic-button" onClick={() => { setNewProvider(""); setNewModel(""); setNewVariant(""); }}>← Choose a different model</button></header>
                        <section className="roster-selected-model" aria-label={`Selected model: ${newSelectedModel.displayName}`}>
                          <ProviderMark authorId={newSelectedModel.authorId || modelAuthorId(newSelectedModel.providerId, newSelectedModel.modelId)} accessProviderId={newSelectedModel.providerId} />
                          <div><strong>{newSelectedModel.displayName}</strong><span>Built by {newSelectedModel.authorDisplayName || providerDisplayName(newSelectedModel.authorId || modelAuthorId(newSelectedModel.providerId, newSelectedModel.modelId))}{newSelectedModel.providerId ? ` · accessed through ${newSelectedModel.accessProviderDisplayName || providerDisplayName(newSelectedModel.providerId)}` : ""}</span>{newSelectedModel.description ? <p>{newSelectedModel.description}</p> : null}</div>
                          <dl><div><dt>Input</dt><dd>{formatCatalogPrice(newSelectedModel.pricing?.inputPerMillion)} / 1M</dd></div><div><dt>Output</dt><dd>{formatCatalogPrice(newSelectedModel.pricing?.outputPerMillion)} / 1M</dd></div></dl>
                        </section>
                        <form className="roster-create-panel" onSubmit={(event) => { event.preventDefault(); if (newName.trim() && !saving) createParticipant(); }}><h4>Name and configure the agent</h4><label>Agent alias<input ref={newNameInputRef} value={newName} maxLength={48} aria-invalid={Boolean(newNameError)} aria-describedby={newNameError ? "new-agent-alias-error" : undefined} placeholder="For example: Scout or Code Coach" onChange={(event) => { setNewName(event.target.value); setNewNameError(""); }} />{newNameError ? <small id="new-agent-alias-error" className="roster-field-error" role="alert">{newNameError}</small> : null}</label><div className="roster-model-options"><label>Variant / reasoning effort<select value={newVariant} onChange={(event) => setNewVariant(event.target.value)}><option value="">Default</option>{newSelectedModel.variants?.map(({ id, displayName }) => <option value={id} key={id}>{displayName}{newSelectedModel.capabilities?.reasoningEffort?.includes(id) ? " (reasoning effort)" : ""}</option>)}</select></label></div><button type="submit" className="classic-button roster-create-button" disabled={!newName.trim() || saving}>Add agent to roster draft</button><small>You will review the agent once more before saving the roster.</small></form>
                      </>
                    ) : (
                      <>
                        <header className="roster-journey-heading"><span className="roster-step-badge">Step 1 of 2</span><div><h3 id="roster-explore-heading">Choose a model</h3><p>Select any model to continue to the agent name and settings.</p></div></header>
                        <p className="roster-discovery-intro">Compare model makers, access providers, popularity, capabilities, context, and live pricing. The maker builds the model; the provider gives this room access to it.</p>
                        <div className="roster-discovery-status"><strong>{modelDiscovery?.status || "loading"}</strong>{modelDiscovery?.diagnostic ? <span>{modelDiscovery.diagnostic}</span> : null}<button type="button" disabled={refreshing} onClick={() => { setRefreshing(true); void refreshModelDiscovery().then(setModelDiscovery).catch((reason) => setError(reason instanceof Error ? reason.message : "Discovery refresh failed.")).finally(() => setRefreshing(false)); }}>{refreshing ? "Refreshing…" : "Refresh"}</button><button type="button" onClick={() => { void initiateProviderSetup().then((result: { command?: string[]; instruction?: string }) => setSetupInstruction(`${result.instruction || "Run on the server host:"} ${(result.command || []).join(" ")}`)).catch((reason) => setError(reason instanceof Error ? reason.message : "Provider setup could not be initiated.")); }}>OpenCode setup instructions</button></div>
                        {setupInstruction ? <p className="roster-diagnostic" role="status">{setupInstruction}</p> : null}
                        <RichModelPicker models={discoveredModels} providerId="" modelId="" view={VIEWS.manageAgentsModelPicker} onChange={(model) => { setNewProvider(model.providerId || ""); setNewModel(model.modelId); setNewVariant(""); }} />
                      </>
                    )}
                  </section>
                )}
              </main>
              </div>
            </div>
          )}
          {error ? <p className="roster-error" role="alert" {...(conflict ? viewAttributes(VIEWS.manageAgentsConflict) : {})}>{error}</p> : null}
          {conflict ? <button type="button" className="classic-button roster-reload" disabled={saving} onClick={useLatest}>Load latest roster</button> : null}
      </DialogFrame>
      {deleteRequest ? <ConfirmationDialog title="Delete agent configuration?" description={<><p>This will remove the agent’s alias, model selection, and room settings when you save the roster.</p><p>To keep the configuration for later, cancel and deactivate the agent instead.</p></>} confirmLabel="Delete configuration" returnFocusTo={deleteRequest.returnFocusTo} onConfirm={() => { removeAgent(deleteRequest.agentId); setDeleteRequest(null); }} onCancel={() => setDeleteRequest(null)} /> : null}
      {discardRequest ? <ConfirmationDialog title="Discard roster changes?" description={<><p>Your unsaved aliases, model selections, activation changes, and added or deleted agents will be lost.</p><p>Choose Cancel to keep editing, or discard the draft to close the manager.</p></>} confirmLabel="Discard changes" returnFocusTo={null} onConfirm={onClose} onCancel={() => setDiscardRequest(false)} view={VIEWS.unsavedChangesConfirmation} /> : null}
    </>
  );
}

function positiveRosterRevision(value: unknown, fallback: number) {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function formatCatalogPrice(value: number | undefined) {
  if (value === undefined) return "Price unavailable";
  if (value === 0) return "Free";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  if (value < 1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}
