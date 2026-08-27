import { validDiscoveryId, validModelDiscoveryId, type ModelReference } from "../shared/model-discovery.js";

export const DEFAULT_MAX_DELTA_MESSAGES = 20;
export const DEFAULT_RECENT_CONTEXT_MESSAGES = 20;
export const DEFAULT_SUMMARY_TOKEN_TARGET = 200;
export const DEFAULT_CONTEXT_SUMMARIZER_MODELS: readonly ModelReference[] = Object.freeze([
  { providerId: "opencode", modelId: "muse-spark-1.2-contributor-free" },
  { providerId: "openrouter", modelId: "~deepseek/deepseek-v4-flash-latest" },
]);
export const DEFAULT_CONTEXT_SUMMARY_PROMPT = `Summarize the room transcript below for a participant who will also receive the newest messages verbatim.
Preserve concrete decisions, rulings, assignments, unresolved questions, names, and message IDs when relevant.
Do not invent facts or instructions. Use compact plain text and no more than {{tokenTarget}} tokens.

TRANSCRIPT SPAN
{{transcript}}`;

export interface AgentContextConfig {
  readonly maxDeltaMessages: number;
  readonly recentMessageCount: number;
  readonly summaryTokenTarget: number;
  readonly summarizerModels: readonly ModelReference[];
  readonly summaryPromptTemplate: string;
}

export function defaultAgentContextConfig(): AgentContextConfig {
  return {
    maxDeltaMessages: DEFAULT_MAX_DELTA_MESSAGES,
    recentMessageCount: DEFAULT_RECENT_CONTEXT_MESSAGES,
    summaryTokenTarget: DEFAULT_SUMMARY_TOKEN_TARGET,
    summarizerModels: DEFAULT_CONTEXT_SUMMARIZER_MODELS.map((model) => ({ ...model })),
    summaryPromptTemplate: DEFAULT_CONTEXT_SUMMARY_PROMPT,
  };
}

function positiveInteger(value: unknown, fallback: number, maximum: number) {
  return Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= maximum ? Number(value) : fallback;
}

function modelReference(value: unknown): ModelReference | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<ModelReference>;
  if (!validModelDiscoveryId(candidate.modelId)) return undefined;
  if (candidate.providerId !== undefined && !validDiscoveryId(candidate.providerId)) return undefined;
  if (candidate.variant !== undefined && !validDiscoveryId(candidate.variant)) return undefined;
  return {
    ...(candidate.providerId ? { providerId: candidate.providerId } : {}),
    modelId: candidate.modelId,
    ...(candidate.variant ? { variant: candidate.variant } : {}),
  };
}

export function normalizeAgentContextConfig(input: unknown): AgentContextConfig {
  const defaults = defaultAgentContextConfig();
  if (!input || typeof input !== "object") return defaults;
  const value = input as Partial<AgentContextConfig>;
  const hasConfiguredModels = Array.isArray(value.summarizerModels);
  const configuredModels = hasConfiguredModels
    ? value.summarizerModels.map(modelReference).filter((model): model is ModelReference => Boolean(model)).slice(0, 4)
    : [];
  const template = typeof value.summaryPromptTemplate === "string"
    && value.summaryPromptTemplate.includes("{{transcript}}")
    && value.summaryPromptTemplate.length <= 8_000
    ? value.summaryPromptTemplate
    : defaults.summaryPromptTemplate;
  return {
    maxDeltaMessages: positiveInteger(value.maxDeltaMessages, defaults.maxDeltaMessages, 200),
    recentMessageCount: positiveInteger(value.recentMessageCount, defaults.recentMessageCount, 200),
    summaryTokenTarget: positiveInteger(value.summaryTokenTarget, defaults.summaryTokenTarget, 1_000),
    summarizerModels: hasConfiguredModels ? configuredModels : defaults.summarizerModels,
    summaryPromptTemplate: template,
  };
}
