import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VIEWS, type ViewKey } from "../src/view-registry.js";
import { expectedVisualKeys, VISUAL_SCENARIOS } from "../tests/visual/matrix.js";
import { affectedVisualScenarios, changedVisualFiles, planVisualScope, scopeScenarioIds, validateVisualScope, VISUAL_FILE_VIEWS, visualScopeSchema } from "./visual-scope.js";
import { visualInputDigest } from "./visual-review.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function repository() {
  const root = mkdtempSync(join(tmpdir(), "visual-scope-test-"));
  directories.push(root);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const write = (path: string, text = "fixture\n") => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };
  git("init", "-b", "main");
  git("config", "user.email", "contributor@example.com");
  git("config", "user.name", "Fixture contributor");
  write("README.md");
  git("add", ".");
  git("commit", "-m", "Initial fixture");
  return { root, git, write };
}

describe("change-scoped visual evidence", () => {
  it("skips backend, documentation, unit tests, and review infrastructure", () => {
    const files = ["server/index.ts", "server/storage/new-store.ts", "docs/design/ui-standards.md", "AGENTS.md", "src/tasks.test.tsx", "shared/domain.test.ts", "scripts/visual-review.ts", "scripts/visual-scope.ts", "tests/visual/config.test.ts", "tests/visual/playwright.config.ts", "tests/visual/matrix.ts", "tsconfig.visual.json", ".github/workflows/visual-evidence.yml"];
    expect(affectedVisualScenarios(files).scenarioIds).toEqual([]);
  });
  it("unions affected feature states without sweeping unrelated views", () => {
    expect(affectedVisualScenarios(["src/tasks.tsx", "src/diagnostics.tsx", "src/tasks.test.tsx"]).scenarioIds).toEqual(["room-tasks-list", "room-task-detail", "owner-diagnostics-query", "owner-diagnostics-results", "owner-diagnostics-sign-in"]);
    const roster = affectedVisualScenarios(["src/roster-manager.tsx"]).scenarioIds;
    expect(roster).toContain("roster-detail");
    expect(roster).toContain("manage-agents-conflict");
    expect(roster).toContain("unsaved-changes-confirmation");
    expect(roster).not.toContain("room-tasks-list");
  });
  it.each(["src/styles.css", "src/dialog-frame.tsx", "src/App.tsx", "src/new-surface.tsx", "shared/new-contract.ts", "public/new-image.png", "package.json", "pnpm-lock.yaml", "vite.config.ts", "index.html"])("expands shared or unknown UI input %s", (file) => {
    expect(affectedVisualScenarios([file]).scenarioIds).toHaveLength(VISUAL_SCENARIOS.length);
  });
  it("allows explicit additions for indirect UI impact, never exclusions", () => {
    expect(affectedVisualScenarios(["src/tasks.tsx"], [VIEWS.help.id]).scenarioIds).toEqual(["room-tasks-list", "room-task-detail", "help"]);
    expect(() => affectedVisualScenarios([], ["UNKNOWN-01"])).toThrow("Unknown stable view");
    expect(visualScopeSchema.safeParse({ mode: "affected", baseCommit: "a".repeat(40), scenarioIds: ["typo"], extraViewIds: [] }).success).toBe(false);
  });
  it("keeps both browsers, every viewport and scroll position for selected views", () => {
    const keys = expectedVisualKeys(["room-tasks-list", "room-task-detail"]);
    expect(keys).toHaveLength(36);
    expect(keys).toContain("webkit--phone-minimum--room-task-detail--bottom");
    expect(keys).toContain("chromium--desktop--room-tasks-list--top");
    expect(keys.some((key) => key.includes("roster"))).toBe(false);
    expect(expectedVisualKeys(["compact-room-chat"])).toHaveLength(6);
  });
  it("maps all directly referenced registered states in each feature boundary", () => {
    for (const [path, views] of Object.entries(VISUAL_FILE_VIEWS)) {
      for (const key of views) expect(VISUAL_SCENARIOS.some((scenario) => scenario.view.id === VIEWS[key].id), `${path}: ${key}`).toBe(true);
      if (!path.startsWith("src/")) continue;
      const source = readFileSync(path, "utf8");
      for (const match of source.matchAll(/VIEWS\.(\w+)/g)) expect(views, `${path}: ${match[1]}`).toContain(match[1] as ViewKey);
    }
  });
  it("includes every PR commit, staged and unstaged edits, and untracked inputs", () => {
    const { root, git, write } = repository();
    const base = git("rev-parse", "HEAD");
    write("src/tasks.tsx"); git("add", "."); git("commit", "-m", "Tasks fixture");
    write("server/route.ts"); git("add", "."); git("commit", "-m", "Backend fixture");
    write("src/diagnostics.tsx"); git("add", ".");
    write("src/tasks.tsx", "modified fixture\n");
    write("src/investigations.tsx");
    const plan = planVisualScope(root, { base });
    expect(plan.files).toEqual(["server/route.ts", "src/diagnostics.tsx", "src/investigations.tsx", "src/tasks.tsx"]);
    expect(scopeScenarioIds(plan.scope)).toEqual(["room-tasks-list", "room-task-detail", "background-investigations", "owner-diagnostics-query", "owner-diagnostics-results", "owner-diagnostics-sign-in"]);
    expect(validateVisualScope(plan.scope, root)).toEqual([]);
    write("src/contributions.tsx");
    expect(validateVisualScope(plan.scope, root)).toHaveLength(1);
  });
  it("uses the merge base when the target branch advances", () => {
    const { root, git, write } = repository();
    git("checkout", "-b", "feature");
    write("src/tasks.tsx"); git("add", "."); git("commit", "-m", "Tasks fixture");
    git("checkout", "main");
    write("src/styles.css"); git("add", "."); git("commit", "-m", "Unrelated target branch fixture");
    git("checkout", "feature");
    expect(planVisualScope(root, { base: "main" }).files).toEqual(["src/tasks.tsx"]);
  });
  it("includes both old and new paths for renames and deleted UI files", () => {
    const { root, git, write } = repository();
    write("src/tasks.tsx"); git("add", "."); git("commit", "-m", "Tasks fixture");
    const base = git("rev-parse", "HEAD");
    renameSync(join(root, "src/tasks.tsx"), join(root, "src/diagnostics.tsx"));
    git("add", ".");
    expect(changedVisualFiles(root, base).files).toEqual(["src/diagnostics.tsx", "src/tasks.tsx"]);
    expect(scopeScenarioIds(planVisualScope(root, { base }).scope)).toHaveLength(5);
  });
  it("hashes deleted UI inputs without crashing or matching replacement text", () => {
    const { root, git, write } = repository();
    write("src/tasks.tsx", "deleted input"); git("add", "."); git("commit", "-m", "Tasks fixture");
    const original = visualInputDigest(root);
    rmSync(join(root, "src/tasks.tsx"));
    expect(visualInputDigest(root)).not.toEqual(original);
    expect(scopeScenarioIds(planVisualScope(root, { base: "HEAD" }).scope)).toEqual(["room-tasks-list", "room-task-detail"]);
  });
  it("fails closed on unavailable bases and edited scope omissions", () => {
    const { root, write } = repository();
    expect(() => planVisualScope(root, { base: "missing-branch" })).toThrow("Cannot resolve visual comparison base");
    write("src/tasks.tsx");
    const plan = planVisualScope(root, { base: "HEAD" });
    if (plan.scope.mode !== "affected") throw new Error("Expected affected scope");
    expect(validateVisualScope({ ...plan.scope, scenarioIds: ["room-tasks-list"] }, root)).toHaveLength(1);
    expect(scopeScenarioIds(planVisualScope(root, { full: true }).scope)).toHaveLength(VISUAL_SCENARIOS.length);
    expect(() => planVisualScope(root, { full: true, views: [VIEWS.help.id] })).toThrow("Use --full alone");
  });
});
