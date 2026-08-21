import type { RoomMessage } from "./types.js";

const LEGACY_CONTINUE_INSTRUCTION = /\s+Use Actions → Continue discussion to start another bounded round\.$/;

export function isVisibleRoomMessage(message: RoomMessage) {
  return !(message.speaker === "system"
    && message.kind === "status"
    && LEGACY_CONTINUE_INSTRUCTION.test(message.text));
}
