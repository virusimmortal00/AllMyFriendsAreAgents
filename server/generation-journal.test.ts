import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
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
      journal.append({ type: "generation.started", generationId: "one", agent: "codex-sol", prompt: "hello" }),
      journal.append({ type: "generation.completed", generationId: "one", agent: "codex-sol", durationMs: 123, rawResponse: "hi" }),
    ]);

    const entries = (await readFile(journal.path, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(entries).toHaveLength(2);
    expect(entries.map(({ type }) => type)).toEqual(["generation.started", "generation.completed"]);
    expect(entries.every(({ timestamp }) => typeof timestamp === "string")).toBe(true);
    expect((await stat(path.dirname(journal.path))).mode & 0o777).toBe(0o700);
    expect((await stat(journal.path)).mode & 0o777).toBe(0o600);
  });
});
