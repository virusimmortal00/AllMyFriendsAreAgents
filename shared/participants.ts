export const AGENT_PROFILES = {
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
    supportsProjectWrites: false,
  },
  "cursor-gemini": {
    id: "cursor-gemini",
    provider: "cursor",
    displayName: "Cursor",
    modelId: "gemini-3.1-pro",
    modelLabel: "Gemini 3.1 Pro",
    conversationalName: "Gemini",
    supportsProjectWrites: false,
  },
  "cursor-composer": {
    id: "cursor-composer",
    provider: "cursor",
    displayName: "Cursor",
    modelId: "composer-2.5",
    modelLabel: "Composer 2.5",
    conversationalName: "Composer",
    supportsProjectWrites: false,
  },
} as const;

export type AgentId = keyof typeof AGENT_PROFILES;
export type AgentProvider = (typeof AGENT_PROFILES)[AgentId]["provider"];
export type ParticipantId = "you" | AgentId;
export type SpeakerId = ParticipantId | "system";

export const AGENT_IDS = [
  "codex-terra",
  "codex-sol",
  "claude-sonnet",
  "claude-opus",
  "cursor-grok",
  "cursor-gemini",
  "cursor-composer",
] as const satisfies readonly AgentId[];
export type ActiveAgentId = (typeof AGENT_IDS)[number];
export type WritableAgent = ActiveAgentId | "nobody";
export const PARTICIPANT_IDS: ParticipantId[] = ["you", ...AGENT_IDS];

export function isAgentId(value: unknown): value is AgentId {
  return typeof value === "string" && value in AGENT_PROFILES;
}

export function isActiveAgentId(value: unknown): value is ActiveAgentId {
  return isAgentId(value) && (AGENT_IDS as readonly AgentId[]).includes(value);
}

export function isParticipantId(value: unknown): value is ParticipantId {
  return value === "you" || isAgentId(value);
}

export function agentSupportsProjectWrites(agent: AgentId) {
  return AGENT_PROFILES[agent].supportsProjectWrites;
}

export function normalizeWritableAgent(value: unknown): WritableAgent {
  if (value === "nobody") return "nobody";
  return isActiveAgentId(value) && agentSupportsProjectWrites(value) ? value : "nobody";
}

export function agentScreenName(agent: AgentId) {
  const profile = AGENT_PROFILES[agent];
  return `${profile.displayName} [${profile.modelLabel}]`;
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
