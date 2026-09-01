import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { expectedVisualKeys, VISUAL_SCENARIOS } from "../tests/visual/matrix.js";
import { VIEWS } from "../src/view-registry.js";
import { captureSchema, visualInputDigest, type VisualRun } from "./visual-review.js";

const root = process.cwd();
const parent = resolve(root, "test-results/visual");
mkdirSync(parent, { recursive: true });
const runDirectory = mkdtempSync(resolve(parent, "run-"));
mkdirSync(resolve(runDirectory, "screenshots"));
const inputDigest = visualInputDigest(root);
const createdAt = new Date().toISOString();
const require = createRequire(import.meta.url);
const cli = require.resolve("@playwright/test/cli");
const result = spawnSync(process.execPath, [cli, "test", "--config", "tests/visual/playwright.config.ts", ...process.argv.slice(2)], {
  cwd: root, stdio: "inherit", env: { ...process.env, VISUAL_RUN_DIRECTORY: runDirectory },
});
const captures = expectedVisualKeys().flatMap((key) => {
  try { return [captureSchema.parse(JSON.parse(readFileSync(resolve(runDirectory, `${key}.json`), "utf8")))]; }
  catch { return []; }
});
const run: VisualRun = {
  schemaVersion: 1, inputDigest, createdAt,
  headCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  dirty: Boolean(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()),
  implementationAgentId: process.env.VISUAL_IMPLEMENTATION_AGENT_ID || "implementation-agent",
  platform: `${process.platform}-${process.arch}`,
  capturePassed: result.status === 0 && captures.length === expectedVisualKeys().length && visualInputDigest(root) === inputDigest,
  captures,
};
writeFileSync(resolve(runDirectory, "manifest.json"), `${JSON.stringify(run, null, 2)}\n`);
const covered = new Set<string>(captures.map((capture) => capture.viewId));
const configured = new Set<string>(VISUAL_SCENARIOS.map((scenario) => scenario.view.id));
const missing = Object.values(VIEWS).filter((view) => !covered.has(view.id)).map((view) => `${view.id}: ${view.name}`);
writeFileSync(resolve(runDirectory, "coverage.json"), `${JSON.stringify({ configuredViewIds: [...configured], capturedViewIds: [...covered], uncapturedViews: missing, visualVerdict: "PENDING — independent image review required for every captured state and viewport" }, null, 2)}\n`);
console.log(`\nVisual evidence: ${runDirectory}\nCaptured ${captures.length}/${expectedVisualKeys().length} screenshots. Agent review: PENDING.\n${missing.length} registered views have no captured image in this run.`);
process.exitCode = run.capturePassed ? 0 : 1;
