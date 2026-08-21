export const ROOM_PROTOCOL_VERSION = 2;

export interface ServerIdentity {
  instanceId: string;
  protocolVersion: number;
}
