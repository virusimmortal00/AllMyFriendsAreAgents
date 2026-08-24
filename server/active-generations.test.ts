import { afterEach, describe, expect, it, vi } from "vitest";
import { ActiveGenerationTracker } from "./active-generations.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("authoritative active generations", () => {
  it("keeps overlapping generations active until each identifier reaches a terminal state", () => {
    const snapshots: Array<Record<string, string>> = [];
    const tracker = new ActiveGenerationTracker((snapshot) => snapshots.push(snapshot));

    tracker.start("older", "codex-sol");
    tracker.start("newer", "claude-sonnet");
    tracker.finish("older");

    expect(tracker.snapshot()).toEqual({ newer: "claude-sonnet" });
    expect(snapshots).toEqual([
      { older: "codex-sol" },
      { older: "codex-sol", newer: "claude-sonnet" },
      { newer: "claude-sonnet" },
    ]);

    tracker.finish("newer");
    expect(tracker.snapshot()).toEqual({});
  });

  it("does not let a late completion clear a superseding generation", () => {
    const tracker = new ActiveGenerationTracker();
    tracker.start("superseded", "codex-sol");
    tracker.finish("superseded");
    tracker.start("replacement", "codex-sol");

    expect(tracker.finish("superseded")).toBe(false);
    expect(tracker.snapshot()).toEqual({ replacement: "codex-sol" });
  });

  it("cleans up an abandoned generation after its lifecycle timeout", () => {
    vi.useFakeTimers();
    const tracker = new ActiveGenerationTracker(() => undefined, 1_000);
    tracker.start("abandoned", "cursor-grok");

    vi.advanceTimersByTime(1_000);

    expect(tracker.snapshot()).toEqual({});
  });

  it("clears all identifiers during disconnect or shutdown cleanup", () => {
    const tracker = new ActiveGenerationTracker();
    tracker.start("one", "codex-sol");
    tracker.start("two", "claude-opus");

    tracker.clear();

    expect(tracker.snapshot()).toEqual({});
  });
});
