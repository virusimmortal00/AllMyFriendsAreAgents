import type { ActiveAgentId, AgentId } from "../shared/participants.js";
import type { ImplementationCapability } from "../shared/protocol.js";
import type { PublicRoomState, RoomState } from "./types.js";
import { isVisibleRoomMessage } from "./message-visibility.js";

export function publicRoomState(state: RoomState, implementationCapabilities?: Partial<Record<AgentId, ImplementationCapability>>): PublicRoomState {
  const { sessions: _sessions, error: _error, settings, ...room } = state;
  const { projectPath: _projectPath, writableAgent: _writableAgent, ...publicSettings } = settings;
  return { ...room, messages: room.messages.filter(isVisibleRoomMessage), settings: publicSettings, ...(implementationCapabilities ? { implementationCapabilities } : {}) };
}

export async function roomStateWithAvailability(
  snapshot: () => RoomState,
  getAvailability: () => Promise<Partial<Record<ActiveAgentId, boolean>>>,
  getImplementationCapabilities?: () => Promise<Partial<Record<AgentId, ImplementationCapability>>>,
) {
  const [availability, implementationCapabilities] = await Promise.all([getAvailability(), getImplementationCapabilities?.()]);
  return { ...publicRoomState(snapshot(), implementationCapabilities), availability };
}
