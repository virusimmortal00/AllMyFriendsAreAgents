import type { HumanPresence, RoomState } from "./types";
import type { MessageMention } from "../shared/mentions";

export function appendOptimisticHumanMessage(room: RoomState, human: HumanPresence, id: string, text: string, timestamp: string, mentions: MessageMention[] = []): RoomState {
  return {
    ...room,
    messages: [
      ...room.messages,
      {
        id,
        speaker: "you",
        humanId: human.id,
        speakerName: human.name,
        text,
        timestamp,
        kind: "chat",
        style: { ...human.style },
        ...(mentions.length ? { mentions } : {}),
      },
    ],
  };
}

export function discardOptimisticMessage(room: RoomState, id: string): RoomState {
  return { ...room, messages: room.messages.filter((message) => message.id !== id) };
}
