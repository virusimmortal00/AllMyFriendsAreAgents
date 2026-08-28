import { describe, expect, it, vi } from "vitest";
import { GitHubRepositoryCatalogClient, GitHubRepositoryCatalogFailure, type GitHubCatalogFetch } from "./github-repository-catalog.js";

const token = "ghu_catalog_access_token_1234567890";
const observedAt = "2026-08-28T16:00:00.000Z";

function json(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status }); }
function installation(id: number, login = "Example") { return { id, account: { id: id + 100, login, type: "Organization" }, repository_selection: "selected" }; }
function repository(id: number, name: string, owner = "Example") { return { id, name, full_name: `${owner}/${name}`, owner: { login: owner }, visibility: "private", default_branch: "main" }; }

describe("GitHub installation repository discovery", () => {
  it("uses fixed GitHub endpoints and returns a canonical metadata-only catalog", async () => {
    const fetcher = vi.fn<GitHubCatalogFetch>(async (input) => {
      const url = new URL(input);
      if (url.pathname === "/user/installations") return json({ total_count: 1, installations: [installation(101)] });
      if (url.pathname === "/user/installations/101/repositories") return json({ total_count: 2, repositories: [repository(201, "One"), repository(202, "Two")] });
      return json({}, 404);
    });
    const result = await new GitHubRepositoryCatalogClient(fetcher, () => observedAt).discover(token);
    expect(result).toEqual({ observedAt, installations: [{ installationId: 101, account: { id: 201, login: "Example", type: "Organization" }, repositorySelection: "selected" }],
      repositories: [
        { githubRepositoryId: 201, installationId: 101, owner: "example", name: "one", canonical: "github.com/example/one", visibility: "private", defaultBranch: "main" },
        { githubRepositoryId: 202, installationId: 101, owner: "example", name: "two", canonical: "github.com/example/two", visibility: "private", defaultBranch: "main" },
      ] });
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const [input, init] of fetcher.mock.calls) {
      expect(String(input)).toMatch(/^https:\/\/api\.github\.com\/user\/installations/);
      expect(init).toMatchObject({ method: "GET", redirect: "error", headers: expect.objectContaining({ authorization: `Bearer ${token}` }) });
    }
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it("paginates installations and repositories without following caller or response URLs", async () => {
    const firstInstallations = Array.from({ length: 100 }, (_, index) => installation(index + 1));
    const fetcher = vi.fn<GitHubCatalogFetch>(async (input) => {
      const url = new URL(input);
      const page = Number(url.searchParams.get("page"));
      if (url.pathname === "/user/installations") return json({ total_count: 101, installations: page === 1 ? firstInstallations : [installation(101)] });
      const installationId = Number(url.pathname.split("/")[3]);
      return json({ total_count: installationId === 101 ? 101 : 0,
        repositories: installationId === 101 ? (page === 1 ? Array.from({ length: 100 }, (_, index) => repository(10_000 + index, `repo-${index}`)) : [repository(20_000, "last")]) : [] });
    });
    const result = await new GitHubRepositoryCatalogClient(fetcher, () => observedAt).discover(token);
    expect(result.installations).toHaveLength(101); expect(result.repositories).toHaveLength(101);
    expect(fetcher.mock.calls.some(([input]) => String(input).endsWith("/user/installations/101/repositories?per_page=100&page=2"))).toBe(true);
  });

  it("fails closed for duplicate, malformed, oversized, and upstream responses with redacted errors", async () => {
    const cases: Array<{ fetcher: GitHubCatalogFetch; kind: string }> = [
      { fetcher: async (input) => String(input).includes("/repositories") ? json({ total_count: 2, repositories: [repository(1, "one"), repository(1, "one")] })
        : json({ total_count: 1, installations: [installation(1)] }), kind: "invalid-response" },
      { fetcher: async () => json({ total_count: 1, installations: [{ id: 1, account: null }] }), kind: "invalid-response" },
      { fetcher: async () => new Response(JSON.stringify({ total_count: 0, installations: [], padding: "x".repeat(2 * 1024 * 1024) })), kind: "invalid-response" },
      { fetcher: async () => json({ message: "private upstream details" }, 403), kind: "upstream" },
    ];
    for (const value of cases) {
      try { await new GitHubRepositoryCatalogClient(value.fetcher, () => observedAt).discover(token); throw new Error("expected failure"); }
      catch (error) {
        expect(error).toBeInstanceOf(GitHubRepositoryCatalogFailure);
        expect(error).toMatchObject({ kind: value.kind, message: `GitHub repository catalog failed (${value.kind}).` });
        expect(JSON.stringify(error)).not.toMatch(/private upstream details|ghu_catalog/);
      }
    }
  });
});
