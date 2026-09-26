import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";
import { describe, expect, it } from "vitest";
import { parseScalarCanaryManifest } from "./conversation-routing-live-analysis.js";
import {
  buildOfflineReviewHtml,
  convertOfflineFrameExport,
  convertOfflineReviewExport,
  parseOfflineReviewExport,
  parseReviewLocator,
  parseReviewQueue,
  reviewFingerprint,
  selectCalibrationReviewQueue,
  selectCompleteFrameReviewQueue,
  selectFlaggedReviewQueue,
  selectFrameCandidateReviewQueue,
  selectPairedReviewQueue,
  selectVisibleReviewQueue,
} from "./conversation-routing-live-review.js";

const ids = [
  "review-aaaaaaaaaaaa",
  "review-bbbbbbbbbbbb",
  "review-cccccccccccc",
  "review-dddddddddddd",
  "review-eeeeeeeeeeee",
  "review-ffffffffffff",
];
const queue = { schemaVersion: 1, reviewIds: ids.slice(0, 2) };
const bundle = (
  reviewId: string,
  prompt = "A fictional question <script>fetch('https://example.invalid/leak')</script>",
) => ({
  schemaVersion: 1,
  reviewId,
  scenarioKind: "direct",
  expectedDirectAgents: ["agent-a"],
  prompt,
  messages: [
    { speaker: "Operator", kind: "human", text: "Please answer." },
    { speaker: "Agent A", kind: "agent", text: "A fictional reply." },
  ],
  qualityContext: { originalHumanAlias: "Operator", roster: [{ agentId: "agent-a", conversationalName: "Agent A" }] },
});
const bundles = ids.slice(0, 2).map((id) => bundle(id));
const manifest = {
  schemaVersion: 1,
  kind: "conversation-routing-live-canary",
  cases: [
    {
      agentCount: 1,
      study: { pairId: "pair-a", arm: "a", factor: "jev" },
      triggers: [{ scenarioId: "case-a", runId: "run-a" }],
    },
    {
      agentCount: 1,
      study: { pairId: "pair-a", arm: "b", factor: "jev" },
      triggers: [{ scenarioId: "case-b", runId: "run-b" }],
    },
  ],
};
const rawManifest = {
  schemaVersion: 1,
  kind: "conversation-routing-live-canary",
  sourceCommit: "b".repeat(40),
  sourceDirty: false,
  sourceSha256: "a".repeat(64),
  scenarioCatalogSha256: "a".repeat(64),
  openCodeVersion: "1.18.25",
  actorModel: "openrouter/example/actor-model",
  judgeModel: null,
  concurrency: 1,
  maxCases: 12,
  maxGenerationsPerCase: 8,
  scenarioTimeoutMs: 120_000,
  totalTimeoutMs: 2_400_000,
  cases: (["jev-on", "jev-off"] as const).map((variant, index) => ({
    schemaVersion: 1,
    scenarioId: `case-${index === 0 ? "a" : "b"}`,
    variant,
    agentCount: 1,
    energy: "low",
    preflightMode: "enforce",
    privateReviewRetained: true,
    judge: [],
    triggers: [
      {
        schemaVersion: 1,
        scenarioId: `case-${index === 0 ? "a" : "b"}`,
        variant,
        runId: `run-${index === 0 ? "a" : "b"}`,
        preflightMode: "enforce",
        requiredAddressAgents: ["agent-a"],
        routing: [{ agentId: "agent-a", outcome: "invoke", reason: "required_plain_address" }],
        classifier:
          variant === "jev-on"
            ? {
                outcome: "completed",
                reason: null,
                durationMs: 1,
                reportedInputTokens: 1,
                reportedOutputTokens: 1,
                reportedCostUsd: 0.001,
              }
            : {
                outcome: "skipped",
                reason: "room-disabled",
                durationMs: 0,
                reportedInputTokens: null,
                reportedOutputTokens: null,
                reportedCostUsd: null,
              },
        queueDelayMs: 1,
        firstVisibleMs: 2,
        terminalReason: "no-explicit-unresolved-state",
        attemptedTurns: 1,
        respondedTurns: 1,
        yieldedTurns: 0,
        confirmedDeliveredBursts: 1,
        generationStarts: 1,
        generationCompletions: 1,
        generationFailures: 0,
        openCodeUsageProvenance: "step-fields-v1",
        openCodeObservedInputTokens: 1,
        openCodeObservedOutputTokens: 1,
        openCodeObservedReasoningTokens: 0,
        openCodeObservedCacheReadTokens: 0,
        openCodeObservedCacheWriteTokens: 0,
        openCodeObservedTotalTokens: 2,
        openCodeTotalCoverage: "reported",
        openCodeEstimatedCostUsd: 0.001,
        openCodeUsageCoverage: "reported",
      },
    ],
  })),
};
const map = {
  schemaVersion: 1,
  entries: [
    { reviewId: ids[0], scenarioId: "case-a", runId: "run-a", sourceFile: "source-a.json", priority: "sample" },
    { reviewId: ids[1], scenarioId: "case-b", runId: "run-b", sourceFile: "source-b.json", priority: "sample" },
  ],
};
const exported = () => ({
  schemaVersion: 1,
  kind: "blinded-quality-ratings",
  packFingerprint: reviewFingerprint(queue, bundles),
  ratings: [
    {
      reviewId: ids[0],
      axes: { social_cadence: { status: "rated", score: 4 }, length_fit: { status: "not_assessable" } },
    },
  ],
});

describe("private offline review pack", () => {
  it("selects every small V2 identity trigger without judge-dependent filtering or adjacent twins", () => {
    const cases = ["one", "two"].flatMap((pairId) =>
      ["a", "b"].map((arm) => ({
        scenarioId: `${pairId}-${arm}`,
        study: {
          schemaVersion: 2,
          factor: "room-system",
          pairId,
          arm,
          roomSystemProfileId: arm === "a" ? "legacy-v1" : "room-v1",
        },
        triggers: [{ scenarioId: `${pairId}-${arm}`, runId: `run-${pairId}-${arm}` }],
      })),
    );
    const studyManifest = { sourceSha256: "a".repeat(64), judgeRubric: "v3", studyPlan: { schemaVersion: 2 }, cases };
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          sourceSha256: studyManifest.sourceSha256,
          studyPlan: studyManifest.studyPlan,
          cases: cases.map((row) => ({
            scenarioId: row.scenarioId,
            study: row.study,
            triggers: row.triggers.map((trigger) => [trigger.scenarioId, trigger.runId]),
          })),
        }),
      )
      .digest("hex");
    const entries = cases.map((row, index) => ({
      reviewId: ids[index]!,
      scenarioId: row.scenarioId,
      runId: row.triggers[0]!.runId,
      sourceFile: `source-${index}.json`,
      priority: "sample",
    }));
    const locator = { schemaVersion: 1, manifestFingerprint: fingerprint, entries };
    const chosen = selectCompleteFrameReviewQueue(studyManifest, locator, "fixed-seed");
    expect(chosen.queue.reviewIds).toHaveLength(4);
    expect(new Set(chosen.queue.reviewIds)).toEqual(new Set(entries.map((entry) => entry.reviewId)));
    expect(chosen.receipt).toMatchObject({ kind: "frame-complete", screenedTriggers: 4, selectedTriggers: 4 });
    expect(selectCompleteFrameReviewQueue(studyManifest, locator, "fixed-seed")).toEqual(chosen);
    expect(JSON.stringify(chosen.receipt)).not.toContain("room-v1");
    const firstPair = (id: string) => entries.find((entry) => entry.reviewId === id)!.scenarioId.split("-")[0];
    expect(chosen.queue.reviewIds.slice(0, 2).map(firstPair)).toEqual(expect.arrayContaining(["one", "two"]));
    expect(() =>
      selectCompleteFrameReviewQueue(studyManifest, { ...locator, entries: entries.slice(1) }, "fixed-seed"),
    ).toThrow();
    const mixed = structuredClone(studyManifest);
    mixed.cases[0]!.study.schemaVersion = 1;
    expect(() => selectCompleteFrameReviewQueue(mixed, locator, "fixed-seed")).toThrow();
    const terminalCases = cases.map((row) => ({
      ...row,
      study: {
        ...row.study,
        schemaVersion: 3,
        factor: "terminal-instruction",
        roomSystemProfileId: "room-v1",
        terminalInstructionProfileId: row.study.arm === "a" ? "current-v1" : "contribution-first-v1",
      },
    }));
    const terminalManifest = { ...studyManifest, studyPlan: { schemaVersion: 3 }, cases: terminalCases };
    const terminalFingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          sourceSha256: terminalManifest.sourceSha256,
          studyPlan: terminalManifest.studyPlan,
          cases: terminalCases.map((row) => ({
            scenarioId: row.scenarioId,
            study: row.study,
            triggers: row.triggers.map((trigger) => [trigger.scenarioId, trigger.runId]),
          })),
        }),
      )
      .digest("hex");
    const terminalLocator = { ...locator, manifestFingerprint: terminalFingerprint };
    expect(
      selectCompleteFrameReviewQueue(terminalManifest, terminalLocator, "fixed-seed").queue.reviewIds,
    ).toHaveLength(4);
    const invalidTerminal = structuredClone(terminalManifest);
    invalidTerminal.cases[0]!.study.roomSystemProfileId = "legacy-v1";
    expect(() => selectCompleteFrameReviewQueue(invalidTerminal, terminalLocator, "fixed-seed")).toThrow();
  });
  it("samples 12 distinct factor-balanced pairs without judge-score influence and keeps flagged cases separate", () => {
    const cases: Record<string, unknown>[] = [];
    const entries: Array<{
      reviewId: string;
      scenarioId: string;
      runId: string;
      sourceFile: string;
      priority: string;
    }> = [];
    const factors = ["jev", "gate", "agent-prompt"] as const;
    let serial = 0;
    for (const factor of factors)
      for (let pairIndex = 0; pairIndex < 12; pairIndex++) {
        const count = factor === "gate" ? [2, 3, 4][pairIndex % 3]! : [1, 2, 3, 4][pairIndex % 4]!;
        const pairId = `${factor.replace("-", "")}-${pairIndex}`;
        for (const arm of ["a", "b"]) {
          const scenarioId = `${pairId}-${arm}`;
          const triggers = [0, 1].map((ordinal) => {
            const runId = `run-${scenarioId}-${ordinal}`;
            const reviewId = `review-${(serial++).toString(16).padStart(12, "0")}`;
            entries.push({ reviewId, scenarioId, runId, sourceFile: `source-${serial}.json`, priority: "unselected" });
            return {
              scenarioId,
              runId,
              requiredTargetCount: 1,
              confirmedDeliveredBursts: pairIndex < 6 && ordinal === 0 ? 0 : 1,
            };
          });
          cases.push({ agentCount: count, study: { pairId, arm, factor }, triggers, qualityJudge: [] });
        }
      }
    const scalar = { schemaVersion: 1, kind: "conversation-routing-live-canary", cases };
    const locator = { schemaVersion: 1, entries };
    const calibration = selectCalibrationReviewQueue(scalar, locator, "fixed-before-outcomes");
    expect(calibration.receipt.selected).toHaveLength(12);
    expect(calibration.queue.reviewIds).toHaveLength(24);
    expect(new Set(calibration.receipt.selected.map((row) => row.pairId)).size).toBe(12);
    for (const factor of factors)
      expect(calibration.receipt.selected.filter((row) => row.factor === factor)).toHaveLength(4);
    const altered = {
      ...scalar,
      cases: cases.map((row) => ({ ...row, qualityJudge: [{ status: "failed", score: 1 }] })),
    };
    expect(selectCalibrationReviewQueue(altered, locator, "fixed-before-outcomes").queue).toEqual(calibration.queue);
    for (const row of calibration.receipt.selected) {
      const positions = row.reviewIds.map((id) => calibration.queue.reviewIds.indexOf(id));
      expect(Math.abs(positions[0]! - positions[1]!)).toBeGreaterThan(1);
    }
    const flagged = selectFlaggedReviewQueue(scalar, locator, calibration.receipt, "fixed-before-outcomes");
    expect(() =>
      selectFlaggedReviewQueue(scalar, locator, { ...calibration.receipt, selected: [] }, "fixed-before-outcomes"),
    ).toThrow();
    expect(flagged.receipt.selected).toHaveLength(3);
    expect(flagged.queue?.reviewIds).toHaveLength(6);
    expect(flagged.receipt.selected.map((row) => row.factor).sort()).toEqual([...factors].sort());
    for (const row of flagged.receipt.selected) {
      expect(row.triggerOrdinal).toBe(0);
      expect(
        calibration.receipt.selected.some(
          (item) => item.pairId === row.pairId && item.triggerOrdinal === row.triggerOrdinal,
        ),
      ).toBe(false);
    }
    expect(JSON.stringify(calibration.queue)).not.toContain("factor");
    expect(JSON.stringify(flagged.queue)).not.toContain("required");
    const visible = selectVisibleReviewQueue(scalar, locator, calibration.receipt, "fixed-before-outcomes");
    expect(visible.queue.reviewIds).toHaveLength(20);
    expect(visible.receipt.selected).toHaveLength(10);
    expect(visible.receipt.selected.filter((row) => row.factor === "agent-prompt")).toHaveLength(2);
    expect(visible.receipt.selected.filter((row) => row.factor === "gate")).toHaveLength(4);
    expect(visible.receipt.selected.filter((row) => row.factor === "jev")).toHaveLength(4);
    expect(new Set(visible.receipt.selected.map((row) => row.pairId)).size).toBe(10);
    expect(selectVisibleReviewQueue(scalar, locator, calibration.receipt, "fixed-before-outcomes")).toEqual(visible);
    expect(selectVisibleReviewQueue(altered, locator, calibration.receipt, "fixed-before-outcomes").queue).toEqual(
      visible.queue,
    );
    for (const row of visible.receipt.selected) {
      expect(
        calibration.receipt.selected.some(
          (item) => item.pairId === row.pairId && item.triggerOrdinal === row.triggerOrdinal,
        ),
      ).toBe(false);
      expect(
        Math.abs(visible.queue.reviewIds.indexOf(row.reviewIds[0]) - visible.queue.reviewIds.indexOf(row.reviewIds[1])),
      ).toBeGreaterThan(1);
    }
    const noPromptVisible = {
      ...scalar,
      cases: cases.map((room) => ({
        ...room,
        triggers:
          room.study && (room.study as { factor: string }).factor === "agent-prompt"
            ? (room.triggers as Array<Record<string, unknown>>).map((trigger) => ({
                ...trigger,
                confirmedDeliveredBursts: 0,
              }))
            : room.triggers,
      })),
    };
    expect(() =>
      selectVisibleReviewQueue(noPromptVisible, locator, calibration.receipt, "fixed-before-outcomes"),
    ).toThrow();
    expect(() =>
      selectFlaggedReviewQueue(
        { ...scalar, sourceSha256: "changed" },
        locator,
        calibration.receipt,
        "fixed-before-outcomes",
      ),
    ).toThrow();
  });
  it("converts only known opaque IDs to the existing private four-axis schema", () => {
    const converted = convertOfflineReviewExport(exported(), queue, map, manifest, bundles);
    expect(converted).toEqual({
      schemaVersion: 2,
      ratings: [
        {
          scenarioId: "case-a",
          runId: "run-a",
          axes: { social_cadence: { status: "rated", score: 4 }, length_fit: { status: "not_assessable" } },
        },
      ],
    });
    expect(JSON.stringify(converted)).not.toContain("fictional question");
    expect(() =>
      parseOfflineReviewExport(
        { ...exported(), ratings: [{ reviewId: "review-000000000000", axes: {} }] },
        parseReviewQueue(queue),
        reviewFingerprint(queue, bundles),
      ),
    ).toThrow();
    expect(() =>
      convertOfflineReviewExport(
        { ...exported(), ratings: [exported().ratings[0], exported().ratings[0]] },
        queue,
        map,
        manifest,
        bundles,
      ),
    ).toThrow();
    expect(() =>
      convertOfflineReviewExport(
        { ...exported(), ratings: [{ reviewId: ids[0], axes: { social_cadence: { status: "rated", score: 6 } } }] },
        queue,
        map,
        manifest,
        bundles,
      ),
    ).toThrow();
    expect(() =>
      convertOfflineReviewExport(exported(), queue, map, manifest, [bundle(ids[0]!, "Changed source"), bundles[1]!]),
    ).toThrow();
    expect(() =>
      convertOfflineReviewExport(
        {
          ...exported(),
          ratings: [{ reviewId: ids[0], axes: { social_cadence: { status: "rated", score: 4 }, prompt: "leak" } }],
        },
        queue,
        map,
        manifest,
        bundles,
      ),
    ).toThrow();
  });

  it("selects paired arms at the same ordinal across factors in stable nonadjacent blind order", () => {
    const factors = ["jev", "gate", "agent-prompt"];
    const cases = factors.flatMap((factor, index) =>
      ["a", "b"].map((arm, side) => ({
        agentCount: index + 1,
        study: { pairId: `pair-${index}`, arm, factor },
        triggers: [{ scenarioId: `case-${index}-${arm}`, runId: `run-${index}-${arm}` }],
      })),
    );
    const entries = cases.map((row, index) => ({
      reviewId: ids[index],
      scenarioId: row.triggers[0]!.scenarioId,
      runId: row.triggers[0]!.runId,
      sourceFile: `source-${index}.json`,
      priority: "sample",
    }));
    const plan = { schemaVersion: 1, kind: "conversation-routing-live-canary", cases };
    const selected = selectPairedReviewQueue(
      plan,
      { schemaVersion: 1, entries },
      { seed: "fictional-seed", maxPairs: 3 },
    );
    expect(selected.reviewIds).toHaveLength(6);
    expect(() =>
      selectPairedReviewQueue(
        plan,
        { schemaVersion: 1, entries: entries.slice(1) },
        { seed: "fictional-seed", maxPairs: 3 },
      ),
    ).toThrow();
    expect(
      selectPairedReviewQueue(plan, { schemaVersion: 1, entries }, { seed: "fictional-seed", maxPairs: 3 }),
    ).toEqual(selected);
    for (let index = 0; index < 3; index++) {
      const a = selected.reviewIds.indexOf(ids[index * 2]!);
      const b = selected.reviewIds.indexOf(ids[index * 2 + 1]!);
      expect(Math.abs(a - b)).toBeGreaterThan(1);
    }
  });

  it("writes only 0600 private artifacts and refuses changed source content", () => {
    expect(parseScalarCanaryManifest(rawManifest).cases).toHaveLength(2);
    const root = mkdtempSync(join(tmpdir(), "private-review-pack-"));
    try {
      const blinded = join(root, "blinded"),
        blindedB = join(root, "blinded-b"),
        source = join(root, "source"),
        sourceB = join(root, "source-b");
      mkdirSync(blinded, { mode: 0o700 });
      mkdirSync(blindedB, { mode: 0o700 });
      mkdirSync(source, { mode: 0o700 });
      mkdirSync(sourceB, { mode: 0o700 });
      const write = (name: string, value: unknown) =>
        writeFileSync(join(root, name), JSON.stringify(value), { mode: 0o600 });
      write("manifest-on.json", { ...rawManifest, cases: [rawManifest.cases[0]] });
      write("manifest-off.json", { ...rawManifest, cases: [rawManifest.cases[1]] });
      const manifestArgs = [
        "--manifest",
        join(root, "manifest-on.json"),
        "--manifest",
        join(root, "manifest-off.json"),
      ];
      write("queue.json", queue);
      write("map.json", map);
      bundles.forEach((value, index) => {
        writeFileSync(join(blinded, `${ids[index]}.json`), JSON.stringify(value), { mode: 0o600 });
        writeFileSync(
          join(source, `source-${index === 0 ? "a" : "b"}.json`),
          JSON.stringify({
            ...value,
            scenarioId: index === 0 ? "case-a" : "case-b",
            runId: index === 0 ? "run-a" : "run-b",
          }),
          { mode: 0o600 },
        );
      });
      renameSync(join(blinded, `${ids[1]}.json`), join(blindedB, `${ids[1]}.json`));
      renameSync(join(source, "source-b.json"), join(sourceB, "source-b.json"));
      const cli = resolve("scripts/conversation-routing-live-review.ts");
      execFileSync(
        "pnpm",
        [
          "exec",
          "tsx",
          cli,
          "blind",
          ...manifestArgs,
          "--source-dir",
          source,
          "--source-dir",
          sourceB,
          "--output-dir",
          join(root, "generated"),
        ],
        { stdio: "pipe" },
      );
      const generated = JSON.parse(readFileSync(join(root, "generated", "blinded-map.json"), "utf8"));
      expect(generated.entries).toHaveLength(2);
      expect(generated.manifestFingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(() => parseReviewLocator(generated, null, { ...manifest, sourceSha256: "changed" })).toThrow();
      expect(statSync(join(root, "generated", "blinded-map.json")).mode & 0o777).toBe(0o600);
      const common = [
        ...manifestArgs,
        "--queue",
        join(root, "queue.json"),
        "--map",
        join(root, "map.json"),
        "--blinded-dir",
        blinded,
        "--blinded-dir",
        blindedB,
        "--source-dir",
        source,
        "--source-dir",
        sourceB,
      ];
      execFileSync("pnpm", ["exec", "tsx", cli, "pack", ...common, "--output", join(root, "review.html")], {
        stdio: "pipe",
      });
      expect(statSync(join(root, "review.html")).mode & 0o777).toBe(0o600);
      expect(readFileSync(join(root, "review.html"), "utf8")).not.toContain('"scenarioId":"case-a"');
      write("ratings.json", exported());
      execFileSync(
        "pnpm",
        [
          "exec",
          "tsx",
          cli,
          "convert",
          ...common,
          "--ratings",
          join(root, "ratings.json"),
          "--output",
          join(root, "converted.json"),
        ],
        { stdio: "pipe" },
      );
      expect(JSON.parse(readFileSync(join(root, "converted.json"), "utf8")).schemaVersion).toBe(2);
      writeFileSync(
        join(source, "source-a.json"),
        JSON.stringify({ ...bundle(ids[0]!), scenarioId: "case-a", runId: "run-a", prompt: "Changed" }),
      );
      expect(() =>
        execFileSync("pnpm", ["exec", "tsx", cli, "pack", ...common, "--output", join(root, "bad.html")], {
          stdio: "pipe",
        }),
      ).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("supports keyboard-friendly one-card review, explicit export, and partial import with no outbound request", async () => {
    const root = mkdtempSync(join(tmpdir(), "private-review-browser-"));
    const browser = await chromium.launch({ headless: true });
    try {
      const html = join(root, "review.html");
      writeFileSync(html, buildOfflineReviewHtml(queue, bundles), { mode: 0o600 });
      const page = await browser.newPage({ acceptDownloads: true });
      const outbound: string[] = [];
      page.on("request", (request) => {
        if (/^https?:/.test(request.url())) outbound.push(request.url());
      });
      await page.goto(pathToFileURL(html).href);
      await expect.poll(async () => page.locator("#counter").textContent()).toBe("1 / 2");
      expect(await page.locator("#prompt").textContent()).toContain("<script>fetch");
      expect(await page.locator("img").count()).toBe(0);
      await page.locator('fieldset[data-axis="social_cadence"] input[value="4"]').check();
      await page.locator('fieldset[data-axis="length_fit"] input[value="NA"]').check();
      await page.keyboard.press("Alt+ArrowRight");
      expect(await page.locator("#counter").textContent()).toBe("2 / 2");
      const downloadPromise = page.waitForEvent("download");
      await page.locator("#export").click();
      const download = await downloadPromise;
      const file = await download.path();
      const saved = JSON.parse(readFileSync(file!, "utf8"));
      expect(saved.packFingerprint).toBe(reviewFingerprint(queue, bundles));
      expect(saved.ratings).toHaveLength(1);
      expect(JSON.stringify(saved)).not.toContain("fictional question");
      expect(JSON.stringify(saved)).not.toContain("case-a");
      await page.locator("#importFile").setInputFiles({
        name: "ratings.json",
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify(saved)),
      });
      await page.keyboard.press("Alt+ArrowLeft");
      expect(await page.locator('fieldset[data-axis="social_cadence"] input[value="4"]').isChecked()).toBe(true);
      await page.locator("#importFile").setInputFiles({
        name: "invalid-ratings.json",
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify({ ...saved, packFingerprint: "0".repeat(64) })),
      });
      expect(await page.locator('fieldset[data-axis="social_cadence"] input[value="4"]').isChecked()).toBe(true);
      await expect.poll(async () => page.locator("#status").textContent()).toContain("retained");
      expect(await page.locator("#replyStatus").textContent()).toContain("visible agent reply");
      expect(outbound).toEqual([]);
      await page.close();
    } finally {
      await browser.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("selects high-confidence frame candidates separately from seed-only calibration without raw receipt text", () => {
    const sources = [
      {
        ...bundle(ids[0]!),
        scenarioId: "case-a",
        runId: "run-a",
        messages: [
          { speaker: "Operator", kind: "human", text: "Please suggest a fictional sign." },
          {
            speaker: "agent-a",
            kind: "agent",
            text: "I am OpenCode, a coding assistant; this roleplay room is not my function.",
          },
        ],
      },
      {
        ...bundle(ids[1]!),
        scenarioId: "case-b",
        runId: "run-b",
        messages: [
          { speaker: "Operator", kind: "human", text: "Please suggest a fictional sign." },
          { speaker: "agent-a", kind: "agent", text: "A concise garden sign idea." },
        ],
      },
    ];
    const selected = selectFrameCandidateReviewQueue(manifest, map, sources, "fixed-seed");
    expect(selected.queue?.reviewIds).toEqual([ids[0]]);
    expect(selected.receipt).toMatchObject({
      kind: "frame-candidate",
      screenedTriggers: 2,
      selectedTriggers: 1,
      categories: { frameRejection: 1, privateMachineryLeak: 0, peerAmplification: 0 },
    });
    expect(JSON.stringify(selected.receipt)).not.toContain("OpenCode");
    expect(selectFrameCandidateReviewQueue(manifest, map, sources, "fixed-seed")).toEqual(selected);
    expect(() => selectFrameCandidateReviewQueue(manifest, map, [...sources, sources[0]], "fixed-seed")).toThrow();
    expect(() => selectFrameCandidateReviewQueue(manifest, map, sources.slice(1), "fixed-seed")).toThrow();
  });

  it("renders a private frame-only pack with conversational names and converts bounded ratings", async () => {
    const root = mkdtempSync(join(tmpdir(), "private-frame-browser-"));
    const browser = await chromium.launch({ headless: true });
    try {
      const one = { schemaVersion: 1, reviewIds: [ids[0]] };
      const card = {
        ...bundle(ids[0]!),
        messages: [
          { speaker: "Operator", kind: "human" as const, text: "Please suggest a fictional sign." },
          { speaker: "agent-a", kind: "agent" as const, text: "I am OpenCode; this room is not my job." },
        ],
      };
      const html = join(root, "frame.html");
      writeFileSync(html, buildOfflineReviewHtml(one, [card], "frame-candidate"), { mode: 0o600 });
      const completeHtml = buildOfflineReviewHtml(one, [card], "frame-complete");
      expect(completeHtml).toContain("complete frame pilot");
      expect(completeHtml).toContain("blinded-frame-ratings");
      expect(completeHtml).not.toContain("Four independent ratings");
      const page = await browser.newPage({ acceptDownloads: true });
      const outbound: string[] = [];
      page.on("request", (request) => {
        if (/^https?:/.test(request.url())) outbound.push(request.url());
      });
      await page.goto(pathToFileURL(html).href);
      expect(await page.locator("fieldset[data-axis='frame_integrity']").count()).toBe(1);
      expect(await page.locator("fieldset[data-axis='social_cadence']").count()).toBe(0);
      expect(await page.locator(".message strong").allTextContents()).toEqual(["Operator · human", "Agent A · agent"]);
      await page.locator('fieldset[data-axis="frame_integrity"] input[value="1"]').check();
      const downloadPromise = page.waitForEvent("download");
      await page.locator("#export").click();
      const download = await downloadPromise;
      expect(download.suggestedFilename()).toBe("blinded-frame-ratings.json");
      const exported = JSON.parse(readFileSync((await download.path())!, "utf8"));
      expect(exported.kind).toBe("blinded-frame-ratings");
      expect(JSON.stringify(exported)).not.toContain(card.messages[1]!.text);
      expect(JSON.stringify(exported)).not.toContain("case-a");
      expect(convertOfflineFrameExport(exported, one, map, manifest, [card])).toEqual({
        schemaVersion: 3,
        rubricVersion: "room-frame-integrity-v1",
        ratings: [{ scenarioId: "case-a", runId: "run-a", frame_integrity: { status: "rated", score: 1 } }],
      });
      expect(() =>
        convertOfflineFrameExport(
          { ...exported, ratings: [{ reviewId: ids[0], axes: { frame_integrity: { status: "rated", score: 6 } } }] },
          one,
          map,
          manifest,
          [card],
        ),
      ).toThrow();
      expect(outbound).toEqual([]);
      await page.close();
    } finally {
      await browser.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
