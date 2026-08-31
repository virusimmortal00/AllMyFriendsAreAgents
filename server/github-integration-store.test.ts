import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BoundGitHubCredentialProvider,
  GitHubIntegrationStore,
  type SecretVaultReader,
} from "./github-integration-store.js";

const roots: string[] = [];
const timestamp = "2026-08-28T12:00:00.000Z";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "amfaa-github-integrations-"));
  roots.push(root);
  return { root, store: await GitHubIntegrationStore.open(root) };
}

async function readyConnection(store: GitHubIntegrationStore) {
  return store.saveConnection({
    expectedRevision: 0,
    connectionId: "github-server-one",
    authMode: "github-device-user",
    state: "ready",
    githubUser: { id: 7, login: "octocat" },
    secretReference: "vault-secret-one",
    connectedAt: timestamp,
    lastValidatedAt: timestamp,
  });
}

async function readyCatalog(store: GitHubIntegrationStore) {
  return store.replaceCatalog({ expectedRevision: 0, connectionId: "github-server-one", connectionRevision: 1, discovery: { observedAt: timestamp,
    installations: [{ installationId: 101, account: { id: 501, login: "Example", type: "Organization" }, repositorySelection: "selected" }],
    repositories: [
      { githubRepositoryId: 201, installationId: 101, owner: "example", name: "one", canonical: "github.com/example/one", visibility: "private", defaultBranch: "main" },
      { githubRepositoryId: 202, installationId: 101, owner: "example", name: "two", canonical: "github.com/example/two", visibility: "private", defaultBranch: "main" },
    ] } });
}

function vault(): SecretVaultReader {
  return {
    available: (reference) => reference === "vault-secret-one",
    read: async (reference) => reference === "vault-secret-one"
      ? { token: "ghu_private_device_token", revision: "vault-revision-one", provider: "github-device-user" as const }
      : undefined,
  };
}

describe("server GitHub integration metadata", () => {
  it("persists non-secret connection metadata with private server projection", async () => {
    const f = await fixture();
    await expect(readyConnection(f.store)).resolves.toMatchObject({ kind: "ok", value: { revision: 1, state: "ready" } });

    expect(f.store.connections()).toEqual([expect.objectContaining({
      connectionId: "github-server-one",
      authMode: "github-device-user",
      githubUser: { id: 7, login: "octocat" },
    })]);
    expect(JSON.stringify(f.store.connections())).not.toContain("vault-secret-one");
    expect((await stat(f.store.filePath)).mode & 0o777).toBe(0o600);

    const reopened = await GitHubIntegrationStore.open(f.root);
    expect(reopened.connection("github-server-one")).toMatchObject({ secretReference: "vault-secret-one", revision: 1 });
  });

  it("gives two projects unique bindings to one server connection and resolves through one vault secret", async () => {
    const f = await fixture(); await readyConnection(f.store); await readyCatalog(f.store);
    const one = await f.store.bindProject({ expectedRevision: 0, projectId: "project-one", connectionId: "github-server-one", installationId: 101, githubRepositoryId: 201, repository: "github.com/example/one" });
    const two = await f.store.bindProject({ expectedRevision: 0, projectId: "project-two", connectionId: "github-server-one", installationId: 101, githubRepositoryId: 202, repository: "github.com/example/two" });
    expect(one).toMatchObject({ kind: "ok", value: { projectId: "project-one", repository: "github.com/example/one" } });
    expect(two).toMatchObject({ kind: "ok", value: { projectId: "project-two", repository: "github.com/example/two" } });
    if (one.kind !== "ok" || two.kind !== "ok") throw new Error("expected project bindings");
    expect(one.value.bindingId).not.toBe(two.value.bindingId);
    expect(one.value.connectionId).toBe(two.value.connectionId);

    const provider = new BoundGitHubCredentialProvider(f.store, vault());
    await expect(provider.resolve({ projectId: "project-one", credentialReference: one.value.bindingId, connectionId: "repository-connection-one", connectionRevision: 1,
      repository: "github.com/example/one" })).resolves.toMatchObject({ token: "ghu_private_device_token", provider: "github-device-user" });
    await expect(provider.resolve({ projectId: "project-two", credentialReference: two.value.bindingId, connectionId: "repository-connection-two", connectionRevision: 1,
      repository: "github.com/example/two" })).resolves.toMatchObject({ token: "ghu_private_device_token", provider: "github-device-user" });
    await expect(provider.resolve({ projectId: "project-two", credentialReference: one.value.bindingId, connectionId: "repository-connection-two", connectionRevision: 1,
      repository: "github.com/example/one" })).resolves.toBeUndefined();
  });

  it("fails closed for stale revisions, repository substitution, missing vault data, and revocation", async () => {
    const f = await fixture(); await readyConnection(f.store); await readyCatalog(f.store);
    const bound = await f.store.bindProject({ expectedRevision: 0, projectId: "project-one", connectionId: "github-server-one", installationId: 101, githubRepositoryId: 201, repository: "github.com/example/one" });
    if (bound.kind !== "ok") throw new Error("expected project binding");
    await expect(f.store.bindProject({ expectedRevision: 0, projectId: "project-one", connectionId: "github-server-one", installationId: 101, githubRepositoryId: 202,
      repository: "github.com/example/other" })).resolves.toEqual({ kind: "conflict", actualRevision: 1 });

    const provider = new BoundGitHubCredentialProvider(f.store, vault());
    await expect(provider.resolve({ projectId: "project-one", credentialReference: bound.value.bindingId, connectionId: "repository-connection-one", connectionRevision: 1,
      repository: "github.com/example/other" })).resolves.toBeUndefined();
    await expect(provider.resolve({ projectId: "project-one", credentialReference: bound.value.bindingId, connectionId: "../connection", connectionRevision: 1,
      repository: "github.com/example/one" })).resolves.toBeUndefined();
    expect(new BoundGitHubCredentialProvider(f.store, { available: () => false, read: async () => undefined })
      .health("project-one", bound.value.bindingId)).toMatchObject({ state: "missing", reason: "credential-missing" });

    await expect(f.store.saveConnection({ expectedRevision: 1, connectionId: "github-server-one", authMode: "github-device-user", state: "revoked",
      githubUser: { id: 7, login: "octocat" }, secretReference: "vault-secret-one", connectedAt: timestamp,
      lastValidatedAt: "2026-08-28T12:01:00.000Z" })).resolves.toMatchObject({ kind: "ok", value: { revision: 2, state: "revoked" } });
    expect(provider.health("project-one", bound.value.bindingId)).toMatchObject({ state: "revoked", reason: "connection-revoked" });
    await expect(provider.resolve({ projectId: "project-one", credentialReference: bound.value.bindingId, connectionId: "repository-connection-one", connectionRevision: 1,
      repository: "github.com/example/one" })).resolves.toBeUndefined();
  });

  it("requires an exact current catalog entry before binding a project", async () => {
    const f = await fixture(); await readyConnection(f.store);
    const input = { expectedRevision: 0, projectId: "project-one", connectionId: "github-server-one", installationId: 101,
      githubRepositoryId: 201, repository: "github.com/example/one" };
    await expect(f.store.bindProject(input)).resolves.toMatchObject({ kind: "rejected", reason: expect.stringContaining("catalog") });
    await readyCatalog(f.store);
    await expect(f.store.bindProject({ ...input, githubRepositoryId: 999 })).resolves.toMatchObject({ kind: "rejected", reason: expect.stringContaining("not present") });
    await expect(f.store.bindProject(input)).resolves.toMatchObject({ kind: "ok" });
    await f.store.saveConnection({ expectedRevision: 1, connectionId: "github-server-one", authMode: "github-device-user", state: "ready",
      githubUser: { id: 7, login: "octocat" }, secretReference: "vault-secret-one", connectedAt: timestamp,
      lastValidatedAt: "2026-08-28T12:01:00.000Z" });
    const binding = f.store.bindingForProject("project-one")!;
    expect(new BoundGitHubCredentialProvider(f.store, vault()).health("project-one", binding.bindingId)).toMatchObject({ state: "degraded", reason: "catalog-stale" });
  });

  it("revokes and revision-safely restores a project binding without exposing its vault authority", async () => {
    const f = await fixture(); await readyConnection(f.store); await readyCatalog(f.store);
    const bound = await f.store.bindProject({ expectedRevision: 0, projectId: "project-one", connectionId: "github-server-one", installationId: 101,
      githubRepositoryId: 201, repository: "github.com/example/one" });
    if (bound.kind !== "ok") throw new Error("expected project binding");
    const provider = new BoundGitHubCredentialProvider(f.store, vault());

    await expect(f.store.revokeBinding({ expectedRevision: 0, projectId: "project-one" })).resolves.toEqual({ kind: "conflict", actualRevision: 1 });
    await expect(f.store.revokeBinding({ expectedRevision: 1, projectId: "project-one" })).resolves.toMatchObject({ kind: "ok", value: { revision: 2, state: "revoked" } });
    expect(provider.available("project-one", bound.value.bindingId)).toBe(false);
    expect(provider.health("project-one", bound.value.bindingId)).toMatchObject({ state: "revoked", reason: "binding-revoked" });
    await expect(provider.resolve({ projectId: "project-one", credentialReference: bound.value.bindingId, connectionId: "repository-connection-one", connectionRevision: 1,
      repository: "github.com/example/one" })).resolves.toBeUndefined();

    const restored = await f.store.bindProject({ expectedRevision: 2, projectId: "project-one", connectionId: "github-server-one", installationId: 101,
      githubRepositoryId: 202, repository: "github.com/example/two" });
    expect(restored).toMatchObject({ kind: "ok", value: { revision: 3, state: "ready", repository: "github.com/example/two" } });
    if (restored.kind !== "ok") throw new Error("expected restored binding");
    expect(restored.value.bindingId).toBe(bound.value.bindingId);
    expect(provider.available("project-one", restored.value.bindingId)).toBe(true);
  });

  it("rejects corrupt persisted integration metadata on restart", async () => {
    const f = await fixture(); await readyConnection(f.store);
    const state = JSON.parse(await readFile(f.store.filePath, "utf8")) as { connections: Array<Record<string, unknown>> };
    state.connections[0]!.secretReference = "../secret";
    await writeFile(f.store.filePath, JSON.stringify(state));
    await expect(GitHubIntegrationStore.open(f.root)).rejects.toThrow(/not canonical/);
  });

  it("keeps the vault and token out of provider serialization", async () => {
    const f = await fixture(); await readyConnection(f.store);
    const provider = new BoundGitHubCredentialProvider(f.store, {
      token: "ghu_serialization_secret",
      available: () => true,
      read: async () => ({ token: "ghu_serialization_secret", revision: "one", provider: "github-device-user" as const }),
    } as SecretVaultReader & { token: string });
    expect(JSON.stringify(provider)).not.toMatch(/ghu_serialization_secret|vault-secret-one/);
  });

  it("rejects a credential when its project binding is revoked while refresh is pending", async () => {
    const f = await fixture(); await readyConnection(f.store); await readyCatalog(f.store);
    const bound = await f.store.bindProject({ expectedRevision: 0, projectId: "project-one", connectionId: "github-server-one", installationId: 101,
      githubRepositoryId: 201, repository: "github.com/example/one" });
    if (bound.kind !== "ok") throw new Error("expected project binding");
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const provider = new BoundGitHubCredentialProvider(f.store, { available: () => true,
      read: async () => { await pending; return { token: "ghu_rotated_1234567890", revision: "vault:2", provider: "github-device-user" }; } });
    const resolution = provider.resolve({ projectId: "project-one", credentialReference: bound.value.bindingId,
      connectionId: "repository-connection-one", connectionRevision: 1, repository: "github.com/example/one" });
    await f.store.revokeBinding({ expectedRevision: 1, projectId: "project-one" });
    release();
    expect(await resolution).toBeUndefined();
  });
});
