import { execFile } from "node:child_process";
import { Buffer } from "node:buffer";
import { promisify } from "node:util";
import type { GitHubExternalResult } from "./github-contribution-record.js";

const execFileAsync = promisify(execFile);

export interface GitHubContributionClient {
  readBranchHead(repository: string, branch: string): Promise<string>;
  pullRequestIdentity(repository: string, number: number): Promise<{ headSha: string; baseSha: string; headRef: string; draft: boolean; state: string }>;
  readIssue(repository: string, number: number): Promise<GitHubExternalResult>;
  readPullRequest(repository: string, number: number): Promise<GitHubExternalResult>;
  readChecks(repository: string, headSha: string): Promise<GitHubExternalResult>;
  comment(repository: string, target: { issueNumber?: number; pullNumber?: number }, body: string, marker: string): Promise<GitHubExternalResult>;
  publishBranch(repository: string, workspacePath: string, branch: string, headSha: string): Promise<void>;
  findDraftPullRequest(repository: string, branch: string): Promise<GitHubExternalResult | null>;
  createDraftPullRequest(repository: string, branch: string, base: string, title: string, body: string): Promise<GitHubExternalResult>;
  updatePullRequest(repository: string, number: number, input: { title?: string; body?: string }): Promise<GitHubExternalResult>;
  requestReview(repository: string, number: number, reviewers: readonly string[]): Promise<GitHubExternalResult>;
}

export class GitHubRestClient implements GitHubContributionClient {
  constructor(
    private readonly token: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly gitExecutor: (cwd: string, args: readonly string[], environment: NodeJS.ProcessEnv) => Promise<void> = async (cwd, args, environment) => {
      await execFileAsync("git", [...args], { cwd, timeout: 60_000, maxBuffer: 1024 * 1024, env: environment });
    },
  ) {
    if (token.length < 20) throw new Error("A server-held GitHub token is required");
  }

  readIssue(repository: string, number: number) { return this.getResult(repository, `/issues/${number}`); }
  readPullRequest(repository: string, number: number) { return this.getResult(repository, `/pulls/${number}`); }
  readChecks(repository: string, headSha: string) { return this.getResult(repository, `/commits/${headSha}/check-runs`); }
  async readBranchHead(repository: string, branch: string) {
    const result = object(await this.request(repository, `/git/ref/heads/${encodeURIComponent(branch)}`, { method: "GET" }));
    return String(object(result.object).sha || "");
  }
  async pullRequestIdentity(repository: string, number: number) {
    const result = object(await this.request(repository, `/pulls/${number}`, { method: "GET" }));
    return { headSha: String(object(result.head).sha || ""), baseSha: String(object(result.base).sha || ""), headRef: String(object(result.head).ref || ""), draft: result.draft === true, state: String(result.state || "") };
  }

  async comment(repository: string, target: { issueNumber?: number; pullNumber?: number }, body: string, marker: string) {
    const number = target.issueNumber ?? target.pullNumber;
    if (!number) throw new Error("A linked issue or pull request is required");
    for (let page = 1; page <= 20; page += 1) {
      const comments = await this.request(repository, `/issues/${number}/comments?per_page=100&page=${page}`, { method: "GET" }) as unknown[];
      const existing = comments.find((value) => object(value).body?.toString().includes(marker));
      if (existing) return project(existing);
      if (comments.length < 100) break;
      if (page === 20) throw new GitHubClientError("Comment reconciliation exceeded the broker pagination quota", false);
    }
    return project(await this.request(repository, `/issues/${number}/comments`, {
      method: "POST", body: JSON.stringify({ body: `${body}\n\n${marker}` }),
    }));
  }

  async publishBranch(repository: string, workspacePath: string, branch: string, headSha: string) {
    const authorization = Buffer.from(`x-access-token:${this.token}`).toString("base64");
    await this.gitExecutor(workspacePath, ["push", `https://github.com/${repository}.git`, `${headSha}:refs/heads/${branch}`], {
        PATH: process.env.PATH || "/usr/bin:/bin", HOME: process.env.HOME || "/var/empty",
        GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_COUNT: "2",
        GIT_CONFIG_KEY_0: "credential.helper", GIT_CONFIG_VALUE_0: "",
        GIT_CONFIG_KEY_1: "http.https://github.com/.extraheader", GIT_CONFIG_VALUE_1: `AUTHORIZATION: basic ${authorization}`,
      }).catch(() => { throw new GitHubClientError("GitHub branch publication transport failed", true); });
  }

  async findDraftPullRequest(repository: string, branch: string) {
    const [owner] = repository.split("/");
    const pulls = await this.request(repository, `/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=10`, { method: "GET" }) as unknown[];
    const pull = pulls.find((value) => object(value).draft === true && object(value).head && object(object(value).head).ref === branch);
    return pull ? project(pull) : null;
  }

  async createDraftPullRequest(repository: string, branch: string, base: string, title: string, body: string) {
    return project(await this.request(repository, "/pulls", { method: "POST", body: JSON.stringify({ head: branch, base, title, body, draft: true }) }));
  }

  async updatePullRequest(repository: string, number: number, input: { title?: string; body?: string }) {
    return project(await this.request(repository, `/pulls/${number}`, { method: "PATCH", body: JSON.stringify(input) }));
  }

  async requestReview(repository: string, number: number, reviewers: readonly string[]) {
    return project(await this.request(repository, `/pulls/${number}/requested_reviewers`, { method: "POST", body: JSON.stringify({ reviewers }) }));
  }

  private async getResult(repository: string, endpoint: string) { return project(await this.request(repository, endpoint, { method: "GET" })); }

  private async request(repository: string, endpoint: string, init: RequestInit) {
    const response = await this.fetcher(`https://api.github.com/repos/${repository}${endpoint}`, {
      ...init,
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${this.token}`, "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json" },
      signal: AbortSignal.timeout(30_000),
    }).catch(() => { throw new GitHubClientError("GitHub request transport failed", true); });
    const text = await response.text();
    if (!response.ok) {
      const retryAfter = response.headers.get("retry-after");
      throw new GitHubClientError(`GitHub request failed with ${response.status}${retryAfter ? `; retry after ${retryAfter}s` : ""}`, response.status === 429 || response.status >= 500);
    }
    if (text.length > 2_000_000) throw new GitHubClientError("GitHub response exceeded the broker quota", false);
    return text ? JSON.parse(text) as unknown : {};
  }
}

export class GitHubClientError extends Error {
  constructor(message: string, readonly retryable: boolean) { super(message); }
}

function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" ? value as Record<string, unknown> : {}; }
function project(value: unknown): GitHubExternalResult {
  const source = object(value);
  const number = Number.isSafeInteger(source.number) ? Number(source.number) : undefined;
  const id = String(source.id ?? source.node_id ?? number ?? "unknown").slice(0, 256);
  const url = String(source.html_url ?? source.url ?? "").slice(0, 2_048);
  const state = typeof source.state === "string" ? source.state.slice(0, 64) : undefined;
  return { id, url, ...(number ? { number } : {}), ...(state ? { state } : {}), data: boundedData(source) };
}

function boundedData(source: Record<string, unknown>) {
  const allowed = ["number", "state", "draft", "html_url", "conclusion", "status", "total_count"];
  const result: Record<string, unknown> = {};
  for (const key of allowed) if (key in source) result[key] = source[key];
  if (Array.isArray(source.check_runs)) result.check_runs = source.check_runs.slice(0, 100).map((value) => {
    const check = object(value); return { id: check.id, name: String(check.name || "").slice(0, 256), status: check.status, conclusion: check.conclusion, details_url: String(check.details_url || "").slice(0, 2_048) };
  });
  const serialized = JSON.stringify(result);
  return JSON.parse(serialized.length > 128_000 ? JSON.stringify({ truncated: true }) : serialized) as unknown;
}
