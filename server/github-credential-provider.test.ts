import { describe, expect, it } from "vitest";
import { LegacyPatGitHubCredentialProvider } from "./github-credential-provider.js";

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
});

