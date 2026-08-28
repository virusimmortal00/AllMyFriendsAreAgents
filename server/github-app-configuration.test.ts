import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultGitHubCredentialKeyPath, loadBundledGitHubAppConfiguration } from "./github-app-configuration.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("bundled GitHub App configuration", () => {
  it("treats a missing public configuration as an unavailable integration", async () => {
    await expect(loadBundledGitHubAppConfiguration("/missing/amfaa-github-app.json")).resolves.toBeUndefined();
  });

  it("loads only the exact public App identity and rejects secret-shaped extensions", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "amfaa-github-app-config-")); roots.push(root);
    const file = path.join(root, "github-app.json");
    await writeFile(file, JSON.stringify({ schemaVersion: 1, appName: "All My Friends Are Agents", appSlug: "all-my-friends-are-agents", clientId: "Iv1.1234567890abcdef" }));
    await expect(loadBundledGitHubAppConfiguration(file)).resolves.toEqual({ schemaVersion: 1, appName: "All My Friends Are Agents",
      appSlug: "all-my-friends-are-agents", clientId: "Iv1.1234567890abcdef" });
    await writeFile(file, JSON.stringify({ schemaVersion: 1, appName: "All My Friends Are Agents", appSlug: "all-my-friends-are-agents",
      clientId: "Iv1.1234567890abcdef", clientSecret: "must-not-be-bundled" }));
    await expect(loadBundledGitHubAppConfiguration(file)).rejects.toThrow(/not canonical/);
  });

  it("places the wrapping key outside project and data directories without environment setup", () => {
    const keyPath = defaultGitHubCredentialKeyPath("/srv/all-my-friends", "/home/server");
    expect(keyPath).toMatch(/^\/home\/server\/\.allmyfriendsareagents\/keys\/[a-f0-9]{24}\/github-credentials\.key$/);
    expect(keyPath).not.toContain("/srv/all-my-friends");
  });
});
