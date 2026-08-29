import { describe, expect, it } from "vitest";
import { CascadingGitHubCredentialProvider, LegacyPatGitHubCredentialProvider, type GitHubCredentialProvider } from "./github-credential-provider.js";

function request(projectId = "project-one", credentialReference = "credential-one") {
  return {
    projectId,
    credentialReference,
    connectionId: "connection-one",
    connectionRevision: 1,
    repository: "github.com/example/repository",
  };
}

describe("GitHub credential providers", () => {
  it("resolves a legacy PAT only for its project-scoped opaque reference", async () => {
    const provider = new LegacyPatGitHubCredentialProvider();
    provider.register("project-one", "credential-one", "github_pat_private_secret");

    await expect(provider.resolve(request())).resolves.toMatchObject({
      provider: "legacy-pat",
      token: "github_pat_private_secret",
      authorityRevision: expect.stringMatching(/^legacy:/),
    });
    await expect(provider.resolve(request("project-two"))).resolves.toBeUndefined();
    expect(provider.health("project-one", "credential-one")).toEqual({ state: "ready", provider: "legacy-pat", reason: "ready" });
    expect(provider.health("project-two", "credential-one")).toEqual({ state: "missing", reason: "credential-missing" });
  });

  it("fails closed for malformed resolution context", async () => {
    const provider = new LegacyPatGitHubCredentialProvider();
    provider.register("project-one", "credential-one", "github_pat_private_secret");

    await expect(provider.resolve({ ...request(), repository: "https://attacker.example/repository" })).resolves.toBeUndefined();
    await expect(provider.resolve({ ...request(), connectionRevision: 0 })).resolves.toBeUndefined();
    await expect(provider.resolve({ ...request(), connectionId: "../connection" })).resolves.toBeUndefined();
  });

  it("does not expose registered tokens through health or serialization", () => {
    const provider = new LegacyPatGitHubCredentialProvider();
    provider.register("project-one", "credential-one", "github_pat_private_secret");

    expect(JSON.stringify(provider)).not.toMatch(/github_pat|private_secret|credential-one/);
    expect(JSON.stringify(provider.health("project-one", "credential-one"))).not.toMatch(/github_pat|private_secret|credential-one/);
    expect(() => provider.register("project-one", "credential-one", "replacement_secret")).toThrow(/already registered/);
  });

  it("migrates references across providers without serializing either provider", async () => {
    const legacy = new LegacyPatGitHubCredentialProvider(); legacy.register("project-one", "legacy-reference", "github_pat_private_secret");
    const app = {
      available: (_projectId: string, reference: string) => reference === "app-reference",
      health: (_projectId: string, reference: string) => reference === "app-reference"
        ? { state: "ready" as const, provider: "github-device-user" as const, reason: "ready" }
        : { state: "missing" as const, reason: "binding-missing" },
      resolve: async (value: ReturnType<typeof request>) => value.credentialReference === "app-reference"
        ? { token: "ghu_private_app_token", provider: "github-device-user" as const, authorityRevision: "app:one" }
        : undefined,
    } satisfies GitHubCredentialProvider;
    const provider = new CascadingGitHubCredentialProvider([app, legacy]);
    await expect(provider.resolve(request("project-one", "app-reference"))).resolves.toMatchObject({ provider: "github-device-user" });
    await expect(provider.resolve(request("project-one", "legacy-reference"))).resolves.toMatchObject({ provider: "legacy-pat" });
    expect(provider.health("project-one", "app-reference")).toMatchObject({ state: "ready", provider: "github-device-user" });
    expect(JSON.stringify(provider)).not.toMatch(/private_app_token|private_secret|app-reference|legacy-reference/);
  });
});
