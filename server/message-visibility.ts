import type { RoomMessage } from "./types.js";

const LEGACY_CONTINUE_INSTRUCTION = /\s+Use Actions → Continue discussion to start another bounded round\.$/;
const LEGACY_PROVIDER_HEALTH = /^(?:Codex|Claude|Cursor) \[.+\] (?:is unavailable: .+ Other agents will keep going\.|is available again\.)$/;

export function isVisibleRoomMessage(message: RoomMessage) {
  return !(message.speaker === "system"
    && message.kind === "status"
    && (LEGACY_CONTINUE_INSTRUCTION.test(message.text) || LEGACY_PROVIDER_HEALTH.test(message.text)));
}
