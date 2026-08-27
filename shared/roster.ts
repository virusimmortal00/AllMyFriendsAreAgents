import { AGENT_IDS, historicalAgentProfile, isActiveAgentId, isAgentId, registerParticipantProfile, type ActiveAgentId } from "./participants.js";
import { resolveOpenCodeVariant, validDiscoveryId, validModelDiscoveryId, type ModelReference } from "./model-discovery.js";
import { normalizeCommandPermissions, validCommandPermissions, type CommandPermissions } from "./command-domain.js";

export const MAX_ROOM_AGENTS = 32;

export interface RoomAgentRosterEntry {
  readonly agentId: ActiveAgentId;
  readonly conversationalName?: string;
  /** Legacy persisted provenance. Active execution always uses OpenCode. */
  readonly harness?: string;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly variant?: string;
  readonly reasoningEffort?: string;
  readonly enabled: boolean;
  readonly supportsProjectWrites?: boolean;
  readonly configurationRevision?: number;
  readonly sessionInvalidationReason?: string;
  readonly selectionConfirmationRequired?: boolean;
  readonly commandPermissions?: CommandPermissions;
}

export type NormalizedRoomAgentRosterEntry = Omit<RoomAgentRosterEntry, "harness" | "reasoningEffort"> & Required<Pick<RoomAgentRosterEntry, "conversationalName" | "modelId" | "supportsProjectWrites" | "configurationRevision" | "commandPermissions">>;

export interface RoomAgentRoster {
  readonly schemaVersion?: 3;
  readonly revision: number;
  readonly entries: readonly RoomAgentRosterEntry[];
}

export interface RoomAgentTurnEpoch {
  readonly agentId: ActiveAgentId;
  readonly rosterRevision: number;
  readonly configurationRevision: number;
}

function legacyProviderId(provider: string) {
  return provider === "codex" ? "openai" : provider === "claude" ? "anthropic" : provider === "cursor" ? "cursor" : undefined;
}

export function legacyRosterEntry(agentId: string, enabled: boolean): NormalizedRoomAgentRosterEntry | undefined {
  const profile = historicalAgentProfile(agentId);
  if (!profile) return undefined;
  const providerId = legacyProviderId(profile.provider);
  return { agentId, conversationalName: profile.conversationalName, ...(providerId ? { providerId } : {}), modelId: profile.modelId, enabled, supportsProjectWrites: profile.supportsProjectWrites, configurationRevision: 1, commandPermissions: normalizeCommandPermissions(undefined), ...(profile.provider !== "opencode" ? { sessionInvalidationReason: "Migrated from a legacy harness. Choose an available OpenCode provider/model before this participant can run.", selectionConfirmationRequired: true } : {}) };
}

function register(entry: NormalizedRoomAgentRosterEntry) {
  registerParticipantProfile({ id: entry.agentId, provider: "opencode", displayName: "OpenCode", modelId: entry.modelId, modelLabel: entry.providerId ? `${entry.providerId}/${entry.modelId}` : entry.modelId, conversationalName: entry.conversationalName, supportsProjectWrites: entry.supportsProjectWrites });
  return entry;
}

export function defaultRoomAgentRoster(): RoomAgentRoster {
  return { schemaVersion: 3, revision: 1, entries: AGENT_IDS.flatMap((agentId) => legacyRosterEntry(agentId, true) || []) };
}

function normalizedEntry(input: unknown, options: { migrateLegacySelection?: boolean; rejectVariantConflict?: boolean } = {}): NormalizedRoomAgentRosterEntry | undefined {
  if (!input || typeof input !== "object") return undefined;
  const value = input as Partial<RoomAgentRosterEntry> & { agentId?: unknown; enabled?: unknown };
  if (typeof value.agentId !== "string" || typeof value.enabled !== "boolean") return undefined;
  const legacy = legacyRosterEntry(value.agentId, value.enabled);
  const modelId = validModelDiscoveryId(value.modelId) ? value.modelId : legacy?.modelId;
  const conversationalName = typeof value.conversationalName === "string" ? value.conversationalName.trim() : legacy?.conversationalName;
  if ((!isActiveAgentId(value.agentId) && !isAgentId(value.agentId)) || !modelId || !conversationalName || conversationalName.length > 48) return undefined;
  if (value.providerId !== undefined && !validDiscoveryId(value.providerId)) return undefined;
  if (value.variant !== undefined && !validDiscoveryId(value.variant)) return undefined;
  if (value.reasoningEffort !== undefined && !validDiscoveryId(value.reasoningEffort)) return undefined;
  if (options.rejectVariantConflict && value.commandPermissions !== undefined && !validCommandPermissions(value.commandPermissions)) return undefined;
  const variantSelection = resolveOpenCodeVariant(value);
  if (variantSelection.conflict && options.rejectVariantConflict) return undefined;
  const configurationRevision = Number.isSafeInteger(value.configurationRevision) && Number(value.configurationRevision) > 0 ? Number(value.configurationRevision) : 1;
  const migratedProviderId = value.providerId || (typeof value.harness === "string" ? legacyProviderId(value.harness) : undefined) || legacy?.providerId;
  const migratedFromLegacyHarness = typeof value.harness === "string" && value.harness !== "opencode";
  const selectionConfirmationRequired = value.selectionConfirmationRequired === true || migratedFromLegacyHarness || options.migrateLegacySelection && Boolean(legacy?.sessionInvalidationReason) || variantSelection.conflict;
  const conflictReason = variantSelection.conflict ? "Conflicting legacy variant and reasoning-effort selections were found. Confirm one OpenCode variant before this participant can run." : undefined;
  return register({ agentId: value.agentId, conversationalName, ...(migratedProviderId ? { providerId: migratedProviderId } : {}), modelId, ...(variantSelection.variant ? { variant: variantSelection.variant } : {}), enabled: value.enabled, supportsProjectWrites: typeof value.supportsProjectWrites === "boolean" ? value.supportsProjectWrites : legacy?.supportsProjectWrites ?? true, configurationRevision, commandPermissions: normalizeCommandPermissions(value.commandPermissions), ...(conflictReason ? { sessionInvalidationReason: conflictReason } : typeof value.sessionInvalidationReason === "string" && value.sessionInvalidationReason.length <= 300 ? { sessionInvalidationReason: value.sessionInvalidationReason } : selectionConfirmationRequired ? { sessionInvalidationReason: "Migrated from a legacy harness. Choose an available OpenCode provider/model before this participant can run." } : {}), ...(selectionConfirmationRequired ? { selectionConfirmationRequired: true } : {}) });
}

export function normalizeRoomAgentRoster(input: unknown): RoomAgentRoster {
  if (!input || typeof input !== "object") return defaultRoomAgentRoster();
  const value = input as Partial<RoomAgentRoster>;
  const revision = Number.isSafeInteger(value.revision) && Number(value.revision) > 0 ? Number(value.revision) : 1;
  if (!Array.isArray(value.entries) || value.entries.length > MAX_ROOM_AGENTS) return defaultRoomAgentRoster();
  const entries = value.entries.map((entry) => normalizedEntry(entry, { migrateLegacySelection: value.schemaVersion !== 3 }));
  if (entries.some((entry) => !entry)) return defaultRoomAgentRoster();
  const resolved = entries as NormalizedRoomAgentRosterEntry[];
  const ids = new Set(resolved.map(({ agentId }) => agentId));
  const names = new Set(resolved.map(({ conversationalName }) => conversationalName.toLocaleLowerCase()));
  return ids.size === resolved.length && names.size === resolved.length ? { schemaVersion: 3, revision, entries: resolved } : defaultRoomAgentRoster();
}

export function validateRosterEntries(input: unknown): readonly RoomAgentRosterEntry[] | undefined {
  if (!Array.isArray(input) || input.length > MAX_ROOM_AGENTS) return undefined;
  const entries = input.map((entry) => normalizedEntry(entry, { rejectVariantConflict: true }));
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
export function roomAgentModelReference(entry: RoomAgentRosterEntry): ModelReference { const normalized = normalizedEntry(entry); if (!normalized?.modelId) throw new Error("Invalid participant execution configuration."); return { ...(normalized.providerId ? { providerId: normalized.providerId } : {}), modelId: normalized.modelId, ...(normalized.variant ? { variant: normalized.variant } : {}) }; }
export function participantConfigurationFingerprint(entry: RoomAgentRosterEntry) { return JSON.stringify(roomAgentModelReference(entry)); }
export function participantConfigurationFingerprintMatches(stored: string | undefined, entry: RoomAgentRosterEntry) {
  const current = participantConfigurationFingerprint(entry);
  if (stored === current) return true;
  if (!stored) return false;
  try {
    const legacy = JSON.parse(stored) as Record<string, unknown>;
    if (
      (legacy.harness !== undefined && legacy.harness !== "opencode")
      || Object.keys(legacy).some((key) => !["harness", "providerId", "modelId", "variant", "reasoningEffort"].includes(key))
    ) return false;
    const selection = resolveOpenCodeVariant({ variant: typeof legacy.variant === "string" ? legacy.variant : undefined, reasoningEffort: typeof legacy.reasoningEffort === "string" ? legacy.reasoningEffort : undefined });
    if (selection.conflict) return false;
    return JSON.stringify({ ...(typeof legacy.providerId === "string" ? { providerId: legacy.providerId } : {}), modelId: legacy.modelId, ...(selection.variant ? { variant: selection.variant } : {}) }) === current;
  } catch {
    return false;
  }
}
export function roomAgentTurnEpoch(roster: RoomAgentRoster, agent: ActiveAgentId): RoomAgentTurnEpoch | undefined { const entry = normalizedEntry(roster.entries.find((candidate) => candidate.agentId === agent && candidate.enabled)); return entry ? { agentId: agent, rosterRevision: roster.revision, configurationRevision: entry.configurationRevision || 1 } : undefined; }
export function roomAgentTurnEpochIsCurrent(roster: RoomAgentRoster, epoch: RoomAgentTurnEpoch) { const entry = normalizedEntry(roster.entries.find((candidate) => candidate.agentId === epoch.agentId && candidate.enabled)); return roster.revision === epoch.rosterRevision && entry?.configurationRevision === epoch.configurationRevision; }
