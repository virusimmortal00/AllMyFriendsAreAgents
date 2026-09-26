import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { retainPrivateTextTrace, textPartBoundaryTrace } from "./conversation-routing-live-text-trace.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const line = (part: unknown) => JSON.stringify(part);
it("records completed part boundaries, step and message order, and replacement snapshots", () => {
  const stdout = [
    line({
      type: "text",
      sessionID: "session-secret",
      part: {
        type: "text",
        sessionID: "session-secret",
        messageID: "message-secret",
        id: "part-one",
        text: "draft",
        time: {},
      },
    }),
    line({
      type: "text",
      sessionID: "session-secret",
      part: {
        type: "text",
        sessionID: "session-secret",
        messageID: "message-secret",
        id: "part-one",
        text: "Hello.",
        time: { end: 1 },
      },
    }),
    line({
      type: "text",
      sessionID: "session-secret",
      part: {
        type: "text",
        sessionID: "session-secret",
        messageID: "message-secret",
        id: "part-one",
        text: "Hello there.",
        time: { end: 2 },
      },
    }),
    line({ type: "step_finish", part: { type: "step-finish" } }),
    line({
      type: "text",
      sessionID: "session-secret",
      part: {
        type: "text",
        sessionID: "session-secret",
        messageID: "second-message",
        id: "part-two",
        text: "Next.",
        time: { end: 3 },
      },
    }),
  ].join("\n");
  const trace = textPartBoundaryTrace(stdout);
  expect(trace).toMatchObject({
    unfinishedSnapshotsSkipped: 1,
    replacementSnapshots: 1,
    assembledTextLength: 19,
    parts: [
      {
        ordinal: 1,
        messageOrdinal: 1,
        stepOrdinal: 1,
        completionMarker: "explicit-end",
        snapshotCount: 2,
        start: 0,
        end: 12,
      },
      {
        ordinal: 2,
        messageOrdinal: 2,
        stepOrdinal: 2,
        completionMarker: "explicit-end",
        snapshotCount: 1,
        start: 14,
        end: 19,
      },
    ],
  });
  expect(JSON.stringify(trace)).not.toMatch(/session-secret|message-secret|part-one|Hello/);
});

it("rejects malformed and oversized protocol data", () => {
  expect(
    textPartBoundaryTrace(line({ type: "text", part: { type: "text", text: "legacy" } })).parts[0]?.completionMarker,
  ).toBe("legacy-absent");
  expect(() => textPartBoundaryTrace("not json")).toThrow(/malformed/);
  expect(() => textPartBoundaryTrace(line({ type: "text", part: { type: "text", text: "x".repeat(33_000) } }))).toThrow(
    /text limit/,
  );
  expect(() =>
    textPartBoundaryTrace(
      Array(65)
        .fill(line({ type: "text", part: { type: "text", text: "x" } }))
        .join("\n"),
    ),
  ).toThrow(/part limit/);
});

it("retains only correlated completed stdout as a private 0600 report", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "text-trace-test-"));
  roots.push(root);
  const logs = path.join(root, "logs");
  const review = path.join(root, "review");
  await mkdir(logs);
  await mkdir(review, { mode: 0o700 });
  const output = line({
    type: "text",
    sessionID: "session-secret",
    part: { type: "text", text: "actor answer", time: { end: 1 } },
  });
  await writeFile(
    path.join(logs, "opencode-harness.jsonl"),
    [
      { event: "opencode.stdout", generationEvent: "generation.completed", runId: "other", output: "private prompt" },
      { event: "opencode.stdout", generationEvent: "generation.failed", runId: "run", output: "private error" },
      { event: "opencode.stdout", generationEvent: "generation.completed", runId: "run", output },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n") + "\n",
  );
  await retainPrivateTextTrace(logs, review, 1, 2, "run", 1);
  const files = await readdir(review);
  expect(files).toEqual(["text-boundaries-case-1-trigger-2.json"]);
  const file = path.join(review, files[0]!);
  expect((await stat(file)).mode & 0o777).toBe(0o600);
  const content = await readFile(file, "utf8");
  expect(JSON.parse(content).generations).toHaveLength(1);
  expect(content).not.toMatch(/private prompt|private error|actor answer|session-secret|"run"|output/);
  await expect(retainPrivateTextTrace(logs, review, 1, 3, "run", 2)).rejects.toThrow(/missing completed/);
  expect(await readdir(review)).toEqual(files);
  await retainPrivateTextTrace(logs, review, 1, 4, "quiet-run", 0);
  expect(
    JSON.parse(await readFile(path.join(review, "text-boundaries-case-1-trigger-4.json"), "utf8")).generations,
  ).toEqual([]);
});
