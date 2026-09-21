export interface OpenRouterModelPageReference {
  readonly modelId: string;
  readonly pageUrl: string;
}

export interface OpenRouterModelPageResolution {
  readonly status: "available" | "unavailable";
  readonly requestedModelId: string;
  readonly resolvedModelId?: string;
  readonly revealedReplacement: boolean;
}

const OPENROUTER_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._+@~-]{0,99}$/;
const OPENROUTER_MODEL_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._:+@~-]{0,99}$/;

export function parseOpenRouterModelPageUrl(value: string): OpenRouterModelPageReference | undefined {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.username || url.password || url.port) return undefined;
    if (url.hostname !== "openrouter.ai" && url.hostname !== "www.openrouter.ai") return undefined;
    const segments = url.pathname
      .split("/")
      .filter(Boolean)
      .map((segment) => decodeURIComponent(segment));
    const [providerSegment, modelSegment] = segments;
    if (
      !providerSegment ||
      !modelSegment ||
      segments.length !== 2 ||
      !OPENROUTER_SEGMENT.test(providerSegment) ||
      !OPENROUTER_MODEL_SEGMENT.test(modelSegment)
    )
      return undefined;
    const modelId = `${providerSegment}/${modelSegment}`;
    return { modelId, pageUrl: `https://openrouter.ai/${segments.map(encodeURIComponent).join("/")}` };
  } catch {
    return undefined;
  }
}
