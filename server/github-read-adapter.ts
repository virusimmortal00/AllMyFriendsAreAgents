import { redactDiagnosticSecrets } from "../shared/diagnostic-redaction.js";
import type { GitHubHttpDiagnostic } from "../shared/github-http-diagnostic.js";

export const GITHUB_API_ORIGIN = "https://api.github.com";
export const GITHUB_READ_TIMEOUT_MS = 8_000;
export const GITHUB_READ_RETRY_BUDGET = 0;
export const GH_MAX_COLLECTION = 20;
export const GH_MAX_TITLE = 240;
export const GH_MAX_BODY = 1_000;
export const GH_MAX_LABEL = 80;
export const GH_MAX_ANNOTATION = 400;

export type GitHubEndpointFamily = "recent-pulls" | "recent-issues" | "recent-runs" | "pull-request" | "issue" | "check-runs";
export type GitHubReadQuery =
  | { readonly family: "recent-pulls" }
  | { readonly family: "recent-issues" }
  | { readonly family: "recent-runs" }
  | { readonly family: "pull-request"; readonly number: number }
  | { readonly family: "issue"; readonly number: number }
  | { readonly family: "check-runs"; readonly sha: string };

export interface GhPullRequest { readonly number: number; readonly title: string; readonly state: "open" | "closed"; readonly draft: boolean; readonly author: string; readonly updatedAt: string; readonly base: string; readonly head: string; readonly headSha: string; readonly merged: boolean; readonly body: string; readonly truncated: boolean }
export interface GhIssue { readonly number: number; readonly title: string; readonly state: "open" | "closed"; readonly author: string; readonly updatedAt: string; readonly labels: readonly string[]; readonly comments: number; readonly body: string; readonly truncated: boolean }
export interface GhCheck { readonly name: string; readonly status: "queued" | "in_progress" | "completed" | "unknown"; readonly conclusion: string | null; readonly updatedAt: string; readonly branch: string; readonly sha: string; readonly annotation: string; readonly truncated: boolean }
export interface GhRun { readonly name: string; readonly status: "queued" | "in_progress" | "completed" | "unknown"; readonly conclusion: string | null; readonly updatedAt: string; readonly branch: string; readonly sha: string }
export type GitHubSanitizedValue =
  | { readonly family: "recent-pulls"; readonly items: readonly GhPullRequest[]; readonly truncated: boolean }
  | { readonly family: "recent-issues"; readonly items: readonly GhIssue[]; readonly truncated: boolean }
  | { readonly family: "recent-runs"; readonly items: readonly GhRun[]; readonly truncated: boolean }
  | { readonly family: "pull-request"; readonly item: GhPullRequest }
  | { readonly family: "issue"; readonly item: GhIssue }
  | { readonly family: "check-runs"; readonly items: readonly GhCheck[]; readonly truncated: boolean };

export type GitHubFailureKind = "forbidden" | "not-found" | "rate-limited" | "timeout" | "invalid-response" | "upstream" | "saturated" | "configuration"
  | "room-not-found" | "general-room" | "project-not-found" | "connection-missing" | "connection-disabled" | "connection-unverified"
  | "connection-stale" | "connection-drift" | "credential-missing";
export class GitHubReadFailure extends Error {
  constructor(readonly kind: GitHubFailureKind, readonly statusClass: "none" | "4xx" | "5xx", readonly retryAfterMs: number | null = null, readonly endpointFamily: GitHubEndpointFamily | null = null, readonly http: GitHubHttpDiagnostic = {}) { super(`GitHub read failed (${kind}).`); this.name = "GitHubReadFailure"; }
}

export interface GitHubReadBinding { readonly owner: string; readonly repository: string; readonly defaultBranch: string; readonly token: string }
export interface GitHubReadFetch { (input: string | URL, init?: RequestInit): Promise<Response> }

function boundedText(value: unknown, max: number) {
  const sanitized = redactDiagnosticSecrets(typeof value === "string" ? value : "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return { value: sanitized.slice(0, max), truncated: sanitized.length > max };
}
function safeNumber(value: unknown) { return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0; }
function canonicalNumber(value: unknown) { return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : undefined; }
function iso(value: unknown) { const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN; return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date(0).toISOString(); }
function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function array(value: unknown) { return Array.isArray(value) ? value : []; }
function login(value: unknown) { return boundedText(object(value).login, 80).value || "unknown"; }
function state(value: unknown): "open" | "closed" { return value === "open" ? "open" : "closed"; }
function runStatus(value: unknown): GhRun["status"] { return value === "queued" || value === "in_progress" || value === "completed" ? value : "unknown"; }

function pull(value: unknown): GhPullRequest | undefined {
  const row = object(value); const number = canonicalNumber(row.number); if (!number) return undefined;
  const title = boundedText(row.title, GH_MAX_TITLE); const body = boundedText(row.body, GH_MAX_BODY);
  return { number, title: title.value || `Pull request #${number}`, state: state(row.state), draft: row.draft === true, author: login(row.user), updatedAt: iso(row.updated_at), base: boundedText(object(row.base).ref, GH_MAX_LABEL).value, head: boundedText(object(row.head).ref, GH_MAX_LABEL).value, headSha: boundedText(object(row.head).sha, 40).value, merged: row.merged === true || typeof row.merged_at === "string", body: body.value, truncated: title.truncated || body.truncated };
}
function issue(value: unknown): GhIssue | undefined {
  const row = object(value); const number = canonicalNumber(row.number); if (!number || row.pull_request) return undefined;
  const title = boundedText(row.title, GH_MAX_TITLE); const body = boundedText(row.body, GH_MAX_BODY); const labels = array(row.labels).slice(0, GH_MAX_COLLECTION).map((label) => boundedText(typeof label === "string" ? label : object(label).name, GH_MAX_LABEL).value).filter(Boolean);
  return { number, title: title.value || `Issue #${number}`, state: state(row.state), author: login(row.user), updatedAt: iso(row.updated_at), labels, comments: safeNumber(row.comments), body: body.value, truncated: title.truncated || body.truncated || array(row.labels).length > labels.length };
}
function run(value: unknown): GhRun { const row=object(value); return { name: boundedText(row.name,GH_MAX_TITLE).value || "workflow", status:runStatus(row.status), conclusion:typeof row.conclusion==="string"?boundedText(row.conclusion,GH_MAX_LABEL).value:null, updatedAt:iso(row.updated_at), branch:boundedText(row.head_branch,GH_MAX_LABEL).value, sha:boundedText(row.head_sha,40).value }; }
function check(value: unknown): GhCheck { const row=object(value);const annotation=boundedText([object(row.output).title,object(row.output).summary,object(row.output).text].filter((item)=>typeof item==="undefined"?false:true).join(" — "),GH_MAX_ANNOTATION);return { name:boundedText(row.name,GH_MAX_TITLE).value||"check",status:runStatus(row.status),conclusion:typeof row.conclusion==="string"?boundedText(row.conclusion,GH_MAX_LABEL).value:null,updatedAt:iso(row.completed_at||row.started_at),branch:"",sha:boundedText(row.head_sha,40).value,annotation:annotation.value,truncated:annotation.truncated }; }

function validateBinding(input: GitHubReadBinding) {
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(input.owner) || !/^[A-Za-z0-9_.-]{1,100}$/.test(input.repository) || !/^[A-Za-z0-9._/-]{1,200}$/.test(input.defaultBranch) || !input.token.trim()) throw new GitHubReadFailure("configuration", "none");
}

export class GitHubReadAdapter {
  readonly repositoryLabel: string;
  constructor(private readonly binding: GitHubReadBinding, private readonly fetcher: GitHubReadFetch = fetch) { validateBinding(binding); this.repositoryLabel = `${binding.owner}/${binding.repository}`; }

  normalizedQuery(query: GitHubReadQuery) {
    if ((query.family === "pull-request" || query.family === "issue") && (!Number.isSafeInteger(query.number) || query.number <= 0)) throw new GitHubReadFailure("configuration", "none");
    if (query.family === "check-runs" && !/^[0-9a-f]{40}$/i.test(query.sha)) throw new GitHubReadFailure("configuration", "none");
    return query.family === "check-runs" ? `sha=${query.sha.toLowerCase()}` : "number" in query ? `number=${query.number}` : query.family === "recent-runs" ? `branch=${this.binding.defaultBranch}` : "default";
  }

  private endpoint(query: GitHubReadQuery) {
    const root = `/repos/${encodeURIComponent(this.binding.owner)}/${encodeURIComponent(this.binding.repository)}`;
    if (query.family === "recent-pulls") return `${root}/pulls?state=all&sort=updated&direction=desc&per_page=9`;
    if (query.family === "recent-issues") return `${root}/issues?state=all&sort=updated&direction=desc&per_page=100`;
    if (query.family === "recent-runs") return `${root}/actions/runs?branch=${encodeURIComponent(this.binding.defaultBranch)}&per_page=9`;
    if (query.family === "pull-request") return `${root}/pulls/${query.number}`;
    if (query.family === "issue") return `${root}/issues/${query.number}`;
    return `${root}/commits/${query.sha.toLowerCase()}/check-runs?per_page=21`;
  }

  async read(query: GitHubReadQuery): Promise<GitHubSanitizedValue> {
    this.normalizedQuery(query);
    const url = new URL(this.endpoint(query), GITHUB_API_ORIGIN);
    if (url.origin !== GITHUB_API_ORIGIN || url.protocol !== "https:") throw new GitHubReadFailure("configuration", "none");
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), GITHUB_READ_TIMEOUT_MS); timer.unref();
    let response: Response;
    try { response = await this.fetcher(url, { method:"GET", redirect:"error", body:undefined, signal:controller.signal, headers:{ Accept:"application/vnd.github+json", Authorization:`Bearer ${this.binding.token}`, "X-GitHub-Api-Version":"2022-11-28", "User-Agent":"all-my-friends-are-agents-read" } }); }
    catch (error) { throw new GitHubReadFailure(error instanceof DOMException && error.name === "AbortError" ? "timeout" : "upstream", "none"); }
    finally { clearTimeout(timer); }
    const requestId = response.headers.get("x-github-request-id");
    const http: GitHubHttpDiagnostic = { httpStatus: response.status,
      ...(requestId && /^[A-Fa-f0-9:]{1,100}$/.test(requestId) && !requestId.includes(this.binding.token) ? { githubRequestId: requestId } : {}) };
    const failure = (kind: GitHubFailureKind, statusClass: "none" | "4xx" | "5xx", retryAfterMs: number | null = null) =>
      new GitHubReadFailure(kind, statusClass, retryAfterMs, query.family, http);
    if (!response.ok) {
      const statusClass = response.status >= 500 ? "5xx" : "4xx";
      if (response.status === 404) throw failure("not-found", statusClass);
      if (response.status === 429 || response.status === 403 && (response.headers.get("retry-after") || response.headers.get("x-ratelimit-remaining") === "0")) throw failure("rate-limited", statusClass, Math.min(60_000, Math.max(0, Number(response.headers.get("retry-after") || 0) * 1_000)) || null);
      if (response.status === 403) throw failure("forbidden", statusClass);
      throw failure("upstream", statusClass);
    }
    let payload: unknown;
    try { payload = await response.json(); } catch { throw failure("invalid-response", "none"); }
    try{payload=JSON.parse(JSON.stringify(payload).replaceAll(this.binding.token,"[REDACTED]"));}catch{throw failure("invalid-response","none");}
    if (query.family === "recent-pulls") { const source=array(payload);const items=source.map(pull).filter((item):item is GhPullRequest=>Boolean(item)).slice(0,8);return {family:query.family,items,truncated:source.length>items.length}; }
    if (query.family === "recent-issues") { const source=array(payload);const valid=source.map(issue).filter((item):item is GhIssue=>Boolean(item));return {family:query.family,items:valid.slice(0,8),truncated:valid.length>8||source.length>=100}; }
    if (query.family === "recent-runs") { const source=array(object(payload).workflow_runs);return {family:query.family,items:source.slice(0,8).map(run),truncated:source.length>8}; }
    if (query.family === "pull-request") { const item=pull(payload);if(!item)throw failure("invalid-response","none");return {family:query.family,item}; }
    if (query.family === "issue") { const item=issue(payload);if(!item)throw failure("invalid-response","none");return {family:query.family,item}; }
    const source=array(object(payload).check_runs);return {family:query.family,items:source.slice(0,GH_MAX_COLLECTION).map(check),truncated:source.length>GH_MAX_COLLECTION};
  }
}
