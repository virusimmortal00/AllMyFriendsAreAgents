const API_ORIGIN = "https://api.github.com";
const API_VERSION = "2022-11-28";
const PAGE_SIZE = 100;
const MAX_INSTALLATION_PAGES = 10;
const MAX_REPOSITORY_PAGES = 100;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const USER_ACCESS_TOKEN = /^ghu_[A-Za-z0-9_]{10,1000}$/;
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const GITHUB_REPOSITORY_NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const GITHUB_BRANCH = /^(?![-./])(?!.*(?:\.\.|\/\/|@\{|\\|\s|[~^:?*\[]))[A-Za-z0-9._/-]{1,240}$/;

export type GitHubCatalogFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface GitHubInstallationCatalogEntry {
  readonly installationId: number;
  readonly account: { readonly id: number; readonly login: string; readonly type: "User" | "Organization" };
  readonly repositorySelection: "all" | "selected";
}

export interface GitHubRepositoryCatalogEntry {
  readonly githubRepositoryId: number;
  readonly installationId: number;
  readonly owner: string;
  readonly name: string;
  readonly canonical: string;
  readonly visibility: "public" | "private" | "internal";
  readonly defaultBranch: string;
}

export interface GitHubRepositoryCatalogDiscovery {
  readonly observedAt: string;
  readonly installations: readonly GitHubInstallationCatalogEntry[];
  readonly repositories: readonly GitHubRepositoryCatalogEntry[];
}

export class GitHubRepositoryCatalogFailure extends Error {
  constructor(readonly kind: "invalid-credential" | "upstream" | "invalid-response" | "limit-exceeded") {
    super(`GitHub repository catalog failed (${kind}).`);
    this.name = "GitHubRepositoryCatalogFailure";
  }
}

/** Discovers installations and repositories visible to one GitHub App user token. */
export class GitHubRepositoryCatalogClient {
  constructor(private readonly fetcher: GitHubCatalogFetch = fetch, private readonly now: () => string = () => new Date().toISOString()) {}

  async discover(accessToken: string): Promise<GitHubRepositoryCatalogDiscovery> {
    if (!USER_ACCESS_TOKEN.test(accessToken)) throw new GitHubRepositoryCatalogFailure("invalid-credential");
    const installationPayloads = await this.pages("/user/installations", "installations", accessToken, MAX_INSTALLATION_PAGES);
    const installations = installationPayloads.map(installationFrom);
    if (new Set(installations.map((entry) => entry.installationId)).size !== installations.length) throw new GitHubRepositoryCatalogFailure("invalid-response");
    const repositories: GitHubRepositoryCatalogEntry[] = [];
    for (const installation of installations) {
      const payloads = await this.pages(`/user/installations/${installation.installationId}/repositories`, "repositories", accessToken, MAX_REPOSITORY_PAGES);
      repositories.push(...payloads.map((payload) => repositoryFrom(payload, installation.installationId)));
    }
    if (new Set(repositories.map((entry) => entry.githubRepositoryId)).size !== repositories.length
      || new Set(repositories.map((entry) => entry.canonical)).size !== repositories.length) throw new GitHubRepositoryCatalogFailure("invalid-response");
    const observedAt = this.now();
    if (!validTimestamp(observedAt)) throw new GitHubRepositoryCatalogFailure("invalid-response");
    return { observedAt, installations, repositories };
  }

  private async pages(pathname: string, field: "installations" | "repositories", accessToken: string, maximumPages: number) {
    const values: unknown[] = [];
    for (let page = 1; page <= maximumPages; page += 1) {
      const payload = await this.get(`${pathname}?per_page=${PAGE_SIZE}&page=${page}`, accessToken);
      const pageValues = payload[field];
      const totalCount = payload.total_count;
      if (!Array.isArray(pageValues) || pageValues.length > PAGE_SIZE || !Number.isSafeInteger(totalCount) || (totalCount as number) < 0) {
        throw new GitHubRepositoryCatalogFailure("invalid-response");
      }
      values.push(...pageValues);
      if (values.length > (totalCount as number)) throw new GitHubRepositoryCatalogFailure("invalid-response");
      if (values.length === totalCount) return values;
      if (pageValues.length < PAGE_SIZE) throw new GitHubRepositoryCatalogFailure("invalid-response");
    }
    throw new GitHubRepositoryCatalogFailure("limit-exceeded");
  }

  private async get(pathname: string, accessToken: string) {
    let response: Response;
    try {
      response = await this.fetcher(`${API_ORIGIN}${pathname}`, { method: "GET", redirect: "error", headers: {
        accept: "application/vnd.github+json", authorization: `Bearer ${accessToken}`, "x-github-api-version": API_VERSION,
      } });
    } catch { throw new GitHubRepositoryCatalogFailure("upstream"); }
    if (!response.ok) throw new GitHubRepositoryCatalogFailure("upstream");
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) throw new GitHubRepositoryCatalogFailure("invalid-response");
    let payload: unknown;
    try { payload = JSON.parse(text); } catch { throw new GitHubRepositoryCatalogFailure("invalid-response"); }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new GitHubRepositoryCatalogFailure("invalid-response");
    return payload as Record<string, unknown>;
  }
}

function installationFrom(value: unknown): GitHubInstallationCatalogEntry {
  if (!value || typeof value !== "object") throw new GitHubRepositoryCatalogFailure("invalid-response");
  const item = value as { id?: unknown; account?: unknown; repository_selection?: unknown };
  const account = item.account as { id?: unknown; login?: unknown; type?: unknown } | undefined;
  if (!Number.isSafeInteger(item.id) || (item.id as number) < 1 || !account || !Number.isSafeInteger(account.id) || (account.id as number) < 1
    || typeof account.login !== "string" || !GITHUB_LOGIN.test(account.login) || !["User", "Organization"].includes(String(account.type))
    || !["all", "selected"].includes(String(item.repository_selection))) throw new GitHubRepositoryCatalogFailure("invalid-response");
  return { installationId: item.id as number, account: { id: account.id as number, login: account.login,
    type: account.type as "User" | "Organization" }, repositorySelection: item.repository_selection as "all" | "selected" };
}

function repositoryFrom(value: unknown, installationId: number): GitHubRepositoryCatalogEntry {
  if (!value || typeof value !== "object") throw new GitHubRepositoryCatalogFailure("invalid-response");
  const item = value as { id?: unknown; name?: unknown; full_name?: unknown; owner?: unknown; visibility?: unknown; default_branch?: unknown };
  const owner = item.owner as { login?: unknown } | undefined;
  if (!Number.isSafeInteger(item.id) || (item.id as number) < 1 || typeof item.name !== "string" || !GITHUB_REPOSITORY_NAME.test(item.name)
    || !owner || typeof owner.login !== "string" || !GITHUB_LOGIN.test(owner.login) || typeof item.full_name !== "string"
    || item.full_name.toLowerCase() !== `${owner.login}/${item.name}`.toLowerCase() || !["public", "private", "internal"].includes(String(item.visibility))
    || typeof item.default_branch !== "string" || !GITHUB_BRANCH.test(item.default_branch)) throw new GitHubRepositoryCatalogFailure("invalid-response");
  const canonicalOwner = owner.login.toLowerCase(); const canonicalName = item.name.toLowerCase();
  return { githubRepositoryId: item.id as number, installationId, owner: canonicalOwner, name: canonicalName,
    canonical: `github.com/${canonicalOwner}/${canonicalName}`, visibility: item.visibility as "public" | "private" | "internal", defaultBranch: item.default_branch };
}

function validTimestamp(value: string) {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}
