import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { prepareContainerCheckout } from "./prepare-container-checkout.mjs";
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "checkout-preparation-")); roots.push(root);
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-b", "main"); git("config", "user.name", "Example"); git("config", "user.email", "example@example.test");
  git("commit", "--allow-empty", "-m", "Initial fixture");
  git("checkout", "--detach"); git("commit", "--allow-empty", "-m", "Next fixture");
  return { root, git };
}
it("attaches a detached checkout without changing its commit and is repeatable", () => {
  const { root, git } = fixture(); const before = git("rev-parse", "HEAD");
  prepareContainerCheckout(root, "main"); prepareContainerCheckout(root, "main");
  expect(git("branch", "--show-current")).toBe("main");
  expect(git("rev-parse", "HEAD")).toBe(before);
});
it("refuses dirty files without changing branch state", () => {
  const { root, git } = fixture(); writeFileSync(path.join(root, "local.txt"), "keep");
  expect(() => prepareContainerCheckout(root, "main")).toThrow("clean");
  expect(git("branch", "--show-current")).toBe("");
});
it("refuses divergent branch history", () => {
  const { root, git } = fixture(); const detached = git("rev-parse", "HEAD");
  git("switch", "main"); git("commit", "--allow-empty", "-m", "Divergent fixture"); git("checkout", "--detach", detached);
  expect(() => prepareContainerCheckout(root, "main")).toThrow("divergent");
  expect(git("branch", "--show-current")).toBe("");
});
