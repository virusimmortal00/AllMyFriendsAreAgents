import { afterEach, describe, expect, it, vi } from "vitest";
import { ActiveGenerationTracker } from "./active-generations.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("authoritative active generations", () => {
  it("atomically reserves shared capacity until the lease is released",()=>{const tracker=new ActiveGenerationTracker();const lease=tracker.reserve("codex-sol",1);expect(lease).toBeTruthy();expect(tracker.size()).toBe(1);expect(tracker.reserve("claude-sonnet",1)).toBeUndefined();lease!.release();expect(tracker.size()).toBe(0);expect(tracker.reserve("claude-sonnet",1)).toBeTruthy();tracker.clear();});
  it("atomically transfers a reservation into its generation",()=>{const tracker=new ActiveGenerationTracker();const lease=tracker.reserve("codex-sol",1)!;expect(lease.activate("generation-1")).toBe(true);expect(tracker.snapshot()).toEqual({"generation-1":"codex-sol"});expect(tracker.size()).toBe(1);expect(tracker.reserve("claude-sonnet",1)).toBeUndefined();expect(lease.release()).toBe(false);tracker.finish("generation-1");expect(tracker.size()).toBe(0);});
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
