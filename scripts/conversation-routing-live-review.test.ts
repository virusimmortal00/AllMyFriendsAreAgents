import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";
import { describe, expect, it } from "vitest";
import { parseScalarCanaryManifest } from "./conversation-routing-live-analysis.js";
import {
  buildOfflineReviewHtml,
  convertOfflineReviewExport,
  parseOfflineReviewExport,
  parseReviewLocator,
  parseReviewQueue,
  reviewFingerprint,
  selectPairedReviewQueue,
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
});
