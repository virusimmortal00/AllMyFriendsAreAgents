import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EncryptedGitHubCredentialVault, type GitHubCredentialRefreshEvent, type GitHubDeviceUserVaultCredential } from "./github-credential-vault.js";

const roots: string[] = [];
const firstTime = "2026-08-28T14:00:00.000Z";
const secondTime = "2026-08-28T15:00:00.000Z";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(now = firstTime) {
  const root = await mkdtemp(path.join(os.tmpdir(), "amfaa-github-vault-"));
  roots.push(root);
  const vaultPath = path.join(root, "data", "github-credentials.enc");
  const keyPath = path.join(root, "keys", "github-credentials.key");
  return { root, vaultPath, keyPath, vault: await EncryptedGitHubCredentialVault.open({ vaultPath, keyPath, now: () => now }) };
}

function credential(access = "ghu_access_token_1234567890", refresh = "ghr_refresh_token_1234567890"): GitHubDeviceUserVaultCredential {
  return {
    kind: "github-device-user",
    accessToken: access,
    refreshToken: refresh,
    accessTokenExpiresAt: "2026-08-28T22:00:00.000Z",
    refreshTokenExpiresAt: "2027-02-28T14:00:00.000Z",
  };
}

describe("encrypted GitHub credential vault", () => {
  it("persists and reopens credentials without plaintext in the vault file", async () => {
    const f = await fixture();
    await expect(f.vault.put("github-secret-one", 0, credential())).resolves.toEqual({ kind: "ok", reference: "github-secret-one", revision: 1 });
    const encrypted = await readFile(f.vaultPath, "utf8");
    expect(encrypted).not.toMatch(/github-secret-one|ghu_access|ghr_refresh|github-device-user/);
    expect((await stat(f.vaultPath)).mode & 0o777).toBe(0o600);
    expect((await stat(f.keyPath)).mode & 0o777).toBe(0o600);

    const reopened = await EncryptedGitHubCredentialVault.open({ vaultPath: f.vaultPath, keyPath: f.keyPath, now: () => firstTime });
    await expect(reopened.read("github-secret-one")).resolves.toEqual({ token: "ghu_access_token_1234567890", revision: "vault:1", provider: "github-device-user" });
    expect(reopened.readCredential("github-secret-one")).toMatchObject({ revision: 1, credential: { refreshToken: "ghr_refresh_token_1234567890" } });
  });

  it("rotates with compare-and-set semantics and removes the old token from durable ciphertext", async () => {
    const f = await fixture(); await f.vault.put("github-secret-one", 0, credential());
    await expect(f.vault.put("github-secret-one", 0, credential("ghu_other_access_token_1234567890", "ghr_other_refresh_token_1234567890")))
      .resolves.toEqual({ kind: "conflict", actualRevision: 1 });
    const reopened = await EncryptedGitHubCredentialVault.open({ vaultPath: f.vaultPath, keyPath: f.keyPath, now: () => secondTime });
    await expect(reopened.put("github-secret-one", 1, credential("ghu_next_access_token_1234567890", "ghr_next_refresh_token_1234567890")))
      .resolves.toEqual({ kind: "ok", reference: "github-secret-one", revision: 2 });
    await expect(reopened.read("github-secret-one")).resolves.toMatchObject({ token: "ghu_next_access_token_1234567890", revision: "vault:2" });
    await expect(reopened.delete("github-secret-one", 1)).resolves.toEqual({ kind: "conflict", actualRevision: 2 });
    await expect(reopened.delete("github-secret-one", 2)).resolves.toEqual({ kind: "ok", reference: "github-secret-one", revision: 3 });
    await expect(reopened.read("github-secret-one")).resolves.toBeUndefined();
    await expect(reopened.put("github-secret-one", 0, credential())).resolves.toEqual({ kind: "conflict", actualRevision: 3 });
    await expect(reopened.put("github-secret-one", 3, credential("ghu_reauthorized_token_1234567890", "ghr_reauthorized_token_1234567890")))
      .resolves.toEqual({ kind: "ok", reference: "github-secret-one", revision: 4 });
  });

  it("serializes compare-and-set mutations across independently opened vault instances", async () => {
    const f = await fixture();
    const second = await EncryptedGitHubCredentialVault.open({ vaultPath: f.vaultPath, keyPath: f.keyPath, now: () => secondTime });
    const [one, two] = await Promise.all([
      f.vault.put("github-secret-one", 0, credential()),
      second.put("github-secret-two", 0, credential("ghu_second_access_token_1234567890", "ghr_second_refresh_token_1234567890")),
    ]);
    expect(one).toMatchObject({ kind: "ok", revision: 1 });
    expect(two).toMatchObject({ kind: "ok", revision: 1 });
    const reopened = await EncryptedGitHubCredentialVault.open({ vaultPath: f.vaultPath, keyPath: f.keyPath });
    expect(reopened.list()).toEqual(expect.arrayContaining([
      expect.objectContaining({ reference: "github-secret-one", revision: 1, state: "ready" }),
      expect.objectContaining({ reference: "github-secret-two", revision: 1, state: "ready" }),
    ]));
  });

  it("fails authentication after ciphertext tampering or when opened with another key", async () => {
    const f = await fixture(); await f.vault.put("github-secret-one", 0, credential());
    const envelope = JSON.parse(await readFile(f.vaultPath, "utf8")) as { ciphertext: string };
    envelope.ciphertext = `${envelope.ciphertext.slice(0, -4)}AAAA`;
    await writeFile(f.vaultPath, JSON.stringify(envelope));
    await expect(EncryptedGitHubCredentialVault.open({ vaultPath: f.vaultPath, keyPath: f.keyPath })).rejects.toThrow(/could not be authenticated/);

    const other = await fixture(); await other.vault.put("github-secret-one", 0, credential());
    await expect(EncryptedGitHubCredentialVault.open({ vaultPath: other.vaultPath, keyPath: f.keyPath })).rejects.toThrow(/could not be authenticated/);
  });

  it("rejects colocated paths, malformed credentials, and secret-bearing serialization", async () => {
    const f = await fixture();
    await expect(EncryptedGitHubCredentialVault.open({ vaultPath: path.join(f.root, "same", "vault"), keyPath: path.join(f.root, "same", "key") }))
      .rejects.toThrow(/separate directories/);
    await expect(f.vault.put("github-secret-one", 0, { ...credential(), accessToken: "not-a-token" })).resolves.toMatchObject({ kind: "rejected" });
    await f.vault.put("github-secret-one", 0, credential());
    expect(JSON.stringify(f.vault)).not.toMatch(/ghu_access|ghr_refresh|github-secret-one/);
    expect(JSON.stringify(f.vault.list())).not.toMatch(/ghu_access|ghr_refresh/);
  });

  it("refreshes once across concurrent readers and reopened instances, and durably rotates both tokens", async () => {
    const f = await fixture();
    await f.vault.put("github-secret-one", 0, credential());
    const now = "2026-08-28T22:00:00.000Z";
    const refresh = vi.fn(async () => ({ accessToken: "ghu_rotated_access_1234567890", refreshToken: "ghr_rotated_refresh_1234567890",
      tokenType: "bearer" as const, expiresInSeconds: 28_800, refreshTokenExpiresInSeconds: 15_897_600 }));
    const events: GitHubCredentialRefreshEvent[] = [];
    const options = { vaultPath: f.vaultPath, keyPath: f.keyPath, now: () => now, refresh, onRefreshEvent: (event: GitHubCredentialRefreshEvent) => events.push(event) };
    const one = await EncryptedGitHubCredentialVault.open(options);
    const two = await EncryptedGitHubCredentialVault.open(options);
    expect(one.available("github-secret-one")).toBe(true);
    const values = await Promise.all([one.read("github-secret-one"), one.read("github-secret-one"), two.read("github-secret-one")]);
    expect(refresh).toHaveBeenCalledExactlyOnceWith(credential().refreshToken);
    for (const value of values) expect(value).toMatchObject({ token: "ghu_rotated_access_1234567890", revision: "vault:2" });
    const reopened = await EncryptedGitHubCredentialVault.open({ ...options, refresh: undefined });
    expect(reopened.readCredential("github-secret-one")).toMatchObject({ revision: 2, credential: {
      refreshToken: "ghr_rotated_refresh_1234567890", accessTokenExpiresAt: "2026-08-29T06:00:00.000Z",
    } });
    expect(await reopened.read("github-secret-one")).toEqual(values[0]);
    expect(await readFile(f.vaultPath, "utf8")).not.toMatch(/ghu_|ghr_/);
    expect(events).toEqual([
      { correlationId: expect.any(String), outcome: "attempted", reason: null, credentialRevision: 1 },
      { correlationId: events[0]!.correlationId, outcome: "completed", reason: null, credentialRevision: 2 },
    ]);
    expect(JSON.stringify(events)).not.toMatch(/ghu_|ghr_|github-secret-one/);
  });

  it("never returns expired credentials without a usable refresh path", async () => {
    const f = await fixture();
    await f.vault.put("github-secret-one", 0, credential());
    const options = { vaultPath: f.vaultPath, keyPath: f.keyPath, now: () => "2026-08-28T22:00:00.000Z" };
    const noRefresh = await EncryptedGitHubCredentialVault.open(options);
    expect(noRefresh.available("github-secret-one")).toBe(false);
    expect(await noRefresh.read("github-secret-one")).toBeUndefined();
    const refresh = vi.fn();
    const expiredPair = await EncryptedGitHubCredentialVault.open({ ...options, refresh, now: () => credential().refreshTokenExpiresAt });
    expect(expiredPair.available("github-secret-one")).toBe(false);
    expect(await expiredPair.read("github-secret-one")).toBeUndefined();
    expect(refresh).not.toHaveBeenCalled();
    await f.vault.put("github-installation", 0, { kind: "github-app-installation", accessToken: "ghs_installation_1234567890", accessTokenExpiresAt: firstTime });
    expect(await expiredPair.read("github-installation")).toBeUndefined();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("fails closed on refresh errors and can recover without overwriting the old pair", async () => {
    const f = await fixture();
    await f.vault.put("github-secret-one", 0, credential());
    const refresh = vi.fn().mockRejectedValueOnce(new Error("raw ghr_secret_must_not_escape"))
      .mockResolvedValueOnce({ accessToken: "ghu_rotated_access_1234567890", refreshToken: "ghr_rotated_refresh_1234567890",
        tokenType: "bearer", expiresInSeconds: 28_800, refreshTokenExpiresInSeconds: 15_897_600 });
    const events: GitHubCredentialRefreshEvent[] = [];
    const vault = await EncryptedGitHubCredentialVault.open({ vaultPath: f.vaultPath, keyPath: f.keyPath, now: () => "2026-08-29T00:00:00.000Z", refresh,
      onRefreshEvent: (event) => events.push(event) });
    expect(await vault.read("github-secret-one")).toBeUndefined();
    expect(vault.readCredential("github-secret-one")).toMatchObject({ revision: 1, credential: credential() });
    expect(await vault.read("github-secret-one")).toMatchObject({ revision: "vault:2", token: "ghu_rotated_access_1234567890" });
    expect(events.map(({ outcome, reason }) => ({ outcome, reason }))).toEqual([
      { outcome: "attempted", reason: null }, { outcome: "failed", reason: "upstream" },
      { outcome: "attempted", reason: null }, { outcome: "completed", reason: null },
    ]);
    expect(events[0]!.correlationId).toBe(events[1]!.correlationId);
    expect(events[2]!.correlationId).toBe(events[3]!.correlationId);
    expect(events[0]!.correlationId).not.toBe(events[2]!.correlationId);
    expect(JSON.stringify(events)).not.toMatch(/raw|ghr_|ghu_|github-secret-one/);
  });

  it.each(["invalid-response", "storage-failed"] as const)("audits %s without releasing a replacement token", async (reason) => {
    const f = await fixture();
    await f.vault.put("github-secret-one", 0, credential());
    const events: GitHubCredentialRefreshEvent[] = [];
    const refresh = vi.fn(async () => {
      if (reason === "storage-failed") {
        // Prevent the atomic rename using only this test's temporary vault path.
        await rm(f.vaultPath);
        await mkdir(f.vaultPath);
      }
      return { accessToken: "ghu_rotated_access_1234567890", refreshToken: "ghr_rotated_refresh_1234567890",
        tokenType: "bearer" as const, expiresInSeconds: reason === "invalid-response" ? -1 : 28_800, refreshTokenExpiresInSeconds: 15_897_600 };
    });
    const vault = await EncryptedGitHubCredentialVault.open({ vaultPath: f.vaultPath, keyPath: f.keyPath, now: () => "2026-08-29T00:00:00.000Z", refresh,
      onRefreshEvent: (event) => events.push(event) });
    expect(await vault.read("github-secret-one")).toBeUndefined();
    expect(events).toEqual([
      { correlationId: expect.any(String), outcome: "attempted", reason: null, credentialRevision: 1 },
      { correlationId: events[0]!.correlationId, outcome: "failed", reason, credentialRevision: 1 },
    ]);
    expect(vault.readCredential("github-secret-one")).toMatchObject({ revision: 1, credential: credential() });
  });

  it("keeps credential resolution independent of an unavailable audit sink", async () => {
    const f = await fixture();
    await f.vault.put("github-secret-one", 0, credential());
    const onRefreshEvent = vi.fn().mockRejectedValue(new Error("sink unavailable"));
    const vault = await EncryptedGitHubCredentialVault.open({ vaultPath: f.vaultPath, keyPath: f.keyPath, now: () => "2026-08-29T00:00:00.000Z", onRefreshEvent,
      refresh: async () => ({ accessToken: "ghu_rotated_access_1234567890", refreshToken: "ghr_rotated_refresh_1234567890",
        tokenType: "bearer", expiresInSeconds: 28_800, refreshTokenExpiresInSeconds: 15_897_600 }) });
    expect(await vault.read("github-secret-one")).toMatchObject({ revision: "vault:2" });
    expect(onRefreshEvent).toHaveBeenCalledTimes(2);
  });

  it("reloads deletions before reading through an older vault instance", async () => {
    const f = await fixture();
    await f.vault.put("github-secret-one", 0, credential());
    const second = await EncryptedGitHubCredentialVault.open({ vaultPath: f.vaultPath, keyPath: f.keyPath, now: () => firstTime });
    await second.delete("github-secret-one", 1);
    expect(await f.vault.read("github-secret-one")).toBeUndefined();
  });
});
