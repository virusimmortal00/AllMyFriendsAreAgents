import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SecretVaultReader } from "./github-credential-provider.js";
import { GitHubIntegrationStore } from "./github-integration-store.js";
import { GitHubRepositoryCatalogService } from "./github-repository-catalog-service.js";

const roots: string[] = [];
const timestamp = "2026-08-28T16:00:00.000Z";
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "amfaa-catalog-service-")); roots.push(root);
  const integrations = await GitHubIntegrationStore.open(root);
  await integrations.saveConnection({ expectedRevision: 0, connectionId: "github-server-one", authMode: "github-device-user", state: "ready",
    githubUser: { id: 7, login: "octocat" }, secretReference: "vault-secret-one", connectedAt: timestamp, lastValidatedAt: timestamp });
  const vault: SecretVaultReader = { available: () => true, read: async () => ({ token: "ghu_catalog_access_token_1234567890", revision: "vault:1", provider: "github-device-user" }) };
  const discovery = { observedAt: timestamp, installations: [{ installationId: 101, account: { id: 501, login: "Example", type: "Organization" as const }, repositorySelection: "selected" as const }],
    repositories: [{ githubRepositoryId: 201, installationId: 101, owner: "example", name: "one", canonical: "github.com/example/one", visibility: "private" as const, defaultBranch: "main" }] };
  return { root, integrations, vault, discovery };
}

describe("GitHub repository catalog refresh", () => {
  it("resolves the token server-side and atomically publishes a metadata-only snapshot", async () => {
    const f = await fixture(); let receivedToken = "";
    const service = new GitHubRepositoryCatalogService(f.integrations, f.vault, { discover: async (token) => { receivedToken = token; return f.discovery; } });
    await expect(service.refresh("github-server-one", 0)).resolves.toMatchObject({ kind: "ok", value: { revision: 1, connectionRevision: 1,
      repositories: [{ canonical: "github.com/example/one" }] } });
    expect(receivedToken).toBe("ghu_catalog_access_token_1234567890");
    expect(JSON.stringify(service.inspect("github-server-one"))).not.toMatch(/ghu_|vault-secret/);
  });

  it("discards discovery when connection authority changes in flight", async () => {
    const f = await fixture(); let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; }); let started!: () => void;
    const observed = new Promise<void>((resolve) => { started = resolve; });
    const service = new GitHubRepositoryCatalogService(f.integrations, f.vault, { discover: async () => { started(); await gate; return f.discovery; } });
    const pending = service.refresh("github-server-one", 0); await observed;
    await f.integrations.saveConnection({ expectedRevision: 1, connectionId: "github-server-one", authMode: "github-device-user", state: "ready",
      githubUser: { id: 7, login: "octocat" }, secretReference: "vault-secret-one", connectedAt: timestamp, lastValidatedAt: "2026-08-28T16:01:00.000Z" });
    release();
    await expect(pending).resolves.toMatchObject({ kind: "rejected", reason: expect.stringContaining("changed") });
    expect(service.inspect("github-server-one")).toBeUndefined();
  });

  it("fails closed for missing credentials and discovery errors", async () => {
    const f = await fixture();
    const missing = new GitHubRepositoryCatalogService(f.integrations, { available: () => false, read: async () => undefined }, { discover: async () => f.discovery });
    await expect(missing.refresh("github-server-one", 0)).resolves.toMatchObject({ kind: "rejected", reason: expect.stringContaining("unavailable") });
    const locked = new GitHubRepositoryCatalogService(f.integrations, { available: () => false, read: async () => { throw new Error("vault path private"); } }, { discover: async () => f.discovery });
    await expect(locked.refresh("github-server-one", 0)).resolves.toEqual({ kind: "rejected", reason: "A device-user credential is unavailable." });
    const failed = new GitHubRepositoryCatalogService(f.integrations, f.vault, { discover: async () => { throw new Error("token private upstream"); } });
    const result = await failed.refresh("github-server-one", 0); expect(result).toEqual({ kind: "rejected", reason: "GitHub repository discovery failed." });
    expect(JSON.stringify(result)).not.toMatch(/token private|ghu_/);
  });
});
