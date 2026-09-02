import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GenerationJournal } from "./generation-journal.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("GenerationJournal", () => {
  it.each([
    ["generation.completed", "info"], ["generation.retry", "warn"],
    ["generation.failed", "error"], ["generation.cancelled", "info"],
  ] as const)("uses the %s outcome for stderr severity and retains complete non-empty evidence", async (type, severity) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "amfaa-stderr-"));
    temporaryDirectories.push(directory);
    const journal = await GenerationJournal.open(directory);
    const output = `  error warning are ordinary text ${"evidence ".repeat(10_000)}token=fixture-secret\n`;
    try {
      for (const cliStderr of [undefined, "", " \t\n", output]) await journal.append({ type, generationId: "generation", agent: "codex-sol", cliStderr });
      await journal.logging.flush();
      const files = (await readdir(path.dirname(journal.path))).filter((name) => name.startsWith("opencode-harness.") && name.endsWith(".jsonl"));
      const entries = (await Promise.all(files.map((name) => readFile(path.join(path.dirname(journal.path), name), "utf8")))).join("").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ event: "opencode.stderr", severity, generationId: "generation" });
      expect(entries[0].output).toBe(output.replace("fixture-secret", "[REDACTED]"));
    } finally { await journal.logging.close(); }
  });
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

    await journal.logging.flush();
    const logDirectory = path.dirname(journal.path);
    const generationFiles = (await readdir(logDirectory)).filter((name) => name.startsWith("generations.") && name.endsWith(".jsonl"));
    const entries = (await Promise.all(generationFiles.map((name) => readFile(path.join(logDirectory, name), "utf8"))))
      .join("").trim().split("\n")
      .map((line) => JSON.parse(line));
    expect(entries).toHaveLength(4);
    expect(entries.map(({ type }) => type)).toEqual(["session.reused", "session.invalidated", "generation.started", "generation.completed"]);
    expect(entries.slice(0, 2).map(({ reason }) => reason)).toEqual(["deployment code epoch match", "deployment code epoch changed"]);
    expect(entries.every(({ timestamp }) => typeof timestamp === "string")).toBe(true);
    expect(JSON.stringify(entries)).not.toMatch(/journal-secret|journal-token/);
    expect(entries.find(({ type }) => type === "generation.started")?.prompt).toBe("hello");
    expect(entries.find(({ type }) => type === "generation.completed")?.rawResponse).toBe("hi");
    expect((await stat(path.dirname(journal.path))).mode & 0o777).toBe(0o700);
    for (const name of generationFiles) expect((await stat(path.join(logDirectory, name))).mode & 0o777).toBe(0o600);
  });
});
