export interface PendingSend {
  clientMessageId: string;
  text: string;
}

function key(kind: "draft" | "pending-send", humanId: string) {
  return `all-my-friends-are-agents-${kind}:${humanId}`;
}

export function loadDraft(storage: Pick<Storage, "getItem">, humanId?: string) {
  return humanId ? storage.getItem(key("draft", humanId)) || "" : "";
}

export function saveDraft(storage: Pick<Storage, "setItem" | "removeItem">, humanId: string, draft: string) {
  if (draft) storage.setItem(key("draft", humanId), draft);
  else storage.removeItem(key("draft", humanId));
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
