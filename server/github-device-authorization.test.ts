import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EncryptedGitHubCredentialVault } from "./github-credential-vault.js";
import { GitHubDeviceAuthorizationCoordinator, GitHubDeviceAuthorizationFailure, type GitHubUserFetch } from "./github-device-authorization.js";
import type { GitHubDeviceFlowTransport } from "./github-device-flow.js";
import { GitHubIntegrationStore } from "./github-integration-store.js";

const roots: string[] = [];
const deviceCode = "device_code_1234567890";
const accessToken = "ghu_access_token_1234567890";
const refreshToken = "ghr_refresh_token_1234567890";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(deviceFlow: GitHubDeviceFlowTransport, now: () => number = () => Date.parse("2026-08-28T14:00:00.000Z")) {
  const root = await mkdtemp(path.join(os.tmpdir(), "amfaa-device-authorization-"));
  roots.push(root);
  const integrations = await GitHubIntegrationStore.open(path.join(root, "data"));
  const vault = await EncryptedGitHubCredentialVault.open({ vaultPath: path.join(root, "data", "github-credentials.enc"),
    keyPath: path.join(root, "keys", "github-credentials.key"), now: () => new Date(now()).toISOString() });
  const userFetch = vi.fn<GitHubUserFetch>(async () => new Response(JSON.stringify({ id: 7, login: "octocat" }), { status: 200 }));
  return { root, integrations, vault, userFetch, coordinator: new GitHubDeviceAuthorizationCoordinator(deviceFlow, integrations, vault, userFetch, now) };
}

function transport(poll: GitHubDeviceFlowTransport["poll"]): GitHubDeviceFlowTransport {
  return {
    start: async () => ({ deviceCode, userCode: "ABCD-EFGH", verificationUri: "https://github.com/login/device", expiresInSeconds: 900, intervalSeconds: 5 }),
    poll,
    refresh: async () => { throw new Error("unused"); },
  };
}

describe("server-only GitHub device authorization", () => {
  it("binds a display-safe challenge to the initiating principal", async () => {
    const f = await fixture(transport(async () => ({ kind: "pending", retryAfterSeconds: 5 })));
    const started = await f.coordinator.start("principal-owner");
    expect(started).toMatchObject({ state: "authorizing", challenge: { userCode: "ABCD-EFGH", verificationUri: "https://github.com/login/device" } });
    expect(JSON.stringify(started)).not.toMatch(/device_code|ghu_|ghr_|github-secret/);
    expect(f.coordinator.status(started.flowId, "principal-owner")).toEqual(started);
    expect(() => f.coordinator.status(started.flowId, "principal-other")).toThrow(GitHubDeviceAuthorizationFailure);
    expect(JSON.stringify(f.coordinator)).not.toMatch(/device_code|principal-owner|github-secret/);
  });

  it("enforces pending and slow-down polling intervals before calling GitHub again", async () => {
    let now = Date.parse("2026-08-28T14:00:00.000Z");
    const poll = vi.fn<GitHubDeviceFlowTransport["poll"]>()
      .mockResolvedValueOnce({ kind: "pending", retryAfterSeconds: 5 })
      .mockResolvedValueOnce({ kind: "slow-down", retryAfterSeconds: 10 });
    const f = await fixture(transport(poll), () => now);
    const started = await f.coordinator.start("principal-owner");
    await f.coordinator.poll(started.flowId, "principal-owner"); expect(poll).not.toHaveBeenCalled();
    now += 5_000;
    const pending = await f.coordinator.poll(started.flowId, "principal-owner");
    expect(pending.nextPollAt).toBe("2026-08-28T14:00:10.000Z");
    await f.coordinator.poll(started.flowId, "principal-owner"); expect(poll).toHaveBeenCalledTimes(1);
    now += 5_000;
    const slowed = await f.coordinator.poll(started.flowId, "principal-owner");
    expect(slowed.nextPollAt).toBe("2026-08-28T14:00:20.000Z"); expect(poll).toHaveBeenCalledTimes(2);
  });

  it("validates the GitHub user, stores tokens only in the vault, and publishes ready metadata", async () => {
    let now = Date.parse("2026-08-28T14:00:00.000Z");
    const f = await fixture(transport(async () => ({ kind: "authorized", credential: { accessToken, tokenType: "bearer", expiresInSeconds: 28_800,
      refreshToken, refreshTokenExpiresInSeconds: 15_897_600 } })), () => now);
    const started = await f.coordinator.start("principal-owner");
    now += 5_000;
    const completed = await f.coordinator.poll(started.flowId, "principal-owner");
    expect(completed).toMatchObject({ state: "ready", connection: { authMode: "github-device-user", state: "ready", githubUser: { id: 7, login: "octocat" } } });
    expect(JSON.stringify(completed)).not.toMatch(/ghu_|ghr_|github-secret/);
    expect(f.userFetch).toHaveBeenCalledWith("https://api.github.com/user", expect.objectContaining({ method: "GET", redirect: "error" }));
    expect((f.userFetch.mock.calls[0]![1] as RequestInit).headers).toMatchObject({ authorization: `Bearer ${accessToken}` });
    expect(f.integrations.connections()).toHaveLength(1);
    expect(f.vault.list()).toEqual([expect.objectContaining({ state: "ready", revision: 1, kind: "github-device-user" })]);
  });

  it("records denial and expiry without writing connection or credential state", async () => {
    let deniedNow = Date.parse("2026-08-28T14:00:00.000Z");
    const denied = await fixture(transport(async () => ({ kind: "denied" })), () => deniedNow);
    const deniedStart = await denied.coordinator.start("principal-owner");
    deniedNow += 5_000;
    await expect(denied.coordinator.poll(deniedStart.flowId, "principal-owner")).resolves.toMatchObject({ state: "denied" });
    expect(denied.integrations.connections()).toHaveLength(0); expect(denied.vault.list()).toHaveLength(0);

    let now = Date.parse("2026-08-28T14:00:00.000Z");
    const expired = await fixture(transport(async () => ({ kind: "pending", retryAfterSeconds: 5 })), () => now);
    const expiredStart = await expired.coordinator.start("principal-owner"); now += 900_000;
    expect(expired.coordinator.status(expiredStart.flowId, "principal-owner")).toMatchObject({ state: "expired" });
  });

  it("tombstones a newly stored token when connection metadata cannot be published", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "amfaa-device-compensation-")); roots.push(root);
    const vault = await EncryptedGitHubCredentialVault.open({ vaultPath: path.join(root, "data", "vault.enc"), keyPath: path.join(root, "keys", "vault.key") });
    const integrations = { saveConnection: async () => ({ kind: "rejected" as const, reason: "failed" }), connections: () => [] };
    let now = Date.parse("2026-08-28T14:00:00.000Z");
    const coordinator = new GitHubDeviceAuthorizationCoordinator(transport(async () => ({ kind: "authorized", credential: { accessToken, tokenType: "bearer", expiresInSeconds: 28_800,
      refreshToken, refreshTokenExpiresInSeconds: 15_897_600 } })), integrations, vault,
      async () => new Response(JSON.stringify({ id: 7, login: "octocat" }), { status: 200 }), () => now);
    const started = await coordinator.start("principal-owner");
    now += 5_000;
    await expect(coordinator.poll(started.flowId, "principal-owner")).resolves.toMatchObject({ state: "failed", failureReason: "storage-failed" });
    expect(vault.list()).toEqual([expect.objectContaining({ state: "deleted", revision: 2 })]);
  });
});
