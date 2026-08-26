import type { DiscoveredModel, ModelDiscoveryResult, ModelOffer, ModelOfferDetails, ModelPricing } from "../shared/model-discovery.js";

const CATALOG_TTL_MS = 15 * 60_000;
const OFFER_TTL_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 2_500;

type OpenRouterModel = {
  id?: unknown;
  name?: unknown;
  description?: unknown;
  context_length?: unknown;
  created?: unknown;
  pricing?: { prompt?: unknown; completion?: unknown };
  supported_parameters?: unknown;
  architecture?: { input_modalities?: unknown; output_modalities?: unknown };
  benchmarks?: { artificial_analysis?: { intelligence_index?: unknown; coding_index?: unknown; agentic_index?: unknown } };
};

type OpenRouterEndpoint = {
  name?: unknown;
  provider_name?: unknown;
  tag?: unknown;
  pricing?: { prompt?: unknown; completion?: unknown; discount?: unknown };
  uptime_last_30m?: unknown;
  latency_last_30m?: unknown;
  throughput_last_30m?: unknown;
};

function finite(value: unknown) {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function perMillion(value: unknown) {
  const number = finite(value);
  return number === undefined ? undefined : number * 1_000_000;
}

function ratio(value: unknown) {
  const number = finite(value);
  if (number === undefined) return undefined;
  if (number <= 1) return number;
  return number <= 100 ? number / 100 : undefined;
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, 20) : [];
}

function friendlyOpenRouterName(value: unknown, authorDisplayName: string | undefined, fallback: string) {
  if (typeof value !== "string" || !value.trim()) return fallback;
  const name = value.trim();
  const prefix = authorDisplayName ? `${authorDisplayName}: ` : "";
  return (prefix && name.toLocaleLowerCase().startsWith(prefix.toLocaleLowerCase()) ? name.slice(prefix.length) : name).slice(0, 160);
}

export class OpenRouterCatalogService {
  private catalog?: { expiresAt: number; promise: Promise<Map<string, OpenRouterModel>> };
  private readonly offers = new Map<string, { expiresAt: number; promise: Promise<ModelOfferDetails> }>();

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async enrich(result: ModelDiscoveryResult): Promise<ModelDiscoveryResult> {
    if (!result.models.some((model) => model.providerId === "openrouter")) return result;
    try {
      const catalog = await this.models();
      return { ...result, models: result.models.map((model) => this.enrichModel(model, catalog.get(model.modelId.replace(/^~/, "")))) };
    } catch {
      return result;
    }
  }

  async details(providerId: string, modelId: string): Promise<ModelOfferDetails | undefined> {
    if (providerId !== "openrouter" || !/^[~A-Za-z0-9][A-Za-z0-9._:/+@~-]{1,199}$/.test(modelId)) return undefined;
    const canonical = modelId.replace(/^~/, "");
    const slash = canonical.indexOf("/");
    if (slash <= 0 || slash === canonical.length - 1) return undefined;
    const cached = this.offers.get(canonical);
    if (cached && cached.expiresAt > this.now()) return cached.promise;
    const promise = this.fetchOffers(canonical).catch((error) => {
      this.offers.delete(canonical);
      throw error;
    });
    this.offers.set(canonical, { expiresAt: this.now() + OFFER_TTL_MS, promise });
    return promise;
  }

  private models() {
    if (this.catalog && this.catalog.expiresAt > this.now()) return this.catalog.promise;
    const promise = this.fetchModels().catch((error) => {
      this.catalog = undefined;
      throw error;
    });
    this.catalog = { expiresAt: this.now() + CATALOG_TTL_MS, promise };
    return promise;
  }

  private async fetchJson(url: string) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(url, { headers: { Accept: "application/json" }, signal: controller.signal });
      if (!response.ok) throw new Error(`OpenRouter catalog returned ${response.status}.`);
      return await response.json() as unknown;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async fetchModels() {
    const payload = await this.fetchJson("https://openrouter.ai/api/v1/models?sort=most-popular");
    const data = payload && typeof payload === "object" && Array.isArray((payload as { data?: unknown }).data)
      ? (payload as { data: OpenRouterModel[] }).data
      : [];
    const models = new Map<string, OpenRouterModel>();
    for (const [index, model] of data.slice(0, 1_000).entries()) {
      if (typeof model.id !== "string" || model.id.length > 200) continue;
      models.set(model.id, { ...model, popularityRank: index + 1 } as OpenRouterModel & { popularityRank: number });
    }
    return models;
  }

  private enrichModel(model: DiscoveredModel, remote: OpenRouterModel | undefined): DiscoveredModel {
    if (!remote) return model;
    const parameters = new Set(stringArray(remote.supported_parameters));
    const inputModalities = stringArray(remote.architecture?.input_modalities);
    const outputModalities = stringArray(remote.architecture?.output_modalities);
    const pricing: ModelPricing = {
      inputPerMillion: perMillion(remote.pricing?.prompt) ?? model.pricing?.inputPerMillion,
      outputPerMillion: perMillion(remote.pricing?.completion) ?? model.pricing?.outputPerMillion,
      cacheReadPerMillion: model.pricing?.cacheReadPerMillion,
      cacheWritePerMillion: model.pricing?.cacheWritePerMillion,
    };
    const scores = remote.benchmarks?.artificial_analysis;
    const rank = finite((remote as OpenRouterModel & { popularityRank?: unknown }).popularityRank);
    return {
      ...model,
      displayName: friendlyOpenRouterName(remote.name, model.authorDisplayName, model.displayName),
      ...(typeof remote.description === "string" && remote.description.trim() ? { description: remote.description.trim().replace(/\s+/g, " ").slice(0, 420) } : {}),
      pricing,
      limits: { ...model.limits, ...(finite(remote.context_length) !== undefined ? { context: finite(remote.context_length) } : {}) },
      ...(finite(remote.created) !== undefined ? { releaseDate: new Date(finite(remote.created)! * 1_000).toISOString().slice(0, 10) } : {}),
      ...(rank !== undefined ? { popularity: { rank, window: "weekly", source: "openrouter" } } : {}),
      ...(scores && [scores.intelligence_index, scores.coding_index, scores.agentic_index].some((value) => finite(value) !== undefined) ? { benchmarks: {
        ...(finite(scores.intelligence_index) !== undefined ? { intelligence: finite(scores.intelligence_index) } : {}),
        ...(finite(scores.coding_index) !== undefined ? { coding: finite(scores.coding_index) } : {}),
        ...(finite(scores.agentic_index) !== undefined ? { agentic: finite(scores.agentic_index) } : {}),
      } } : {}),
      capabilities: {
        ...model.capabilities,
        reasoning: model.capabilities?.reasoning ?? (parameters.has("reasoning") || parameters.has("include_reasoning")),
        toolCall: model.capabilities?.toolCall ?? parameters.has("tools"),
        inputModalities: inputModalities.length ? inputModalities : model.capabilities?.inputModalities,
        outputModalities: outputModalities.length ? outputModalities : model.capabilities?.outputModalities,
      },
    };
  }

  private async fetchOffers(canonicalModelId: string): Promise<ModelOfferDetails> {
    const slash = canonicalModelId.indexOf("/");
    const author = canonicalModelId.slice(0, slash);
    const slug = canonicalModelId.slice(slash + 1);
    const payload = await this.fetchJson(`https://openrouter.ai/api/v1/models/${encodeURIComponent(author)}/${encodeURIComponent(slug)}/endpoints`);
    const endpoints = payload && typeof payload === "object" && (payload as { data?: unknown }).data && typeof (payload as { data: unknown }).data === "object"
      && Array.isArray(((payload as { data: { endpoints?: unknown } }).data).endpoints)
      ? (payload as { data: { endpoints: OpenRouterEndpoint[] } }).data.endpoints
      : [];
    const grouped = new Map<string, ModelOffer>();
    for (const endpoint of endpoints.slice(0, 100)) {
      const providerName = typeof endpoint.provider_name === "string" ? endpoint.provider_name.slice(0, 100) : typeof endpoint.name === "string" ? endpoint.name.split("|")[0].trim().slice(0, 100) : "OpenRouter provider";
      const providerId = typeof endpoint.tag === "string" ? endpoint.tag.split("/")[0].slice(0, 100) : undefined;
      const discount = finite(endpoint.pricing?.discount);
      const offer: ModelOffer = {
        providerName,
        ...(providerId ? { providerId } : {}),
        ...(perMillion(endpoint.pricing?.prompt) !== undefined ? { inputPerMillion: perMillion(endpoint.pricing?.prompt) } : {}),
        ...(perMillion(endpoint.pricing?.completion) !== undefined ? { outputPerMillion: perMillion(endpoint.pricing?.completion) } : {}),
        ...(discount !== undefined && discount > 0 && discount < 1 ? { discount } : {}),
        ...(ratio(endpoint.uptime_last_30m) !== undefined ? { uptime: ratio(endpoint.uptime_last_30m) } : {}),
        ...(finite(endpoint.latency_last_30m) !== undefined ? { latencySeconds: finite(endpoint.latency_last_30m) } : {}),
        ...(finite(endpoint.throughput_last_30m) !== undefined ? { throughputTokensPerSecond: finite(endpoint.throughput_last_30m) } : {}),
      };
      const key = providerId || providerName;
      const previous = grouped.get(key);
      const offerPrice = (offer.inputPerMillion || 0) + (offer.outputPerMillion || 0);
      const previousPrice = (previous?.inputPerMillion || 0) + (previous?.outputPerMillion || 0);
      if (!previous || offerPrice < previousPrice) grouped.set(key, offer);
    }
    return { providerId: "openrouter", modelId: canonicalModelId, offers: [...grouped.values()].sort((a, b) => ((a.inputPerMillion || 0) + (a.outputPerMillion || 0)) - ((b.inputPerMillion || 0) + (b.outputPerMillion || 0))).slice(0, 16), fetchedAt: new Date(this.now()).toISOString() };
  }
}
