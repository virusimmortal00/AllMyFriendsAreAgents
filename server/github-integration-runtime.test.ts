import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openGitHubIntegrationRuntime } from "./github-integration-runtime.js";

const roots: string[] = [];
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("GitHub integration production runtime", () => {
  it("does not create stores or key material without a bundled public client ID", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "amfaa-github-runtime-disabled-")); roots.push(root);
    await expect(openGitHubIntegrationRuntime({ projectRoot: root, dataDirectory: path.join(root, "data") })).resolves.toBeUndefined();
    await expect(stat(path.join(root, "data"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("opens the tested stores and keeps generated key material outside runtime data", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "amfaa-github-runtime-")); roots.push(root);
    const configurationPath = path.join(root, "github-app.json"); const dataDirectory = path.join(root, "data");
    const keyPath = path.join(root, "keys", "github-credentials.key");
    await writeFile(configurationPath, JSON.stringify({ schemaVersion: 1, appName: "All My Friends Are Agents",
      appSlug: "all-my-friends-are-agents", clientId: "Iv1.1234567890abcdef" }));
    const runtime = await openGitHubIntegrationRuntime({ projectRoot: root, dataDirectory, configurationPath, credentialKeyPath: keyPath });
    expect(runtime?.configuration).toMatchObject({ appSlug: "all-my-friends-are-agents", clientId: "Iv1.1234567890abcdef" });
    expect(runtime?.integrations.connections()).toEqual([]);
    expect(runtime?.vault.list()).toEqual([]);
    expect(runtime?.credentials.available("project-one", "binding-one")).toBe(false);
    expect((await stat(dataDirectory)).mode & 0o777).toBe(0o700);
    expect((await stat(runtime!.vault.vaultPath)).mode & 0o777).toBe(0o600);
    expect((await stat(keyPath)).mode & 0o777).toBe(0o600);
    expect(await readFile(keyPath, "utf8")).toMatch(/^amfaa-github-vault-key-v1:/);
    expect(path.dirname(keyPath)).not.toBe(path.dirname(runtime!.vault.vaultPath));
  });

  it("wires expired credential reads through device-flow refresh and survives restart", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "amfaa-github-runtime-refresh-")); roots.push(root);
    const configurationPath = path.join(root, "github-app.json");
    await writeFile(configurationPath, JSON.stringify({ schemaVersion: 1, appName: "Example App", appSlug: "example-app", clientId: "Iv1.1234567890abcdef" }));
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ access_token: "ghu_rotated_1234567890", refresh_token: "ghr_rotated_1234567890",
      token_type: "bearer", expires_in: 28_800, refresh_token_expires_in: 15_897_600 }), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    const options = { projectRoot: root, dataDirectory: path.join(root, "data"), configurationPath, credentialKeyPath: path.join(root, "keys", "github-credentials.key") };
    const runtime = (await openGitHubIntegrationRuntime(options))!;
    await runtime.vault.put("example-secret", 0, { kind: "github-device-user", accessToken: "ghu_expired_1234567890", refreshToken: "ghr_original_1234567890",
      accessTokenExpiresAt: new Date(Date.now() - 1_000).toISOString(), refreshTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString() });
    expect(await runtime.vault.read("example-secret")).toMatchObject({ token: "ghu_rotated_1234567890", revision: "vault:2" });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]).toMatchObject(["https://github.com/login/oauth/access_token", { method: "POST", redirect: "error",
      body: "client_id=Iv1.1234567890abcdef&grant_type=refresh_token&refresh_token=ghr_original_1234567890" }]);
    const reopened = (await openGitHubIntegrationRuntime(options))!;
    expect(await reopened.vault.read("example-secret")).toMatchObject({ token: "ghu_rotated_1234567890", revision: "vault:2" });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
