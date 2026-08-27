import type { ModelReference } from "../shared/model-discovery.js";
import {
  DEFAULT_CONTEXT_SUMMARIZER_MODELS,
  DEFAULT_CONTEXT_SUMMARY_PROMPT,
  defaultAgentContextConfig,
  type AgentContextConfig,
} from "./agent-context-config.js";

export const DEFAULT_ROOM_BASE_PROMPT = "Evaluate every contribution — human or agent — on its technical merit alone. Do not assign extra weight to a speaker's status or identity, and do not defer to a claim because its author is human, confident, or another agent. Challenge weak arguments regardless of who makes them.";
export const DEFAULT_ROOM_FEATURE_FLAGS = Object.freeze({ preflightInvocationGating: false });

export interface RoomConfiguration {
  readonly basePromptRevision: number;
  /** Null explicitly disables the room base-prompt section. */
  readonly basePromptText: string | null;
  readonly summarizerModel: ModelReference | null;
  readonly summarizerPromptText: string;
  readonly summarizerPromptRevision: number;
  readonly featureFlags: Readonly<Record<string, boolean>>;
  readonly updatedAt: string | null;
}

export interface RoomConfigurationUpdate {
  readonly basePromptText?: string | null;
  readonly summarizerModel?: ModelReference | null;
  readonly summarizerPromptText?: string;
  readonly featureFlags?: Readonly<Record<string, boolean>>;
}

export interface RoomConfigurationAuditEvent {
  readonly id: string;
  readonly actorId: string;
  readonly changeKind: "base_prompt" | "summarizer" | "feature_flags" | "mixed";
  readonly basePromptRevision: number;
  readonly summarizerPromptRevision: number;
  readonly at: string;
  readonly snapshot: RoomConfiguration;
}

export function defaultRoomConfiguration(): RoomConfiguration {
  return {
    basePromptRevision: 0,
    basePromptText: DEFAULT_ROOM_BASE_PROMPT,
    summarizerModel: { ...DEFAULT_CONTEXT_SUMMARIZER_MODELS[0] },
    summarizerPromptText: DEFAULT_CONTEXT_SUMMARY_PROMPT,
    summarizerPromptRevision: 0,
    featureFlags: { ...DEFAULT_ROOM_FEATURE_FLAGS },
    updatedAt: null,
  };
}

function featureFlags(input: unknown) {
  const result: Record<string, boolean> = { ...DEFAULT_ROOM_FEATURE_FLAGS };
  if (!input || typeof input !== "object" || Array.isArray(input)) return result;
  for (const [key, value] of Object.entries(input)) {
    if (/^[a-z][a-zA-Z0-9]{0,63}$/.test(key) && typeof value === "boolean") result[key] = value;
  }
  return result;
}

function revision(input: unknown) {
  return Number.isSafeInteger(input) && Number(input) >= 0 ? Number(input) : 0;
}

export function normalizeRoomConfiguration(input: unknown): RoomConfiguration {
  const defaults = defaultRoomConfiguration();
  if (!input || typeof input !== "object") return defaults;
  const value = input as Partial<RoomConfiguration>;
  const basePromptText = value.basePromptText === null
    ? null
    : typeof value.basePromptText === "string" && value.basePromptText.trim()
      ? value.basePromptText
      : defaults.basePromptText;
  const summarizerPromptText = typeof value.summarizerPromptText === "string" && value.summarizerPromptText.trim()
    ? value.summarizerPromptText
    : defaults.summarizerPromptText;
  const configured = value.summarizerModel === null
    ? null
    : value.summarizerModel && typeof value.summarizerModel.modelId === "string"
      ? { ...value.summarizerModel }
      : defaults.summarizerModel;
  return {
    basePromptRevision: revision(value.basePromptRevision),
    basePromptText,
    summarizerModel: configured,
    summarizerPromptText,
    summarizerPromptRevision: revision(value.summarizerPromptRevision),
    featureFlags: featureFlags(value.featureFlags),
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : null,
  };
}

export function agentContextConfigFor(configuration: RoomConfiguration | undefined): AgentContextConfig {
  const normalized = normalizeRoomConfiguration(configuration);
  const defaults = defaultAgentContextConfig();
  const primary = normalized.summarizerModel;
  const fallback = DEFAULT_CONTEXT_SUMMARIZER_MODELS[1];
  const summarizerModels = primary
    ? [primary, ...(primary.providerId === fallback.providerId && primary.modelId === fallback.modelId ? [] : [{ ...fallback }])]
    : [];
  return {
    ...defaults,
    summarizerModels,
    summaryPromptTemplate: normalized.summarizerPromptText,
  };
}

export function roomBasePrompt(configuration: RoomConfiguration | undefined) {
  return normalizeRoomConfiguration(configuration).basePromptText;
}
