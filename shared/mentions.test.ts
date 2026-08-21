import { describe, expect, it } from "vitest";
import { reconcileMessageMentions, reconcileMessageMentionsAfterEdit, roomMentionCandidates, validateMessageMentions } from "./mentions.js";

describe("message mentions", () => {
  it("uses stable participant IDs while retaining selected labels", () => {
    const candidates = roomMentionCandidates([{ id: "human-alice", name: "Alice" }]);
    expect(candidates.find(({ targetId }) => targetId === "cursor-grok")).toMatchObject({ label: "Grok", revision: 1 });
    expect(candidates.find(({ targetId }) => targetId === "human-alice")).toMatchObject({ label: "Alice", targetKind: "human" });
  });

  it("disambiguates humans with duplicate display names", () => {
    const candidates = roomMentionCandidates([
      { id: "human-alice-1", name: "Alice" },
      { id: "human-alice-2", name: "Alice" },
    ]).filter(({ targetKind }) => targetKind === "human");
    expect(candidates.map(({ description }) => description)).toEqual([
      "Human participant · human-alice-1",
      "Human participant · human-alice-2",
    ]);
  });

  it("reconciles offsets after ordinary typing and drops deleted labels", () => {
    const mention = { targetKind: "agent" as const, targetId: "cursor-grok", label: "Grok", providerSnapshot: "cursor", modelSnapshot: "Grok 4.6", revision: 1, start: 0, end: 5 };
    expect(reconcileMessageMentions("hello @Grok", [mention])).toEqual([{ ...mention, start: 6, end: 11 }]);
    expect(reconcileMessageMentions("hello Grok", [mention])).toEqual([]);
  });

  it("drops ambiguous duplicate labels instead of rebinding stable IDs", () => {
    const first = { targetKind: "human" as const, targetId: "alice-1", label: "Alice", revision: 1, start: 0, end: 6 };
    const second = { ...first, targetId: "alice-2", start: 11, end: 17 };
    expect(reconcileMessageMentions("@Alice and @Alice", [first, second]).map(({ targetId }) => targetId)).toEqual(["alice-1", "alice-2"]);
    expect(reconcileMessageMentions("@Alice", [first, second])).toEqual([]);
  });

  it("shifts an existing same-label binding when text is inserted before it", () => {
    const mention = { targetKind: "human" as const, targetId: "alice-2", label: "Alice", revision: 1, start: 13, end: 19 };
    expect(reconcileMessageMentionsAfterEdit("say @ali and @Alice", "say @Alice and @Alice", [mention]))
      .toEqual([{ ...mention, start: 15, end: 21 }]);
  });

  it("rejects forged, stale, and text-mismatched targets", () => {
    const candidates = roomMentionCandidates([]);
    const mention = { targetKind: "agent" as const, targetId: "cursor-grok", label: "Grok", revision: 1, start: 0, end: 5 };
    const expectedMention = { ...mention, providerSnapshot: "cursor", modelSnapshot: "Grok 4.6" };
    expect(validateMessageMentions([mention], "@Grok hello", candidates)).toEqual([expectedMention]);
    expect(() => validateMessageMentions([{ ...mention, targetId: "missing" }], "@Grok hello", candidates)).toThrow();
    expect(() => validateMessageMentions([mention], "Grok hello", candidates)).toThrow();
    expect(() => validateMessageMentions([{ ...mention, start: -1 }], "@Grok hello", candidates)).toThrow();
    expect(() => validateMessageMentions([{ ...mention, end: 99 }], "@Grok hello", candidates)).toThrow();
  });

  it("rejects duplicate and overlapping mention spans", () => {
    const candidates = roomMentionCandidates([
      { id: "alice-1", name: "Alice" },
      { id: "alice-2", name: "Alice" },
    ]);
    const first = { targetKind: "human" as const, targetId: "alice-1", label: "Alice", revision: 1, start: 0, end: 6 };
    const second = { ...first, targetId: "alice-2" };
    expect(() => validateMessageMentions([first, second], "@Alice", candidates)).toThrow("cannot overlap");
  });
});
