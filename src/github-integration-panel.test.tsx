// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { updateControlSession } from "./control-session-state";
import { GitHubIntegrationPanel } from "./github-integration-panel";

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

afterEach(() => { cleanup(); updateControlSession({ status: null, session: null, checked: false, error: "" }); vi.unstubAllGlobals(); });

describe("GitHubIntegrationPanel", () => {
  it("repairs stale paths and retries an uncertain response with the same request", async () => {
    const attempts: string[] = [];
    let repaired = false;
    vi.stubGlobal("fetch", vi.fn(async (input, options) => {
      const route = String(input);
      if (route.endsWith("/status")) return json({ claimed: true });
      if (route.endsWith("/me")) return json({ principal: { id: "owner", username: "owner", role: "OWNER", capabilities: [], revision: 1 }, csrfToken: "fictional-csrf", expiresAt: "2099-01-01T00:00:00Z" });
      if (route === "/api/control/integrations/github") return json({ connections: [connection] });
      if (route.includes("/repositories?")) return json({ catalog });
      if (route.endsWith("/repository/repair")) {
        attempts.push(String(options.body));
        expect(new Headers(options.headers).get("X-AMFAA-CSRF")).toBe("fictional-csrf");
        if (attempts.length === 1) throw new Error("Lost response");
        repaired = true; return json({ repository: { configured: true, revision: 2 } });
      }
      if (route.endsWith("/repository")) return json({ binding: { revision: 1 }, repository: { configured: true, revision: repaired ? 2 : 1, repository: "github.com/example/project" }, defaults: { checkoutPath: "/workspace", worktreeRoot: "/worktrees" }, readiness: { authority: repaired ? "verified" : "unverified", state: "available" } });
      throw new Error("Unexpected route");
    }));
    const user = userEvent.setup();
    render(<GitHubIntegrationPanel onOpenAdministration={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "Repair repository paths" }));
    expect(screen.getByLabelText("Checkout path").hasAttribute("disabled")).toBe(true);
    await user.click(await screen.findByRole("button", { name: "Retry repair" }));
    await screen.findByText("Repository verified");
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toBe(attempts[1]);
    expect(JSON.parse(attempts[0])).toMatchObject({ expectedBindingRevision: 1, expectedRepositoryRevision: 1, checkoutPath: "/workspace", worktreeRoot: "/worktrees" });
  });

  it("offers administration after capability denial without discarding a valid session", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input) => {
      if (String(input).endsWith("/status")) return json({ claimed: true, bootstrapConfigured: false });
      if (String(input).endsWith("/me")) return json({ principal: { id: "member", username: "operator", role: "MEMBER", capabilities: [], revision: 1 }, csrfToken: "fictional-csrf", expiresAt: "2099-01-01T00:00:00Z" });
      return json({ error: "The INTEGRATION_VIEW capability is required." }, 403);
    }));
    const onOpenAdministration = vi.fn();
    render(<GitHubIntegrationPanel onOpenAdministration={onOpenAdministration} />);
    await userEvent.setup().click(await screen.findByRole("button", { name: "Sign in to server administration" }));
    expect(onOpenAdministration).toHaveBeenCalledOnce();
    expect(screen.getByRole("alert").textContent).toContain("INTEGRATION_VIEW");
  });

  it("shows the server connection and binds a catalog repository to the current project", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/control/status") return json({ claimed: true, bootstrapConfigured: false });
      if (path === "/api/control/me") return json({ expiresAt: "2099-01-01T00:00:00Z", principal: { id: "owner", username: "owner", role: "OWNER", capabilities: [], revision: 1 }, csrfToken: "csrf-test" });
      if (path === "/api/control/integrations/github") return json({ app: { name: "All My Friends Are Agents", slug: "all-my-friends-are-agents", clientId: "Iv23test" }, connections: [connection] });
      if (path === "/api/control/projects/current/repository" && init?.method === "GET") return json({ repository: { configured: false }, defaults: { checkoutPath: "/srv/amfaa", worktreeRoot: "/srv/worktrees", policyRevision: 1 } });
      if (path.startsWith("/api/control/integrations/github/repositories?")) return json({ catalog });
      if (path === "/api/control/projects/current/repository" && init?.method === "PUT") return json({
        binding: { projectId: "project-one", revision: 1, state: "ready", connectionId: connection.connectionId, installationId: 157_360_466, githubRepositoryId: 1_234, repository: "github.com/virusimmortal00/AllMyFriendsAreAgents", updatedAt: "2026-08-28T12:03:00.000Z" },
        repository: { configured: true, revision: 1, state: "verified", repository: "github.com/virusimmortal00/AllMyFriendsAreAgents" },
      });
      return json({ error: `Unexpected request: ${path}` }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<GitHubIntegrationPanel onOpenAdministration={() => undefined} />);

    expect(await screen.findByRole("heading", { name: "GitHub connected" })).toBeTruthy();
    expect(screen.getByText("@virusimmortal00")).toBeTruthy();
    expect(screen.queryByText(/client secret|private key|PAT|device-user token|revision/i)).toBeNull();
    expect(screen.getByRole("link", { name: "Manage repository access" }).getAttribute("href")).toBe("https://github.com/apps/all-my-friends-are-agents/installations/new");
    expect(screen.getByRole("option", { name: "virusimmortal00/AllMyFriendsAreAgents · private" })).toBeTruthy();

    await userEvent.setup().click(screen.getByRole("button", { name: "Use repository" }));

    expect(await screen.findByText("Configured")).toBeTruthy();
    expect(screen.getByText("Used by every room in this project.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "virusimmortal00/AllMyFriendsAreAgents" }).getAttribute("href")).toBe("https://github.com/virusimmortal00/AllMyFriendsAreAgents");
    expect(screen.queryByRole("combobox", { name: "Repository" })).toBeNull();
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

  it.each([true, false])("routes claimed=%s to administration without duplicate credentials", async (claimed) => {
    vi.stubGlobal("fetch", vi.fn(async (input) => String(input).endsWith("/status") ? json({ claimed, bootstrapConfigured: true }) : json({ error: "Authentication required." }, 401)));
    const onOpenAdministration = vi.fn();
    render(<GitHubIntegrationPanel onOpenAdministration={onOpenAdministration} />);
    await userEvent.setup().click(await screen.findByRole("button", { name: "Sign in to server administration" }));
    expect(onOpenAdministration).toHaveBeenCalledOnce();
    expect(screen.queryByLabelText("Password")).toBeNull();
  });
});
