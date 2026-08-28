import path from "node:path";
import { describe, expect, it } from "vitest";
import { githubAppRegistrationUrl, loadGitHubAppRegistrationTemplate } from "./github-app-registration-template.js";

const templatePath = path.resolve(import.meta.dirname, "../config/github-app-registration.template.json");

describe("reusable GitHub App registration template", () => {
  it("generates a public, webhook-free, read-only prefilled registration URL", async () => {
    const template = await loadGitHubAppRegistrationTemplate(templatePath);
    const url = new URL(githubAppRegistrationUrl(template));
    expect(url.origin + url.pathname).toBe("https://github.com/settings/apps/new");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ public: "true", request_oauth_on_install: "false", webhook_active: "false",
      actions: "read", checks: "read", issues: "read", pull_requests: "read" });
    expect([...url.searchParams.values()]).not.toContain("write");
    expect(url.searchParams.has("contents")).toBe(false);
    expect(JSON.stringify(template)).not.toMatch(/secret|private.?key|callback|webhook.?url/i);
    expect(template.postRegistration).toEqual({ enableDeviceFlow: true, expireUserAuthorizationTokens: true });
  });

  it("targets an organization without allowing owner-controlled path injection", async () => {
    const template = await loadGitHubAppRegistrationTemplate(templatePath);
    expect(new URL(githubAppRegistrationUrl(template, "Example Org/../../personal")).pathname)
      .toBe("/organizations/Example%20Org%2F..%2F..%2Fpersonal/settings/apps/new");
  });
});
