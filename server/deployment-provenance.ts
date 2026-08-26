import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 3_000;
const GIT_OUTPUT_LIMIT = 64 * 1024;
const SHA = /^[0-9a-f]{40,64}$/;
const EPOCH = /^deployment-v1:[0-9a-f]{64}$/;
const BRANCH_LIMIT = 240;

export type DeploymentReference =
  | { readonly kind: "branch"; readonly name: string }
  | { readonly kind: "detached" }
  | { readonly kind: "unavailable" };

export type DeploymentWorktreeState = "clean" | "dirty" | "unavailable";
export type DeploymentUnavailableReason = "git-unavailable" | "not-a-git-checkout" | "no-commit" | "inspection-failed";

export interface DeploymentProvenance {
  readonly schemaVersion: 1;
  readonly commitSha: string | null;
  readonly reference: DeploymentReference;
  readonly worktree: DeploymentWorktreeState;
  /** Stable for clean checkout identity; deliberately restart-scoped otherwise. */
  readonly epoch: string;
  readonly observedAt: string;
  readonly unavailableReason?: DeploymentUnavailableReason;
}

interface DerivationOptions {
  readonly gitCommand?: string;
  readonly now?: () => string;
  readonly nonce?: () => string;
}

function epoch(parts: readonly string[]) {
  return `deployment-v1:${createHash("sha256").update(parts.join("\0")).digest("hex")}`;
}

function safeBranch(value: string) {
  const branch = value.trim().replace(/[\u0000-\u001f\u007f]/g, "").slice(0, BRANCH_LIMIT);
  return branch || undefined;
}

function unavailableReason(error: unknown): DeploymentUnavailableReason {
  if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return "git-unavailable";
  const message = error instanceof Error ? error.message : "";
  if (/not a git repository/i.test(message)) return "not-a-git-checkout";
  if (/needed a single revision|unknown revision|ambiguous argument 'HEAD'/i.test(message)) return "no-commit";
  return "inspection-failed";
}

function unavailable(options: Required<Pick<DerivationOptions, "now" | "nonce">>, reason: DeploymentUnavailableReason): DeploymentProvenance {
  const observedAt = options.now();
  return {
    schemaVersion: 1,
    commitSha: null,
    reference: { kind: "unavailable" },
    worktree: "unavailable",
    epoch: epoch(["unavailable", reason, options.nonce()]),
    observedAt,
    unavailableReason: reason,
  };
}

export async function deriveDeploymentProvenance(projectPath: string, options: DerivationOptions = {}): Promise<DeploymentProvenance> {
  const gitCommand = options.gitCommand || "git";
  const resolved = { now: options.now || (() => new Date().toISOString()), nonce: options.nonce || randomUUID };
  const git = async (args: readonly string[]) => execFileAsync(gitCommand, ["-C", projectPath, ...args], {
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_OUTPUT_LIMIT,
    encoding: "utf8",
  });

  let commitSha: string;
  try {
    commitSha = (await git(["rev-parse", "--verify", "HEAD"])).stdout.trim().toLowerCase();
    if (!SHA.test(commitSha)) return unavailable(resolved, "no-commit");
  } catch (error) {
    return unavailable(resolved, unavailableReason(error));
  }

  let reference: DeploymentReference;
  try {
    const branch = safeBranch((await git(["symbolic-ref", "--quiet", "--short", "HEAD"])).stdout);
    if (!branch) return unavailable(resolved, "inspection-failed");
    reference = { kind: "branch", name: branch };
  } catch (error) {
    const exitCode = (error as { code?: unknown }).code;
    if (exitCode === 1) reference = { kind: "detached" };
    else return unavailable(resolved, unavailableReason(error));
  }

  let worktree: DeploymentWorktreeState;
  try {
    worktree = (await git(["status", "--porcelain=v1", "--untracked-files=normal"])).stdout.length ? "dirty" : "clean";
  } catch {
    worktree = "unavailable";
  }
  const observedAt = resolved.now();
  const referenceIdentity = reference.kind === "branch" ? `branch:${reference.name}` : reference.kind;
  const stable = worktree === "clean";
  return {
    schemaVersion: 1,
    commitSha,
    reference,
    worktree,
    epoch: epoch([commitSha, referenceIdentity, worktree, ...(stable ? [] : [resolved.nonce()])]),
    observedAt,
    ...(worktree === "unavailable" ? { unavailableReason: "inspection-failed" as const } : {}),
  };
}

export function normalizeDeploymentEpoch(value: unknown) {
  return typeof value === "string" && EPOCH.test(value) ? value : undefined;
}

export function normalizeDeploymentProvenance(value: unknown): DeploymentProvenance | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<DeploymentProvenance>;
  const epochValue = normalizeDeploymentEpoch(candidate.epoch);
  const observedAt = typeof candidate.observedAt === "string" && !Number.isNaN(Date.parse(candidate.observedAt)) ? candidate.observedAt : undefined;
  const commitSha = typeof candidate.commitSha === "string" && SHA.test(candidate.commitSha) ? candidate.commitSha : candidate.commitSha === null ? null : undefined;
  const reference = candidate.reference;
  const normalizedReference = reference?.kind === "detached" || reference?.kind === "unavailable"
    ? { kind: reference.kind } as DeploymentReference
    : reference?.kind === "branch" && safeBranch(reference.name)
      ? { kind: "branch" as const, name: safeBranch(reference.name)! }
      : undefined;
  if (candidate.schemaVersion !== 1 || !epochValue || !observedAt || commitSha === undefined || !normalizedReference) return undefined;
  if (candidate.worktree !== "clean" && candidate.worktree !== "dirty" && candidate.worktree !== "unavailable") return undefined;
  if ((commitSha === null) !== (normalizedReference.kind === "unavailable")) return undefined;
  const reason = candidate.unavailableReason;
  const validReason = reason === undefined || reason === "git-unavailable" || reason === "not-a-git-checkout" || reason === "no-commit" || reason === "inspection-failed";
  if (!validReason) return undefined;
  if (normalizedReference.kind === "unavailable" && (candidate.worktree !== "unavailable" || !reason)) return undefined;
  if (candidate.worktree === "unavailable" && !reason) return undefined;
  if (candidate.worktree !== "unavailable" && reason) return undefined;
  return { schemaVersion: 1, commitSha, reference: normalizedReference, worktree: candidate.worktree, epoch: epochValue, observedAt, ...(reason ? { unavailableReason: reason } : {}) };
}

export function deploymentPromptContext(provenance: DeploymentProvenance | undefined) {
  if (!provenance || provenance.commitSha === null) {
    return "- Commit: unavailable (do not guess a revision)\n- Checkout: unavailable\n- Worktree: unavailable";
  }
  const checkout = provenance.reference.kind === "branch" ? `branch ${provenance.reference.name}` : "detached HEAD";
  return `- Commit: ${provenance.commitSha}\n- Checkout: ${checkout}\n- Worktree: ${provenance.worktree}`;
}
