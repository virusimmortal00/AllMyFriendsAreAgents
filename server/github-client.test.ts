import { describe, expect, it, vi } from "vitest";
import { GitHubClientError, GitHubRestClient } from "./github-client.js";

function response(value: unknown, status = 200, headers?: HeadersInit) {
  return Promise.resolve(new Response(typeof value === "string" ? value : JSON.stringify(value), { status, headers: { "Content-Type": "application/json", ...headers } }));
}

describe("server-held GitHub client", () => {
  it("keeps credentials out of Git arguments and passes them only to the trusted child environment", async () => {
    const execute = vi.fn(async (_cwd: string, _args: readonly string[], _environment: NodeJS.ProcessEnv) => undefined); const token = "secret-server-token-value";
    const client = new GitHubRestClient(token, vi.fn() as unknown as typeof fetch, execute);
    await client.publishBranch("owner/repo", "/assignment", "amfaa/assignment-one-12345678", "a".repeat(40));
    expect(execute).toHaveBeenCalledOnce();
    const [cwd, args, environment] = execute.mock.calls[0]!;
    expect(cwd).toBe("/assignment"); expect(args).toEqual(["push", "https://github.com/owner/repo.git", `${"a".repeat(40)}:refs/heads/amfaa/assignment-one-12345678`]);
    expect(JSON.stringify(args)).not.toContain(token); expect(environment.GIT_CONFIG_VALUE_1).toContain("AUTHORIZATION: basic");
    expect(environment).toMatchObject({ GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_COUNT: "2" });
  });

  it("deduplicates comments using the broker marker and never includes the token in external errors", async () => {
    const fetcher = vi.fn()
      .mockImplementationOnce(() => response([{ id: 7, html_url: "https://github.test/comment/7", body: "done <!-- marker -->" }]))
      .mockImplementationOnce(() => response({ message: "secret should remain external" }, 429, { "retry-after": "12" }));
    const client = new GitHubRestClient("x".repeat(30), fetcher);
    await expect(client.comment("owner/repo", { issueNumber: 3 }, "body", "<!-- marker -->")).resolves.toMatchObject({ id: "7" });
    expect(fetcher).toHaveBeenCalledOnce();
    await expect(client.readIssue("owner/repo", 3)).rejects.toMatchObject({ message: "GitHub request failed with 429; retry after 12s", retryable: true });
    expect((await fetcher.mock.calls[1]![1]).headers.Authorization).toBe(`Bearer ${"x".repeat(30)}`);
  });

  it("paginates marker reconciliation, strips content from projections, and classifies ambiguous transport failures", async () => {
    const firstPage = Array.from({ length: 100 }, (_, id) => ({ id, body: "unrelated" }));
    const fetcher = vi.fn()
      .mockImplementationOnce(() => response(firstPage))
      .mockImplementationOnce(() => response([{ id: 101, body: "private <!-- marker -->", html_url: "https://github.test/101" }]))
      .mockImplementationOnce(() => response({ id: 3, body: "private response body", title: "private title", state: "open", html_url: "https://github.test/3" }))
      .mockRejectedValueOnce(new Error("connection reset"));
    const client = new GitHubRestClient("x".repeat(30), fetcher);
    await expect(client.comment("owner/repo", { issueNumber: 3 }, "body", "<!-- marker -->")).resolves.toMatchObject({ id: "101" });
    expect(fetcher.mock.calls[0]![0]).toContain("page=1"); expect(fetcher.mock.calls[1]![0]).toContain("page=2");
    const issue = await client.readIssue("owner/repo", 3); expect(JSON.stringify(issue)).not.toMatch(/private response body|private title/);
    await expect(client.readIssue("owner/repo", 3)).rejects.toMatchObject({ message: "GitHub request transport failed", retryable: true });
  });

  it("accepts only an open draft with the exact head ref and rejects oversized responses", async () => {
    const fetcher = vi.fn()
      .mockImplementationOnce(() => response([{ id: 1, draft: false, head: { ref: "branch" } }, { id: 2, draft: true, head: { ref: "branch" }, html_url: "https://github.test/2" }]))
      .mockImplementationOnce(() => response(`{"body":"${"x".repeat(2_000_001)}"}`));
    const client = new GitHubRestClient("x".repeat(30), fetcher);
    await expect(client.findDraftPullRequest("owner/repo", "branch")).resolves.toMatchObject({ id: "2" });
    await expect(client.readIssue("owner/repo", 1)).rejects.toEqual(new GitHubClientError("GitHub response exceeded the broker quota", false));
  });
});
