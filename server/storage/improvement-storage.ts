import type { EmergencyStop, Improvement } from "../../shared/improvement-domain.js";
import type {
  EmergencyStopProjection,
  ImprovementEvent,
  ImprovementListQuery,
  ImprovementPage,
} from "./room-repository.js";

export const CLEAR_EMERGENCY_STOP: EmergencyStopProjection = {
  revision: 0,
  active: false,
  activatedBy: null,
  activatedAt: null,
  reason: null,
};

export interface EmergencyStopEvent {
  readonly revision: number;
  readonly actorId: string;
  readonly at: string;
  readonly snapshot: EmergencyStopProjection;
}

export interface JsonImprovementState {
  readonly schemaVersion: 1;
  readonly improvements: Record<string, Improvement>;
  readonly events: readonly ImprovementEvent[];
  readonly emergencyStop: EmergencyStopProjection;
  readonly emergencyStopEvents: readonly EmergencyStopEvent[];
}

export function emptyJsonImprovementState(): JsonImprovementState {
  return {
    schemaVersion: 1,
    improvements: {},
    events: [],
    emergencyStop: { ...CLEAR_EMERGENCY_STOP },
    emergencyStopEvents: [],
  };
}

export function normalizeJsonImprovementState(value: unknown): JsonImprovementState {
  if (!value || typeof value !== "object") return emptyJsonImprovementState();
  const stored = value as Partial<JsonImprovementState>;
  return {
    schemaVersion: 1,
    improvements: stored.improvements && typeof stored.improvements === "object" ? stored.improvements : {},
    events: Array.isArray(stored.events) ? stored.events : [],
    emergencyStop: stored.emergencyStop && typeof stored.emergencyStop === "object"
      ? { ...CLEAR_EMERGENCY_STOP, ...stored.emergencyStop }
      : { ...CLEAR_EMERGENCY_STOP },
    emergencyStopEvents: Array.isArray(stored.emergencyStopEvents) ? stored.emergencyStopEvents : [],
  };
}

export function paginateImprovements(
  improvements: readonly Improvement[],
  query: ImprovementListQuery = {},
): ImprovementPage {
  const limit = Math.max(1, Math.min(100, Math.trunc(query.limit ?? 50)));
  const parsedCursor = Number.parseInt(query.cursor ?? "0", 10);
  const offset = Number.isSafeInteger(parsedCursor) && parsedCursor >= 0 ? parsedCursor : 0;
  const items = improvements
    .filter((improvement) => !query.states?.length || query.states.includes(improvement.state))
    .filter((improvement) => !query.risks?.length || query.risks.includes(improvement.risk))
    .filter((improvement) => !query.authorId || improvement.authorId === query.authorId)
    .filter((improvement) => !query.claimId || improvement.claims.some(({ id }) => id === query.claimId))
    .filter((improvement) => !query.evidenceId || improvement.evidence.some(({ id }) => id === query.evidenceId))
    .filter((improvement) => !query.updatedAfter || improvement.updatedAt > query.updatedAfter)
    .filter((improvement) => !query.updatedBefore || improvement.updatedAt < query.updatedBefore)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id));
  const page = items.slice(offset, offset + limit);
  return {
    items: structuredClone(page),
    nextCursor: offset + page.length < items.length ? String(offset + page.length) : null,
  };
}

export function emergencyStopProjection(
  previous: EmergencyStopProjection,
  update: { readonly active: boolean; readonly reason?: string },
  actorId: string,
  now: string,
): EmergencyStopProjection {
  const stop: EmergencyStop = update.active
    ? { active: true, activatedBy: actorId, activatedAt: now, reason: update.reason?.trim() || null }
    : { active: false, activatedBy: null, activatedAt: null, reason: null };
  return { revision: previous.revision + 1, ...stop };
}
