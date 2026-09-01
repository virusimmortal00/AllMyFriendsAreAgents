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

export function parseOpenRouterModelPageUrl(value: string): OpenRouterModelPageReference | undefined {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.username || url.password || url.port) return undefined;
    if (url.hostname !== "openrouter.ai" && url.hostname !== "www.openrouter.ai") return undefined;
    const segments = url.pathname.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment));
    if (segments.length !== 2 || !segments.every((segment) => OPENROUTER_SEGMENT.test(segment))) return undefined;
    const modelId = `${segments[0]}/${segments[1]}`;
    return { modelId, pageUrl: `https://openrouter.ai/${segments.map(encodeURIComponent).join("/")}` };
  } catch {
    return undefined;
  }
}
