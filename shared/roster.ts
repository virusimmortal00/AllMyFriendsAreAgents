import { AGENT_IDS, SUPPORTED_AGENT_IDS, isActiveAgentId, type ActiveAgentId } from "./participants.js";

export interface RoomAgentRosterEntry {
  readonly agentId: ActiveAgentId;
  readonly enabled: boolean;
}

export interface RoomAgentRoster {
  readonly revision: number;
  readonly entries: readonly RoomAgentRosterEntry[];
}

export interface RoomAgentTurnEpoch {
  readonly agentId: ActiveAgentId;
  readonly rosterRevision: number;
}

export function defaultRoomAgentRoster(): RoomAgentRoster {
  return { revision: 1, entries: AGENT_IDS.map((agentId) => ({ agentId, enabled: true })) };
}

export function normalizeRoomAgentRoster(input: unknown): RoomAgentRoster {
  if (!input || typeof input !== "object") return defaultRoomAgentRoster();
  const value = input as Partial<RoomAgentRoster>;
  const revision = Number.isSafeInteger(value.revision) && Number(value.revision) > 0 ? Number(value.revision) : 1;
  if (!Array.isArray(value.entries)) return defaultRoomAgentRoster();
  const seen = new Set<ActiveAgentId>();
  const entries = value.entries.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const candidate = entry as Partial<RoomAgentRosterEntry>;
    if (!isActiveAgentId(candidate.agentId) || typeof candidate.enabled !== "boolean" || seen.has(candidate.agentId)) return [];
    seen.add(candidate.agentId);
    return [{ agentId: candidate.agentId, enabled: candidate.enabled }];
  });
  return entries.length === value.entries.length ? { revision, entries } : defaultRoomAgentRoster();
}

export function validateRosterEntries(input: unknown): readonly RoomAgentRosterEntry[] | undefined {
  if (!Array.isArray(input) || input.length > SUPPORTED_AGENT_IDS.length) return undefined;
  const seen = new Set<ActiveAgentId>();
  const entries: RoomAgentRosterEntry[] = [];
  for (const value of input) {
    if (!value || typeof value !== "object") return undefined;
    const entry = value as Partial<RoomAgentRosterEntry>;
    if (!isActiveAgentId(entry.agentId) || typeof entry.enabled !== "boolean" || seen.has(entry.agentId)) return undefined;
    seen.add(entry.agentId);
    entries.push({ agentId: entry.agentId, enabled: entry.enabled });
  }
  return entries;
}

export function roomAgentIds(roster: RoomAgentRoster) {
  return roster.entries.map(({ agentId }) => agentId);
}

export function enabledRoomAgentIds(roster: RoomAgentRoster) {
  return roster.entries.filter(({ enabled }) => enabled).map(({ agentId }) => agentId);
}

export function roomAgentEnabled(roster: RoomAgentRoster, agent: ActiveAgentId) {
  return roster.entries.some((entry) => entry.agentId === agent && entry.enabled);
}

export function roomAgentTurnEpoch(roster: RoomAgentRoster, agent: ActiveAgentId): RoomAgentTurnEpoch | undefined {
  return roomAgentEnabled(roster, agent) ? { agentId: agent, rosterRevision: roster.revision } : undefined;
}

export function roomAgentTurnEpochIsCurrent(roster: RoomAgentRoster, epoch: RoomAgentTurnEpoch) {
  return roster.revision === epoch.rosterRevision && roomAgentEnabled(roster, epoch.agentId);
}
