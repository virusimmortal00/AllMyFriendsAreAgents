import type { ActiveAgentId, AgentId } from "../shared/participants.js";
import type { ImplementationCapability } from "../shared/protocol.js";
import type { PublicRoomState, RoomState } from "./types.js";
import { projectVisibleRoomMessage } from "./message-visibility.js";
import type { AgentHealth } from "./agent-health.js";
import type { ProviderHealth } from "./provider-health.js";

export function publicRoomState(
  state: RoomState,
  implementationCapabilities?: Partial<Record<AgentId, ImplementationCapability>>,
  viewerHumanId?: string,
  health?: { agentHealth?: Partial<Record<ActiveAgentId, AgentHealth>>; providerHealth?: Record<string, ProviderHealth> },
): PublicRoomState {
  const { sessions: _sessions, error: _error, agentContextSummaries: _summaries, roomConfigurationAudit: _configurationAudit, settings, ...room } = state;
  const { projectPath: _projectPath, writableAgent: _writableAgent, ...publicSettings } = settings;
  const roster = room.roster ? { ...room.roster, entries: room.roster.entries.map(({ lastSeenMessageId: _cursor, ...entry }) => entry) } : undefined;
  const messages = room.messages.map((message) => projectVisibleRoomMessage(message, viewerHumanId)).filter((message): message is NonNullable<typeof message> => Boolean(message));
  return { ...room, ...(roster ? { roster } : {}), messages, settings: publicSettings, ...(implementationCapabilities ? { implementationCapabilities } : {}), ...health };
}

export async function roomStateWithAvailability(
  snapshot: () => RoomState,
  getAvailability: () => Promise<Partial<Record<ActiveAgentId, boolean>>>,
  getImplementationCapabilities?: () => Promise<Partial<Record<AgentId, ImplementationCapability>>>,
  viewerHumanId?: string,
) {
  const [availability, implementationCapabilities] = await Promise.all([getAvailability(), getImplementationCapabilities?.()]);
  return { ...publicRoomState(snapshot(), implementationCapabilities, viewerHumanId), availability };
}
