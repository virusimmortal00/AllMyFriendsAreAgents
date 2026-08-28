import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GenerationJournal } from "./generation-journal.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("GenerationJournal", () => {
  it("serializes concurrent diagnostic events as complete JSONL records", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "all-my-friends-generations-"));
    temporaryDirectories.push(directory);
    const journal = await GenerationJournal.open(directory);

    await Promise.all([
      journal.append({ type: "session.reused", generationId: "one", agent: "codex-sol", reason: "deployment code epoch match", deploymentEpoch: `deployment-v1:${"a".repeat(64)}` }),
      journal.append({ type: "session.invalidated", generationId: "two", agent: "claude-sonnet", reason: "deployment code epoch changed", storedSessionEpoch: `deployment-v1:${"b".repeat(64)}` }),
      journal.append({ type: "generation.started", generationId: "one", agent: "codex-sol", prompt: "hello" }),
      journal.append({ type: "generation.completed", generationId: "one", agent: "codex-sol", durationMs: 123, rawResponse: "hi", authorization: "Bearer journal-secret", error: "token=journal-token" }),
    ]);

    const entries = (await readFile(journal.path, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(entries).toHaveLength(4);
    expect(entries.map(({ type }) => type)).toEqual(["session.reused", "session.invalidated", "generation.started", "generation.completed"]);
    expect(entries.slice(0, 2).map(({ reason }) => reason)).toEqual(["deployment code epoch match", "deployment code epoch changed"]);
    expect(entries.every(({ timestamp }) => typeof timestamp === "string")).toBe(true);
    expect(JSON.stringify(entries)).not.toMatch(/journal-secret|journal-token/);
    expect((await stat(path.dirname(journal.path))).mode & 0o777).toBe(0o700);
    expect((await stat(journal.path)).mode & 0o777).toBe(0o600);
  });

  it("recovers later writes when persistence and sync or async error handlers fail", async () => {
    for (const onError of [() => { throw new Error("sync reporter"); }, () => Promise.reject(new Error("async reporter"))]) {
      const directory = await mkdtemp(path.join(os.tmpdir(), "all-my-friends-generation-recovery-")); temporaryDirectories.push(directory);
      const journal = await GenerationJournal.open(directory, directory, onError);
      await mkdir(journal.path);
      await expect(journal.append({ type: "generation.failed", generationId: "failed", agent: "codex-sol" })).resolves.toBeUndefined();
      await rm(journal.path, { recursive: true });
      await expect(journal.append({ type: "generation.completed", generationId: "recovered", agent: "codex-sol" })).resolves.toBeUndefined();
      expect(await readFile(journal.path, "utf8")).toContain('"generationId":"recovered"');
    }
  });
});
