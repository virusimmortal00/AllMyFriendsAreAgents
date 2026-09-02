import { readFileSync, lstatSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { hashBytes, runSchema, validateVisualReceipts, validateVisualReview, visualInputDigest } from "./visual-review.js";
import { validateVisualScope } from "./visual-scope.js";
import { reviewPrompt } from "./codex-visual-review.js";

try {
  const { values } = parseArgs({ options: { run: { type: "string" }, review: { type: "string" }, receipts: { type: "string" } } });
  if (!values.run || !values.review || !values.receipts) throw new Error("Usage: pnpm check:visual-review --run <capture-directory> --review <review.json> --receipts <receipts.json>");
  const runDirectory = resolve(values.run);
  const run = runSchema.parse(JSON.parse(readFileSync(resolve(runDirectory, "manifest.json"), "utf8")));
  const review = JSON.parse(readFileSync(resolve(values.review), "utf8"));
  const receipts = JSON.parse(readFileSync(resolve(values.receipts), "utf8"));
  const standards = readFileSync(resolve(process.cwd(), "docs/design/ui-standards.md"), "utf8");
  const errors = [...validateVisualScope(run.scope), ...validateVisualReview(
    run,
    review,
    visualInputDigest(),
    (key) => {
      const path = resolve(runDirectory, "screenshots", `${key}.png`);
      if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error("Expected a regular screenshot file.");
      return readFileSync(path);
    },
  ), ...validateVisualReceipts(run, review, receipts, (captures) => hashBytes(reviewPrompt(captures, standards)))];
  if (errors.length) throw new Error(errors.join("\n"));
  console.log(`Independent visual reviews passed for every screenshot in the declared ${run.scope.mode} scope. This does not certify uncovered views or real-device behavior.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Visual review validation failed.");
  process.exitCode = 1;
}
