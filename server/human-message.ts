import type { HumanPresence } from "./types.js";
import type { RoomRepository } from "./storage/room-repository.js";

export async function addHumanMessageOnce(
  store: RoomRepository,
  human: HumanPresence,
  text: string,
  clientMessageId: string,
) {
  const duplicate = store.snapshot().messages.find((message) =>
    message.humanId === human.id && message.clientMessageId === clientMessageId
  );
  if (duplicate) return { inserted: false as const, message: duplicate };

  const message = await store.addMessage("you", text, "chat", human.style, undefined, {
    ...human,
    clientMessageId,
  });
  return { inserted: true as const, message };
}
