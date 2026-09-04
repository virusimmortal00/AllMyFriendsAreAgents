import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { z } from "zod";
import { VIEWS, type ViewKey } from "../src/view-registry.js";
import { VISUAL_SCENARIOS } from "../tests/visual/matrix.js";

// Feature boundaries include dependent states (for example, a roster edit can
// affect its model picker and discard confirmation). Unknown UI inputs expand
// to the full matrix until their impact is explicitly mapped here.
const roster: ViewKey[] = ["manageAgentsSignIn", "manageAgentsRoster", "manageAgentsDetail", "manageAgentsModelPicker", "manageAgentsConflict", "unsavedChangesConfirmation"];
const properties: ViewKey[] = ["roomPropertiesGeneral", "roomPropertiesAgentBehavior", "roomSummarizerModelPicker"];
const github: ViewKey[] = ["githubAdminSignIn", "githubClaimOwner", "githubConnect", "githubDeviceAuth", "githubChooseRepo", "githubConfiguredRepo", "githubEmptyRepo"];
const chat: ViewKey[] = ["roomChat", "compactRoomChat", "mentionSuggestions", "textColorPalette", "highlightColorPalette", "classicSmileyPicker", "pollCards", "pendingSendRecovery", "connectionNotices"];
export const VISUAL_FILE_VIEWS: Record<string, readonly ViewKey[]> = {
  "src/roster-manager.tsx": roster,
  "src/room-configuration-dialog.tsx": [...properties, ...github],
  "src/github-integration-dialog.tsx": github,
  "src/model-picker.tsx": [...properties, ...roster],
  "src/improvements.tsx": ["improvementsList", "improvementDetail", "improvementNotFound"],
  "src/tasks.tsx": ["roomTasksList", "roomTaskDetail"],
  "src/continuations.tsx": ["durableContinuations"],
  "src/investigations.tsx": ["backgroundInvestigations"],
  "src/contributions.tsx": ["reviewedContributionsList", "reviewedContributionDetail"],
  "src/diagnostics.tsx": ["ownerDiagnosticsQuery", "ownerDiagnosticsResults"],
  "src/composer.tsx": chat,
  "src/workshop-dialog.ts": ["improvementWorkshop", "improvementWorkshopRecovery"],
  "tests/visual/roster.visual.ts": roster,
  "tests/visual/fixtures.ts": roster,
  "tests/visual/app.visual.ts": Object.keys(VIEWS).filter((key) => !["manageAgentsRoster", "manageAgentsDetail"].includes(key)) as ViewKey[],
  "tests/visual/app-fixtures.ts": Object.keys(VIEWS).filter((key) => !["manageAgentsRoster", "manageAgentsDetail"].includes(key)) as ViewKey[],
};

const scenarioId = z.string().refine((id) => VISUAL_SCENARIOS.some((scenario) => scenario.id === id), "Unknown visual scenario");
const viewId = z.string().refine((id) => Object.values(VIEWS).some((view) => view.id === id), "Unknown stable view ID");
export const visualScopeSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("full") }).strict(),
  z.object({
    mode: z.literal("affected"), baseCommit: z.string().regex(/^[a-f0-9]{40}$/),
    scenarioIds: z.array(scenarioId), extraViewIds: z.array(viewId),
  }).strict(),
]);
export type VisualScope = z.infer<typeof visualScopeSchema>;

export function scopeScenarioIds(scope: VisualScope) {
  return scope.mode === "full" ? VISUAL_SCENARIOS.map((scenario) => scenario.id) : scope.scenarioIds;
}

export function affectedVisualScenarios(files: readonly string[], extraViewIds: readonly string[] = []) {
  const selected = new Set<string>(extraViewIds);
  for (const id of selected) if (!Object.values(VIEWS).some((view) => view.id === id)) throw new Error(`Unknown stable view ID: ${id}`);
  const reasons: string[] = [];
  let full = false;
  for (const file of [...new Set(files)].sort()) {
    if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(file) || file.endsWith(".md")) continue;
    // Infrastructure changes use tooling tests. They do not change pixels;
    // --view/--full remain available for an intentional browser smoke test.
    if (["tests/visual/matrix.ts", "tests/visual/playwright.config.ts", "tests/visual/geometry.ts", "tsconfig.visual.json", "tsconfig.node.json"].includes(file)) continue;
    const mapped = VISUAL_FILE_VIEWS[file];
    if (mapped) {
      for (const key of mapped) selected.add(VIEWS[key].id);
      reasons.push(`${file}: mapped feature views`);
    } else if (/^(src|shared|public|tests\/visual)\//.test(file) || /^(index\.html|package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|vite\.config\.[^/]+|tsconfig[^/]*\.json)$/.test(file)) {
      full = true;
      reasons.push(`${file}: shared or unmapped UI input; all views`);
    }
  }
  const scenarioIds = VISUAL_SCENARIOS.filter((scenario) => full || selected.has(scenario.view.id)).map((scenario) => scenario.id);
  for (const id of selected) if (!VISUAL_SCENARIOS.some((scenario) => scenario.view.id === id)) throw new Error(`No visual fixture for affected view: ${id}`);
  return { scenarioIds, reasons };
}

function git(root: string, args: string[]) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trimEnd();
}

export function changedVisualFiles(root: string, base: string) {
  // Resolve the merge base rather than the previous commit: include the entire
  // PR plus staged/unstaged work. No rename detection means both paths count.
  let baseCommit: string;
  try {
    const revision = git(root, ["rev-parse", "--verify", "--end-of-options", `${base}^{commit}`]);
    baseCommit = git(root, ["merge-base", revision, "HEAD"]);
  } catch { throw new Error("Cannot resolve visual comparison base. Fetch the base branch, pass --base <ref>, or explicitly use --full."); }
  const tracked = git(root, ["diff", "--name-only", "--no-renames", "-z", baseCommit, "--"]).split("\0");
  const untracked = git(root, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0");
  return { baseCommit, files: [...new Set([...tracked, ...untracked].filter(Boolean))].sort() };
}

export function planVisualScope(root: string, options: { base?: string; full?: boolean; views?: string[] }): { scope: VisualScope; reasons: string[]; files: string[] } {
  if (options.full && (options.base || options.views?.length)) throw new Error("Use --full alone; --view only expands an affected scope.");
  if (options.full) return { scope: { mode: "full" }, reasons: ["Explicit full-matrix capture"], files: [] };
  const { baseCommit, files } = changedVisualFiles(root, options.base || "origin/main");
  const extraViewIds = [...new Set(options.views || [])].sort();
  const { scenarioIds, reasons } = affectedVisualScenarios(files, extraViewIds);
  return { scope: { mode: "affected", baseCommit, scenarioIds, extraViewIds }, reasons: [...reasons, ...extraViewIds.map((id) => `${id}: explicitly added view`)], files };
}

export function validateVisualScope(scope: VisualScope, root = process.cwd()) {
  if (scope.mode === "full") return [];
  const current = planVisualScope(root, { base: scope.baseCommit, views: scope.extraViewIds }).scope;
  if (current.mode !== "affected" || current.baseCommit !== scope.baseCommit || JSON.stringify(current.scenarioIds) !== JSON.stringify(scope.scenarioIds)) return ["Visual scope is stale or incomplete for the changes since its comparison base. Re-plan and recapture."];
  return [];
}

export function visualScopeOptions() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    base: { type: "string" }, full: { type: "boolean" }, view: { type: "string", multiple: true },
    "plan-only": { type: "boolean" },
  } });
  if (positionals.length) throw new Error("Use --base <ref> [--view <stable-ID>] or --full; arbitrary Playwright filters cannot establish visual scope.");
  return { base: values.base, full: values.full, views: values.view, planOnly: values["plan-only"] };
}
