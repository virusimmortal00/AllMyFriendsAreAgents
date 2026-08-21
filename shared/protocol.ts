export const ROOM_PROTOCOL_VERSION = 1;

export interface ServerIdentity {
  instanceId: string;
  protocolVersion: number;
}
