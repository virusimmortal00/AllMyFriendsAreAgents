import type { MessageMention } from "../shared/mentions";

export interface PendingSend {
  clientMessageId: string;
  text: string;
  mentions?: MessageMention[];
}

export interface DraftSnapshot {
  text: string;
  mentions: MessageMention[];
}

interface StoredDraftSnapshot extends DraftSnapshot {
  version: 1;
}

function key(kind: "draft" | "draft-mentions" | "draft-state" | "pending-send", humanId: string) {
  return `all-my-friends-are-agents-${kind}:${humanId}`;
}

function storedDraftSnapshot(storage: Pick<Storage, "getItem">, humanId?: string): DraftSnapshot | null {
  if (!humanId) return null;
  try {
    const value = JSON.parse(storage.getItem(key("draft-state", humanId)) || "null") as Partial<StoredDraftSnapshot> | null;
    if (value?.version !== 1 || typeof value.text !== "string" || !Array.isArray(value.mentions)) return null;
    return { text: value.text, mentions: value.mentions as MessageMention[] };
  } catch {
    return null;
  }
}

export function loadDraft(storage: Pick<Storage, "getItem">, humanId?: string) {
  const snapshot = storedDraftSnapshot(storage, humanId);
  return snapshot ? snapshot.text : (humanId ? storage.getItem(key("draft", humanId)) || "" : "");
}

export function saveDraft(storage: Pick<Storage, "setItem" | "removeItem">, humanId: string, draft: string) {
  if (draft) storage.setItem(key("draft", humanId), draft);
  else storage.removeItem(key("draft", humanId));
}

export function loadDraftMentions(storage: Pick<Storage, "getItem">, humanId?: string): MessageMention[] {
  if (!humanId) return [];
  const snapshot = storedDraftSnapshot(storage, humanId);
  if (snapshot) return snapshot.mentions;
  try {
    const value = JSON.parse(storage.getItem(key("draft-mentions", humanId)) || "[]");
    return Array.isArray(value) ? value as MessageMention[] : [];
  } catch {
    return [];
  }
}

export function loadDraftSnapshot(storage: Pick<Storage, "getItem">, humanId?: string): DraftSnapshot {
  const snapshot = storedDraftSnapshot(storage, humanId);
  return snapshot || { text: loadDraft(storage, humanId), mentions: loadDraftMentions(storage, humanId) };
}

export function saveDraftSnapshot(
  storage: Pick<Storage, "setItem" | "removeItem">,
  humanId: string,
  snapshot: DraftSnapshot,
) {
  if (snapshot.text || snapshot.mentions.length) {
    const value: StoredDraftSnapshot = { version: 1, text: snapshot.text, mentions: snapshot.mentions };
    storage.setItem(key("draft-state", humanId), JSON.stringify(value));
  } else {
    storage.removeItem(key("draft-state", humanId));
  }
  storage.removeItem(key("draft", humanId));
  storage.removeItem(key("draft-mentions", humanId));
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
