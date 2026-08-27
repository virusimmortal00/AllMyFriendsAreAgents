import { useEffect, useId, useMemo, useState } from "react";
import { friendlyModelName } from "../shared/model-presentation";
import type { DiscoveredModel, ModelReference } from "../shared/model-discovery";
import { ApiRequestError, loadRoomConfiguration, updateRoomConfiguration, type RoomConfiguration } from "./api";
import { RichModelPicker } from "./model-picker";
import { useModalOverlay } from "./overlay";

export function RoomConfigurationDialog({ returnFocusTo, onClose }: { returnFocusTo: HTMLElement | null; onClose: () => void }) {
  const titleId = useId();
  const [saved, setSaved] = useState<RoomConfiguration>();
  const [basePromptText, setBasePromptText] = useState("");
  const [basePromptEnabled, setBasePromptEnabled] = useState(true);
  const [summarizerModel, setSummarizerModel] = useState<ModelReference | null>(null);
  const [summarizerPromptText, setSummarizerPromptText] = useState("");
  const [featureFlags, setFeatureFlags] = useState<Record<string, boolean>>({ preflightInvocationGating: false });
  const [models, setModels] = useState<readonly DiscoveredModel[]>([]);
  const [defaultBasePrompt, setDefaultBasePrompt] = useState("");
  const [choosingModel, setChoosingModel] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const dirty = useMemo(() => Boolean(saved) && JSON.stringify({ basePromptText: basePromptEnabled ? basePromptText : null, summarizerModel, summarizerPromptText, featureFlags }) !== JSON.stringify({ basePromptText: saved?.basePromptText, summarizerModel: saved?.summarizerModel, summarizerPromptText: saved?.summarizerPromptText, featureFlags: saved?.featureFlags }), [saved, basePromptEnabled, basePromptText, summarizerModel, summarizerPromptText, featureFlags]);
  const { dialogRef, onDialogKeyDown, onBackdropMouseDown } = useModalOverlay(onClose, returnFocusTo);

  useEffect(() => {
    let current = true;
    void loadRoomConfiguration().then((result) => {
      if (!current) return;
      setSaved(result.settings);
      setBasePromptEnabled(result.settings.basePromptText !== null);
      setBasePromptText(result.settings.basePromptText || "");
      setSummarizerModel(result.settings.summarizerModel);
      setSummarizerPromptText(result.settings.summarizerPromptText);
      setFeatureFlags(result.settings.featureFlags);
      setModels(result.modelDiscovery?.models || []);
      setDefaultBasePrompt(result.defaults?.basePromptText || "");
    }).catch((failure) => { if (current) setError(failure instanceof Error ? failure.message : "Could not load room settings."); }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, []);

  async function save() {
    if (!dirty || saving) return;
    setSaving(true);
    setError("");
    try {
      const nextBasePrompt = basePromptEnabled ? basePromptText : null;
      const update = {
        ...(saved?.basePromptText !== nextBasePrompt ? { basePromptText: nextBasePrompt } : {}),
        ...(JSON.stringify(saved?.summarizerModel) !== JSON.stringify(summarizerModel) ? { summarizerModel } : {}),
        ...(saved?.summarizerPromptText !== summarizerPromptText ? { summarizerPromptText } : {}),
        ...(JSON.stringify(saved?.featureFlags) !== JSON.stringify(featureFlags) ? { featureFlags } : {}),
      };
      const result = await updateRoomConfiguration(update);
      setSaved(result.settings);
      onClose();
    } catch (failure) {
      setError(failure instanceof ApiRequestError && failure.status === 401 ? "Sign in as a server administrator through Manage agents, then try again." : failure instanceof Error ? failure.message : "Could not save room settings.");
    } finally { setSaving(false); }
  }

  const modelLabel = summarizerModel ? friendlyModelName(summarizerModel.modelId) : "No summarizer configured";
  return (
    <div className="modal-backdrop room-settings-backdrop" onMouseDown={onBackdropMouseDown}>
      <section ref={dialogRef} className="agent-settings-window room-configuration-window" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onKeyDown={onDialogKeyDown}>
        <header className="agent-settings-titlebar"><h2 id={titleId}>Room Settings</h2><button type="button" aria-label="Close Room Settings" disabled={saving} onClick={onClose}>×</button></header>
        <div className="room-configuration-body">
          {loading ? <p role="status">Loading room settings…</p> : null}
          {error ? <p role="alert" className="room-settings-error">{error}</p> : null}
          {!loading && saved ? <>
            <section className="room-configuration-card" aria-labelledby="base-prompt-heading">
              <h3 id="base-prompt-heading">Base Prompt</h3>
              <p>Applied after each agent’s identity rules on every turn.</p>
              <label className="room-configuration-check"><input type="checkbox" checked={basePromptEnabled} onChange={(event) => setBasePromptEnabled(event.target.checked)} /> Include a room base prompt</label>
              <label>Prompt<textarea rows={7} maxLength={4000} disabled={!basePromptEnabled} value={basePromptText} onChange={(event) => setBasePromptText(event.target.value)} /></label>
              <button type="button" className="classic-button" disabled={!basePromptEnabled || basePromptText === defaultBasePrompt} onClick={() => setBasePromptText(defaultBasePrompt)}>Use built-in default</button>
              <small>Revision {saved.basePromptRevision}. An empty value resolves to the built-in default; disabling removes this section explicitly.</small>
            </section>
            <section className="room-configuration-card" aria-labelledby="summarizer-heading">
              <h3 id="summarizer-heading">Summarizer</h3>
              <p>Used only for cold starts and large deltas. Verbatim history remains the source of truth.</p>
              <div className="room-configuration-model"><strong>{modelLabel}</strong><button type="button" className="classic-button" onClick={() => setChoosingModel((value) => !value)}>{choosingModel ? "Hide models" : "Choose model…"}</button></div>
              {choosingModel ? <RichModelPicker models={models} providerId={summarizerModel?.providerId || ""} modelId={summarizerModel?.modelId || ""} title="Choose the room summarizer" description="This internal model creates bounded cold-start navigation summaries." onChange={(model) => { setSummarizerModel({ ...(model.providerId ? { providerId: model.providerId } : {}), modelId: model.modelId }); setChoosingModel(false); }} /> : null}
              <label>Prompt template<textarea rows={9} maxLength={8000} value={summarizerPromptText} onChange={(event) => setSummarizerPromptText(event.target.value)} /></label>
              <small>Revision {saved.summarizerPromptRevision}. Keep {"{{transcript}}"} where verbatim input should be inserted. DeepSeek V4 Flash remains the built-in failover route.</small>
            </section>
            <section className="room-configuration-card" aria-labelledby="flags-heading">
              <h3 id="flags-heading">Feature Flags</h3>
              <label className="room-configuration-check"><input type="checkbox" checked={Boolean(featureFlags.preflightInvocationGating)} onChange={(event) => setFeatureFlags((current) => ({ ...current, preflightInvocationGating: event.target.checked }))} /> Pre-flight invocation gating</label>
              <small>The flag is stored now; gate-decision behavior is tracked separately.</small>
            </section>
          </> : null}
        </div>
        <footer className="agent-settings-actions roster-actions"><span className={`roster-actions__status${dirty ? " roster-actions__status--dirty" : ""}`}>{dirty ? "Unsaved room settings" : "No unsaved changes"}</span><button type="button" className="classic-button" disabled={saving} onClick={onClose}>Cancel</button><button type="button" className="classic-button" disabled={!dirty || saving || !summarizerPromptText.trim()} onClick={() => void save()}>{saving ? "Saving…" : "Save settings"}</button></footer>
      </section>
    </div>
  );
}
