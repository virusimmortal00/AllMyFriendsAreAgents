import { useEffect, useMemo, useRef, useState } from "react";
import { AGENT_BEHAVIOR_RULES } from "../shared/agent-behavior";
import { friendlyModelName } from "../shared/model-presentation";
import type { DiscoveredModel, ModelReference } from "../shared/model-discovery";
import { ApiRequestError, loadRoomConfiguration, loadRoomConfigurationModels, updateRoomConfiguration, type RoomConfiguration } from "./api";
import { RichModelPicker } from "./model-picker";
import { DEFAULT_PREFLIGHT_MODE, PREFLIGHT_MODES, PREFLIGHT_MODE_LABELS, type PreflightEvidence, type PreflightMode } from "../shared/preflight";
import { DialogFrame } from "./dialog-frame";
import { RoomControls, type RoomSettingsInput } from "./components";
import { VIEWS, viewAttributes } from "./view-registry";

interface RoomPropertiesDialogProps extends RoomSettingsInput {
  active?: boolean;
  repository?: string;
  disabled: boolean;
  returnFocusTo: HTMLElement | null;
  onOpenRepositorySettings?: () => void;
  onSave: (settings: RoomSettingsInput) => void | Promise<void>;
  onClose: () => void;
}

export function RoomConfigurationPanel({ active, onClose, onDirtyChange }: { active: boolean; onClose: () => void; onDirtyChange?: (dirty: boolean) => void }) {
  const pickerRef = useRef<HTMLDivElement>(null);
  const modelTriggerRef = useRef<HTMLButtonElement>(null);
  const [saved, setSaved] = useState<RoomConfiguration>();
  const [basePromptText, setBasePromptText] = useState("");
  const [basePromptEnabled, setBasePromptEnabled] = useState(true);
  const [summarizerModel, setSummarizerModel] = useState<ModelReference | null>(null);
  const [summarizerPromptText, setSummarizerPromptText] = useState("");
  const [featureFlags, setFeatureFlags] = useState<Record<string, boolean>>({ preflightInvocationGating: false });
  const [preflightMode, setPreflightMode] = useState<PreflightMode>(DEFAULT_PREFLIGHT_MODE);
  const [intentClassifierEnabled, setIntentClassifierEnabled] = useState(true);
  const [routingEvidence, setRoutingEvidence] = useState<PreflightEvidence>();
  const [models, setModels] = useState<readonly DiscoveredModel[]>([]);
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelError, setModelError] = useState("");
  const [defaultBasePrompt, setDefaultBasePrompt] = useState("");
  const [choosingModel, setChoosingModel] = useState(false);
  useEffect(() => {
    if (active && choosingModel && modelsLoaded) pickerRef.current?.scrollIntoView?.({ block: "start", behavior: "instant" });
  }, [active, choosingModel, modelsLoaded]);
  const [retryCount, setRetryCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const dirty = useMemo(() => Boolean(saved) && JSON.stringify({ basePromptText: basePromptEnabled ? basePromptText : null, summarizerModel, summarizerPromptText, featureFlags, preflightMode, intentClassifierEnabled }) !== JSON.stringify({ basePromptText: saved?.basePromptText, summarizerModel: saved?.summarizerModel, summarizerPromptText: saved?.summarizerPromptText, featureFlags: saved?.featureFlags, preflightMode: saved?.preflightMode, intentClassifierEnabled: saved?.intentClassifierEnabled }), [saved, basePromptEnabled, basePromptText, summarizerModel, summarizerPromptText, featureFlags, preflightMode, intentClassifierEnabled]);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(() => {
    if (!active || saved) return;
    let current = true;
    setLoading(true);
    setError("");
    void loadRoomConfiguration().then((result) => {
      if (!current) return;
      setSaved(result.settings);
      setBasePromptEnabled(result.settings.basePromptText !== null);
      setBasePromptText(result.settings.basePromptText || "");
      setSummarizerModel(result.settings.summarizerModel);
      setSummarizerPromptText(result.settings.summarizerPromptText);
      setFeatureFlags(result.settings.featureFlags);
      setPreflightMode(result.settings.preflightMode || DEFAULT_PREFLIGHT_MODE);
      setIntentClassifierEnabled(result.settings.intentClassifierEnabled !== false);
      setRoutingEvidence(result.routingEvidence);
      setDefaultBasePrompt(result.defaults?.basePromptText || "");
    }).catch((failure) => { if (current) setError(failure instanceof Error ? failure.message : "Could not load agent behavior."); }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [active, retryCount]);

  async function fetchModels() {
    if (modelsLoading) return;
    setModelsLoading(true);
    setModelError("");
    try {
      const result = await loadRoomConfigurationModels();
      setModels(result.models || []);
      setModelsLoaded(true);
    } catch (failure) {
      setModelError(failure instanceof Error ? failure.message : "Could not load the model catalog.");
    } finally {
      setModelsLoading(false);
    }
  }

  function toggleModels() {
    const shouldShow = !choosingModel;
    setChoosingModel(shouldShow);
    if (shouldShow && !modelsLoaded && !modelsLoading) void fetchModels();
  }

  async function save(closeAfter: boolean) {
    if (!dirty || saving) {
      if (closeAfter && !dirty) onClose();
      return;
    }
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
        ...(saved?.intentClassifierEnabled !== intentClassifierEnabled ? { intentClassifierEnabled } : {}),
      };
      const result = await updateRoomConfiguration(update);
      setSaved(result.settings);
      if (closeAfter) onClose();
    } catch (failure) {
      const requiresSignIn = failure instanceof ApiRequestError && [401, 403].includes(failure.status || 0);
      setError(requiresSignIn ? "Your administrator session expired. Sign in again from Owner login, then return to apply these changes." : failure instanceof Error ? failure.message : "Could not save agent behavior.");
    } finally { setSaving(false); }
  }

  const modelLabel = summarizerModel ? friendlyModelName(summarizerModel.modelId) : "No summarizer configured";
  const closeModels = () => {
    setChoosingModel(false);
    modelTriggerRef.current?.focus();
  };
  return <section className="room-configuration-panel" aria-label="Room behavior" hidden={!active}>
    <div className="room-properties-page-content">
      {loading ? <p role="status">Loading agent behavior…</p> : null}
      {error ? <div role="alert" className="room-settings-error"><p>{error}</p>{!saved && !loading ? <button type="button" className="classic-button" onClick={() => setRetryCount((value) => value + 1)}>Retry</button> : null}</div> : null}
      {!loading && saved ? <>
        <section className="room-configuration-card classic-property-section" aria-labelledby="base-prompt-heading">
          <h3 id="base-prompt-heading">Base Prompt</h3>
          <p>Each turn includes the agent’s identity, shared behavior rules, and any additional room prompt below.</p>
          <details className="room-behavior-rules">
            <summary onKeyDown={(event) => { if (event.key === "Enter") event.stopPropagation(); }}>Shared behavior rules · always included</summary>
            <p>Read-only guidance for every agent, even when the room base prompt is disabled. Each turn also receives the current UTC date, time, and weekday.</p>
            <ol>{AGENT_BEHAVIOR_RULES.map((rule) => <li key={rule}>{rule}</li>)}</ol>
          </details>
          <label className="classic-check"><input type="checkbox" checked={basePromptEnabled} onChange={(event) => setBasePromptEnabled(event.target.checked)} /><span>Include a room base prompt</span></label>
          <div className="classic-field-heading"><label htmlFor="room-base-prompt">Additional room prompt</label><button type="button" className="classic-button" disabled={!basePromptEnabled || basePromptText === defaultBasePrompt} onClick={() => setBasePromptText(defaultBasePrompt)}>Use built-in default</button></div>
          <textarea id="room-base-prompt" aria-describedby="room-base-prompt-help" rows={4} maxLength={4000} disabled={!basePromptEnabled} value={basePromptText} onChange={(event) => setBasePromptText(event.target.value)} />
          <small id="room-base-prompt-help">Revision {saved.basePromptRevision}. An empty value resolves to the built-in default; disabling removes only this additional prompt. Shared behavior rules remain included.</small>
        </section>
        <section className="room-configuration-card classic-property-section" aria-labelledby="summarizer-heading">
          <h3 id="summarizer-heading">Summarizer</h3>
          <p>Used only for cold starts and large deltas. Verbatim history remains the source of truth.</p>
          <div className="room-configuration-model"><strong>{modelLabel}</strong><button ref={modelTriggerRef} type="button" className="classic-button" onClick={toggleModels}>{choosingModel ? "Hide models" : "Choose model…"}</button></div>
          {choosingModel && modelsLoading ? <p role="status">Loading available models…</p> : null}
          {choosingModel && modelError ? <p role="alert" className="room-settings-error">{modelError} <button type="button" className="classic-button" onClick={() => void fetchModels()}>Retry</button></p> : null}
          {choosingModel && modelsLoaded ? <div ref={pickerRef} className="room-model-selection" {...viewAttributes(VIEWS.roomSummarizerModelPicker)}><div className="room-model-selection__navigation"><button type="button" className="classic-button" onClick={closeModels}>Back to agent behavior</button></div><RichModelPicker models={models} providerId={summarizerModel?.providerId || ""} modelId={summarizerModel?.modelId || ""} title="Choose the room summarizer" description="Creates concise summaries when agents need earlier room context." onChange={(model) => { setSummarizerModel({ ...(model.providerId ? { providerId: model.providerId } : {}), modelId: model.modelId }); closeModels(); }} /></div> : null}
          <label>Prompt template<textarea aria-describedby="room-summarizer-prompt-help" rows={4} maxLength={8000} value={summarizerPromptText} onChange={(event) => setSummarizerPromptText(event.target.value)} /></label>
          <small id="room-summarizer-prompt-help">Revision {saved.summarizerPromptRevision}. Keep {"{{transcript}}"} where verbatim input should be inserted. DeepSeek V4 Flash remains the built-in failover route.</small>
        </section>
        <section className="room-configuration-card classic-property-section" aria-labelledby="routing-heading">
          <h3 id="routing-heading">Agent Routing</h3>
          <label className="classic-property-row"><span>Pre-flight mode</span><select className="classic-select" value={preflightMode} onChange={(event) => setPreflightMode(event.target.value as PreflightMode)}>
            {PREFLIGHT_MODES.map((mode) => <option value={mode} key={mode}>{PREFLIGHT_MODE_LABELS[mode].label}</option>)}
          </select></label>
          <p>{PREFLIGHT_MODE_LABELS[preflightMode].description}</p>
          <label className="classic-check"><input type="checkbox" checked={intentClassifierEnabled} onChange={(event) => setIntentClassifierEnabled(event.target.checked)} /><span>Intent classifier (Jev via OpenRouter)</span></label>
          <p>When pre-flight routing is Shadow or Enforce, a fast typed-decision model checks whether each message directly addresses each agent before any agent is invoked. On by default; disable to route with deterministic signals only. Routing evidence records classifier cost and latency either way.</p>

          <small data-testid="preflight-evidence">{routingEvidence?.recordedDecisions
            ? `${routingEvidence.evaluatedShadowSuppressions} evaluated shadow suppressions; ${routingEvidence.falseSuppressionRate === null ? "false-suppression rate unavailable" : `${(routingEvidence.falseSuppressionRate * 100).toFixed(1)}% false-suppression rate`}. Mode changes take effect immediately.`
            : "No routing evidence has been recorded yet. Mode changes take effect immediately."}</small>
        </section>
      </> : null}
    </div>
    {!loading && saved ? <div className="room-settings-actions">
        <button type="button" className="classic-button" data-default-button disabled={saving || !summarizerPromptText.trim()} onClick={() => void save(true)}>{saving ? "Saving…" : "OK"}</button>
        <button type="button" className="classic-button" disabled={saving} onClick={onClose}>Cancel</button>
        <button type="button" className="classic-button" disabled={!dirty || saving || !summarizerPromptText.trim()} onClick={() => void save(false)}>Apply</button>
      </div> : null}
  </section>;
}

export function RoomPropertiesDialog({ returnFocusTo, onClose, active = true, onOpenRepositorySettings, ...general }: RoomPropertiesDialogProps) {
  return <DialogFrame active={active} title="Room Properties" layout="property-sheet" closeLabel="Close Room Properties" className="room-properties-window" backdropClassName="room-settings-backdrop" bodyClassName="room-properties-body classic-scrollbars" returnFocusTo={returnFocusTo} onClose={onClose} view={VIEWS.roomPropertiesGeneral}>
    <RoomControls {...general} showTitle={false} propertySheet {...(onOpenRepositorySettings ? { onOpenRepositorySettings } : {})} onCancel={onClose} onSaved={onClose} />
  </DialogFrame>;
}
