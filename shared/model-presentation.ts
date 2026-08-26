const PROVIDER_NAMES: Readonly<Record<string, string>> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  openrouter: "OpenRouter",
  opencode: "OpenCode Zen",
  google: "Google",
  "google-vertex": "Google Vertex",
  "google-vertex-anthropic": "Google Vertex",
  "google-generative-ai": "Google AI Studio",
  mistralai: "Mistral AI",
  "x-ai": "xAI",
  xai: "xAI",
  "z-ai": "Z.ai",
  qwen: "Qwen",
  deepseek: "DeepSeek",
  nvidia: "NVIDIA",
  meta: "Meta",
  xiaomi: "Xiaomi",
  tencent: "Tencent",
  "amazon-bedrock": "Amazon Bedrock",
  cursor: "Cursor",
  codex: "OpenAI",
  claude: "Anthropic",
};

const RELAY_PROVIDERS = new Set(["openrouter", "vercel", "llmgateway", "github-copilot", "amazon-bedrock"]);

const MODEL_AUTHOR_PATTERNS: readonly { pattern: RegExp; authorId: string }[] = [
  { pattern: /(?:^|[\/_-])(?:gpt|chatgpt|o[134])(?:[\d._-]|$)/, authorId: "openai" },
  { pattern: /(?:^|[\/_-])claude(?:[\/_-]|$)/, authorId: "anthropic" },
  { pattern: /(?:^|[\/_-])(?:gemini|gemma)(?:[\/_-]|$)/, authorId: "google" },
  { pattern: /(?:^|[\/_-])grok(?:[\/_-]|$)/, authorId: "x-ai" },
  { pattern: /(?:^|[\/_-])glm(?:[\/_-]|$)/, authorId: "z-ai" },
  { pattern: /(?:^|[\/_-])(?:mistral|mixtral|codestral)(?:[\/_-]|$)/, authorId: "mistralai" },
  { pattern: /(?:^|[\/_-])(?:llama|meta-llama)(?:[\/_-]|$)/, authorId: "meta" },
  { pattern: /(?:^|[\/_-])qwen(?:[\/_-]|$)/, authorId: "qwen" },
  { pattern: /(?:^|[\/_-])deepseek(?:[\/_-]|$)/, authorId: "deepseek" },
];

const LOGO_ID_ALIASES: Readonly<Record<string, string>> = {
  "amazon-bedrock": "amazon",
  claude: "anthropic",
  codex: "openai",
  "google-ai-studio": "google",
  "google-generative-ai": "google",
  "google-vertex": "google",
  "google-vertex-anthropic": "anthropic",
  "meta-llama": "meta",
  "qwen-lan": "qwen",
};

// models.dev intentionally serves a generic sparkle for unknown IDs with a
// successful response. Only use it for IDs verified to have distinct art.
const MODELS_DEV_BRANDED = new Set([
  "anthropic", "cohere", "deepseek", "google", "inception", "meta", "minimax",
  "moonshotai", "nvidia", "openai", "opencode", "openrouter", "perplexity",
  "poolside", "stepfun", "thinkingmachines", "xiaomi",
]);

const OPENROUTER_LOGOS: Readonly<Record<string, string>> = {
  "dots-studio": "DotsStudio.png",
  "ibm-granite": "IBMGranite.svg",
  kwaipilot: "Kwaipilot.png",
  microsoft: "Microsoft.svg",
  mistralai: "Mistral.png",
  "nex-agi": "NexAGI.svg",
  qwen: "Qwen.png",
  stealth: "Stealth.svg",
  tencent: "Tencent.png",
  thedrummer: "TheDrummer.png",
};

const PROVIDER_DOMAINS: Readonly<Record<string, string>> = {
  "aion-labs": "www.aionlabs.ai",
  allenai: "allenai.org",
  amazon: "nova.amazon.com",
  "arcee-ai": "www.arcee.ai",
  baidu: "www.baidu.com",
  bytedance: "seed.bytedance.com",
  "bytedance-seed": "seed.bytedance.com",
  inclusionai: "www.inclusion-ai.org",
  liquid: "www.liquid.ai",
  meituan: "www.meituan.com",
  minimax: "minimaxi.com",
  morph: "morphllm.com",
  nousresearch: "nousresearch.com",
  nvidia: "nvidia.com",
  perceptron: "www.perceptron.inc",
  relace: "www.relace.ai",
  rekaai: "reka.ai",
  sakana: "sakana.ai",
  stepfun: "platform.stepfun.ai",
  thinkingmachines: "thinkingmachines.ai",
  upstage: "www.upstage.ai",
  writer: "writer.com",
  "x-ai": "x.ai",
  xiaomi: "www.mi.com",
  "z-ai": "z.ai",
};

export function providerDisplayName(providerId: string | undefined) {
  if (!providerId) return "Configured provider";
  return PROVIDER_NAMES[providerId] || providerId
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => part.length <= 3 ? part.toUpperCase() : `${part[0].toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

export function modelAuthorId(providerId: string | undefined, modelId: string) {
  const normalized = modelId.replace(/^~/, "").toLocaleLowerCase();
  const slash = normalized.indexOf("/");
  if (providerId && RELAY_PROVIDERS.has(providerId) && slash > 0) return normalized.slice(0, slash);
  const inferred = MODEL_AUTHOR_PATTERNS.find(({ pattern }) => pattern.test(normalized));
  if (inferred) return inferred.authorId;
  if (providerId === "claude") return "anthropic";
  if (providerId === "codex") return "openai";
  return providerId || (slash > 0 ? normalized.slice(0, slash) : undefined);
}

export function modelSlug(modelId: string) {
  const normalized = modelId.replace(/^~/, "");
  return normalized.includes("/") ? normalized.slice(normalized.indexOf("/") + 1) : normalized;
}

export function providerLogoUrl(providerId: string | undefined) {
  const safe = providerId?.toLocaleLowerCase().match(/^[a-z0-9][a-z0-9._-]{0,99}$/)?.[0];
  if (!safe) return undefined;
  const logoId = LOGO_ID_ALIASES[safe] || safe;
  if (logoId === "cursor") return "https://cursor.com/favicon.ico";
  if (MODELS_DEV_BRANDED.has(logoId)) return `https://models.dev/logos/${encodeURIComponent(logoId)}.svg`;
  if (OPENROUTER_LOGOS[logoId]) return `https://openrouter.ai/images/icons/${OPENROUTER_LOGOS[logoId]}`;
  const domain = PROVIDER_DOMAINS[logoId];
  return domain ? `https://t0.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=${encodeURIComponent(`https://${domain}/`)}&size=256` : undefined;
}

export function friendlyModelName(modelId: string) {
  const uppercaseTokens = new Set(["ai", "gpt", "glm", "llm", "vlm", "mpt", "rwkv"]);
  return modelSlug(modelId)
    .replace(/:(free|nitro|extended|online)$/i, " ($1)")
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => uppercaseTokens.has(part.toLocaleLowerCase()) || /^\d+(?:\.\d+)*[a-z]?$/i.test(part) || /^[a-z]\d/i.test(part)
      ? part.toUpperCase()
      : `${part[0].toUpperCase()}${part.slice(1)}`)
    .join(" ");
}
