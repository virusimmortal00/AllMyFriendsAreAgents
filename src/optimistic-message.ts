import type { RoomState } from "./types";

export function appendOptimisticHumanMessage(room: RoomState, id: string, text: string, timestamp: string): RoomState {
  return {
    ...room,
    messages: [
      ...room.messages,
      {
        id,
        speaker: "you",
        text,
        timestamp,
        kind: "chat",
        style: room.settings.participantStyles.you,
      },
    ],
  };
}

export function discardOptimisticMessage(room: RoomState, id: string): RoomState {
  return { ...room, messages: room.messages.filter((message) => message.id !== id) };
}
