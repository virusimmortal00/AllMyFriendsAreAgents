export const ROOM_PROTOCOL_VERSION = 4;

export interface ServerIdentity {
  instanceId: string;
  protocolVersion: number;
}

export interface RoomProtocolPosition {
  streamId: string;
  version: number;
}

export interface RoomFullSnapshotEvent<State> extends RoomProtocolPosition {
  kind: "snapshot";
  reason: "initial" | "resync";
  continuity: "same-stream" | "fresh";
  fromVersion?: number;
  state: State;
}

export interface RoomStateDeltaEvent<State> extends RoomProtocolPosition {
  kind: "state-delta";
  fromVersion: number;
  state: Omit<State, "messages">;
}

export interface RoomMessagesAppendedEvent<Message> extends RoomProtocolPosition {
  kind: "messages-appended";
  fromVersion: number;
  messages: Message[];
}

export type RoomProtocolEvent<State extends { messages: Message[] }, Message = State["messages"][number]> =
  | RoomFullSnapshotEvent<State>
  | RoomStateDeltaEvent<State>
  | RoomMessagesAppendedEvent<Message>;

export interface MessageMutationAcknowledgement {
  accepted: true;
  duplicate: boolean;
  clientMessageId: string;
  messageId: string;
}
