import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ApiRequestError, bootstrapControlPlane, controlLogin, initiateProviderSetup, loadControlMe, loadControlStatus, loadRoster, refreshModelDiscovery, updateRoster, type RosterCatalogEntry, type RosterResponse } from "./api";
import { useModalOverlay } from "./overlay";
import type { RoomAgentRoster, RoomAgentRosterEntry } from "../shared/roster";
import type { ModelDiscoveryResult } from "../shared/model-discovery";

export function RosterManagerDialog({
  initialRoster,
  returnFocusTo,
  onSaved,
  onClose,
}: {
  initialRoster: RoomAgentRoster;
  returnFocusTo: HTMLElement | null;
  onSaved: (roster: RoomAgentRoster) => void;
  onClose: () => void;
}) {
  const titleId = useId();
  const [base, setBase] = useState(initialRoster);
  const [entries, setEntries] = useState<RoomAgentRosterEntry[]>(() => [...initialRoster.entries]);
  const [catalog, setCatalog] = useState<readonly RosterCatalogEntry[]>([]);
  const [modelDiscovery, setModelDiscovery] = useState<ModelDiscoveryResult>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState<RosterResponse | null>(null);
  const [newName, setNewName] = useState("");
  const [newProvider, setNewProvider] = useState("");
  const [newModel, setNewModel] = useState("");
  const [newVariant, setNewVariant] = useState("");
  const [newEffort, setNewEffort] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [controlStatus, setControlStatus] = useState<{ claimed: boolean; bootstrapConfigured: boolean } | null>(null);
  const [controlUsername, setControlUsername] = useState("");
  const [controlPassword, setControlPassword] = useState("");
  const [bootstrapSecret, setBootstrapSecret] = useState("");
  const [setupInstruction, setSetupInstruction] = useState("");
  const closed = useRef(false);
  const requestClose = () => { if (!saving) onClose(); };
  const { dialogRef, onDialogKeyDown, onBackdropMouseDown } = useModalOverlay(requestClose, returnFocusTo);

  useEffect(() => {
    closed.current = false;
    void loadRoster().then(async (response) => {
      if (response.modelDiscovery) await loadControlMe();
      if (closed.current) return;
      setBase(response.roster);
      setEntries([...response.roster.entries]);
      setCatalog(response.catalog);
      setModelDiscovery(response.modelDiscovery);
      setError("");
    }).catch((reason) => {
      if (closed.current) return;
      if (reason instanceof ApiRequestError && reason.status === 401) {
        void loadControlStatus().then(setControlStatus).catch(() => setError("The server control plane could not be loaded."));
      } else setError(reason instanceof Error ? reason.message : "The roster could not be loaded.");
    }).finally(() => {
      if (!closed.current) setLoading(false);
    });
    return () => { closed.current = true; };
  }, []);

  const catalogById = useMemo(() => new Map(catalog.map((entry) => [entry.agentId, entry])), [catalog]);
  const duplicateNames = useMemo(() => {
    const seen = new Set<string>(); const duplicates = new Set<string>();
    for (const entry of entries) { const name = (entry.conversationalName || catalogById.get(entry.agentId)?.conversationalName || "").trim().toLocaleLowerCase(); if (seen.has(name)) duplicates.add(name); else seen.add(name); }
    return duplicates;
  }, [entries, catalogById]);
  const discoveredModels = modelDiscovery?.models || [];

  function replaceAt(index: number, entry: RoomAgentRosterEntry) {
    setEntries((current) => current.map((value, position) => position === index ? entry : value));
    setConflict(null);
  }

  function move(index: number, direction: -1 | 1) {
    setEntries((current) => {
      const target = index + direction;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
    setConflict(null);
  }

  function useLatest() {
    if (!conflict) return;
    setBase(conflict.roster);
    setEntries([...conflict.roster.entries]);
    setCatalog(conflict.catalog);
    setModelDiscovery(conflict.modelDiscovery);
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
      const response = await updateRoster(base.revision, entries);
      setBase(response.roster);
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
    } finally {
      setSaving(false);
    }
  }

  async function authenticateControl() {
    setSaving(true); setError("");
    try {
      if (controlStatus?.claimed) await controlLogin(controlUsername, controlPassword);
      else await bootstrapControlPlane(bootstrapSecret, controlUsername, controlPassword);
      const response = await loadRoster(); setBase(response.roster); setEntries([...response.roster.entries]); setCatalog(response.catalog); setModelDiscovery(response.modelDiscovery); setControlStatus(null); setControlPassword(""); setBootstrapSecret("");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Control-plane authentication failed."); }
    finally { setSaving(false); }
  }

  return (
    <div className="modal-backdrop roster-backdrop" onMouseDown={onBackdropMouseDown}>
      <section ref={dialogRef} className="agent-settings-window roster-window" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onKeyDown={onDialogKeyDown}>
        <header className="agent-settings-titlebar">
          <h2 id={titleId}>Manage room agents</h2>
          <button type="button" aria-label="Close roster manager" disabled={saving} onClick={requestClose}>×</button>
        </header>
        <div className="roster-body">
          <p>Choose which OpenCode provider and model combinations participate in this room. Changes apply immediately and persist across restarts.</p>
          {controlStatus ? <fieldset className="roster-control-login"><legend>{controlStatus.claimed ? "Server administrator sign in" : "Claim server owner"}</legend><p>This identity is durable and separate from your room screen name. Provider credentials remain in OpenCode or the server keychain.</p>{!controlStatus.claimed ? <label>Local bootstrap secret<input type="password" autoComplete="off" value={bootstrapSecret} onChange={(event) => setBootstrapSecret(event.target.value)} disabled={!controlStatus.bootstrapConfigured} /></label> : null}<label>Username<input autoComplete="username" value={controlUsername} onChange={(event) => setControlUsername(event.target.value)} /></label><label>Password<input type="password" autoComplete={controlStatus.claimed ? "current-password" : "new-password"} value={controlPassword} onChange={(event) => setControlPassword(event.target.value)} /></label>{!controlStatus.claimed && !controlStatus.bootstrapConfigured ? <p role="alert">A local operator must set ALL_MY_FRIENDS_ARE_AGENTS_OWNER_BOOTSTRAP_SECRET on the server before owner bootstrap.</p> : null}<button type="button" className="classic-button" disabled={saving || !controlUsername || controlPassword.length < 12 || (!controlStatus.claimed && !bootstrapSecret)} onClick={() => void authenticateControl()}>{controlStatus.claimed ? "Sign in" : "Claim owner"}</button></fieldset> : null}
          {controlStatus ? null : <>
          {loading ? <p role="status">Loading roster…</p> : (
            <div className="roster-editor" role="list" aria-label="Room agent roster">
              {entries.map((entry, index) => {
                const profile = catalogById.get(entry.agentId);
                const name = entry.conversationalName || profile?.conversationalName || entry.agentId;
                const selectedModel = discoveredModels.find((model) => model.modelId === (entry.modelId || profile?.modelId) && (model.providerId || "") === (entry.providerId || ""));
                return (
                  <div className="roster-editor-row" role="listitem" key={entry.agentId}>
                    <label className="roster-enabled">
                      <input type="checkbox" checked={entry.enabled} disabled={saving} onChange={(event) => replaceAt(index, { ...entry, enabled: event.target.checked })} />
                      <span><strong>{name}</strong><small>{entry.modelId ? `${entry.providerId ? `${entry.providerId}/` : ""}${entry.modelId}` : profile ? `${profile.displayName} · ${profile.modelLabel}` : entry.agentId}</small></span>
                    </label>
                    <div className="roster-row-actions" aria-label={`Reorder or remove ${name}`}>
                      <button type="button" disabled={saving || index === 0} aria-label="Move up" onClick={() => move(index, -1)}>↑</button>
                      <button type="button" disabled={saving || index === entries.length - 1} aria-label="Move down" onClick={() => move(index, 1)}>↓</button>
                      <button type="button" disabled={saving} aria-label={`Remove ${name}`} onClick={() => { setEntries((current) => current.filter((value) => value.agentId !== entry.agentId)); setConflict(null); }}>Remove</button>
                    </div>
                    <details className="roster-config-editor">
                      <summary>Edit configuration</summary>
                      <label>Conversational name<input value={name} maxLength={48} onChange={(event) => replaceAt(index, { ...entry, conversationalName: event.target.value })} /></label>
                      <label>Model<select value={`${entry.providerId || ""}\u0000${entry.modelId || profile?.modelId || ""}`} onChange={(event) => { const [providerId, modelId] = event.target.value.split("\u0000"); replaceAt(index, { ...entry, providerId: providerId || undefined, modelId, variant: undefined, reasoningEffort: undefined, sessionInvalidationReason: undefined, selectionConfirmationRequired: undefined }); }}>{!selectedModel ? <option value={`${entry.providerId || ""}\u0000${entry.modelId || profile?.modelId || ""}`}>{entry.providerId ? `${entry.providerId}/` : ""}{entry.modelId || profile?.modelId} (currently unavailable)</option> : null}{discoveredModels.map((model) => <option key={`${model.providerId || ""}/${model.modelId}`} value={`${model.providerId || ""}\u0000${model.modelId}`}>{model.displayName}</option>)}</select></label>
                      <label>Variant<select value={entry.variant || ""} onChange={(event) => replaceAt(index, { ...entry, variant: event.target.value || undefined })}><option value="">Default</option>{entry.variant && !selectedModel?.variants?.some(({ id }) => id === entry.variant) ? <option value={entry.variant}>{entry.variant} (currently unavailable)</option> : null}{selectedModel?.variants?.map(({ id, displayName }) => <option key={id} value={id}>{displayName}</option>)}</select></label>
                      <label>Reasoning effort<select value={entry.reasoningEffort || ""} onChange={(event) => replaceAt(index, { ...entry, reasoningEffort: event.target.value || undefined })}><option value="">Default</option>{entry.reasoningEffort && !selectedModel?.capabilities?.reasoningEffort?.includes(entry.reasoningEffort) ? <option value={entry.reasoningEffort}>{entry.reasoningEffort} (currently unavailable)</option> : null}{selectedModel?.capabilities?.reasoningEffort?.map((effort) => <option key={effort}>{effort}</option>)}</select></label>
                      {entry.sessionInvalidationReason ? <div className="roster-diagnostic"><p>{entry.sessionInvalidationReason}</p>{entry.selectionConfirmationRequired ? <button type="button" className="classic-button" onClick={() => replaceAt(index, { ...entry, sessionInvalidationReason: "", selectionConfirmationRequired: undefined })}>Confirm selected OpenCode model</button> : null}</div> : null}
                    </details>
                  </div>
                );
              })}
              {entries.length === 0 ? <p className="roster-empty">No agents are in this room. Humans can still use the chat and add agents later.</p> : null}
            </div>
          )}
          <fieldset className="roster-discovery">
            <legend>Create participant instance</legend>
            <label>Conversational name<input value={newName} maxLength={48} onChange={(event) => setNewName(event.target.value)} /></label>
            <div className="roster-discovery-status"><strong>{modelDiscovery?.status || "loading"}</strong>{modelDiscovery?.diagnostic ? <span>{modelDiscovery.diagnostic}</span> : null}<button type="button" disabled={refreshing} onClick={() => { setRefreshing(true); void refreshModelDiscovery().then(setModelDiscovery).catch((reason) => setError(reason instanceof Error ? reason.message : "Discovery refresh failed.")).finally(() => setRefreshing(false)); }}>{refreshing ? "Refreshing…" : "Refresh"}</button><button type="button" onClick={() => { void initiateProviderSetup().then((result: { command?: string[]; instruction?: string }) => setSetupInstruction(`${result.instruction || "Run on the server host:"} ${(result.command || []).join(" ")}`)).catch((reason) => setError(reason instanceof Error ? reason.message : "Provider setup could not be initiated.")); }}>OpenCode setup instructions</button></div>
            {setupInstruction ? <p className="roster-diagnostic" role="status">{setupInstruction}</p> : null}
            <label>Model<select value={`${newProvider}\u0000${newModel}`} onChange={(event) => { const [providerId, modelId] = event.target.value.split("\u0000"); setNewProvider(providerId); setNewModel(modelId); setNewVariant(""); }}><option value="\u0000">Choose discovered model…</option>{discoveredModels.map((model) => <option key={`${model.providerId || ""}/${model.modelId}`} value={`${model.providerId || ""}\u0000${model.modelId}`}>{model.displayName} ({model.provenance})</option>)}</select></label>
            <label>Variant<select value={newVariant} onChange={(event) => setNewVariant(event.target.value)}><option value="">Default</option>{discoveredModels.find((model) => model.modelId === newModel && (model.providerId || "") === newProvider)?.variants?.map(({ id, displayName }) => <option value={id} key={id}>{displayName}</option>)}</select></label>
            <label>Reasoning effort<select value={newEffort} onChange={(event) => setNewEffort(event.target.value)}><option value="">Default</option>{discoveredModels.find((model) => model.modelId === newModel && (model.providerId || "") === newProvider)?.capabilities?.reasoningEffort?.map((effort) => <option key={effort}>{effort}</option>)}</select></label>
            <button type="button" className="classic-button" disabled={!newName.trim() || !newModel || saving} onClick={() => { const normalizedName = newName.trim().toLocaleLowerCase(); if (entries.some((entry) => (entry.conversationalName || catalogById.get(entry.agentId)?.conversationalName || "").trim().toLocaleLowerCase() === normalizedName)) { setError("Conversational names must be unique (case-insensitive)."); return; } setEntries((current) => [...current, { agentId: `agent-${crypto.randomUUID()}`, conversationalName: newName.trim(), ...(newProvider ? { providerId: newProvider } : {}), modelId: newModel, ...(newVariant ? { variant: newVariant } : {}), ...(newEffort ? { reasoningEffort: newEffort } : {}), enabled: true, supportsProjectWrites: true, configurationRevision: 1 }]); setNewName(""); setNewProvider(""); setNewModel(""); setNewVariant(""); setNewEffort(""); setError(""); }}>Create participant</button>
          </fieldset>
          </>}
          {error ? <p className="roster-error" role="alert">{error}</p> : null}
          {conflict ? <button type="button" className="classic-button roster-reload" disabled={saving} onClick={useLatest}>Load latest roster</button> : null}
        </div>
        <footer className="agent-settings-actions roster-actions">
          <button type="button" className="classic-button" disabled={saving} onClick={requestClose}>Cancel</button>
          <button type="button" className="classic-button" disabled={saving || loading || Boolean(conflict) || duplicateNames.size > 0 || Boolean(controlStatus)} onClick={() => void save()}>{saving ? "Saving…" : "Save roster"}</button>
        </footer>
      </section>
    </div>
  );
}
