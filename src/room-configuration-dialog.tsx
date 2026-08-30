import { useEffect, useMemo, useState } from "react";
import { friendlyModelName } from "../shared/model-presentation";
import type { DiscoveredModel, ModelReference } from "../shared/model-discovery";
import { ApiRequestError, loadRoomConfiguration, loadRoomConfigurationModels, updateRoomConfiguration, type RoomConfiguration } from "./api";
import { RichModelPicker } from "./model-picker";
import { PREFLIGHT_MODES, PREFLIGHT_MODE_LABELS, type PreflightEvidence, type PreflightMode } from "../shared/preflight";
import { DialogFrame } from "./dialog-frame";
import { RoomControls, type RoomSettingsInput } from "./components";
import { VIEWS } from "./view-registry";

type PropertiesPage = "general" | "agent-behavior";

interface RoomPropertiesDialogProps extends RoomSettingsInput {
  disabled: boolean;
  returnFocusTo: HTMLElement | null;
  onSave: (settings: RoomSettingsInput) => void | Promise<void>;
  onClose: () => void;
}

function RoomConfigurationPanel({ active, onClose }: { active: boolean; onClose: () => void }) {
  const [saved, setSaved] = useState<RoomConfiguration>();
  const [basePromptText, setBasePromptText] = useState("");
  const [basePromptEnabled, setBasePromptEnabled] = useState(true);
  const [summarizerModel, setSummarizerModel] = useState<ModelReference | null>(null);
  const [summarizerPromptText, setSummarizerPromptText] = useState("");
  const [featureFlags, setFeatureFlags] = useState<Record<string, boolean>>({ preflightInvocationGating: false });
  const [preflightMode, setPreflightMode] = useState<PreflightMode>("off");
  const [routingEvidence, setRoutingEvidence] = useState<PreflightEvidence>();
  const [models, setModels] = useState<readonly DiscoveredModel[]>([]);
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelError, setModelError] = useState("");
  const [defaultBasePrompt, setDefaultBasePrompt] = useState("");
  const [choosingModel, setChoosingModel] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const dirty = useMemo(() => Boolean(saved) && JSON.stringify({ basePromptText: basePromptEnabled ? basePromptText : null, summarizerModel, summarizerPromptText, featureFlags, preflightMode }) !== JSON.stringify({ basePromptText: saved?.basePromptText, summarizerModel: saved?.summarizerModel, summarizerPromptText: saved?.summarizerPromptText, featureFlags: saved?.featureFlags, preflightMode: saved?.preflightMode }), [saved, basePromptEnabled, basePromptText, summarizerModel, summarizerPromptText, featureFlags, preflightMode]);

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
      setPreflightMode(result.settings.preflightMode || "off");
      setRoutingEvidence(result.routingEvidence);
      setDefaultBasePrompt(result.defaults?.basePromptText || "");
    }).catch((failure) => { if (current) setError(failure instanceof Error ? failure.message : "Could not load agent behavior."); }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [active, retryCount]);

  async function showModels() {
    if (choosingModel) {
      setChoosingModel(false);
      return;
    }
    setChoosingModel(true);
    if (modelsLoaded || modelsLoading) return;
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
      };
      const result = await updateRoomConfiguration(update);
      setSaved(result.settings);
      if (closeAfter) onClose();
    } catch (failure) {
      setError(failure instanceof ApiRequestError && failure.status === 401 ? "Sign in as a server administrator through Manage agents, then try again." : failure instanceof Error ? failure.message : "Could not save agent behavior.");
    } finally { setSaving(false); }
  }

  const modelLabel = summarizerModel ? friendlyModelName(summarizerModel.modelId) : "No summarizer configured";
  return <section className="room-configuration-panel" role="tabpanel" id="room-properties-agent-panel" aria-labelledby="room-properties-agent-tab" hidden={!active}>
    <div className="room-properties-page-content">
      {loading ? <p role="status">Loading agent behavior…</p> : null}
      {error ? <div role="alert" className="room-settings-error"><p>{error}</p>{!saved && !loading ? <button type="button" className="classic-button" onClick={() => setRetryCount((value) => value + 1)}>Retry</button> : null}</div> : null}
      {!loading && saved ? <>
        <section className="room-configuration-card classic-group" aria-labelledby="base-prompt-heading">
          <h3 id="base-prompt-heading">Base Prompt</h3>
          <p>Applied after each agent’s identity rules on every turn.</p>
          <label className="room-configuration-check"><input type="checkbox" checked={basePromptEnabled} onChange={(event) => setBasePromptEnabled(event.target.checked)} /> Include a room base prompt</label>
          <label>Prompt<textarea rows={7} maxLength={4000} disabled={!basePromptEnabled} value={basePromptText} onChange={(event) => setBasePromptText(event.target.value)} /></label>
          <button type="button" className="classic-button" disabled={!basePromptEnabled || basePromptText === defaultBasePrompt} onClick={() => setBasePromptText(defaultBasePrompt)}>Use built-in default</button>
          <small>Revision {saved.basePromptRevision}. An empty value resolves to the built-in default; disabling removes this section explicitly.</small>
        </section>
        <section className="room-configuration-card classic-group" aria-labelledby="summarizer-heading">
          <h3 id="summarizer-heading">Summarizer</h3>
          <p>Used only for cold starts and large deltas. Verbatim history remains the source of truth.</p>
          <div className="room-configuration-model"><strong>{modelLabel}</strong><button type="button" className="classic-button" onClick={() => void showModels()}>{choosingModel ? "Hide models" : "Choose model…"}</button></div>
          {choosingModel && modelsLoading ? <p role="status">Loading available models…</p> : null}
          {choosingModel && modelError ? <p role="alert" className="room-settings-error">{modelError} <button type="button" className="classic-button" onClick={() => { setChoosingModel(false); void showModels(); }}>Retry</button></p> : null}
          {choosingModel && modelsLoaded ? <RichModelPicker models={models} providerId={summarizerModel?.providerId || ""} modelId={summarizerModel?.modelId || ""} title="Choose the room summarizer" description="This internal model creates bounded cold-start navigation summaries." view={VIEWS.roomSummarizerModelPicker} onChange={(model) => { setSummarizerModel({ ...(model.providerId ? { providerId: model.providerId } : {}), modelId: model.modelId }); setChoosingModel(false); }} /> : null}
          <label>Prompt template<textarea rows={9} maxLength={8000} value={summarizerPromptText} onChange={(event) => setSummarizerPromptText(event.target.value)} /></label>
          <small>Revision {saved.summarizerPromptRevision}. Keep {"{{transcript}}"} where verbatim input should be inserted. DeepSeek V4 Flash remains the built-in failover route.</small>
        </section>
        <section className="room-configuration-card classic-group" aria-labelledby="routing-heading">
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
    {!loading && saved ? <div className="room-settings-actions">
        <button type="button" className="classic-button" data-default-button disabled={saving || !summarizerPromptText.trim()} onClick={() => void save(true)}>{saving ? "Saving…" : "OK"}</button>
        <button type="button" className="classic-button" disabled={saving} onClick={onClose}>Cancel</button>
        <button type="button" className="classic-button" disabled={!dirty || saving || !summarizerPromptText.trim()} onClick={() => void save(false)}>Apply</button>
      </div> : null}
  </section>;
}

export function RoomPropertiesDialog({ returnFocusTo, onClose, ...general }: RoomPropertiesDialogProps) {
  const [page, setPage] = useState<PropertiesPage>("general");
  return <DialogFrame title="Room Properties" closeLabel="Close Room Properties" className="room-properties-window" backdropClassName="room-settings-backdrop" bodyClassName="room-properties-body" returnFocusTo={returnFocusTo} onClose={onClose} dataPresentation={page} view={page === "general" ? VIEWS.roomPropertiesGeneral : VIEWS.roomPropertiesAgentBehavior}>
    <div className="classic-tabs" role="tablist" aria-label="Room property pages">
      <button type="button" role="tab" id="room-properties-general-tab" aria-selected={page === "general"} aria-controls="room-properties-general-panel" onClick={() => setPage("general")}>General</button>
      <button type="button" role="tab" id="room-properties-agent-tab" aria-selected={page === "agent-behavior"} aria-controls="room-properties-agent-panel" onClick={() => setPage("agent-behavior")}>Agent behavior</button>
    </div>
    <section role="tabpanel" id="room-properties-general-panel" aria-labelledby="room-properties-general-tab" hidden={page !== "general"}>
      <RoomControls {...general} showTitle={false} propertySheet onCancel={onClose} onSaved={onClose} />
    </section>
    <RoomConfigurationPanel active={page === "agent-behavior"} onClose={onClose} />
  </DialogFrame>;
}

export function RoomConfigurationDialog({ returnFocusTo, onClose }: { returnFocusTo: HTMLElement | null; onClose: () => void }) {
  return <DialogFrame title="Room Properties" closeLabel="Close Room Properties" className="room-properties-window" backdropClassName="room-settings-backdrop" bodyClassName="room-properties-body" returnFocusTo={returnFocusTo} onClose={onClose} view={VIEWS.roomPropertiesAgentBehavior}>
    <RoomConfigurationPanel active onClose={onClose} />
  </DialogFrame>;
}
