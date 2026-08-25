import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ApiRequestError, loadRoster, updateRoster, type RosterCatalogEntry, type RosterResponse } from "./api";
import { useModalOverlay } from "./overlay";
import type { RoomAgentRoster, RoomAgentRosterEntry } from "../shared/roster";
import type { ActiveAgentId } from "../shared/participants";

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
  const [addAgent, setAddAgent] = useState<ActiveAgentId | "">("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState<RosterResponse | null>(null);
  const closed = useRef(false);
  const requestClose = () => { if (!saving) onClose(); };
  const { dialogRef, onDialogKeyDown, onBackdropMouseDown } = useModalOverlay(requestClose, returnFocusTo);

  useEffect(() => {
    closed.current = false;
    void loadRoster().then((response) => {
      if (closed.current) return;
      setBase(response.roster);
      setEntries([...response.roster.entries]);
      setCatalog(response.catalog);
      setError("");
    }).catch((reason) => {
      if (!closed.current) setError(reason instanceof Error ? reason.message : "The roster could not be loaded.");
    }).finally(() => {
      if (!closed.current) setLoading(false);
    });
    return () => { closed.current = true; };
  }, []);

  const available = useMemo(() => {
    const present = new Set(entries.map((entry) => entry.agentId));
    return catalog.filter((entry) => !present.has(entry.agentId));
  }, [catalog, entries]);
  const catalogById = useMemo(() => new Map(catalog.map((entry) => [entry.agentId, entry])), [catalog]);

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
    setAddAgent("");
    setConflict(null);
    setError("");
  }

  async function save() {
    if (saving) return;
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

  return (
    <div className="modal-backdrop roster-backdrop" onMouseDown={onBackdropMouseDown}>
      <section ref={dialogRef} className="agent-settings-window roster-window" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onKeyDown={onDialogKeyDown}>
        <header className="agent-settings-titlebar">
          <h2 id={titleId}>Manage room agents</h2>
          <button type="button" aria-label="Close roster manager" disabled={saving} onClick={requestClose}>×</button>
        </header>
        <div className="roster-body">
          <p>Choose which supported provider and model combinations participate in this room. Changes apply immediately and persist across restarts.</p>
          {loading ? <p role="status">Loading roster…</p> : (
            <div className="roster-editor" role="list" aria-label="Room agent roster">
              {entries.map((entry, index) => {
                const profile = catalogById.get(entry.agentId);
                return (
                  <div className="roster-editor-row" role="listitem" key={entry.agentId}>
                    <label className="roster-enabled">
                      <input type="checkbox" checked={entry.enabled} disabled={saving} onChange={(event) => replaceAt(index, { ...entry, enabled: event.target.checked })} />
                      <span><strong>{profile?.conversationalName || entry.agentId}</strong><small>{profile ? `${profile.displayName} · ${profile.modelLabel}` : entry.agentId}</small></span>
                    </label>
                    <div className="roster-row-actions" aria-label={`Reorder or remove ${profile?.conversationalName || entry.agentId}`}>
                      <button type="button" disabled={saving || index === 0} aria-label="Move up" onClick={() => move(index, -1)}>↑</button>
                      <button type="button" disabled={saving || index === entries.length - 1} aria-label="Move down" onClick={() => move(index, 1)}>↓</button>
                      <button type="button" disabled={saving} aria-label={`Remove ${profile?.conversationalName || entry.agentId}`} onClick={() => { setEntries((current) => current.filter((value) => value.agentId !== entry.agentId)); setConflict(null); }}>Remove</button>
                    </div>
                  </div>
                );
              })}
              {entries.length === 0 ? <p className="roster-empty">No agents are in this room. Humans can still use the chat and add agents later.</p> : null}
            </div>
          )}
          <div className="roster-add">
            <label htmlFor="roster-add-agent">Add a supported agent</label>
            <div>
              <select id="roster-add-agent" className="classic-select" value={addAgent} disabled={saving || loading || available.length === 0} onChange={(event) => setAddAgent(event.target.value as ActiveAgentId | "")}>
                <option value="">{available.length ? "Choose provider / model…" : "All supported agents are listed"}</option>
                {available.map((entry) => <option value={entry.agentId} key={entry.agentId}>{entry.displayName} — {entry.modelLabel}</option>)}
              </select>
              <button type="button" className="classic-button" disabled={!addAgent || saving} onClick={() => {
                if (!addAgent) return;
                setEntries((current) => current.some((entry) => entry.agentId === addAgent) ? current : [...current, { agentId: addAgent, enabled: true }]);
                setAddAgent("");
                setConflict(null);
              }}>Add</button>
            </div>
          </div>
          {error ? <p className="roster-error" role="alert">{error}</p> : null}
          {conflict ? <button type="button" className="classic-button roster-reload" disabled={saving} onClick={useLatest}>Load latest roster</button> : null}
        </div>
        <footer className="agent-settings-actions roster-actions">
          <button type="button" className="classic-button" disabled={saving} onClick={requestClose}>Cancel</button>
          <button type="button" className="classic-button" disabled={saving || loading || Boolean(conflict)} onClick={() => void save()}>{saving ? "Saving…" : "Save roster"}</button>
        </footer>
      </section>
    </div>
  );
}
