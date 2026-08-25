export interface AgentProfile {
  readonly id: string;
  readonly provider: string;
  readonly displayName: string;
  readonly modelId: string;
  readonly modelLabel: string;
  readonly conversationalName: string;
  readonly supportsProjectWrites: boolean;
}

const LEGACY_AGENT_PROFILES = {
  // Retained for historical transcript rendering. Luna is no longer in AGENT_IDS.
  "codex-luna": {
    id: "codex-luna",
    provider: "codex",
    displayName: "Codex",
    modelId: "gpt-5.6-luna",
    modelLabel: "gpt-5.6 Luna",
    conversationalName: "Luna",
    supportsProjectWrites: true,
  },
  // Retained for historical transcript rendering. Terra is no longer active.
  "codex-terra": {
    id: "codex-terra",
    provider: "codex",
    displayName: "Codex",
    modelId: "gpt-5.6-terra",
    modelLabel: "gpt-5.6 Terra",
    conversationalName: "Terra",
    supportsProjectWrites: true,
  },
  "codex-sol": {
    id: "codex-sol",
    provider: "codex",
    displayName: "Codex",
    modelId: "gpt-5.6-sol",
    modelLabel: "gpt-5.6 Sol",
    conversationalName: "Sol",
    supportsProjectWrites: true,
  },
  "claude-sonnet": {
    id: "claude-sonnet",
    provider: "claude",
    displayName: "Claude",
    modelId: "claude-sonnet-5",
    modelLabel: "Claude Sonnet 5",
    conversationalName: "Claude",
    supportsProjectWrites: true,
  },
  // Available as an opt-in catalog entry rather than a default room participant
  // because its cost and provider-wide quota impact are higher for room turns.
  "claude-opus": {
    id: "claude-opus",
    provider: "claude",
    displayName: "Claude",
    modelId: "claude-opus-5",
    modelLabel: "Claude Opus 5",
    conversationalName: "Opus",
    supportsProjectWrites: true,
  },
  "cursor-grok": {
    id: "cursor-grok",
    provider: "cursor",
    displayName: "Cursor",
    modelId: "cursor-grok-4.6-high",
    modelLabel: "Grok 4.6",
    conversationalName: "Grok",
    supportsProjectWrites: true,
  },
  // Retained as an opt-in catalog entry and for historical transcript rendering;
  // Gemini Pro is intentionally absent from the default room roster.
  "cursor-gemini": {
    id: "cursor-gemini",
    provider: "cursor",
    displayName: "Cursor",
    modelId: "gemini-3.1-pro",
    modelLabel: "Gemini 3.1 Pro",
    conversationalName: "Gemini",
    supportsProjectWrites: true,
  },
  "cursor-composer": {
    id: "cursor-composer",
    provider: "cursor",
    displayName: "Cursor",
    modelId: "composer-2.5",
    modelLabel: "Composer 2.5",
    conversationalName: "Composer",
    supportsProjectWrites: true,
  },
  "cursor-gemini-flash": {
    id: "cursor-gemini-flash",
    provider: "cursor",
    displayName: "Cursor",
    modelId: "gemini-3.7-flash-high",
    modelLabel: "Gemini 3.7 Flash",
    conversationalName: "Flash",
    supportsProjectWrites: true,
  },
  "cursor-glm": {
    id: "cursor-glm",
    provider: "cursor",
    displayName: "Cursor",
    modelId: "glm-5.2-high",
    modelLabel: "GLM 5.2",
    conversationalName: "GLM",
    supportsProjectWrites: true,
  },
  "opencode-configured": {
    id: "opencode-configured",
    provider: "opencode",
    displayName: "OpenCode",
    modelId: "configured",
    modelLabel: "Configured model",
    conversationalName: "OpenCode",
    supportsProjectWrites: true,
  },
} as const satisfies Record<string, AgentProfile>;

// Historical profiles remain available for transcript rendering and migration.
// Room-scoped participant instances are registered from the normalized roster.
export const AGENT_PROFILES: Record<string, AgentProfile> = { ...LEGACY_AGENT_PROFILES };

export type LegacyAgentId = keyof typeof LEGACY_AGENT_PROFILES;
export type AgentId = string;
export type AgentProvider = string;
export type ParticipantId = "you" | AgentId;
export type SpeakerId = ParticipantId | "system";

export const AGENT_IDS = [
  "codex-sol",
  "claude-sonnet",
  "cursor-grok",
  "cursor-composer",
  "cursor-gemini-flash",
  "cursor-glm",
] as const satisfies readonly LegacyAgentId[];

export const SUPPORTED_AGENT_IDS = [
  "codex-sol",
  "claude-sonnet",
  "claude-opus",
  "cursor-grok",
  "cursor-gemini",
  "cursor-composer",
  "cursor-gemini-flash",
  "cursor-glm",
  "opencode-configured",
] as const satisfies readonly LegacyAgentId[];

const activeAgentIds = new Set<string>(SUPPORTED_AGENT_IDS);

export type ActiveAgentId = AgentId;
export type WritableAgent = ActiveAgentId | "nobody";
export const PARTICIPANT_IDS: ParticipantId[] = ["you", ...AGENT_IDS];

export function isAgentId(value: unknown): value is AgentId {
  return typeof value === "string" && (value in AGENT_PROFILES || /^agent-[a-f0-9-]{16,64}$/i.test(value));
}

export function isActiveAgentId(value: unknown): value is ActiveAgentId {
  return typeof value === "string" && activeAgentIds.has(value);
}

export function isParticipantId(value: unknown): value is ParticipantId {
  return value === "you" || isAgentId(value);
}

export function agentSupportsProjectWrites(agent: AgentId) {
  return AGENT_PROFILES[agent]?.supportsProjectWrites ?? true;
}

export function normalizeWritableAgent(value: unknown): WritableAgent {
  if (value === "nobody") return "nobody";
  return isActiveAgentId(value) && agentSupportsProjectWrites(value) ? value : "nobody";
}

export function agentScreenName(agent: AgentId) {
  const profile = AGENT_PROFILES[agent];
  return profile ? `${profile.displayName} [${profile.modelLabel}]` : agent;
}

export function participantScreenName(participant: SpeakerId) {
  if (participant === "you") return "You";
  if (participant === "system") return "System";
  return agentScreenName(participant);
}

export function migrateLegacyAgentId(value: unknown): AgentId | undefined {
  if (isAgentId(value)) return value;
  if (value === "codex") return "codex-sol";
  if (value === "claude") return "claude-sonnet";
  return undefined;
}

export function registerParticipantProfile(profile: AgentProfile) {
  if (!isAgentId(profile.id)) return;
  AGENT_PROFILES[profile.id] = { ...profile };
  activeAgentIds.add(profile.id);
}
