import type { AgentId, RoomState } from "./types.js";

export async function roomStateWithAvailability(
  snapshot: () => RoomState,
  getAvailability: () => Promise<Record<AgentId, boolean>>,
) {
  const availability = await getAvailability();
  return { ...snapshot(), availability };
}
