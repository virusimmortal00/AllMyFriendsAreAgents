import type { DiscoveredModel } from "../shared/model-discovery";
import type { RoomAgentRosterEntry } from "../shared/roster";

export function replaceRosterModel(
  entry: RoomAgentRosterEntry,
  model: Pick<DiscoveredModel, "providerId" | "modelId">,
): RoomAgentRosterEntry {
  const {
    providerId: _providerId,
    variant: _variant,
    reasoningEffort: _reasoningEffort,
    sessionInvalidationReason: _sessionInvalidationReason,
    selectionConfirmationRequired: _selectionConfirmationRequired,
    ...retained
  } = entry;
  return {
    ...retained,
    ...(model.providerId ? { providerId: model.providerId } : {}),
    modelId: model.modelId,
  };
}

export function replaceRosterVariant(entry: RoomAgentRosterEntry, variant: string): RoomAgentRosterEntry {
  const { variant: _variant, reasoningEffort: _reasoningEffort, ...retained } = entry;
  return { ...retained, ...(variant ? { variant } : {}) };
}

export function confirmRosterSelection(entry: RoomAgentRosterEntry): RoomAgentRosterEntry {
  const {
    sessionInvalidationReason: _sessionInvalidationReason,
    selectionConfirmationRequired: _selectionConfirmationRequired,
    ...retained
  } = entry;
  return retained;
}
