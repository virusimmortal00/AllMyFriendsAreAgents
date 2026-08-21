import { describe, expect, it } from "vitest";
import { loadDraft, loadDraftMentions, loadPendingSend, saveDraft, saveDraftMentions, savePendingSend } from "./client-persistence";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) || null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

describe("client reconnect persistence", () => {
  it("keeps drafts separate for each human profile", () => {
    const storage = memoryStorage();
    saveDraft(storage, "alice", "hello");
    expect(loadDraft(storage, "alice")).toBe("hello");
    expect(loadDraft(storage, "bob")).toBe("");
  });

  it("persists only attempted ambiguous sends", () => {
    const storage = memoryStorage();
    const pending = { clientMessageId: "message-123", text: "did this land?" };
    savePendingSend(storage, "alice", pending);
    expect(loadPendingSend(storage, "alice")).toEqual(pending);
    savePendingSend(storage, "alice", null);
    expect(loadPendingSend(storage, "alice")).toBeNull();
  });

  it("persists stable mention metadata alongside a draft", () => {
    const storage = memoryStorage();
    const mention = { targetKind: "agent" as const, targetId: "cursor-grok", label: "Grok", revision: 1, start: 0, end: 5 };
    saveDraft(storage, "alice", "@Grok hello");
    saveDraftMentions(storage, "alice", [mention]);
    expect(loadDraftMentions(storage, "alice")).toEqual([mention]);
    saveDraftMentions(storage, "alice", []);
    expect(loadDraftMentions(storage, "alice")).toEqual([]);
  });
});
