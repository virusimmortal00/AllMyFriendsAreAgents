export const ROOM_PROTOCOL_VERSION = 3;

export interface ServerIdentity {
  instanceId: string;
  protocolVersion: number;
}
