export const AGENT_PROFILES = {
  "codex-luna": {
    id: "codex-luna",
    provider: "codex",
    displayName: "Codex",
    modelId: "gpt-5.6-luna",
    modelLabel: "gpt-5.6 Luna",
    conversationalName: "Luna",
  },
  "codex-terra": {
    id: "codex-terra",
    provider: "codex",
    displayName: "Codex",
    modelId: "gpt-5.6-terra",
    modelLabel: "gpt-5.6 Terra",
    conversationalName: "Terra",
  },
  "codex-sol": {
    id: "codex-sol",
    provider: "codex",
    displayName: "Codex",
    modelId: "gpt-5.6-sol",
    modelLabel: "gpt-5.6 Sol",
    conversationalName: "Sol",
  },
  "claude-sonnet": {
    id: "claude-sonnet",
    provider: "claude",
    displayName: "Claude",
    modelId: "claude-sonnet-5",
    modelLabel: "Claude Sonnet 5",
    conversationalName: "Claude",
  },
} as const;

export type AgentId = keyof typeof AGENT_PROFILES;
export type AgentProvider = (typeof AGENT_PROFILES)[AgentId]["provider"];
export type ParticipantId = "you" | AgentId;
export type SpeakerId = ParticipantId | "system";
export type WritableAgent = AgentId | "nobody";

export const AGENT_IDS = Object.keys(AGENT_PROFILES) as AgentId[];
export const PARTICIPANT_IDS: ParticipantId[] = ["you", ...AGENT_IDS];

export function isAgentId(value: unknown): value is AgentId {
  return typeof value === "string" && value in AGENT_PROFILES;
}

export function isParticipantId(value: unknown): value is ParticipantId {
  return value === "you" || isAgentId(value);
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
