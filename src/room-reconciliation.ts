import type { RoomProtocolEvent, RoomProtocolPosition } from "../shared/protocol";
import { ROOM_PROTOCOL_VERSION } from "../shared/protocol";
import { isConversationEnergy } from "../shared/conversation-energy";
import { isActiveAgentId } from "../shared/participants";
import type { RoomMessage, RoomState } from "./types";

export type RoomReconciliation =
  | { kind: "applied"; room: RoomState; position: RoomProtocolPosition; snapshot: boolean }
  | { kind: "ignored" }
  | { kind: "resync" }
  | { kind: "incompatible"; instanceId: string; protocolVersion: number };

export function reconcileRoomEvent(
  current: RoomState,
  position: RoomProtocolPosition | undefined,
  input: unknown,
): RoomReconciliation {
  if (!isProtocolEvent(input)) return { kind: "resync" };

  if (input.kind === "snapshot") {
    const compatibility = compatibleServer(input.state);
    if (compatibility) return compatibility;
    return {
      kind: "applied",
      room: installSnapshot(current, input.state),
      position: { streamId: input.streamId, version: input.version },
      snapshot: true,
    };
  }

  if (!position || input.streamId !== position.streamId) return { kind: "resync" };
  if (input.version <= position.version) return { kind: "ignored" };
  if (input.fromVersion !== position.version || input.version !== input.fromVersion + 1) return { kind: "resync" };

  if (input.kind === "messages-appended") {
    return {
      kind: "applied",
      room: { ...current, messages: mergeAuthoritativeMessages(current.messages, input.messages) },
      position: { streamId: input.streamId, version: input.version },
      snapshot: false,
    };
  }

  const compatibility = compatibleServer(input.state);
  if (compatibility) return compatibility;
  return {
    kind: "applied",
    room: mergeRoomFields(current, input.state),
    position: { streamId: input.streamId, version: input.version },
    snapshot: false,
  };
}

function installSnapshot(current: RoomState, next: RoomState): RoomState {
  const authoritativeClientIds = new Set(next.messages.map(({ clientMessageId }) => clientMessageId).filter(Boolean));
  const optimistic = current.messages.filter((message) =>
    isOptimistic(message) && (!message.clientMessageId || !authoritativeClientIds.has(message.clientMessageId))
  );
  return mergeRoomFields(current, { ...next, messages: [...next.messages, ...optimistic] });
}

function mergeRoomFields(current: RoomState, next: Omit<RoomState, "messages"> & { messages?: RoomMessage[] }): RoomState {
  return {
    ...next,
    messages: next.messages || current.messages,
    availability: next.availability || current.availability,
    agentHealth: next.agentHealth || current.agentHealth,
  };
}

function mergeAuthoritativeMessages(current: RoomMessage[], appended: RoomMessage[]): RoomMessage[] {
  let result = current;
  for (const message of appended) {
    const duplicateIndex = result.findIndex((existing) =>
      existing.id === message.id || Boolean(message.clientMessageId && existing.clientMessageId === message.clientMessageId)
    );
    if (duplicateIndex >= 0) {
      if (sameValue(result[duplicateIndex], message)) continue;
      result = result.map((existing, index) => index === duplicateIndex ? message : existing);
    } else {
      result = [...result, message];
    }
  }
  return result;
}

function compatibleServer(state: Partial<RoomState>): Extract<RoomReconciliation, { kind: "incompatible" }> | undefined {
  if (!state.server || state.server.protocolVersion === ROOM_PROTOCOL_VERSION) return undefined;
  return { kind: "incompatible", instanceId: state.server.instanceId, protocolVersion: state.server.protocolVersion };
}

function isOptimistic(message: RoomMessage) {
  return message.id.startsWith("pending-");
}

function sameValue(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isProtocolEvent(value: unknown): value is RoomProtocolEvent<RoomState> {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<RoomProtocolEvent<RoomState>>;
  if (typeof event.streamId !== "string" || !Number.isSafeInteger(event.version) || (event.version as number) < 0) return false;
  if (event.kind === "snapshot") return Boolean(event.state && isRoomState(event.state) && (event.reason === "initial" || event.reason === "resync"));
  if (event.kind === "messages-appended") return Number.isSafeInteger(event.fromVersion) && Array.isArray(event.messages) && event.messages.every(isRoomMessage);
  if (event.kind === "state-delta") return Number.isSafeInteger(event.fromVersion) && isNonMessageRoomState(event.state);
  return false;
}

function isRoomState(value: unknown): value is RoomState {
  if (!value || typeof value !== "object") return false;
  const room = value as Partial<RoomState>;
  if (!Array.isArray(room.messages) || !room.messages.every(isRoomMessage)) return false;
  const { messages: _messages, ...nonMessageState } = room;
  return isNonMessageRoomState(nonMessageState);
}

function isNonMessageRoomState(value: unknown): value is Omit<RoomState, "messages"> {
  if (!value || typeof value !== "object" || "messages" in value) return false;
  const room = value as Partial<Omit<RoomState, "messages">>;
  const settings = room.settings;
  const server = room.server;
  return Boolean(
    settings && typeof settings === "object"
    && typeof settings.roomName === "string"
    && typeof settings.topic === "string"
    && (settings.writableAgent === "nobody" || isActiveAgentId(settings.writableAgent))
    && isConversationEnergy(settings.conversationEnergy)
    && settings.participantStyles && typeof settings.participantStyles === "object"
    && (room.status === "idle" || room.status === "working" || room.status === "error")
    && server && typeof server === "object"
    && typeof server.instanceId === "string" && server.instanceId.length > 0
    && Number.isSafeInteger(server.protocolVersion),
  );
}

function isRoomMessage(value: unknown): value is RoomMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<RoomMessage>;
  return typeof message.id === "string" && typeof message.speaker === "string"
    && typeof message.text === "string" && typeof message.timestamp === "string";
}
