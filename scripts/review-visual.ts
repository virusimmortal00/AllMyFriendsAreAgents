import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { codexEnvironment, codexReviewArgs, codexBatchVerdictSchema, executeCodex, groupReviewCaptures, parseCodexResult, requireChatGptLogin, reviewPrompt } from "./codex-visual-review.js";
import { hashBytes, reviewSchema, runSchema, validateVisualCapture, validateVisualReceipts, validateVisualReview, visualInputDigest } from "./visual-review.js";
import { validateVisualScope } from "./visual-scope.js";

function readRegular(path: string, maxBytes: number) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw new Error("Expected a bounded regular evidence file, not a symlink.");
  return readFileSync(path);
}

async function main() {
  const { values } = parseArgs({ options: { run: { type: "string" }, key: { type: "string", multiple: true }, model: { type: "string" } } });
  if (!values.run) throw new Error("Usage: pnpm review:visual --run <capture-directory> [--key <screenshot-key>] [--model <Codex-model>]");
  const env = codexEnvironment(process.env);
  const root = process.cwd();
  const directory = realpathSync(resolve(values.run));
  const screenshots = resolve(directory, "screenshots");
  if (!lstatSync(screenshots).isDirectory() || lstatSync(screenshots).isSymbolicLink()) throw new Error("Expected a real screenshot directory.");
  const run = runSchema.parse(JSON.parse(readRegular(resolve(directory, "manifest.json"), 512_000).toString()));
  const readImage = (key: string) => readRegular(resolve(screenshots, `${key}.png`), 20_000_000);
  const preflight = [...validateVisualScope(run.scope, root), ...validateVisualCapture(run, visualInputDigest(root), readImage)];
  if (preflight.length) throw new Error(preflight.join("\n"));
  const requested = values.key;
  if (requested && (new Set(requested).size !== requested.length || requested.some((key) => !run.captures.some((capture) => capture.key === key)))) {
    throw new Error("Every --key must name a different screenshot in the manifest.");
  }
  const selected = run.captures.filter((capture) => !requested || requested.includes(capture.key));
  const scratch = mkdtempSync(join(tmpdir(), "codex-visual-review-"));
  const abort = new AbortController();
  const interrupt = () => abort.abort();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    const execute = (args: string[], input?: string) => executeCodex("codex", args, scratch, env, input, 180_000, abort.signal);
    const version = (await execute(["--version"])).stdout.trim();
    if (!/^codex-cli [a-zA-Z0-9.+-]+$/.test(version)) throw new Error("Cannot identify the installed Codex CLI version.");
    const help = (await execute(["exec", "--help"])).stdout;
    for (const flag of ["--ignore-user-config", "--ignore-rules", "--ephemeral", "--output-schema", "--image"]) {
      if (!help.includes(flag)) throw new Error(`Installed Codex lacks ${flag}; update Codex before running visual review.`);
    }
    const auth = await execute(["login", "status"]);
    requireChatGptLogin(`${auth.stdout}\n${auth.stderr}`);
    const output = mkdtempSync(resolve(directory, "codex-review-"));
    const standards = readFileSync(resolve(root, "docs/design/ui-standards.md"), "utf8");
    // At most three originals per fresh session and two sessions in flight.
    const batches = groupReviewCaptures(selected);
    const review: z.infer<typeof reviewSchema> = { schemaVersion: 1, inputDigest: run.inputDigest, reviews: [] };
    const receipts: unknown[] = [];
    const receiptDocument = () => ({ schemaVersion: 1, inputDigest: run.inputDigest, cliVersion: version, auth: "chatgpt" as const, requestedModel: values.model || "CLI default", receipts });
    let next = 0;
    let failed = false;
    const persist = () => {
      writeFileSync(resolve(output, "review.json"), `${JSON.stringify(review, null, 2)}\n`);
      writeFileSync(resolve(output, "receipts.json"), `${JSON.stringify(receiptDocument(), null, 2)}\n`);
    };
    console.log(`Codex image review: ${selected.length} screenshots; ChatGPT account usage applies.\nReview evidence: ${output}`);
    persist();
    async function worker() {
      while (!failed && !abort.signal.aborted && next < batches.length) {
        const index = next++;
        const captures = batches[index];
        const batchDirectory = resolve(scratch, `batch-${index}`);
        mkdirSync(batchDirectory);
        const schemaPath = resolve(batchDirectory, "verdict.schema.json");
        writeFileSync(schemaPath, JSON.stringify(z.toJSONSchema(codexBatchVerdictSchema(captures))));
        const prompt = reviewPrompt(captures, standards);
        const startedAt = new Date().toISOString();
        const receipt = { keys: captures.map((capture) => capture.key), startedAt, promptSha256: hashBytes(prompt), imageHashes: captures.map((capture) => capture.screenshotSha256) };
        try {
          const images = captures.map((capture) => {
            const bytes = readImage(capture.key);
            if (hashBytes(bytes) !== capture.screenshotSha256) throw new Error("Screenshot changed before attachment.");
            if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes.length < 24 || bytes.readUInt32BE(16) !== capture.viewport.width || bytes.readUInt32BE(20) !== capture.viewport.height) throw new Error("PNG dimensions do not match capture metadata.");
            const path = resolve(batchDirectory, `${capture.key}.png`);
            writeFileSync(path, bytes);
            return path;
          });
          const { stdout } = await execute(codexReviewArgs(schemaPath, images, values.model), prompt);
          const result = parseCodexResult(stdout, captures);
          const reviewedAt = new Date().toISOString();
          for (const item of result.verdict.reviews) {
            const capture = captures.find((entry) => entry.key === item.key)!;
            review.reviews.push({ ...item, inspectedImage: true, screenshotSha256: capture.screenshotSha256, reviewerAgentId: `codex:${result.threadId}`, reviewedAt });
          }
          receipts.push({ ...receipt, completedAt: reviewedAt, threadId: result.threadId, usage: result.usage, startupWarnings: result.startupWarnings, status: "completed", verdictSha256: hashBytes(JSON.stringify(result.verdict)) });
          console.log(`Reviewed ${review.reviews.length}/${selected.length}: ${captures[0].key.split("--").slice(0, 2).join(" / ")}`);
        } catch (error) {
          failed = true;
          // Never retain raw model/CLI diagnostics, which may include private context.
          const message = error instanceof z.ZodError || error instanceof SyntaxError ? "Codex returned an invalid review response." : error instanceof Error ? error.message : "Codex review failed.";
          receipts.push({ ...receipt, status: "failed", error: message });
          console.error(message);
        }
        persist();
      }
    }
    await Promise.all([worker(), worker()]);
    review.reviews.sort((a, b) => a.key.localeCompare(b.key));
    persist();
    const errors = [
      ...validateVisualScope(run.scope, root),
      ...validateVisualReview(run, review, visualInputDigest(root), readImage),
      ...validateVisualReceipts(run, review, receiptDocument(), (captures) => hashBytes(reviewPrompt(captures, standards))),
    ];
    if (abort.signal.aborted) errors.unshift("Review interrupted.");
    if (failed) errors.unshift("Codex review did not complete successfully.");
    writeFileSync(resolve(output, "result.json"), `${JSON.stringify({ passed: errors.length === 0, reviewed: review.reviews.length, expected: run.captures.length, errors }, null, 2)}\n`);
    if (errors.length) throw new Error(`Visual approval FAILED. ${review.reviews.length}/${run.captures.length} images reviewed.\n${errors.join("\n")}\nEvidence: ${output}`);
    console.log(`Visual approval passed for the declared ${run.scope.mode} scope only. Uncovered views and real-device behavior remain unverified.\nEvidence: ${output}`);
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    rmSync(scratch, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof z.ZodError || error instanceof SyntaxError ? "Invalid visual evidence or review schema." : error instanceof Error ? error.message : "Visual review failed.");
  process.exitCode = 1;
});
