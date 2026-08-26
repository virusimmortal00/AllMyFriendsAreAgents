import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

export type GuardrailMode = "report" | "enforce";

export interface PlanningDocRecord {
  path: string;
  status?: string;
  issue?: number;
}

export interface IssueState {
  number: number;
  state: "OPEN" | "CLOSED";
}

export interface SyncViolation {
  path: string;
  reason: string;
}

const ALLOWED_STATUSES = new Set(["proposed", "active", "blocked", "done", "superseded"]);
const LIVE_STATUSES = new Set(["proposed", "active", "blocked"]);
const TRACKED_WITHOUT_ISSUE = new Set(["active", "blocked"]);
const CLOSING_KEYWORD = /\b(?:close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)(?:\s*:\s*|\s+)#(\d+)\b/gi;
const SKIP_FILES = new Set(["README.md", "TEMPLATE.md"]);

/**
 * Reads a YAML-ish planning-doc frontmatter block into status and issue fields.
 */
export function parsePlanningFrontmatter(contents: string): Pick<PlanningDocRecord, "status" | "issue"> {
  const match = contents.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const fields = new Map<string, string>();
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    fields.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  return {
    status: fields.get("status"),
    issue: parseIssueReference(fields.get("issue")),
  };
}

/**
 * Accepts `13`, `#13`, or a GitHub issue/PR URL and returns the issue number.
 */
export function parseIssueReference(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = value.match(/(?:issues|pull)\/(\d+)\b/) || value.match(/^#?(\d+)$/);
  const number = Number(match?.[1]);
  return Number.isInteger(number) && number > 0 ? number : undefined;
}

/**
 * Collects GitHub closing-keyword issue numbers from PR or commit text.
 */
export function extractClosingIssueNumbers(text: string): number[] {
  return [...new Set([...text.matchAll(CLOSING_KEYWORD)].map((match) => Number(match[1])))];
}

interface PullRequestPayload {
  title?: string;
  body?: string;
  commits?: Array<{ messageHeadline?: string; messageBody?: string }>;
  files?: Array<{ path?: string }>;
}

/** GitHub closing keywords apply to PR descriptions and commit messages, not PR titles. */
export function extractPullRequestClosingIssueNumbers(payload: PullRequestPayload): number[] {
  const commitText = (payload.commits ?? [])
    .map((commit) => `${commit.messageHeadline ?? ""}\n${commit.messageBody ?? ""}`)
    .join("\n");
  return extractClosingIssueNumbers(`${payload.body ?? ""}\n${commitText}`);
}

/**
 * Evaluates planning-doc / issue drift against the locked sync rules.
 */
export function evaluatePlanningDocSync(input: {
  documents: readonly PlanningDocRecord[];
  issueStates: ReadonlyMap<number, IssueState>;
  closingIssueNumbers: readonly number[];
  changedPaths: ReadonlySet<string>;
}): SyncViolation[] {
  const violations: SyncViolation[] = [];
  const documentsByIssue = new Map<number, PlanningDocRecord[]>();

  for (const document of input.documents) {
    if (!document.status || !ALLOWED_STATUSES.has(document.status)) {
      violations.push({ path: document.path, reason: `status must be one of ${[...ALLOWED_STATUSES].join(", ")}` });
      continue;
    }
    if (document.issue) {
      const existing = documentsByIssue.get(document.issue) ?? [];
      existing.push(document);
      documentsByIssue.set(document.issue, existing);
    }
    if (TRACKED_WITHOUT_ISSUE.has(document.status ?? "") && !document.issue) {
      violations.push({ path: document.path, reason: `status ${document.status} requires an issue: field` });
      continue;
    }
    if (!document.issue || !LIVE_STATUSES.has(document.status ?? "")) continue;
    const issue = input.issueStates.get(document.issue);
    if (!issue) {
      violations.push({ path: document.path, reason: `could not read issue #${document.issue}` });
      continue;
    }
    if (issue.state === "CLOSED") {
      violations.push({ path: document.path, reason: `status ${document.status} but issue #${document.issue} is closed` });
    }
  }

  for (const issueNumber of input.closingIssueNumbers) {
    const matches = documentsByIssue.get(issueNumber) ?? [];
    for (const document of matches) {
      if (!input.changedPaths.has(document.path)) {
        violations.push({
          path: document.path,
          reason: `PR closes #${issueNumber} but ${path.basename(document.path)} is unchanged`,
        });
        continue;
      }
      if (!LIVE_STATUSES.has(document.status ?? "")) continue;
      violations.push({
        path: document.path,
        reason: `PR closes #${issueNumber} but ${path.basename(document.path)} is still ${document.status}`,
      });
    }
  }

  return violations;
}

/**
 * Runs the built-in fixtures that fail if the sync rules regress.
 */
export function runSelfCheck(): string[] {
  const failures: string[] = [];
  const closingKeywordCases: Array<{ name: string; payload: PullRequestPayload; expected: number[] }> = [
    { name: "colon-separated closing keywords are recognized", payload: { body: "Closes: #24" }, expected: [24] },
    { name: "PR titles do not imply issue closure", payload: { title: "Closes #24", body: "No closing keyword here." }, expected: [] },
    { name: "commit messages can close issues", payload: { commits: [{ messageHeadline: "Fixes #25" }] }, expected: [25] },
  ];
  for (const testCase of closingKeywordCases) {
    const actual = extractPullRequestClosingIssueNumbers(testCase.payload);
    if (JSON.stringify(actual) !== JSON.stringify(testCase.expected)) {
      failures.push(`${testCase.name}: expected ${testCase.expected.join(",") || "none"}, got ${actual.join(",") || "none"}`);
    }
  }
  const cases: Array<{ name: string; expected: number; input: Parameters<typeof evaluatePlanningDocSync>[0] }> = [
    {
      name: "proposed notes without an issue stay allowed",
      expected: 0,
      input: { documents: [{ path: "a.md", status: "proposed" }], issueStates: new Map(), closingIssueNumbers: [], changedPaths: new Set() },
    },
    {
      name: "active work without an issue fails",
      expected: 1,
      input: { documents: [{ path: "a.md", status: "active" }], issueStates: new Map(), closingIssueNumbers: [], changedPaths: new Set() },
    },
    {
      name: "unknown statuses fail closed",
      expected: 1,
      input: { documents: [{ path: "a.md", status: "in-progress" }], issueStates: new Map(), closingIssueNumbers: [], changedPaths: new Set() },
    },
    {
      name: "active work with an open issue passes",
      expected: 0,
      input: {
        documents: [{ path: "a.md", status: "active", issue: 24 }],
        issueStates: new Map([[24, { number: 24, state: "OPEN" }]]),
        closingIssueNumbers: [],
        changedPaths: new Set(),
      },
    },
    {
      name: "live status with a closed issue fails",
      expected: 1,
      input: {
        documents: [{ path: "a.md", status: "proposed", issue: 13 }],
        issueStates: new Map([[13, { number: 13, state: "CLOSED" }]]),
        closingIssueNumbers: [],
        changedPaths: new Set(),
      },
    },
    {
      name: "superseded file with a closed issue passes",
      expected: 0,
      input: {
        documents: [{ path: "a.md", status: "superseded", issue: 13 }],
        issueStates: new Map([[13, { number: 13, state: "CLOSED" }]]),
        closingIssueNumbers: [13],
        changedPaths: new Set(["a.md"]),
      },
    },
    {
      name: "closing an issue without flipping its live file fails",
      expected: 1,
      input: {
        documents: [{ path: "compose.md", status: "proposed", issue: 13 }],
        issueStates: new Map([[13, { number: 13, state: "OPEN" }]]),
        closingIssueNumbers: [13],
        changedPaths: new Set(["compose.md"]),
      },
    },
    {
      name: "closing an issue requires changing its terminal planning record",
      expected: 1,
      input: {
        documents: [{ path: "compose.md", status: "done", issue: 13 }],
        issueStates: new Map([[13, { number: 13, state: "OPEN" }]]),
        closingIssueNumbers: [13],
        changedPaths: new Set(),
      },
    },
    {
      name: "closing an issue passes when its terminal planning record changed",
      expected: 0,
      input: {
        documents: [{ path: "compose.md", status: "done", issue: 13 }],
        issueStates: new Map([[13, { number: 13, state: "OPEN" }]]),
        closingIssueNumbers: [13],
        changedPaths: new Set(["compose.md"]),
      },
    },
  ];

  for (const testCase of cases) {
    const actual = evaluatePlanningDocSync(testCase.input).length;
    if (actual !== testCase.expected) failures.push(`${testCase.name}: expected ${testCase.expected} violations, got ${actual}`);
  }
  return failures;
}

/**
 * Resolves CLI flags of the form `--name` or `--name=value`.
 */
function option(name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = process.argv.find((argument) => argument.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

/**
 * Runs a command and returns stdout, throwing if the process fails.
 */
async function runCommand(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk as Buffer));
    child.stderr.on("data", (chunk) => stderr.push(chunk as Buffer));
    child.on("error", reject);
    child.on("close", (code) => {
      const output = Buffer.concat(stdout).toString("utf8");
      if (code === 0) return resolve(output);
      reject(new Error(`${command} ${args.join(" ")} exited ${code}: ${Buffer.concat(stderr).toString("utf8") || output}`));
    });
  });
}

/**
 * Loads every planning markdown file except the index and template.
 */
async function loadPlanningDocuments(planningDirectory: string): Promise<PlanningDocRecord[]> {
  const names = (await readdir(planningDirectory)).filter((name) => name.endsWith(".md") && !SKIP_FILES.has(name)).sort();
  return Promise.all(names.map(async (name) => {
    const filePath = path.join(planningDirectory, name);
    return { path: path.posix.join("docs/planning", name), ...parsePlanningFrontmatter(await readFile(filePath, "utf8")) };
  }));
}

/**
 * Reads issue open/closed state through `gh api` without writing anything.
 */
async function loadIssueStates(repo: string, issueNumbers: readonly number[]): Promise<Map<number, IssueState>> {
  const states = new Map<number, IssueState>();
  for (const issueNumber of [...new Set(issueNumbers)]) {
    const payload = JSON.parse(await runCommand("gh", ["api", `repos/${repo}/issues/${issueNumber}`, "--jq", "{number,state}"])) as { number: number; state: string };
    states.set(issueNumber, { number: payload.number, state: payload.state.toUpperCase() === "OPEN" ? "OPEN" : "CLOSED" });
  }
  return states;
}

/**
 * Collects closing keywords and changed paths when a PR number is known.
 */
async function loadPullRequestContext(repo: string, pullRequest: string | undefined): Promise<{
  closingIssueNumbers: number[];
  changedPaths: ReadonlySet<string>;
}> {
  if (!pullRequest) return { closingIssueNumbers: [], changedPaths: new Set() };
  const payload = JSON.parse(await runCommand("gh", [
    "pr", "view", pullRequest, "--repo", repo, "--json", "body,commits,files",
  ])) as PullRequestPayload;
  return {
    closingIssueNumbers: extractPullRequestClosingIssueNumbers(payload),
    changedPaths: new Set((payload.files ?? []).map((file) => file.path).filter((value): value is string => Boolean(value))),
  };
}

/**
 * Prints violations and exits according to report vs enforce mode.
 */
function reportViolations(violations: readonly SyncViolation[], mode: GuardrailMode): never {
  if (violations.length === 0) {
    process.stdout.write("Planning docs are in sync with GitHub Issues.\n");
    process.exit(0);
  }
  process.stdout.write(`Planning doc / issue drift (${violations.length}):\n`);
  for (const violation of violations) {
    process.stdout.write(`- ${path.basename(violation.path)}: ${violation.reason}\n`);
  }
  process.exit(mode === "enforce" ? 1 : 0);
}

/**
 * CLI entry: self-check fixtures, then evaluate the planning directory against GitHub.
 */
async function main() {
  if (process.argv.includes("--self-check")) {
    const failures = runSelfCheck();
    if (failures.length) {
      process.stderr.write(`Planning-doc guardrail self-check failed:\n${failures.map((line) => `- ${line}`).join("\n")}\n`);
      process.exit(1);
    }
    process.stdout.write("Planning-doc guardrail self-check passed.\n");
    process.exit(0);
  }

  const mode: GuardrailMode = option("mode") === "report" || process.env.PLANNING_DOC_GUARDRAIL_MODE === "report" ? "report" : "enforce";
  const repo = option("repo") || process.env.GITHUB_REPOSITORY || (await runCommand("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"])).trim();
  if (!repo) throw new Error("Pass --repo=owner/name or set GITHUB_REPOSITORY.");

  const planningDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../docs/planning");
  const documents = await loadPlanningDocuments(planningDirectory);
  const pullRequestContext = await loadPullRequestContext(repo, option("pr") || process.env.PR_NUMBER);
  const issueNumbers = [...new Set(documents.map((document) => document.issue).filter((value): value is number => Boolean(value)))];
  const issueStates = await loadIssueStates(repo, issueNumbers);
  reportViolations(evaluatePlanningDocSync({ documents, issueStates, ...pullRequestContext }), mode);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  void main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
    process.exit(1);
  });
}
