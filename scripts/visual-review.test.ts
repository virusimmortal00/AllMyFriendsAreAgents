import { describe, expect, it } from "vitest";
import { expectedVisualKeys, VISUAL_SCENARIOS, VISUAL_VIEWPORTS } from "../tests/visual/matrix.js";
import { captureSchema, hashBytes, validateVisualReceipts, validateVisualReview, VISUAL_QUESTIONS, type VisualReview, type VisualRun } from "./visual-review.js";
import { requiredAt, requiredValue } from "./type-invariants.js";

function fixture() {
  const bytes = new Uint8Array([1, 2, 3]);
  const digest = hashBytes("source");
  const captures = expectedVisualKeys().map((key) => {
    const [engine, viewportId, scenarioId] = key.split("--");
    if (engine !== "chromium" && engine !== "webkit") throw new Error(`Unexpected visual engine: ${engine ?? "missing"}`);
    const normalizedEngine: VisualRun["captures"][number]["engine"] = engine;
    const { width, height } = requiredValue(VISUAL_VIEWPORTS.find((item) => item.id === viewportId), `viewport ${viewportId ?? "missing"}`);
    const scenario = requiredValue(VISUAL_SCENARIOS.find((item) => item.id === scenarioId), `scenario ${scenarioId ?? "missing"}`);
    return { key, engine: normalizedEngine, viewId: scenario.view.id, viewport: { width, height }, screenshotSha256: hashBytes(bytes), layoutIssues: [] as string[], scrollRegions: [] };
  });
  const run: VisualRun = { schemaVersion: 1, inputDigest: digest, headCommit: "a".repeat(40), dirty: false, implementationAgentId: "author", platform: "test", createdAt: "2026-08-30T00:00:00.000Z", capturePassed: true, captures };
  const reviews: VisualReview["reviews"] = [];
  const receiptEntries: any[] = [];
  const completedAt = "2026-08-30T01:00:00.000Z";
  for (let index = 0; index < captures.length; index += 3) {
    const batch = captures.slice(index, index + 3);
    const threadId = `018f1010-1234-4000-8000-${String(index / 3 + 1).padStart(12, "0")}`;
    const batchReviews: VisualReview["reviews"] = batch.map((capture) => ({ key: capture.key, screenshotSha256: capture.screenshotSha256, reviewerAgentId: `codex:${threadId}`, reviewedAt: completedAt, inspectedImage: true, answers: Object.fromEntries(VISUAL_QUESTIONS.map((question) => [question, { verdict: "pass", observation: `Observed ${question}: the screenshot shows the expected composition.` }])) as VisualReview["reviews"][number]["answers"] }));
    reviews.push(...batchReviews);
    const verdict = { reviews: batchReviews.map(({ key, inspectedImage, answers }) => ({ key, inspectedImage, answers })) };
    receiptEntries.push({ keys: batch.map((capture) => capture.key), startedAt: "2026-08-30T00:59:00.000Z", promptSha256: hashBytes("prompt"), imageHashes: batch.map((capture) => capture.screenshotSha256), completedAt, threadId, usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 50 }, startupWarnings: [], status: "completed", verdictSha256: hashBytes(JSON.stringify(verdict)) });
  }
  const review = { schemaVersion: 1, inputDigest: digest, reviews };
  const receipts = { schemaVersion: 1, inputDigest: digest, cliVersion: "codex-cli 1.2.3", auth: "chatgpt", requestedModel: "CLI default", receipts: receiptEntries };
  return { run, review, receipts, digest, readImage: () => bytes, promptHash: () => hashBytes("prompt") };
}

describe("independent screenshot review gate", () => {
  it("requires bounded factual scroll measurements rather than silently omitting them", () => {
    const capture = requiredAt(fixture().run.captures, 0, "first visual capture");
    expect(captureSchema.safeParse({ ...capture, scrollRegions: undefined }).success).toBe(false);
    for (const maximum of [-1, NaN, Infinity, 1.5]) expect(captureSchema.safeParse({ ...capture, scrollRegions: [{ name: "Page", offset: 0, maximum }] }).success).toBe(false);
    for (const region of [{ name: "Page", offset: -1, maximum: 1 }, { name: "Page", offset: 2, maximum: 1 }]) expect(captureSchema.safeParse({ ...capture, scrollRegions: [region] }).success).toBe(false);
    for (const region of [{ name: "Page", offset: 0, maximum: 0 }, { name: "Page", offset: 2, maximum: 2 }]) expect(captureSchema.safeParse({ ...capture, scrollRegions: [region] }).success).toBe(true);
    expect(captureSchema.safeParse({ ...capture, scrollRegions: Array.from({ length: 21 }, () => ({ name: "Page", offset: 0, maximum: 1 })) }).success).toBe(false);
  });
  it("accepts a complete current independently reviewed capture set", () => {
    const { run, review, receipts, digest, readImage, promptHash } = fixture();
    expect(validateVisualReview(run, review, digest, readImage)).toEqual([]);
    expect(validateVisualReceipts(run, review, receipts, promptHash)).toEqual([]);
  });
  it.each(["missing receipt", "wrong image", "wrong prompt", "wrong verdict", "wrong reviewer", "reused session", "failed invocation"])("rejects %s", (kind) => {
    const { run, review, receipts, promptHash } = fixture();
    const first = requiredAt(receipts.receipts, 0, "first visual review receipt") as Record<string, unknown>;
    if (kind === "missing receipt") receipts.receipts.pop();
    if (kind === "wrong image") (first.imageHashes as string[])[0] = hashBytes("different image");
    if (kind === "wrong prompt") first.promptSha256 = hashBytes("different prompt");
    if (kind === "wrong verdict") first.verdictSha256 = hashBytes("different verdict");
    if (kind === "wrong reviewer") requiredAt(review.reviews, 0, "first visual review").reviewerAgentId = "codex:018f1010-1234-4000-8000-999999999999";
    if (kind === "reused session") requiredAt(receipts.receipts, 1, "second visual review receipt").threadId = first.threadId;
    if (kind === "failed invocation") receipts.receipts[0] = { keys: first.keys, startedAt: first.startedAt, promptSha256: first.promptSha256, imageHashes: first.imageHashes, status: "failed", error: "Reviewer failed safely." };
    expect(validateVisualReceipts(run, review, receipts, promptHash).length).toBeGreaterThan(0);
  });
  it.each(["stale source", "stale review", "missing screenshot", "missing review", "duplicate review", "wrong viewport", "self approval", "failed layout", "failed capture", "changed screenshot", "failed visual verdict"])("rejects %s", (kind) => {
    const { run, review, digest, readImage } = fixture();
    let current = digest;
    if (kind === "stale source") current = hashBytes("changed");
    if (kind === "stale review") review.inputDigest = hashBytes("old");
    if (kind === "missing screenshot") run.captures.pop();
    if (kind === "missing review") review.reviews.pop();
    const firstCapture = requiredAt(run.captures, 0, "first visual capture");
    const firstReview = requiredAt(review.reviews, 0, "first visual review");
    if (kind === "duplicate review") review.reviews.push(firstReview);
    if (kind === "wrong viewport") firstCapture.viewport.width = 1280;
    if (kind === "self approval") firstReview.reviewerAgentId = "author";
    if (kind === "failed layout") firstCapture.layoutIssues.push("Overlapping rows");
    if (kind === "failed capture") run.capturePassed = false;
    if (kind === "changed screenshot") firstCapture.screenshotSha256 = hashBytes("different image");
    if (kind === "failed visual verdict") firstReview.answers.proportion.verdict = "fail";
    expect(validateVisualReview(run, review, current, readImage).length).toBeGreaterThan(0);
  });
  it("rejects a verdict that does not answer all seven questions", () => {
    const { run, review, digest, readImage } = fixture();
    delete (requiredAt(review.reviews, 0, "first visual review").answers as Partial<VisualReview["reviews"][number]["answers"]>).navigation;
    expect(() => validateVisualReview(run, review, digest, readImage)).toThrow();
  });
  it("rejects missing image bytes even when a verdict exists", () => {
    const { run, review, digest } = fixture();
    expect(validateVisualReview(run, review, digest, () => { throw new Error("missing"); })).toContain(`${requiredAt(run.captures, 0, "first visual capture").key}: screenshot is missing.`);
  });
});
