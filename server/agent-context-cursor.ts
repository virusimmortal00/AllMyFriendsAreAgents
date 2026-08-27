import type { ActiveAgentId } from "../shared/participants.js";
import { normalizeRoomAgentRoster, roomAgentTurnEpochIsCurrent, type RoomAgentTurnEpoch } from "../shared/roster.js";
import type { RoomRepository } from "./storage/room-repository.js";

export async function advanceAgentContextCursor(
  store: RoomRepository,
  agent: ActiveAgentId,
  epoch: RoomAgentTurnEpoch,
  completed: { readonly cursorMessageId?: string } | undefined,
) {
  if (!completed?.cursorMessageId) return false;
  if (!roomAgentTurnEpochIsCurrent(normalizeRoomAgentRoster(store.snapshot().roster), epoch)) return false;
  await store.setLastSeenMessageId(agent, completed.cursorMessageId);
  return true;
}
