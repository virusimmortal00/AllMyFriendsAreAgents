import { AGENT_IDS, AGENT_PROFILES, isActiveAgentId, isAgentId, registerParticipantProfile, type ActiveAgentId } from "./participants.js";
import { isHarnessId, validDiscoveryId, type HarnessId, type ModelReference } from "./model-discovery.js";

export const MAX_ROOM_AGENTS = 32;

export interface RoomAgentRosterEntry {
  readonly agentId: ActiveAgentId;
  readonly conversationalName?: string;
  readonly harness?: HarnessId;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly variant?: string;
  readonly reasoningEffort?: string;
  readonly enabled: boolean;
  readonly supportsProjectWrites?: boolean;
  readonly configurationRevision?: number;
  readonly sessionInvalidationReason?: string;
}

export type NormalizedRoomAgentRosterEntry = RoomAgentRosterEntry & Required<Pick<RoomAgentRosterEntry, "conversationalName" | "harness" | "modelId" | "supportsProjectWrites" | "configurationRevision">>;

export interface RoomAgentRoster {
  readonly schemaVersion?: 2;
  readonly revision: number;
  readonly entries: readonly RoomAgentRosterEntry[];
}

export interface RoomAgentTurnEpoch {
  readonly agentId: ActiveAgentId;
  readonly rosterRevision: number;
  readonly configurationRevision: number;
}

function displayName(harness: HarnessId) {
  return harness === "codex" ? "Codex" : harness === "claude" ? "Claude" : harness === "cursor" ? "Cursor" : "OpenCode";
}

export function legacyRosterEntry(agentId: string, enabled: boolean): NormalizedRoomAgentRosterEntry | undefined {
  const profile = AGENT_PROFILES[agentId];
  if (!profile) return undefined;
  return { agentId, conversationalName: profile.conversationalName, harness: profile.provider, modelId: profile.modelId, enabled, supportsProjectWrites: profile.supportsProjectWrites, configurationRevision: 1 };
}

function register(entry: NormalizedRoomAgentRosterEntry) {
  const existing = AGENT_PROFILES[entry.agentId];
  const retainsLegacyLabel = existing?.provider === entry.harness && existing.modelId === entry.modelId && !entry.providerId;
  registerParticipantProfile({ id: entry.agentId, provider: entry.harness, displayName: displayName(entry.harness), modelId: entry.modelId, modelLabel: retainsLegacyLabel ? existing.modelLabel : entry.providerId ? `${entry.providerId}/${entry.modelId}` : entry.modelId, conversationalName: entry.conversationalName, supportsProjectWrites: entry.supportsProjectWrites });
  return entry;
}

export function defaultRoomAgentRoster(): RoomAgentRoster {
  return { revision: 1, entries: AGENT_IDS.flatMap((agentId) => legacyRosterEntry(agentId, true) || []) };
}

function normalizedEntry(input: unknown): NormalizedRoomAgentRosterEntry | undefined {
  if (!input || typeof input !== "object") return undefined;
  const value = input as Partial<RoomAgentRosterEntry> & { agentId?: unknown; enabled?: unknown };
  if (typeof value.agentId !== "string" || typeof value.enabled !== "boolean") return undefined;
  const legacy = legacyRosterEntry(value.agentId, value.enabled);
  const harness = isHarnessId(value.harness) ? value.harness : legacy?.harness;
  const modelId = validDiscoveryId(value.modelId) ? value.modelId : legacy?.modelId;
  const conversationalName = typeof value.conversationalName === "string" ? value.conversationalName.trim() : legacy?.conversationalName;
  if ((!isActiveAgentId(value.agentId) && !isAgentId(value.agentId)) || !harness || !modelId || !conversationalName || conversationalName.length > 48) return undefined;
  if (value.providerId !== undefined && !validDiscoveryId(value.providerId)) return undefined;
  if (value.variant !== undefined && !validDiscoveryId(value.variant)) return undefined;
  if (value.reasoningEffort !== undefined && !validDiscoveryId(value.reasoningEffort)) return undefined;
  const configurationRevision = Number.isSafeInteger(value.configurationRevision) && Number(value.configurationRevision) > 0 ? Number(value.configurationRevision) : 1;
  return register({ agentId: value.agentId, conversationalName, harness, ...(value.providerId ? { providerId: value.providerId } : {}), modelId, ...(value.variant ? { variant: value.variant } : {}), ...(value.reasoningEffort ? { reasoningEffort: value.reasoningEffort } : {}), enabled: value.enabled, supportsProjectWrites: typeof value.supportsProjectWrites === "boolean" ? value.supportsProjectWrites : legacy?.supportsProjectWrites ?? true, configurationRevision, ...(typeof value.sessionInvalidationReason === "string" && value.sessionInvalidationReason.length <= 300 ? { sessionInvalidationReason: value.sessionInvalidationReason } : {}) });
}

export function normalizeRoomAgentRoster(input: unknown): RoomAgentRoster {
  if (!input || typeof input !== "object") return defaultRoomAgentRoster();
  const value = input as Partial<RoomAgentRoster>;
  const revision = Number.isSafeInteger(value.revision) && Number(value.revision) > 0 ? Number(value.revision) : 1;
  if (!Array.isArray(value.entries) || value.entries.length > MAX_ROOM_AGENTS) return defaultRoomAgentRoster();
  const entries = value.entries.map(normalizedEntry);
  if (entries.some((entry) => !entry)) return defaultRoomAgentRoster();
  const resolved = entries as NormalizedRoomAgentRosterEntry[];
  const ids = new Set(resolved.map(({ agentId }) => agentId));
  const names = new Set(resolved.map(({ conversationalName }) => conversationalName.toLocaleLowerCase()));
  return ids.size === resolved.length && names.size === resolved.length ? { revision, entries: resolved } : defaultRoomAgentRoster();
}

export function validateRosterEntries(input: unknown): readonly RoomAgentRosterEntry[] | undefined {
  if (!Array.isArray(input) || input.length > MAX_ROOM_AGENTS) return undefined;
  const entries = input.map(normalizedEntry);
  if (entries.some((entry) => !entry)) return undefined;
  const resolved = entries as NormalizedRoomAgentRosterEntry[];
  const ids = new Set(resolved.map(({ agentId }) => agentId));
  const names = new Set(resolved.map(({ conversationalName }) => conversationalName.toLocaleLowerCase()));
  return ids.size === resolved.length && names.size === resolved.length ? resolved : undefined;
}

export function roomAgentIds(roster: RoomAgentRoster) { return roster.entries.map(({ agentId }) => agentId); }
export function enabledRoomAgentIds(roster: RoomAgentRoster) { return roster.entries.filter(({ enabled }) => enabled).map(({ agentId }) => agentId); }
export function roomAgentEnabled(roster: RoomAgentRoster, agent: ActiveAgentId) { return roster.entries.some((entry) => entry.agentId === agent && entry.enabled); }
export function roomAgentEntry(roster: RoomAgentRoster | undefined, agent: ActiveAgentId) { return normalizeRoomAgentRoster(roster).entries.find((entry) => entry.agentId === agent); }
export function roomAgentModelReference(entry: RoomAgentRosterEntry): ModelReference { const normalized = normalizedEntry(entry); if (!normalized?.harness || !normalized.modelId) throw new Error("Invalid participant execution configuration."); return { harness: normalized.harness, ...(normalized.providerId ? { providerId: normalized.providerId } : {}), modelId: normalized.modelId, ...(normalized.variant ? { variant: normalized.variant } : {}), ...(normalized.reasoningEffort ? { reasoningEffort: normalized.reasoningEffort } : {}) }; }
export function participantConfigurationFingerprint(entry: RoomAgentRosterEntry) { return JSON.stringify(roomAgentModelReference(entry)); }
export function roomAgentTurnEpoch(roster: RoomAgentRoster, agent: ActiveAgentId): RoomAgentTurnEpoch | undefined { const entry = normalizedEntry(roster.entries.find((candidate) => candidate.agentId === agent && candidate.enabled)); return entry ? { agentId: agent, rosterRevision: roster.revision, configurationRevision: entry.configurationRevision || 1 } : undefined; }
export function roomAgentTurnEpochIsCurrent(roster: RoomAgentRoster, epoch: RoomAgentTurnEpoch) { const entry = normalizedEntry(roster.entries.find((candidate) => candidate.agentId === epoch.agentId && candidate.enabled)); return roster.revision === epoch.rosterRevision && entry?.configurationRevision === epoch.configurationRevision; }
