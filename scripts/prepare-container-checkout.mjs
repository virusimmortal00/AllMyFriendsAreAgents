import { execFileSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** Explicit operator preparation. Never fetches, changes files, or discards history. */
export function prepareContainerCheckout(directory, branch) {
  if (!directory || !branch || branch.startsWith("-")) throw new Error("Provide the standalone checkout path and its saved default branch.");
  const root = realpathSync(directory);
  if (!lstatSync(path.join(root, ".git")).isDirectory()) throw new Error("A standalone Git checkout is required.");
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("check-ref-format", "--branch", branch);
  if (git("status", "--porcelain")) throw new Error("The checkout must be clean before preparation.");
  const head = git("rev-parse", "HEAD");
  const current = git("branch", "--show-current");
  if (current && current !== branch) throw new Error("The checkout is on a different branch; choose the project branch explicitly before preparation.");
  if (current === branch) return;
  git("show-ref", "--verify", "--quiet", `refs/heads/${branch}`);
  try { git("merge-base", "--is-ancestor", `refs/heads/${branch}`, head); }
  catch { throw new Error("The saved branch has divergent history. Reconcile it before preparation."); }
  git("switch", "-C", branch, head);
  if (git("rev-parse", "HEAD") !== head || git("branch", "--show-current") !== branch) throw new Error("Checkout verification failed.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 4) throw new Error("Usage: node scripts/prepare-container-checkout.mjs <checkout> <default-branch>");
    prepareContainerCheckout(process.argv[2], process.argv[3]);
    console.log("Checkout is attached to its default branch at the same commit.");
  } catch { console.error("Checkout preparation failed. Use a clean standalone checkout with the saved default branch present and no divergent history."); process.exitCode = 1; }
}
