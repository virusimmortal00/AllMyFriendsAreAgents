import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { expectedVisualKeys, VISUAL_SCENARIOS, VISUAL_VIEWPORTS } from "../tests/visual/matrix.js";

export const VISUAL_QUESTIONS = ["screenUse", "navigation", "retroStyle", "proportion", "emptyArea", "scrollAndActions", "outcome"] as const;
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const key = z.string().regex(/^[a-z0-9-]+$/);
const scrollRegionSchema = z.object({
  name: z.string().min(1).max(160),
  offset: z.number().int().nonnegative(),
  maximum: z.number().int().nonnegative(),
}).strict().refine(({ offset, maximum }) => offset <= maximum, { message: "Scroll offset cannot exceed its maximum." });
export const captureSchema = z.object({
  key, viewId: z.string(), engine: z.enum(["chromium", "webkit"]),
  viewport: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).strict(),
  screenshotSha256: sha, layoutIssues: z.array(z.string()),
  scrollRegions: z.array(scrollRegionSchema).max(20),
}).strict();
export const runSchema = z.object({
  schemaVersion: z.literal(1), inputDigest: sha, headCommit: z.string().regex(/^[a-f0-9]{40}$/),
  dirty: z.boolean(), implementationAgentId: z.string().min(3), platform: z.string(),
  createdAt: z.iso.datetime(), capturePassed: z.boolean(), captures: z.array(captureSchema),
}).strict();
const answer = z.object({ verdict: z.enum(["pass", "fail"]), observation: z.string().trim().min(20) }).strict();
export const visualAnswersSchema = z.object({ screenUse: answer, navigation: answer, retroStyle: answer, proportion: answer, emptyArea: answer, scrollAndActions: answer, outcome: answer }).strict();
export const reviewSchema = z.object({
  schemaVersion: z.literal(1), inputDigest: sha,
  reviews: z.array(z.object({
    key, screenshotSha256: sha, reviewerAgentId: z.string().trim().min(3), reviewedAt: z.iso.datetime(),
    inspectedImage: z.literal(true),
    answers: visualAnswersSchema,
  }).strict()),
}).strict();
export type VisualRun = z.infer<typeof runSchema>;
export type VisualReview = z.infer<typeof reviewSchema>;

const receiptBase = z.object({
  keys: z.array(key).min(1).max(3),
  startedAt: z.iso.datetime(),
  promptSha256: sha,
  imageHashes: z.array(sha).min(1).max(3),
}).strict();
const completedReceipt = receiptBase.extend({
  completedAt: z.iso.datetime(),
  threadId: z.string().uuid(),
  usage: z.object({ input_tokens: z.number().nonnegative(), cached_input_tokens: z.number().nonnegative(), output_tokens: z.number().nonnegative() }).strict(),
  startupWarnings: z.array(z.literal("code-mode-host-disabled")),
  status: z.literal("completed"),
  verdictSha256: sha,
}).strict();
const failedReceipt = receiptBase.extend({ status: z.literal("failed"), error: z.string().min(1).max(300) }).strict();
export const visualReceiptsSchema = z.object({
  schemaVersion: z.literal(1), inputDigest: sha, cliVersion: z.string().regex(/^codex-cli [a-zA-Z0-9.+-]+$/),
  auth: z.literal("chatgpt"), requestedModel: z.string().min(1).max(160),
  receipts: z.array(z.union([completedReceipt, failedReceipt])),
}).strict();

export function hashBytes(bytes: Uint8Array | string) { return createHash("sha256").update(bytes).digest("hex"); }

export function visualInputDigest(root = process.cwd()) {
  // Include newly added source/fixtures as well as tracked inputs, but never local
  // state, secrets, screenshots, or verdicts. A review-only commit stays valid.
  const inputs = ["src", "shared", "public", "tests/visual", "scripts/visual-review.ts", "scripts/capture-visual.ts", "scripts/check-visual-review.ts", "scripts/codex-visual-review.ts", "scripts/review-visual.ts", "package.json", "pnpm-lock.yaml", "tsconfig.visual.json", "docs/design/ui-standards.md", "docs/testing/visual-review.md"];
  const files = [...new Set(execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...inputs], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean))].sort();
  const hash = createHash("sha256");
  for (const file of files) hash.update(file).update("\0").update(hashBytes(readFileSync(resolve(root, file)))).update("\0");
  return hash.digest("hex");
}

export function validateVisualCapture(runValue: unknown, currentInputDigest: string, readImage: (key: string) => Uint8Array) {
  const run = runSchema.parse(runValue);
  const errors: string[] = [];
  if (!run.capturePassed) errors.push("The browser capture run failed.");
  if (run.inputDigest !== currentInputDigest) errors.push("The review is stale: UI, fixture, or review-contract inputs changed.");
  const expected = expectedVisualKeys().sort();
  if (JSON.stringify(run.captures.map((capture) => capture.key).sort()) !== JSON.stringify(expected)) errors.push("Capture coverage is missing, duplicated, or unexpected.");
  for (const capture of run.captures) {
    const [engine, viewportId, scenarioId] = capture.key.split("--");
    const viewport = VISUAL_VIEWPORTS.find((item) => item.id === viewportId);
    const scenario = VISUAL_SCENARIOS.find((item) => item.id === scenarioId);
    if (!expected.includes(capture.key) || !viewport || !scenario || capture.engine !== engine || capture.viewId !== scenario.view.id || capture.viewport.width !== viewport.width || capture.viewport.height !== viewport.height) {
      errors.push(`${capture.key}: unexpected view, engine, or actual viewport.`);
      continue;
    }
    if (capture.layoutIssues.length) errors.push(`${capture.key}: layout assertions failed.`);
    try {
      if (hashBytes(readImage(capture.key)) !== capture.screenshotSha256) errors.push(`${capture.key}: screenshot content changed.`);
    } catch { errors.push(`${capture.key}: screenshot is missing.`); }
  }
  return errors;
}

export function validateVisualReview(runValue: unknown, reviewValue: unknown, currentInputDigest: string, readImage: (key: string) => Uint8Array) {
  const run = runSchema.parse(runValue);
  const review = reviewSchema.parse(reviewValue);
  const errors = validateVisualCapture(run, currentInputDigest, readImage);
  if (review.inputDigest !== run.inputDigest) errors.push("The review is stale: UI, fixture, or review-contract inputs changed.");
  if (JSON.stringify(review.reviews.map((item) => item.key).sort()) !== JSON.stringify(expectedVisualKeys().sort())) errors.push("Every expected screenshot needs exactly one independent review.");
  for (const capture of run.captures) {
    const item = review.reviews.find((entry) => entry.key === capture.key);
    if (!item) continue;
    if (item.screenshotSha256 !== capture.screenshotSha256) errors.push(`${capture.key}: reviewer inspected a different screenshot.`);
    if (item.reviewerAgentId === run.implementationAgentId) errors.push(`${capture.key}: implementation agent cannot approve its own screenshots.`);
    if (Date.parse(item.reviewedAt) < Date.parse(run.createdAt)) errors.push(`${capture.key}: review predates capture.`);
    for (const question of VISUAL_QUESTIONS) if (item.answers[question].verdict !== "pass") errors.push(`${capture.key}: ${question} failed visual review.`);
  }
  return errors;
}

export function validateVisualReceipts(
  runValue: unknown,
  reviewValue: unknown,
  receiptsValue: unknown,
  promptHash: (captures: VisualRun["captures"]) => string,
) {
  const run = runSchema.parse(runValue);
  const review = reviewSchema.parse(reviewValue);
  const document = visualReceiptsSchema.parse(receiptsValue);
  const errors: string[] = [];
  if (document.inputDigest !== run.inputDigest || document.inputDigest !== review.inputDigest) errors.push("The review receipts are stale.");
  const completed = document.receipts.filter((receipt): receipt is z.infer<typeof completedReceipt> => receipt.status === "completed");
  if (completed.length !== document.receipts.length) errors.push("A reviewer invocation failed; its images cannot be approved.");
  if (new Set(completed.map((receipt) => receipt.threadId)).size !== completed.length) errors.push("Each completed receipt must represent a different fresh reviewer session.");
  const receiptKeys = completed.flatMap((receipt) => receipt.keys);
  if (new Set(receiptKeys).size !== receiptKeys.length || JSON.stringify([...receiptKeys].sort()) !== JSON.stringify(review.reviews.map((item) => item.key).sort())) {
    errors.push("Completed reviewer receipts must cover every review exactly once.");
  }
  for (const receipt of completed) {
    if (new Set(receipt.keys).size !== receipt.keys.length || receipt.imageHashes.length !== receipt.keys.length) {
      errors.push("A reviewer receipt has duplicated keys or mismatched image hashes.");
      continue;
    }
    const captures = receipt.keys.map((receiptKey) => run.captures.find((capture) => capture.key === receiptKey));
    if (captures.some((capture) => !capture)) {
      errors.push("A reviewer receipt references an unknown screenshot.");
      continue;
    }
    const exactCaptures = captures as VisualRun["captures"];
    if (exactCaptures.some((capture, index) => capture.screenshotSha256 !== receipt.imageHashes[index])) errors.push("A reviewer receipt is bound to different screenshot bytes.");
    if (receipt.promptSha256 !== promptHash(exactCaptures)) errors.push("A reviewer receipt is bound to a different review prompt.");
    if (Date.parse(receipt.startedAt) < Date.parse(run.createdAt) || Date.parse(receipt.completedAt) < Date.parse(receipt.startedAt)) errors.push("A reviewer receipt has an invalid capture or completion time.");
    const reviewed = receipt.keys.map((receiptKey) => review.reviews.find((item) => item.key === receiptKey));
    if (reviewed.some((item) => !item || item.reviewerAgentId !== `codex:${receipt.threadId}` || item.reviewedAt !== receipt.completedAt)) {
      errors.push("A reviewer receipt does not match the recorded reviewer session and completion time.");
      continue;
    }
    const verdict = { reviews: receipt.keys.map((receiptKey) => {
      const item = review.reviews.find((candidate) => candidate.key === receiptKey)!;
      return { key: item.key, inspectedImage: item.inspectedImage, answers: item.answers };
    }) };
    if (receipt.verdictSha256 !== hashBytes(JSON.stringify(verdict))) errors.push("A reviewer receipt does not match the recorded verdict.");
  }
  return errors;
}
