// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubIntegrationDialog } from "./github-integration-dialog";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json" },
});

const connection = {
  connectionId: "github-connection:test",
  revision: 2,
  authMode: "github-device-user",
  state: "ready",
  githubUser: { id: 25_620_500, login: "virusimmortal00" },
  connectedAt: "2026-08-28T12:00:00.000Z",
  lastValidatedAt: "2026-08-28T12:01:00.000Z",
  updatedAt: "2026-08-28T12:01:00.000Z",
};

const catalog = {
  connectionId: connection.connectionId,
  connectionRevision: connection.revision,
  revision: 4,
  observedAt: "2026-08-28T12:02:00.000Z",
  installations: [{
    installationId: 157_360_466,
    account: { id: 25_620_500, login: "virusimmortal00", type: "User" },
    repositorySelection: "selected",
  }],
  repositories: [{
    githubRepositoryId: 1_234,
    installationId: 157_360_466,
    owner: "virusimmortal00",
    name: "AllMyFriendsAreAgents",
    canonical: "virusimmortal00/AllMyFriendsAreAgents",
    visibility: "private",
    defaultBranch: "main",
  }],
};

afterEach(() => vi.unstubAllGlobals());

describe("GitHubIntegrationDialog", () => {
  it("shows the server connection and binds a catalog repository to the current project", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/control/me") return json({ principal: { id: "owner", username: "owner", role: "OWNER", capabilities: [], revision: 1 }, csrfToken: "csrf-test" });
      if (path === "/api/control/integrations/github") return json({ app: { name: "All My Friends Are Agents", slug: "all-my-friends-are-agents", clientId: "Iv23test" }, connections: [connection] });
      if (path === "/api/control/projects/current/repository" && init?.method === "GET") return json({ repository: { configured: false }, defaults: { checkoutPath: "/srv/amfaa", worktreeRoot: "/srv/worktrees", policyRevision: 1 } });
      if (path.startsWith("/api/control/integrations/github/repositories?")) return json({ catalog });
      if (path === "/api/control/projects/current/repository" && init?.method === "PUT") return json({
        binding: { projectId: "project-one", revision: 1, state: "ready", connectionId: connection.connectionId, installationId: 157_360_466, githubRepositoryId: 1_234, repository: "virusimmortal00/AllMyFriendsAreAgents", updatedAt: "2026-08-28T12:03:00.000Z" },
        repository: { configured: true, revision: 1, state: "verified", repository: "virusimmortal00/AllMyFriendsAreAgents" },
      });
      return json({ error: `Unexpected request: ${path}` }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<GitHubIntegrationDialog returnFocusTo={null} onClose={vi.fn()} />);

    expect(await screen.findByText("Connected as virusimmortal00")).toBeTruthy();
    expect(screen.getByText("No client secret, private key, PAT, or room environment variable is required.", { exact: false })).toBeTruthy();
    expect(screen.getByRole("option", { name: "virusimmortal00/AllMyFriendsAreAgents · private" })).toBeTruthy();

    await userEvent.setup().click(screen.getByRole("button", { name: "Use for this project" }));

    expect(await screen.findByText("Verified")).toBeTruthy();
    expect(screen.getByText("Inherited by every room attached to this project.", { exact: false })).toBeTruthy();
    const configureCall = fetchMock.mock.calls.find(([path, options]) => path === "/api/control/projects/current/repository" && options?.method === "PUT");
    expect(new Headers(configureCall?.[1]?.headers).get("X-AMFAA-CSRF")).toBe("csrf-test");
    expect(JSON.parse(String(configureCall?.[1]?.body))).toEqual({
      githubConnectionId: connection.connectionId,
      githubRepositoryId: 1_234,
      expectedBindingRevision: 0,
      expectedRepositoryRevision: 0,
      checkoutPath: "/srv/amfaa",
      worktreeRoot: "/srv/worktrees",
      policyRevision: 1,
    });
  });

  it("keeps server-owner bootstrap inside the UI before loading GitHub settings", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/control/me") return json({ error: "Authentication required." }, 401);
      if (path === "/api/control/status") return json({ claimed: false, bootstrapConfigured: true });
      if (path === "/api/control/bootstrap" && init?.method === "POST") return json({ principal: { id: "owner", username: "server-owner", role: "OWNER", capabilities: [], revision: 1 }, csrfToken: "csrf-claimed" });
      if (path === "/api/control/integrations/github") return json({ app: { name: "All My Friends Are Agents", slug: "all-my-friends-are-agents", clientId: "Iv23test" }, connections: [] });
      if (path === "/api/control/projects/current/repository") return json({ repository: { configured: false }, defaults: { checkoutPath: "/srv/amfaa", worktreeRoot: "/srv/worktrees", policyRevision: 1 } });
      return json({ error: `Unexpected request: ${path}` }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<GitHubIntegrationDialog returnFocusTo={null} onClose={vi.fn()} />);
    expect(await screen.findByRole("heading", { name: "Claim server owner" })).toBeTruthy();
    await user.type(screen.getByLabelText("Local bootstrap secret"), "bootstrap-secret");
    await user.type(screen.getByLabelText("Username"), "server-owner");
    await user.type(screen.getByLabelText("Password"), "strong-local-password");
    await user.click(screen.getByRole("button", { name: "Claim owner" }));

    expect(await screen.findByRole("button", { name: "Connect with GitHub" })).toBeTruthy();
    const bootstrapCall = fetchMock.mock.calls.find(([path]) => path === "/api/control/bootstrap");
    expect(JSON.parse(String(bootstrapCall?.[1]?.body))).toEqual({ bootstrapSecret: "bootstrap-secret", username: "server-owner", password: "strong-local-password" });
  });
});
