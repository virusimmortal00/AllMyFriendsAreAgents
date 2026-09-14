import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OpenRouterSpendStore } from "./openrouter-spend-store.js";

const temporaryDirectories: string[] = [];
afterEach(async () => Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

async function tempDir() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "amfaa-spend-store-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("OpenRouterSpendStore", () => {
  it("accumulates lifetime totals per agent and room synchronously", async () => {
    const store = await OpenRouterSpendStore.open(await tempDir());
    store.record("codex-sol", { inputTokens: 100, outputTokens: 20, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, 0.01, { generationId: "g1" });
    store.record("claude-sonnet", { inputTokens: 40, outputTokens: 10, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, 0.002);
    const snapshot = store.snapshot();
    expect(snapshot.room).toMatchObject({ generations: 2, costUsd: 0.012 });
    expect(snapshot.agents["codex-sol"]).toMatchObject({ generations: 1, costUsd: 0.01, inputTokens: 100 });
    expect(snapshot.agents["claude-sonnet"]).toMatchObject({ generations: 1, costUsd: 0.002 });
    await store.flush();
  });

  it("persists to disk and replays on reopen", async () => {
    const directory = await tempDir();
    const store = await OpenRouterSpendStore.open(directory);
    store.record("codex-sol", { inputTokens: 5, outputTokens: 1, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, 0.001, { generationId: "g1" });
    await store.flush();
    const reopened = await OpenRouterSpendStore.open(directory);
    expect(reopened.snapshot()).toEqual(store.snapshot());
    const raw = JSON.parse(await readFile(path.join(directory, "openrouter-spend.json"), "utf8"));
    expect(raw.events).toHaveLength(1);
    expect(raw.events[0]).toMatchObject({ agentId: "codex-sol", generationId: "g1", costUsd: 0.001 });
  });

  it("starts fresh instead of throwing on a missing or corrupt store file", async () => {
    const directory = await tempDir();
    await writeFile(path.join(directory, "openrouter-spend.json"), "not json");
    const store = await OpenRouterSpendStore.open(directory);
    expect(store.snapshot()).toEqual({ room: { generations: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, agents: {} });
  });

  it("ignores a record call with neither usage nor cost, persisting nothing", async () => {
    const directory = await tempDir();
    const store = await OpenRouterSpendStore.open(directory);
    store.record("codex-sol", undefined, undefined);
    await store.flush();
    await expect(readFile(path.join(directory, "openrouter-spend.json"), "utf8")).rejects.toThrow();
  });

  it("computes windowed totals from retained events without flagging truncation when nothing was ever pruned", async () => {
    const store = await OpenRouterSpendStore.open(await tempDir());
    const now = Date.parse("2026-08-26T12:00:00.000Z");
    store.record("codex-sol", { inputTokens: 1, outputTokens: 1, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, 1, { timestamp: new Date(now - 2 * 60 * 60_000).toISOString() });
    store.record("codex-sol", { inputTokens: 1, outputTokens: 1, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, 2, { timestamp: new Date(now - 30 * 60_000).toISOString() });

    const lastHour = store.since("1h", () => now);
    expect(lastHour).toMatchObject({ room: { generations: 1, costUsd: 2 }, sinceIso: new Date(now - 60 * 60_000).toISOString(), truncated: false });

    const all = store.since("all", () => now);
    expect(all).toMatchObject({ room: { generations: 2, costUsd: 3 }, sinceIso: null, truncated: false });

    // A 7-day window predates all of this room's real history, but since nothing was ever pruned,
    // that's a genuine "nothing happened before this," not a gap left by retention.
    const week = store.since("7d", () => now);
    expect(week).toMatchObject({ room: { generations: 2, costUsd: 3 }, truncated: false });
    await store.flush();
  });

  it("bounds retained events to the configured limit, keeps lifetime totals exact, and flags truncation once pruning has actually discarded history", async () => {
    const store = await OpenRouterSpendStore.open(await tempDir(), 100);
    for (let index = 0; index < 150; index++) store.record("codex-sol", undefined, 0.01);
    expect(store.snapshot().room.generations).toBe(150);
    expect(store.snapshot().room.costUsd).toBeCloseTo(1.5);

    const all = store.since("all");
    expect(all.room.generations).toBe(100); // only the retained 100 are visible to a windowed query
    expect(all.truncated).toBe(true); // ...and the store says so, rather than silently under-reporting
    await store.flush();
  });
});
