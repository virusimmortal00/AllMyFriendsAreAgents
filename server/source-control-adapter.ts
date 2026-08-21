import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

export const SOURCE_CONTROL_ADAPTER_REVISION = "source-control-readonly/v1" as const;

export const SOURCE_EVIDENCE_CAPABILITIES = ["SOURCE_PROVENANCE", "SOURCE_DIFF", "SOURCE_CHECKS"] as const;
export type SourceEvidenceCapability = (typeof SOURCE_EVIDENCE_CAPABILITIES)[number];

export type SourceBinding =
  | { readonly kind: "branch"; readonly repository: string; readonly branch: string; readonly base: string; readonly head: string }
  | { readonly kind: "worktree"; readonly repository: string; readonly worktree: string; readonly branch: string | null; readonly base: string; readonly head: string };

export interface GovernedSourceTarget {
  readonly targetId: string;
  readonly improvementId: string;
}

const issuedTargets = new WeakSet<object>();
const issuedBindings = new WeakSet<object>();

/** The governed executor is the sole target-issuing authority. */
export class GovernedSourceExecutor {
  createSourceTarget(input: { readonly targetId: string; readonly improvementId: string }): GovernedSourceTarget {
    if (!nonempty(input.targetId) || !nonempty(input.improvementId)) throw new Error("A governed source target requires target and improvement IDs");
    const target = deepFreeze({ targetId: input.targetId.trim(), improvementId: input.improvementId.trim() });
    issuedTargets.add(target);
    return target;
  }
}

export interface BoundSourceTarget {
  readonly target: GovernedSourceTarget;
  readonly repository: string;
  readonly worktree: string | null;
  readonly branch: string | null;
  readonly base: { readonly requested: string; readonly revision: string };
  readonly head: { readonly requested: string; readonly revision: string };
}

export interface SourceDiffEntry {
  readonly path: string;
  readonly previousPath: string | null;
  readonly status: "added" | "modified" | "deleted" | "renamed" | "copied" | "type_changed" | "unmerged" | "unknown";
  readonly additions: number | null;
  readonly deletions: number | null;
  readonly binary: boolean;
}

export interface SourceCheckResult {
  readonly name: string;
  readonly conclusion: "passed" | "failed";
  readonly summary: string;
}

export interface SourceSnapshot {
  readonly snapshotId: string;
  readonly targetId: string;
  readonly improvementId: string;
  readonly capturedAt: string;
  readonly adapterRevision: typeof SOURCE_CONTROL_ADAPTER_REVISION;
  readonly provenance: {
    readonly repository: string;
    readonly worktree: string | null;
    readonly branch: string | null;
    readonly base: BoundSourceTarget["base"];
    readonly head: BoundSourceTarget["head"];
  };
  readonly diff: readonly SourceDiffEntry[];
  readonly checks: readonly SourceCheckResult[];
}

export interface SourceEvidence {
  readonly snapshotId: string;
  readonly targetId: string;
  readonly improvementId: string;
  readonly capturedAt: string;
  readonly adapterRevision: typeof SOURCE_CONTROL_ADAPTER_REVISION;
  readonly provenance?: SourceSnapshot["provenance"];
  readonly diff?: SourceSnapshot["diff"];
  readonly checks?: SourceSnapshot["checks"];
}

export interface ReadonlySourceBackend {
  resolve(binding: SourceBinding): Promise<Omit<BoundSourceTarget, "target">>;
  capture(binding: BoundSourceTarget): Promise<{ readonly diff: readonly SourceDiffEntry[]; readonly checks: readonly SourceCheckResult[] }>;
}

export type SourceAdapterResult<T> =
  | { readonly kind: "ok"; readonly value: T }
  | { readonly kind: "missing_revision"; readonly revision: string }
  | { readonly kind: "rejected"; readonly reason: string };

/**
 * Deliberately exposes only bind/read operations. It cannot mint targets, run
 * caller-selected commands, or obtain commit/publication capabilities.
 */
export class ReadonlySourceControlAdapter {
  private readonly bindings = new Map<string, Promise<SourceAdapterResult<BoundSourceTarget>>>();
  private readonly snapshots = new Map<string, Promise<SourceAdapterResult<SourceSnapshot>>>();

  constructor(
    private readonly backend: ReadonlySourceBackend = new GitReadonlySourceBackend(),
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  bind(target: GovernedSourceTarget, binding: SourceBinding): Promise<SourceAdapterResult<BoundSourceTarget>> {
    if (!issuedTargets.has(target as object)) return Promise.resolve({ kind: "rejected", reason: "Source target was not issued by the governed executor" });
    const invalid = validateBinding(binding);
    if (invalid) return Promise.resolve({ kind: "rejected", reason: invalid });
    const key = `${target.targetId}\0${stableBindingKey(binding)}`;
    const existing = this.bindings.get(key);
    if (existing) return existing;
    const pending = this.backend.resolve(binding)
      .then((resolved) => {
        const value = deepFreeze({ target, ...resolved });
        issuedBindings.add(value);
        return { kind: "ok", value } as const;
      })
      .catch((error: unknown) => classifySourceError(error));
    this.bindings.set(key, pending);
    return pending;
  }

  readEvidence(input: {
    readonly item: { readonly canonicalId: string; readonly data?: unknown; readonly evidence?: unknown };
    readonly binding: BoundSourceTarget;
    readonly capabilities: readonly SourceEvidenceCapability[];
  }): Promise<SourceAdapterResult<SourceEvidence>> {
    if (!issuedTargets.has(input.binding.target as object)) return Promise.resolve({ kind: "rejected", reason: "Source target was not issued by the governed executor" });
    if (!issuedBindings.has(input.binding as object)) return Promise.resolve({ kind: "rejected", reason: "Source target was not bound by this read-only adapter" });
    if (input.item.canonicalId !== input.binding.target.improvementId) return Promise.resolve({ kind: "rejected", reason: "Source target is unrelated to this improvement item" });
    if (containsProhibitedRequest(input.item.data) || containsProhibitedRequest(input.item.evidence)) {
      return Promise.resolve({ kind: "rejected", reason: "Mutation, publication, target creation, and command requests are prohibited" });
    }
    if (!input.capabilities.every((capability) => SOURCE_EVIDENCE_CAPABILITIES.includes(capability))) {
      return Promise.resolve({ kind: "rejected", reason: "Unknown source evidence capability" });
    }
    return this.#snapshot(input.binding).then((result) => {
      if (result.kind !== "ok") return result;
      const snapshot = result.value;
      const allowed = new Set(input.capabilities);
      return { kind: "ok", value: deepFreeze({
        snapshotId: snapshot.snapshotId,
        targetId: snapshot.targetId,
        improvementId: snapshot.improvementId,
        capturedAt: snapshot.capturedAt,
        adapterRevision: snapshot.adapterRevision,
        ...(allowed.has("SOURCE_PROVENANCE") ? { provenance: snapshot.provenance } : {}),
        ...(allowed.has("SOURCE_DIFF") ? { diff: snapshot.diff } : {}),
        ...(allowed.has("SOURCE_CHECKS") ? { checks: snapshot.checks } : {}),
      }) } as const;
    });
  }

  #snapshot(binding: BoundSourceTarget): Promise<SourceAdapterResult<SourceSnapshot>> {
    const key = `${binding.target.targetId}\0${binding.repository}\0${binding.worktree ?? ""}\0${binding.base.revision}\0${binding.head.revision}`;
    const existing = this.snapshots.get(key);
    if (existing) return existing;
    const pending = this.backend.capture(binding).then(({ diff, checks }) => {
      const capturedAt = this.now();
      return { kind: "ok", value: deepFreeze({
        snapshotId: `${SOURCE_CONTROL_ADAPTER_REVISION}:${binding.base.revision}:${binding.head.revision}`,
        targetId: binding.target.targetId,
        improvementId: binding.target.improvementId,
        capturedAt,
        adapterRevision: SOURCE_CONTROL_ADAPTER_REVISION,
        provenance: {
          repository: binding.repository,
          worktree: binding.worktree,
          branch: binding.branch,
          base: binding.base,
          head: binding.head,
        },
        diff: [...diff],
        checks: [...checks],
      }) } as const;
    }).catch((error: unknown) => classifySourceError(error));
    this.snapshots.set(key, pending);
    return pending;
  }
}

const execFileAsync = promisify(execFile);

export class GitReadonlySourceBackend implements ReadonlySourceBackend {
  async resolve(binding: SourceBinding): Promise<Omit<BoundSourceTarget, "target">> {
    const requestedRoot = binding.kind === "worktree" ? binding.worktree : binding.repository;
    const root = await realpath(requestedRoot);
    const repository = await realpath(binding.repository);
    const [rootCommon, repositoryCommon] = await Promise.all([
      gitCommonDirectory(root),
      gitCommonDirectory(repository),
    ]);
    if (rootCommon !== repositoryCommon) throw new Error("Worktree does not belong to the governed repository");
    const base = await resolveRevision(root, binding.base);
    const head = await resolveRevision(root, binding.head);
    return deepFreeze({
      repository,
      worktree: binding.kind === "worktree" ? root : null,
      branch: binding.branch,
      base: { requested: binding.base, revision: base },
      head: { requested: binding.head, revision: head },
    });
  }

  async capture(binding: BoundSourceTarget) {
    const root = binding.worktree ?? binding.repository;
    const range = [binding.base.revision, binding.head.revision];
    const [names, numbers, check] = await Promise.all([
      git(root, ["diff", "--no-ext-diff", "--find-renames", "--name-status", "-z", ...range]),
      git(root, ["diff", "--no-ext-diff", "--numstat", "-z", ...range]),
      gitResult(root, ["diff", "--no-ext-diff", "--check", ...range]),
    ]);
    const diff = normalizeDiff(names, numbers);
    const checks: SourceCheckResult[] = [{
      name: "git-diff-check",
      conclusion: check.exitCode === 0 ? "passed" : "failed",
      summary: check.exitCode === 0 ? "No whitespace errors detected" : `${check.stdout.trim().split("\n").filter(Boolean).length} whitespace error(s) detected`,
    }];
    return deepFreeze({ diff, checks });
  }
}

async function resolveRevision(root: string, requested: string) {
  try {
    return (await git(root, ["rev-parse", "--verify", "--end-of-options", `${requested}^{commit}`])).trim();
  } catch {
    throw new MissingRevisionError(requested);
  }
}

async function gitCommonDirectory(root: string) {
  const common = (await git(root, ["rev-parse", "--git-common-dir"])).trim();
  return realpath(path.resolve(root, common));
}

async function git(root: string, args: readonly string[]) {
  const result = await gitResult(root, args);
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "Read-only git operation failed");
  return result.stdout;
}

async function gitResult(root: string, args: readonly string[]) {
  try {
    const result = await execFileAsync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", exitCode: typeof failure.code === "number" ? failure.code : 1 };
  }
}

class MissingRevisionError extends Error {
  constructor(readonly revision: string) { super(`Missing source revision: ${revision}`); }
}

function classifySourceError(error: unknown): SourceAdapterResult<never> {
  return error instanceof MissingRevisionError
    ? { kind: "missing_revision", revision: error.revision }
    : { kind: "rejected", reason: error instanceof Error ? error.message : "Read-only source operation failed" };
}

function validateBinding(binding: SourceBinding) {
  if (!binding || !["branch", "worktree"].includes(binding.kind)) return "A branch or worktree binding is required";
  if (!path.isAbsolute(binding.repository) || !nonempty(binding.base) || !nonempty(binding.head)) return "Repository and revisions must be explicit";
  if (binding.kind === "branch" && !nonempty(binding.branch)) return "Branch binding requires a branch";
  if (binding.kind === "worktree" && !path.isAbsolute(binding.worktree)) return "Worktree binding requires an absolute path";
  return null;
}

function stableBindingKey(binding: SourceBinding) {
  return JSON.stringify(binding.kind === "branch"
    ? [binding.kind, binding.repository, binding.branch, binding.base, binding.head]
    : [binding.kind, binding.repository, binding.worktree, binding.branch, binding.base, binding.head]);
}

function normalizeDiff(nameOutput: string, numberOutput: string): readonly SourceDiffEntry[] {
  const numbers = new Map<string, { additions: number | null; deletions: number | null; binary: boolean }>();
  const numberParts = numberOutput.split("\0").filter(Boolean);
  for (let index = 0; index < numberParts.length;) {
    const fields = numberParts[index++].split("\t");
    let diffPath = fields[2] ?? "";
    if (!diffPath && index < numberParts.length) diffPath = numberParts[index++];
    const additions = fields[0] === "-" ? null : Number(fields[0]);
    const deletions = fields[1] === "-" ? null : Number(fields[1]);
    numbers.set(diffPath, { additions, deletions, binary: additions === null || deletions === null });
  }
  const parts = nameOutput.split("\0").filter(Boolean);
  const entries: SourceDiffEntry[] = [];
  for (let index = 0; index < parts.length;) {
    const [rawStatus, inlinePath] = parts[index++].split("\t");
    const renamed = rawStatus.startsWith("R") || rawStatus.startsWith("C");
    const previousPath = renamed ? (inlinePath || parts[index++] || "") : null;
    const currentPath = renamed ? (parts[index++] || "") : (inlinePath || parts[index++] || "");
    const count = numbers.get(currentPath) ?? { additions: null, deletions: null, binary: false };
    entries.push({ path: currentPath, previousPath, status: normalizeStatus(rawStatus), ...count });
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

function normalizeStatus(status: string): SourceDiffEntry["status"] {
  if (status.startsWith("A")) return "added";
  if (status.startsWith("M")) return "modified";
  if (status.startsWith("D")) return "deleted";
  if (status.startsWith("R")) return "renamed";
  if (status.startsWith("C")) return "copied";
  if (status.startsWith("T")) return "type_changed";
  if (status.startsWith("U")) return "unmerged";
  return "unknown";
}

const PROHIBITED = new Set(["commit", "push", "merge", "deploy", "create_source_target", "create-source-target", "exec", "execute", "command", "shell"]);

function containsProhibitedRequest(value: unknown, key = ""): boolean {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.some((entry) => containsProhibitedRequest(entry, key));
  if (typeof value === "object") return Object.entries(value as Record<string, unknown>)
    .some(([childKey, child]) => containsProhibitedRequest(child, childKey));
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase().replaceAll(" ", "_");
  const requestKey = key.toLowerCase();
  if (requestKey === "command" && normalized.length > 0) return true;
  if (!["action", "operation", "request", "capability", "tool"].includes(requestKey)) return false;
  return PROHIBITED.has(normalized) || [...PROHIBITED].some((operation) => new RegExp(`(^|[^a-z])${operation.replaceAll("_", "[-_ ]")}([^a-z]|$)`).test(value.toLowerCase()));
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && !value.includes("\0");
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
