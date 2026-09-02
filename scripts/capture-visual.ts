import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { expectedVisualKeys, VISUAL_SCENARIOS } from "../tests/visual/matrix.js";
import { VIEWS } from "../src/view-registry.js";
import { captureSchema, visualInputDigest, type VisualRun } from "./visual-review.js";
import { planVisualScope, scopeScenarioIds, validateVisualScope, visualScopeOptions } from "./visual-scope.js";

function main() {
  const root = process.cwd();
  const options = visualScopeOptions();
  const plan = planVisualScope(root, options);
  const scenarios = scopeScenarioIds(plan.scope);
  const expected = expectedVisualKeys(scenarios);
  const parent = resolve(root, "test-results/visual");
  mkdirSync(parent, { recursive: true });
  const selectedViews = VISUAL_SCENARIOS.filter((scenario) => scenarios.includes(scenario.id)).map((scenario) => scenario.view.id);
  writeFileSync(resolve(parent, "scope.json"), `${JSON.stringify({ ...plan, selectedViewIds: selectedViews, expectedScreenshots: expected.length }, null, 2)}\n`);
  console.log(`Visual scope: ${scenarios.length}/${VISUAL_SCENARIOS.length} scenarios, ${expected.length} screenshots.\n${plan.reasons.join("\n")}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `required=${scenarios.length > 0}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Visual evidence: ${scenarios.length ? `${scenarios.length} affected scenarios, ${expected.length} screenshots. Views: ${selectedViews.join(", ")}. Capture/layout checks are not visual approval.` : "Not applicable: no UI inputs changed. No screenshots or account-backed review required."}\n`);
  if (!scenarios.length) {
    console.log("Visual evidence is not applicable: no UI inputs changed. No capture or visual approval required.");
    return;
  }
  if (options.planOnly) return;
  const runDirectory = mkdtempSync(resolve(parent, "run-"));
  mkdirSync(resolve(runDirectory, "screenshots"));
  const inputDigest = visualInputDigest(root);
  const createdAt = new Date().toISOString();
  const require = createRequire(import.meta.url);
  const cli = require.resolve("@playwright/test/cli");
  const result = spawnSync(process.execPath, [cli, "test", "--config", "tests/visual/playwright.config.ts"], {
    cwd: root, stdio: "inherit", env: { ...process.env, VISUAL_RUN_DIRECTORY: runDirectory, VISUAL_SCENARIO_IDS: JSON.stringify(scenarios) },
  });
  const captures = expected.flatMap((key) => {
    try { return [captureSchema.parse(JSON.parse(readFileSync(resolve(runDirectory, `${key}.json`), "utf8")))]; }
    catch { return []; }
  });
  const run: VisualRun = {
    schemaVersion: 2, scope: plan.scope, inputDigest, createdAt,
    headCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    dirty: Boolean(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()),
    implementationAgentId: process.env.VISUAL_IMPLEMENTATION_AGENT_ID || "implementation-agent",
    platform: `${process.platform}-${process.arch}`,
    capturePassed: result.status === 0 && captures.length === expected.length && visualInputDigest(root) === inputDigest && validateVisualScope(plan.scope, root).length === 0,
    captures,
  };
  writeFileSync(resolve(runDirectory, "manifest.json"), `${JSON.stringify(run, null, 2)}\n`);
  const covered = new Set<string>(captures.map((capture) => capture.viewId));
  const missing = Object.values(VIEWS).filter((view) => !covered.has(view.id)).map((view) => `${view.id}: ${view.name}`);
  writeFileSync(resolve(runDirectory, "coverage.json"), `${JSON.stringify({ scope: plan.scope, selectedViewIds: selectedViews, capturedViewIds: [...covered], uncapturedViews: missing, visualVerdict: "PENDING — independent image review required for every screenshot in the declared scope" }, null, 2)}\n`);
  console.log(`\nVisual evidence: ${runDirectory}\nCaptured ${captures.length}/${expected.length} screenshots in the declared scope. Agent review: PENDING.\n${missing.length} registered views have no captured image in this run.`);
  process.exitCode = run.capturePassed ? 0 : 1;
}

try { main(); }
catch (error) {
  console.error(error instanceof Error ? error.message : "Visual capture failed.");
  process.exitCode = 1;
}
