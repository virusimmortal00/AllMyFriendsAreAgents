import type { MessageMention } from "../shared/mentions";

export interface PendingSend {
  clientMessageId: string;
  text: string;
  mentions?: MessageMention[];
}

function key(kind: "draft" | "draft-mentions" | "pending-send", humanId: string) {
  return `all-my-friends-are-agents-${kind}:${humanId}`;
}

export function loadDraft(storage: Pick<Storage, "getItem">, humanId?: string) {
  return humanId ? storage.getItem(key("draft", humanId)) || "" : "";
}

export function saveDraft(storage: Pick<Storage, "setItem" | "removeItem">, humanId: string, draft: string) {
  if (draft) storage.setItem(key("draft", humanId), draft);
  else storage.removeItem(key("draft", humanId));
}

export function loadDraftMentions(storage: Pick<Storage, "getItem">, humanId?: string): MessageMention[] {
  if (!humanId) return [];
  try {
    const value = JSON.parse(storage.getItem(key("draft-mentions", humanId)) || "[]");
    return Array.isArray(value) ? value as MessageMention[] : [];
  } catch {
    return [];
  }
}

export function saveDraftMentions(storage: Pick<Storage, "setItem" | "removeItem">, humanId: string, mentions: MessageMention[]) {
  if (mentions.length) storage.setItem(key("draft-mentions", humanId), JSON.stringify(mentions));
  else storage.removeItem(key("draft-mentions", humanId));
}

export function loadPendingSend(storage: Pick<Storage, "getItem">, humanId?: string): PendingSend | null {
  if (!humanId) return null;
  try {
    const value = JSON.parse(storage.getItem(key("pending-send", humanId)) || "null") as PendingSend | null;
    return value?.clientMessageId && value.text ? value : null;
  } catch {
    return null;
  }
}

export function savePendingSend(storage: Pick<Storage, "setItem" | "removeItem">, humanId: string, pending: PendingSend | null) {
  if (pending) storage.setItem(key("pending-send", humanId), JSON.stringify(pending));
  else storage.removeItem(key("pending-send", humanId));
}
