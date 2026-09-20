import type { DiscoveredModel, ModelDiscoveryResult, ModelOffer, ModelOfferDetails, ModelPricing } from "../shared/model-discovery.js";
import type { OpenRouterCreditBalance } from "../shared/openrouter-usage.js";
import { parseOpenRouterModelPageUrl, type OpenRouterModelPageResolution } from "../shared/openrouter-model-page.js";
import { readOpenRouterApiKey } from "./openrouter-credentials.js";

const CATALOG_TTL_MS = 15 * 60_000;
const OFFER_TTL_MS = 5 * 60_000;
const CREDITS_TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 2_500;
const MODEL_PAGE_LIMIT_BYTES = 512 * 1024;

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

function delimitedLabel(value: unknown, delimiter?: string) {
  if (typeof value !== "string") return undefined;
  const label = (delimiter ? value.split(delimiter).at(0) : value)?.trim();
  return label ? label.slice(0, 100) : undefined;
}

function releaseDate(value: unknown) {
  const seconds = finite(value);
  if (seconds === undefined) return undefined;
  const date = new Date(seconds * 1_000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString().slice(0, 10);
}

function friendlyOpenRouterName(value: unknown, authorDisplayName: string | undefined, fallback: string) {
  if (typeof value !== "string" || !value.trim()) return fallback;
  const name = value.trim();
  const prefix = authorDisplayName ? `${authorDisplayName}: ` : "";
  return (prefix && name.toLocaleLowerCase().startsWith(prefix.toLocaleLowerCase()) ? name.slice(prefix.length) : name).slice(0, 160);
}

export class OpenRouterCatalogService {
  private catalog: { expiresAt: number; promise: Promise<Map<string, OpenRouterModel>> } | undefined;
  private readonly offers = new Map<string, { expiresAt: number; promise: Promise<ModelOfferDetails> }>();
  private creditsCache: { expiresAt: number; promise: Promise<OpenRouterCreditBalance | undefined> } | undefined;

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
    private readonly apiKey: (env?: NodeJS.ProcessEnv) => Promise<string | undefined> = readOpenRouterApiKey,
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

  async resolveModelPage(value: string, availableModels: readonly DiscoveredModel[]): Promise<OpenRouterModelPageResolution | undefined> {
    const reference = parseOpenRouterModelPageUrl(value);
    if (!reference) return undefined;
    const available = new Set(availableModels.flatMap((model) => model.providerId === "openrouter" ? [model.modelId.replace(/^~/, "")] : []));
    if (available.has(reference.modelId)) {
      return { status: "available", requestedModelId: reference.modelId, resolvedModelId: reference.modelId, revealedReplacement: false };
    }
    const replacement = this.revealedReplacement(await this.fetchModelPage(reference.pageUrl));
    if (replacement && available.has(replacement)) {
      return { status: "available", requestedModelId: reference.modelId, resolvedModelId: replacement, revealedReplacement: true };
    }
    return { status: "unavailable", requestedModelId: reference.modelId, ...(replacement ? { resolvedModelId: replacement } : {}), revealedReplacement: Boolean(replacement) };
  }

  /** The connected account's remaining OpenRouter balance, or undefined when no key is configured. Pass `forceRefresh` to bypass the cache for an explicit user-initiated refresh. */
  async credits(forceRefresh = false): Promise<OpenRouterCreditBalance | undefined> {
    if (!forceRefresh && this.creditsCache && this.creditsCache.expiresAt > this.now()) return this.creditsCache.promise;
    const promise = this.fetchCredits().catch((error) => {
      this.creditsCache = undefined;
      throw error;
    });
    this.creditsCache = { expiresAt: this.now() + CREDITS_TTL_MS, promise };
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

  private async fetchJson(url: string, authorization?: string) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(url, { headers: { Accept: "application/json", ...(authorization ? { Authorization: authorization } : {}) }, signal: controller.signal });
      if (!response.ok) throw new Error(`OpenRouter catalog returned ${response.status}.`);
      return await response.json() as unknown;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async fetchModelPage(url: string) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(url, { headers: { Accept: "text/html" }, redirect: "error", signal: controller.signal });
      if (!response.ok) throw new Error(`OpenRouter model page returned ${response.status}.`);
      if (!(response.headers.get("content-type") || "").toLocaleLowerCase().startsWith("text/html")) throw new Error("OpenRouter model page was not HTML.");
      if (!response.body) return "";
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > MODEL_PAGE_LIMIT_BYTES) {
          await reader.cancel();
          throw new Error("OpenRouter model page exceeded the response limit.");
        }
        chunks.push(value);
      }
      const body = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
      return new TextDecoder().decode(body);
    } finally {
      clearTimeout(timeout);
    }
  }

  private revealedReplacement(html: string) {
    const marker = html.toLocaleLowerCase().indexOf("revealed to be");
    if (marker < 0) return undefined;
    const nearby = html.slice(marker, marker + 4_000);
    // Validate the complete URL so variant suffixes cannot become a different model ID.
    const match = nearby.match(/https:\/\/(?:www\.)?openrouter\.ai\/[^\s"'<>\\]+/i);
    if (!match) return undefined;
    return parseOpenRouterModelPageUrl(match[0])?.modelId;
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
    const remoteInputModalities = stringArray(remote.architecture?.input_modalities);
    const remoteOutputModalities = stringArray(remote.architecture?.output_modalities);
    const inputModalities = remoteInputModalities.length ? remoteInputModalities : model.capabilities?.inputModalities;
    const outputModalities = remoteOutputModalities.length ? remoteOutputModalities : model.capabilities?.outputModalities;
    const inputPerMillion = perMillion(remote.pricing?.prompt) ?? model.pricing?.inputPerMillion;
    const outputPerMillion = perMillion(remote.pricing?.completion) ?? model.pricing?.outputPerMillion;
    const pricing: ModelPricing = {
      ...(inputPerMillion !== undefined ? { inputPerMillion } : {}),
      ...(outputPerMillion !== undefined ? { outputPerMillion } : {}),
      ...(model.pricing?.cacheReadPerMillion !== undefined ? { cacheReadPerMillion: model.pricing.cacheReadPerMillion } : {}),
      ...(model.pricing?.cacheWritePerMillion !== undefined ? { cacheWritePerMillion: model.pricing.cacheWritePerMillion } : {}),
    };
    const scores = remote.benchmarks?.artificial_analysis;
    const intelligence = finite(scores?.intelligence_index);
    const coding = finite(scores?.coding_index);
    const agentic = finite(scores?.agentic_index);
    const benchmarks = intelligence !== undefined || coding !== undefined || agentic !== undefined ? {
      ...(intelligence !== undefined ? { intelligence } : {}),
      ...(coding !== undefined ? { coding } : {}),
      ...(agentic !== undefined ? { agentic } : {}),
    } : undefined;
    const rank = finite((remote as OpenRouterModel & { popularityRank?: unknown }).popularityRank);
    const context = finite(remote.context_length);
    const discoveredReleaseDate = releaseDate(remote.created);
    return {
      ...model,
      displayName: friendlyOpenRouterName(remote.name, model.authorDisplayName, model.displayName),
      ...(typeof remote.description === "string" && remote.description.trim() ? { description: remote.description.trim().replace(/\s+/g, " ").slice(0, 420) } : {}),
      ...(Object.keys(pricing).length ? { pricing } : {}),
      ...(context !== undefined ? { limits: { ...model.limits, context } } : model.limits !== undefined ? { limits: model.limits } : {}),
      ...(discoveredReleaseDate !== undefined ? { releaseDate: discoveredReleaseDate } : {}),
      ...(rank !== undefined ? { popularity: { rank, window: "weekly", source: "openrouter" } } : {}),
      ...(benchmarks !== undefined ? { benchmarks } : {}),
      capabilities: {
        ...model.capabilities,
        reasoning: model.capabilities?.reasoning ?? (parameters.has("reasoning") || parameters.has("include_reasoning")),
        toolCall: model.capabilities?.toolCall ?? parameters.has("tools"),
        ...(inputModalities !== undefined ? { inputModalities } : {}),
        ...(outputModalities !== undefined ? { outputModalities } : {}),
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
      const providerName = delimitedLabel(endpoint.provider_name) ?? delimitedLabel(endpoint.name, "|") ?? "OpenRouter provider";
      const providerId = delimitedLabel(endpoint.tag, "/");
      const inputPerMillion = perMillion(endpoint.pricing?.prompt);
      const outputPerMillion = perMillion(endpoint.pricing?.completion);
      const discount = finite(endpoint.pricing?.discount);
      const uptime = ratio(endpoint.uptime_last_30m);
      const latencySeconds = finite(endpoint.latency_last_30m);
      const throughputTokensPerSecond = finite(endpoint.throughput_last_30m);
      const offer: ModelOffer = {
        providerName,
        ...(providerId ? { providerId } : {}),
        ...(inputPerMillion !== undefined ? { inputPerMillion } : {}),
        ...(outputPerMillion !== undefined ? { outputPerMillion } : {}),
        ...(discount !== undefined && discount > 0 && discount < 1 ? { discount } : {}),
        ...(uptime !== undefined ? { uptime } : {}),
        ...(latencySeconds !== undefined ? { latencySeconds } : {}),
        ...(throughputTokensPerSecond !== undefined ? { throughputTokensPerSecond } : {}),
      };
      const key = providerId || providerName;
      const previous = grouped.get(key);
      const offerPrice = (offer.inputPerMillion || 0) + (offer.outputPerMillion || 0);
      const previousPrice = (previous?.inputPerMillion || 0) + (previous?.outputPerMillion || 0);
      if (!previous || offerPrice < previousPrice) grouped.set(key, offer);
    }
    return { providerId: "openrouter", modelId: canonicalModelId, offers: [...grouped.values()].sort((a, b) => ((a.inputPerMillion || 0) + (a.outputPerMillion || 0)) - ((b.inputPerMillion || 0) + (b.outputPerMillion || 0))).slice(0, 16), fetchedAt: new Date(this.now()).toISOString() };
  }

  private async fetchCredits(): Promise<OpenRouterCreditBalance | undefined> {
    const key = await this.apiKey();
    if (!key) return undefined;
    const payload = await this.fetchJson("https://openrouter.ai/api/v1/credits", `Bearer ${key}`);
    const data = payload && typeof payload === "object" ? (payload as { data?: unknown }).data : undefined;
    const totalCreditsUsd = finite(data && typeof data === "object" ? (data as { total_credits?: unknown }).total_credits : undefined);
    const totalUsageUsd = finite(data && typeof data === "object" ? (data as { total_usage?: unknown }).total_usage : undefined);
    if (totalCreditsUsd === undefined || totalUsageUsd === undefined) throw new Error("OpenRouter credits response was malformed.");
    return { totalCreditsUsd, totalUsageUsd, remainingUsd: Math.max(0, totalCreditsUsd - totalUsageUsd), fetchedAt: new Date(this.now()).toISOString() };
  }
}
