import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";

export const OPENCODE_CONTRACT_PATH = "integration-contracts/opencode.json";

export interface IntegrationSurface {
  readonly id: string;
  readonly description: string;
  readonly local: readonly string[];
  readonly upstream: readonly string[];
  readonly tests: readonly string[];
}

export interface OpenCodeIntegrationContract {
  readonly schemaVersion: 1;
  readonly integration: "opencode";
  readonly upstream: {
    readonly repository: string;
    readonly minimumVersion: string;
    readonly auditedVersion: string;
    readonly auditedTag: string;
    readonly auditedCommit: string;
  };
  readonly review: {
    readonly revision: number;
    readonly reviewedOn: string;
    readonly result: string;
    readonly paths: readonly string[];
  };
  readonly surfaces: readonly IntegrationSurface[];
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && item.length > 0);
}

export function parseContract(text: string): OpenCodeIntegrationContract {
  const value = JSON.parse(text) as Partial<OpenCodeIntegrationContract>;
  if (value.schemaVersion !== 1 || value.integration !== "opencode") throw new Error("The OpenCode integration contract has an unsupported identity or schema version.");
  if (!value.upstream || !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/.test(value.upstream.repository)) throw new Error("The OpenCode contract requires a public GitHub upstream repository.");
  if (!/^\d+\.\d+\.\d+$/.test(value.upstream.minimumVersion)
    || !/^\d+\.\d+\.\d+$/.test(value.upstream.auditedVersion)
    || value.upstream.auditedTag !== `v${value.upstream.auditedVersion}`
    || !/^[0-9a-f]{40}$/.test(value.upstream.auditedCommit)) throw new Error("The OpenCode contract has invalid version or immutable-commit evidence.");
  if (!value.review || !Number.isSafeInteger(value.review.revision) || value.review.revision < 1
    || !/^\d{4}-\d{2}-\d{2}$/.test(value.review.reviewedOn)
    || typeof value.review.result !== "string" || value.review.result.length < 40
    || !isStringArray(value.review.paths)) throw new Error("The OpenCode contract requires a substantive, versioned review record.");
  if (!Array.isArray(value.surfaces) || !value.surfaces.length) throw new Error("The OpenCode contract must declare at least one integration surface.");
  const ids = new Set<string>();
  for (const surface of value.surfaces) {
    if (!surface || typeof surface.id !== "string" || !surface.id || ids.has(surface.id)
      || typeof surface.description !== "string" || surface.description.length < 20
      || !isStringArray(surface.local) || !isStringArray(surface.upstream) || !isStringArray(surface.tests)) throw new Error("Every OpenCode integration surface requires a unique ID, description, local paths, upstream paths, and tests.");
    ids.add(surface.id);
  }
  return value as OpenCodeIntegrationContract;
}

export function pathMatches(pattern: string, file: string) {
  if (pattern.endsWith("/**")) return file.startsWith(pattern.slice(0, -3));
  return pattern === file;
}

export function affectedSurfaces(contract: OpenCodeIntegrationContract, changedFiles: readonly string[]) {
  return contract.surfaces.filter((surface) => surface.local.some((pattern) => changedFiles.some((file) => pathMatches(pattern, file))));
}

export function requiredUpstreamPaths(surfaces: readonly IntegrationSurface[]) {
  return [...new Set(surfaces.flatMap((surface) => surface.upstream))].sort();
}

export function validateReview(contract: OpenCodeIntegrationContract, surfaces: readonly IntegrationSurface[], baseRevision = 0) {
  const errors: string[] = [];
  if (contract.review.revision <= baseRevision) errors.push(`increment review.revision above ${baseRevision}`);
  const recorded = new Set(contract.review.paths);
  for (const path of requiredUpstreamPaths(surfaces)) if (!recorded.has(path)) errors.push(`record upstream review path ${path}`);
  return errors;
}

export function validatePullRequestEvidence(contract: OpenCodeIntegrationContract, surfaces: readonly IntegrationSurface[], body: string) {
  const errors: string[] = [];
  if (!body.includes("## OpenCode upstream review")) errors.push("add the OpenCode upstream review section to the pull request body");
  if (!body.includes(contract.upstream.auditedTag)) errors.push(`record audited tag ${contract.upstream.auditedTag} in the pull request body`);
  if (!body.includes(contract.upstream.auditedCommit)) errors.push(`record audited commit ${contract.upstream.auditedCommit} in the pull request body`);
  for (const surface of surfaces) if (!body.includes(surface.id)) errors.push(`record affected surface ${surface.id} in the pull request body`);
  if (!/^Result:\s+\S.{30,}$/m.test(body)) errors.push("add a substantive Result: line to the OpenCode upstream review section");
  return errors;
}

export function validateLocalPins(contract: OpenCodeIntegrationContract, input: { packageText: string; tsconfigText: string; workspaceText: string; discoveryText: string }) {
  const errors: string[] = [];
  const packageJson = JSON.parse(input.packageText) as { devDependencies?: Record<string, string> };
  if (packageJson.devDependencies?.["@opencode-ai/plugin"] !== contract.upstream.auditedVersion) errors.push(`pin @opencode-ai/plugin to ${contract.upstream.auditedVersion}`);
  const tsconfig = JSON.parse(input.tsconfigText) as { include?: string[]; exclude?: string[] };
  if (!tsconfig.include?.includes("server/**/*.ts") || tsconfig.exclude?.some((path) => path.includes("server/agent-tools"))) errors.push("keep server/agent-tools inside the server TypeScript build");
  if (!input.workspaceText.includes("msgpackr-extract: false")) errors.push("keep the optional msgpackr-extract install script disabled");
  for (const packageName of ["@opencode-ai/plugin", "@opencode-ai/sdk"]) {
    if (!input.workspaceText.includes(`'${packageName}@${contract.upstream.auditedVersion}'`)) errors.push(`retain the audited minimum-release-age exception for ${packageName}@${contract.upstream.auditedVersion}`);
  }
  if (!input.discoveryText.includes(`MINIMUM_OPENCODE_VERSION = "${contract.upstream.minimumVersion}"`)) errors.push("synchronize the minimum runtime version with the integration contract");
  if (!input.discoveryText.includes(`MAXIMUM_AUDITED_OPENCODE_VERSION = "${contract.upstream.auditedVersion}"`)) errors.push("synchronize the maximum audited runtime version with the integration contract");
  return errors;
}

function git(args: readonly string[], fallback = "") {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return fallback;
  }
}

function lines(value: string) {
  return value.split("\n").map((line) => line.trim()).filter(Boolean);
}

function option(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function resolveBase() {
  const explicit = option("--base") || process.env.INTEGRATION_CONTRACT_BASE_SHA;
  if (explicit && !/^0+$/.test(explicit)) {
    const resolved = git(["rev-parse", "--verify", `${explicit}^{commit}`]);
    if (!resolved) throw new Error(`Integration-contract base revision is unavailable: ${explicit}`);
    return resolved;
  }
  return git(["rev-parse", "--verify", "origin/main^{commit}"])
    || git(["rev-parse", "--verify", "HEAD^"]);
}

function changedFiles(base: string, head: string) {
  const committed = base && base !== head ? lines(git(["diff", "--name-only", `${base}...${head}`])) : [];
  const working = lines(git(["diff", "--name-only", "HEAD"]));
  const untracked = lines(git(["ls-files", "--others", "--exclude-standard"]));
  return [...new Set([...committed, ...working, ...untracked])].sort();
}

function baseReviewRevision(base: string) {
  if (!base) return 0;
  const text = git(["show", `${base}:${OPENCODE_CONTRACT_PATH}`]);
  if (!text) return 0;
  return parseContract(text).review.revision;
}

async function verifyUpstream(contract: OpenCodeIntegrationContract, paths: readonly string[]) {
  const refs = lines(execFileSync("git", ["ls-remote", "--tags", contract.upstream.repository, contract.upstream.auditedTag, `${contract.upstream.auditedTag}^{}`], { encoding: "utf8" }));
  if (!refs.some((line) => line.startsWith(`${contract.upstream.auditedCommit}\t`))) throw new Error(`OpenCode tag ${contract.upstream.auditedTag} does not resolve to ${contract.upstream.auditedCommit}.`);
  const repository = new URL(contract.upstream.repository);
  const [owner, nameWithGit] = repository.pathname.slice(1).split("/");
  const name = nameWithGit.replace(/\.git$/, "");
  for (const path of paths) {
    const url = `https://raw.githubusercontent.com/${owner}/${name}/${contract.upstream.auditedCommit}/${path}`;
    const response = await fetch(url, { method: "HEAD" });
    if (!response.ok) throw new Error(`Recorded OpenCode source path is unavailable at the audited commit: ${path}`);
  }
}

function runFocusedTests(surfaces: readonly IntegrationSurface[]) {
  const tests = [...new Set(surfaces.flatMap((surface) => surface.tests))].sort();
  if (!tests.length) return;
  execFileSync("pnpm", ["exec", "vitest", "run", ...tests], { stdio: "inherit" });
}

async function main() {
  const contract = parseContract(readFileSync(OPENCODE_CONTRACT_PATH, "utf8"));
  const pinErrors = validateLocalPins(contract, {
    packageText: readFileSync("package.json", "utf8"),
    tsconfigText: readFileSync("tsconfig.node.json", "utf8"),
    workspaceText: readFileSync("pnpm-workspace.yaml", "utf8"),
    discoveryText: readFileSync("server/model-discovery.ts", "utf8"),
  });
  if (pinErrors.length) throw new Error(`OpenCode local pins are inconsistent:\n- ${pinErrors.join("\n- ")}`);
  const all = process.argv.includes("--all");
  const base = resolveBase();
  const head = option("--head") || process.env.INTEGRATION_CONTRACT_HEAD_SHA || git(["rev-parse", "HEAD"]);
  const requestedFiles = (option("--inspect-files") || "").split(",").map((file) => file.trim()).filter(Boolean);
  const inspectOnly = requestedFiles.length > 0;
  const changed = [...new Set([...changedFiles(base, head), ...requestedFiles])].sort();
  const mappedSurfaces = affectedSurfaces(contract, changed);
  const surfaces = (all || (!mappedSurfaces.length && changed.includes(OPENCODE_CONTRACT_PATH))) ? [...contract.surfaces] : mappedSurfaces;
  if (!surfaces.length) {
    console.log("OpenCode integration contract: no mapped surfaces changed.");
    return;
  }

  console.log(`OpenCode integration contract: ${surfaces.map((surface) => surface.id).join(", ")}`);
  for (const surface of surfaces) {
    console.log(`\n${surface.id}: ${surface.description}`);
    console.log(`Upstream:\n${surface.upstream.map((path) => `  - ${path}`).join("\n")}`);
    console.log(`Tests:\n${surface.tests.map((path) => `  - ${path}`).join("\n")}`);
  }

  if (!all && !inspectOnly) {
    const errors = validateReview(contract, surfaces, baseReviewRevision(base));
    if (!changed.includes(OPENCODE_CONTRACT_PATH)) errors.unshift(`change ${OPENCODE_CONTRACT_PATH} with the source-review evidence`);
    if (process.env.INTEGRATION_CONTRACT_REQUIRE_REVIEW === "true") errors.push(...validatePullRequestEvidence(contract, surfaces, process.env.INTEGRATION_CONTRACT_PR_BODY || ""));
    if (errors.length) throw new Error(`OpenCode upstream review is incomplete:\n- ${errors.join("\n- ")}`);
  }

  const paths = requiredUpstreamPaths(surfaces);
  if (all || process.argv.includes("--verify-upstream")) await verifyUpstream(contract, paths);
  if (process.argv.includes("--run-tests") && !inspectOnly) runFocusedTests(surfaces);
}

if (process.argv[1]?.endsWith("check-integration-contracts.ts")) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
