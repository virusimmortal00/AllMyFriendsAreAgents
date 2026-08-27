import { useDeferredValue, useEffect, useMemo, useState } from "react";
import type { DiscoveredModel, ModelOfferDetails } from "../shared/model-discovery";
import { modelKey } from "../shared/model-discovery";
import { modelAuthorId, providerDisplayName } from "../shared/model-presentation";
import { loadModelOfferDetails } from "./api";
import { ProviderMark } from "./provider-mark";

type ModelFilter = "all" | "popular" | "free" | "tools" | "vision" | "reasoning";
type ModelSort = "recommended" | "popular" | "price" | "newest" | "name";

const FILTERS: readonly { id: ModelFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "popular", label: "Popular" },
  { id: "free", label: "Free" },
  { id: "tools", label: "Tools" },
  { id: "vision", label: "Images" },
  { id: "reasoning", label: "Reasoning" },
];

function priceTotal(model: DiscoveredModel) {
  return (model.pricing?.inputPerMillion ?? Number.POSITIVE_INFINITY)
    + (model.pricing?.outputPerMillion ?? Number.POSITIVE_INFINITY);
}

function isFree(model: DiscoveredModel) {
  return model.modelId.endsWith(":free")
    || (model.pricing?.inputPerMillion === 0 && model.pricing?.outputPerMillion === 0);
}

function matchesFilter(model: DiscoveredModel, filter: ModelFilter) {
  if (filter === "all") return true;
  if (filter === "popular") return Boolean(model.popularity && model.popularity.rank <= 50);
  if (filter === "free") return isFree(model);
  if (filter === "tools") return model.capabilities?.toolCall === true;
  if (filter === "vision") return model.capabilities?.inputModalities?.some((item) => item === "image" || item === "video") === true;
  return model.capabilities?.reasoning === true || Boolean(model.capabilities?.reasoningEffort?.length);
}

function formatMoney(value: number | undefined) {
  if (value === undefined) return "—";
  if (value === 0) return "Free";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  if (value < 1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}

function formatTokens(value: number | undefined) {
  if (value === undefined) return "Unknown";
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(1))}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return String(value);
}

function estimateRun(model: DiscoveredModel) {
  const input = model.pricing?.inputPerMillion;
  const output = model.pricing?.outputPerMillion;
  if (input === undefined || output === undefined) return undefined;
  return input * 0.01 + output * 0.002;
}

function compareModels(sort: ModelSort) {
  return (left: DiscoveredModel, right: DiscoveredModel) => {
    if (sort === "name") return left.displayName.localeCompare(right.displayName);
    if (sort === "newest") return (right.releaseDate || "").localeCompare(left.releaseDate || "") || left.displayName.localeCompare(right.displayName);
    if (sort === "price") return priceTotal(left) - priceTotal(right) || left.displayName.localeCompare(right.displayName);
    if (sort === "popular") return (left.popularity?.rank ?? 100_000) - (right.popularity?.rank ?? 100_000) || left.displayName.localeCompare(right.displayName);
    const leftScore = (left.popularity ? Math.max(0, 110 - left.popularity.rank) : 0) + (left.capabilities?.toolCall ? 20 : 0) + (left.capabilities?.reasoning ? 8 : 0);
    const rightScore = (right.popularity ? Math.max(0, 110 - right.popularity.rank) : 0) + (right.capabilities?.toolCall ? 20 : 0) + (right.capabilities?.reasoning ? 8 : 0);
    return rightScore - leftScore || left.displayName.localeCompare(right.displayName);
  };
}

export function RichModelPicker({
  models,
  providerId,
  modelId,
  onChange,
  title = "Choose the agent’s model",
  description = "The model shapes what your agent is good at. A provider is the service that gives you access to it.",
}: {
  models: readonly DiscoveredModel[];
  providerId: string;
  modelId: string;
  onChange: (model: DiscoveredModel) => void;
  title?: string;
  description?: string;
}) {
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query.trim().toLocaleLowerCase());
  const [filter, setFilter] = useState<ModelFilter>("all");
  const [sort, setSort] = useState<ModelSort>("recommended");
  const [visibleCount, setVisibleCount] = useState(30);
  const [offerDetails, setOfferDetails] = useState<ModelOfferDetails>();
  const [offersLoading, setOffersLoading] = useState(false);
  const selected = models.find((model) => model.modelId === modelId && (model.providerId || "") === providerId);

  const filtered = useMemo(() => [...models].filter((model) => {
    if (!matchesFilter(model, filter)) return false;
    if (!deferredQuery) return true;
    const haystack = [model.displayName, model.modelId, model.description, model.authorDisplayName, model.accessProviderDisplayName, model.family]
      .filter(Boolean).join(" ").toLocaleLowerCase();
    return deferredQuery.split(/\s+/).every((term) => haystack.includes(term));
  }).sort(compareModels(sort)), [models, filter, deferredQuery, sort]);

  useEffect(() => { setVisibleCount(30); }, [filter, deferredQuery, sort]);

  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    setOfferDetails(undefined);
    setOffersLoading(false);
    if (!selected || selected.providerId !== "openrouter") return () => { current = false; controller.abort(); };
    setOffersLoading(true);
    void loadModelOfferDetails(selected.providerId, selected.modelId, controller.signal)
      .then((details) => { if (current) setOfferDetails(details); })
      .catch(() => { /* Pricing from the catalog remains useful if live offers fail. */ })
      .finally(() => { if (current) setOffersLoading(false); });
    return () => { current = false; controller.abort(); };
  }, [selected?.providerId, selected?.modelId]);

  const selectedAuthorId = selected ? selected.authorId || modelAuthorId(selected.providerId, selected.modelId) : undefined;
  const sale = offerDetails?.offers.reduce((best, offer) => Math.max(best, offer.discount || 0), 0) || 0;

  return (
    <section className="model-picker" aria-labelledby="model-picker-title">
      <div className="model-picker__intro">
        <div><strong id="model-picker-title">{title}</strong><span>{description}</span></div>
        <span className="model-picker__count">{models.length} available</span>
      </div>
      <div className="model-picker__toolbar">
        <label className="model-picker__search"><span>Search models</span><input type="search" value={query} placeholder="Try Gemini, Claude, coding…" onChange={(event) => setQuery(event.target.value)} /></label>
        <label className="model-picker__sort"><span>Sort</span><select value={sort} onChange={(event) => setSort(event.target.value as ModelSort)}><option value="recommended">Recommended</option><option value="popular">Most popular</option><option value="price">Lowest price</option><option value="newest">Newest</option><option value="name">Name</option></select></label>
      </div>
      <div className="model-picker__filters" aria-label="Filter models">{FILTERS.map((item) => <button type="button" className={filter === item.id ? "is-selected" : ""} aria-pressed={filter === item.id} key={item.id} onClick={() => setFilter(item.id)}>{item.label}</button>)}</div>
      <div className="model-picker__results" aria-label="Available models">
        {filtered.slice(0, visibleCount).map((model) => {
          const key = modelKey(model);
          const checked = model.modelId === modelId && (model.providerId || "") === providerId;
          const authorId = model.authorId || modelAuthorId(model.providerId, model.modelId);
          return (
            <button type="button" className={`model-card${checked ? " model-card--selected" : ""}`} aria-pressed={checked} key={key} onClick={() => onChange(model)}>
              <ProviderMark authorId={authorId} accessProviderId={model.providerId} />
              <span className="model-card__content">
                <span className="model-card__heading"><strong>{model.displayName}</strong><span className="model-card__badges">{model.popularity?.rank && model.popularity.rank <= 50 ? <em className="model-badge model-badge--popular">Popular #{model.popularity.rank}</em> : null}{isFree(model) ? <em className="model-badge model-badge--free">Free</em> : null}{model.capabilities?.reasoning ? <em className="model-badge">Reasoning</em> : null}{model.capabilities?.toolCall ? <em className="model-badge">Tools</em> : null}</span></span>
                <span className="model-card__provider">By {model.authorDisplayName || providerDisplayName(authorId)}{model.providerId && model.providerId !== authorId ? ` · via ${model.accessProviderDisplayName || providerDisplayName(model.providerId)}` : ""}</span>
                {model.description ? <span className="model-card__description">{model.description}</span> : null}
                <span className="model-card__facts"><span><b>Input</b> {formatMoney(model.pricing?.inputPerMillion)}/1M</span><span><b>Output</b> {formatMoney(model.pricing?.outputPerMillion)}/1M</span><span><b>Context</b> {formatTokens(model.limits?.context)}</span></span>
                <span className="model-card__action">Choose this model&nbsp; →</span>
              </span>
            </button>
          );
        })}
        {!filtered.length ? <p className="model-picker__empty">No available models match those filters.</p> : null}
      </div>
      {visibleCount < filtered.length ? <button type="button" className="classic-button model-picker__more" onClick={() => setVisibleCount((count) => count + 30)}>Show 30 more</button> : null}
      {selected ? (
        <div className="model-detail" aria-live="polite">
          <div className="model-detail__summary">
            <ProviderMark authorId={selectedAuthorId} accessProviderId={selected.providerId} />
            <div><strong>{selected.displayName}</strong><span>Built by {selected.authorDisplayName || providerDisplayName(selectedAuthorId)}{selected.providerId && selected.providerId !== selectedAuthorId ? ` · accessed through ${selected.accessProviderDisplayName || providerDisplayName(selected.providerId)}` : ""}</span></div>
            {sale > 0 ? <em className="model-badge model-badge--sale">Save {Math.round(sale * 100)}%</em> : null}
          </div>
          <div className="model-detail__costs"><span><b>{formatMoney(selected.pricing?.inputPerMillion)}</b> input / 1M tokens</span><span><b>{formatMoney(selected.pricing?.outputPerMillion)}</b> output / 1M tokens</span><span><b>{estimateRun(selected) === undefined ? "—" : formatMoney(estimateRun(selected))}</b> example run*</span></div>
          <small>*Rough estimate for 10K input and 2K output tokens. Actual cost depends on usage and the provider route selected at request time.</small>
          {selected.providerId === "openrouter" ? <div className="model-offers"><strong>OpenRouter provider offers</strong>{offersLoading ? <span role="status">Checking live prices and promotions…</span> : offerDetails?.offers.length ? offerDetails.offers.slice(0, 6).map((offer) => <div className="model-offer" key={offer.providerId || offer.providerName}><ProviderMark authorId={offer.providerId} compact /><span><b>{offer.providerName}</b>{offer.uptime !== undefined ? <small>{Math.round(offer.uptime * 100)}% uptime</small> : null}</span><span>{formatMoney(offer.inputPerMillion)} in · {formatMoney(offer.outputPerMillion)} out</span>{offer.discount ? <em className="model-badge model-badge--sale">{Math.round(offer.discount * 100)}% off</em> : null}</div>) : <span>Live provider offers are unavailable right now; catalog pricing is shown above.</span>}</div> : null}
          {selected.capabilities?.toolCall === false ? <p className="model-detail__warning">This model does not report tool support, so it may not be suitable for an agent that needs to take actions.</p> : null}
        </div>
      ) : null}
    </section>
  );
}
