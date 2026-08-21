import type { ActiveAgentId } from "../shared/participants.js";
import type { PublicRoomState, RoomState } from "./types.js";

export function publicRoomState(state: RoomState): PublicRoomState {
  const { sessions: _sessions, error: _error, settings, ...room } = state;
  const { projectPath: _projectPath, ...publicSettings } = settings;
  return { ...room, settings: publicSettings };
}

export async function roomStateWithAvailability(
  snapshot: () => RoomState,
  getAvailability: () => Promise<Record<ActiveAgentId, boolean>>,
) {
  const availability = await getAvailability();
  return { ...publicRoomState(snapshot()), availability };
}
