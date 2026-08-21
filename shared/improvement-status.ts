export const IMPROVEMENT_STATUS_SCHEMA_VERSION = 1 as const;

export type UnresolvedStatus =
  | { readonly state: "UNKNOWN" }
  | { readonly state: "PENDING" }
  | { readonly state: "NOT_APPLICABLE" };

export interface StatusEvidenceReference {
  readonly id: string;
  readonly uri: string;
}

export interface CodeLocation {
  /** Immutable commit or content-addressed revision. Never a deployment identifier. */
  readonly immutableRevision: string;
  readonly repository: string;
  readonly branch: string | null;
  readonly worktree: string | null;
}

export type ImplementationStatus = UnresolvedStatus | {
  readonly state: "IMPLEMENTED";
  readonly codeLocation: CodeLocation;
};

export type DeploymentStatus = UnresolvedStatus | {
  readonly state: "DEPLOYED";
  readonly generation: string;
  readonly environment: string;
};

export type DeveloperTeamEvidenceStatus = UnresolvedStatus | {
  readonly state: "AVAILABLE";
  readonly evidence: readonly StatusEvidenceReference[];
};

export type IndependentAcceptanceStatus = UnresolvedStatus | {
  readonly state: "ACCEPTED" | "REJECTED";
  readonly assessedBy: string;
  readonly assessedAt: string;
  readonly evidence: readonly StatusEvidenceReference[];
};

export type UpstreamPublicationStatus = UnresolvedStatus | {
  readonly state: "PUBLISHED";
  readonly revision: string;
  readonly location: string;
};

export type NextActionStatus = UnresolvedStatus
  | { readonly state: "ACTION_REQUIRED"; readonly action: string }
  | { readonly state: "BLOCKED"; readonly blocker: string };

/**
 * Versioned six-field delivery status. Each field is authoritative only for its
 * own concern; consumers must not derive one field from another.
 */
export interface ImprovementStatusContract {
  readonly schemaVersion: typeof IMPROVEMENT_STATUS_SCHEMA_VERSION;
  readonly implementation: ImplementationStatus;
  readonly deployment: DeploymentStatus;
  readonly developerTeamEvidence: DeveloperTeamEvidenceStatus;
  readonly independentAcceptance: IndependentAcceptanceStatus;
  readonly upstreamPublication: UpstreamPublicationStatus;
  readonly nextAction: NextActionStatus;
}

export type ImprovementStatusField = Exclude<keyof ImprovementStatusContract, "schemaVersion">;

export type ImprovementStatusTransition = {
  readonly [Field in ImprovementStatusField]: {
    readonly field: Field;
    readonly value: ImprovementStatusContract[Field];
  }
}[ImprovementStatusField];

export function emptyImprovementStatus(): ImprovementStatusContract {
  return {
    schemaVersion: IMPROVEMENT_STATUS_SCHEMA_VERSION,
    implementation: { state: "UNKNOWN" },
    deployment: { state: "UNKNOWN" },
    developerTeamEvidence: { state: "UNKNOWN" },
    independentAcceptance: { state: "UNKNOWN" },
    upstreamPublication: { state: "UNKNOWN" },
    nextAction: { state: "UNKNOWN" },
  };
}

export function applyImprovementStatusTransition(
  current: ImprovementStatusContract,
  transition: ImprovementStatusTransition,
): ImprovementStatusContract {
  const currentError = validateImprovementStatus(current);
  if (currentError) throw new Error(`Invalid current status contract: ${currentError}`);
  if (!STATUS_FIELDS.includes(transition.field)) throw new Error("Unknown status field");

  const candidate = { ...current, [transition.field]: transition.value };
  const error = validateImprovementStatus(candidate);
  if (error) throw new Error(error);
  return candidate;
}

export function serializeImprovementStatus(status: ImprovementStatusContract): string {
  const error = validateImprovementStatus(status);
  if (error) throw new Error(error);
  return JSON.stringify(status);
}

export function parseImprovementStatus(serialized: string): ImprovementStatusContract {
  const value: unknown = JSON.parse(serialized);
  const error = validateImprovementStatus(value);
  if (error) throw new Error(error);
  return value as ImprovementStatusContract;
}

export function validateImprovementStatus(value: unknown): string | null {
  if (!isRecord(value)) return "Status contract must be an object";
  if (value.schemaVersion !== IMPROVEMENT_STATUS_SCHEMA_VERSION) return "Unsupported status contract schema version";
  if (!hasExactKeys(value, ["schemaVersion", ...STATUS_FIELDS])) return "Status contract contains missing or conflated fields";

  return validateImplementation(value.implementation)
    ?? validateDeployment(value.deployment)
    ?? validateEvidence(value.developerTeamEvidence)
    ?? validateAcceptance(value.independentAcceptance)
    ?? validatePublication(value.upstreamPublication)
    ?? validateNextAction(value.nextAction);
}

const STATUS_FIELDS = [
  "implementation",
  "deployment",
  "developerTeamEvidence",
  "independentAcceptance",
  "upstreamPublication",
  "nextAction",
] as const;

const UNRESOLVED_STATES = ["UNKNOWN", "PENDING", "NOT_APPLICABLE"] as const;

function validateImplementation(value: unknown): string | null {
  if (isUnresolved(value)) return null;
  if (!isRecord(value) || value.state !== "IMPLEMENTED" || !hasExactKeys(value, ["state", "codeLocation"])) {
    return "Implementation must be unresolved or contain only an implemented code location";
  }
  const location = value.codeLocation;
  if (!isRecord(location) || !hasExactKeys(location, ["immutableRevision", "repository", "branch", "worktree"])) {
    return "Code location must identify revision, repository, branch, and worktree context";
  }
  if (!nonempty(location.immutableRevision) || !nonempty(location.repository)) return "Code revision and repository are required";
  if (!nullableNonempty(location.branch) || !nullableNonempty(location.worktree)) return "Branch and worktree must be non-empty strings or null";
  return null;
}

function validateDeployment(value: unknown): string | null {
  if (isUnresolved(value)) return null;
  if (!isRecord(value) || value.state !== "DEPLOYED" || !hasExactKeys(value, ["state", "generation", "environment"])) {
    return "Deployment must be unresolved or contain only generation and environment";
  }
  return nonempty(value.generation) && nonempty(value.environment) ? null : "Deployment generation and environment are required";
}

function validateEvidence(value: unknown): string | null {
  if (isUnresolved(value)) return null;
  if (!isRecord(value) || value.state !== "AVAILABLE" || !hasExactKeys(value, ["state", "evidence"])) {
    return "Developer Team evidence must be unresolved or contain only evidence references";
  }
  return validEvidenceList(value.evidence) ? null : "Developer Team evidence requires at least one valid reference";
}

function validateAcceptance(value: unknown): string | null {
  if (isUnresolved(value)) return null;
  if (!isRecord(value) || !["ACCEPTED", "REJECTED"].includes(String(value.state))
    || !hasExactKeys(value, ["state", "assessedBy", "assessedAt", "evidence"])) {
    return "Independent acceptance must be unresolved or contain an explicit assessment";
  }
  if (!nonempty(value.assessedBy) || !validIsoDate(value.assessedAt) || !validEvidenceList(value.evidence)) {
    return "Independent acceptance requires assessor, timestamp, and evidence";
  }
  return null;
}

function validatePublication(value: unknown): string | null {
  if (isUnresolved(value)) return null;
  if (!isRecord(value) || value.state !== "PUBLISHED" || !hasExactKeys(value, ["state", "revision", "location"])) {
    return "Publication must be unresolved or contain only upstream revision and location";
  }
  return nonempty(value.revision) && nonempty(value.location) ? null : "Publication revision and location are required";
}

function validateNextAction(value: unknown): string | null {
  if (isUnresolved(value)) return null;
  if (!isRecord(value)) return "Next action must be an object";
  if (value.state === "ACTION_REQUIRED" && hasExactKeys(value, ["state", "action"]) && nonempty(value.action)) return null;
  if (value.state === "BLOCKED" && hasExactKeys(value, ["state", "blocker"]) && nonempty(value.blocker)) return null;
  return "Next action must be unresolved, actionable, or blocked with an explicit reason";
}

function isUnresolved(value: unknown): boolean {
  return isRecord(value) && UNRESOLVED_STATES.includes(value.state as typeof UNRESOLVED_STATES[number]) && hasExactKeys(value, ["state"]);
}

function validEvidenceList(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0 && value.every((item) =>
    isRecord(item) && hasExactKeys(item, ["id", "uri"]) && nonempty(item.id) && nonempty(item.uri));
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim());
}

function nullableNonempty(value: unknown): boolean {
  return value === null || nonempty(value);
}

function validIsoDate(value: unknown): boolean {
  return nonempty(value) && Number.isFinite(Date.parse(value));
}
