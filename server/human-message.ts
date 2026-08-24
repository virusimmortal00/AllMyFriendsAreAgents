import type { HumanPresence } from "./types.js";
import type { RoomRepository } from "./storage/room-repository.js";
import type { MessageMention } from "../shared/mentions.js";
import type { MessageMutationAcknowledgement } from "../shared/protocol.js";

export async function addHumanMessageOnce(
  store: RoomRepository,
  human: HumanPresence,
  text: string,
  clientMessageId: string,
  mentions: MessageMention[] = [],
) {
  const duplicate = store.snapshot().messages.find((message) =>
    message.humanId === human.id && message.clientMessageId === clientMessageId
  );
  if (duplicate) return { inserted: false as const, message: duplicate };

  const message = await store.addMessage("you", text, "chat", human.style, undefined, {
    ...human,
    clientMessageId,
    mentions,
  });
  return { inserted: true as const, message };
}

export function messageMutationAcknowledgement(
  result: Awaited<ReturnType<typeof addHumanMessageOnce>>,
): MessageMutationAcknowledgement {
  return {
    accepted: true,
    duplicate: !result.inserted,
    clientMessageId: result.message.clientMessageId!,
    messageId: result.message.id,
  };
}
