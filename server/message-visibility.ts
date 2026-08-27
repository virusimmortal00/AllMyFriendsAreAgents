import type { RoomMessage } from "./types.js";

const LEGACY_CONTINUE_INSTRUCTION = /\s+Use Actions → Continue discussion to start another bounded round\.$/;
const LEGACY_PROVIDER_HEALTH = /^(?:Codex|Claude|Cursor|OpenCode) \[.+\] (?:is unavailable: .+ Other agents will keep going\.|is available again\.)$/;

export function isVisibleRoomMessage(message: RoomMessage, viewerHumanId?: string) {
  return (!message.recipientHumanId || message.recipientHumanId === viewerHumanId) && !(message.speaker === "system"
    && message.kind === "status"
    && (LEGACY_CONTINUE_INSTRUCTION.test(message.text) || LEGACY_PROVIDER_HEALTH.test(message.text)));
}

export function projectVisibleRoomMessage(message: RoomMessage, viewerHumanId?: string) {
  if (!isVisibleRoomMessage(message, viewerHumanId)) return undefined;
  const { recipientHumanId: _recipient, ...projection } = message;
  return projection;
}
