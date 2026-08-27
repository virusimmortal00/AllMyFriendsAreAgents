import { useEffect, useId, useMemo, useState } from "react";
import { friendlyModelName } from "../shared/model-presentation";
import type { DiscoveredModel, ModelReference } from "../shared/model-discovery";
import { ApiRequestError, loadRoomConfiguration, updateRoomConfiguration, type RoomConfiguration } from "./api";
import { RichModelPicker } from "./model-picker";
import { useModalOverlay } from "./overlay";
import { PREFLIGHT_MODES, PREFLIGHT_MODE_LABELS, type PreflightEvidence, type PreflightMode } from "../shared/preflight";

export function RoomConfigurationDialog({ returnFocusTo, onClose }: { returnFocusTo: HTMLElement | null; onClose: () => void }) {
  const titleId = useId();
  const [saved, setSaved] = useState<RoomConfiguration>();
  const [basePromptText, setBasePromptText] = useState("");
  const [basePromptEnabled, setBasePromptEnabled] = useState(true);
  const [summarizerModel, setSummarizerModel] = useState<ModelReference | null>(null);
  const [summarizerPromptText, setSummarizerPromptText] = useState("");
  const [featureFlags, setFeatureFlags] = useState<Record<string, boolean>>({ preflightInvocationGating: false });
  const [preflightMode, setPreflightMode] = useState<PreflightMode>("off");
  const [routingEvidence, setRoutingEvidence] = useState<PreflightEvidence>();
  const [models, setModels] = useState<readonly DiscoveredModel[]>([]);
  const [defaultBasePrompt, setDefaultBasePrompt] = useState("");
  const [choosingModel, setChoosingModel] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const dirty = useMemo(() => Boolean(saved) && JSON.stringify({ basePromptText: basePromptEnabled ? basePromptText : null, summarizerModel, summarizerPromptText, featureFlags, preflightMode }) !== JSON.stringify({ basePromptText: saved?.basePromptText, summarizerModel: saved?.summarizerModel, summarizerPromptText: saved?.summarizerPromptText, featureFlags: saved?.featureFlags, preflightMode: saved?.preflightMode }), [saved, basePromptEnabled, basePromptText, summarizerModel, summarizerPromptText, featureFlags, preflightMode]);
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
      setPreflightMode(result.settings.preflightMode || "off");
      setRoutingEvidence(result.routingEvidence);
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
        ...(saved?.preflightMode !== preflightMode ? { preflightMode } : {}),
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
            <section className="room-configuration-card" aria-labelledby="routing-heading">
              <h3 id="routing-heading">Agent Routing</h3>
              <label>Pre-flight mode<select value={preflightMode} onChange={(event) => setPreflightMode(event.target.value as PreflightMode)}>
                {PREFLIGHT_MODES.map((mode) => <option value={mode} key={mode}>{PREFLIGHT_MODE_LABELS[mode].label}</option>)}
              </select></label>
              <p>{PREFLIGHT_MODE_LABELS[preflightMode].description}</p>
              <small data-testid="preflight-evidence">{routingEvidence?.recordedDecisions
                ? `${routingEvidence.evaluatedShadowSuppressions} evaluated shadow suppressions; ${routingEvidence.falseSuppressionRate === null ? "false-suppression rate unavailable" : `${(routingEvidence.falseSuppressionRate * 100).toFixed(1)}% false-suppression rate`}. ${routingEvidence.promotionEligible ? "Eligible for explicit owner/admin promotion." : "Not yet eligible for enforcement."}`
                : "No shadow routing evidence has been recorded yet."}</small>
            </section>
          </> : null}
        </div>
        <footer className="agent-settings-actions roster-actions"><span className={`roster-actions__status${dirty ? " roster-actions__status--dirty" : ""}`}>{dirty ? "Unsaved room settings" : "No unsaved changes"}</span><button type="button" className="classic-button" disabled={saving} onClick={onClose}>Cancel</button><button type="button" className="classic-button" disabled={!dirty || saving || !summarizerPromptText.trim()} onClick={() => void save()}>{saving ? "Saving…" : "Save settings"}</button></footer>
      </section>
    </div>
  );
}
