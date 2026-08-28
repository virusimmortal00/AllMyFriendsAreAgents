import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EncryptedGitHubCredentialVault, type GitHubDeviceUserVaultCredential } from "./github-credential-vault.js";

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

    const reopened = await EncryptedGitHubCredentialVault.open({ vaultPath: f.vaultPath, keyPath: f.keyPath });
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
});
