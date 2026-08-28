import { createHash, randomUUID } from "node:crypto";

export const IDENTITY_SCHEMA_VERSION = 1 as const;
export const IDENTITY_MIGRATION_VERSION = "durable-identities/v1" as const;

export type DurableIdentityKind = "server" | "project" | "room" | "repository-reference";
export type SourceWorkKind = "assignment" | "continuation" | "investigation" | "contribution" | "github-broker" | "command-delivery" | "pov-delivery";
export type SourceWorkReconciliationState = "bound" | "needs-reconciliation" | "terminal-history";

export interface DurableServerRecord {
  readonly schemaVersion: 1;
  readonly serverId: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DurableProjectRecord {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly serverId: string;
  readonly revision: number;
  readonly name: string;
  readonly repositoryCapacity: 0 | 1;
  readonly repositoryReferenceId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DurableRoomRecord {
  readonly schemaVersion: 1;
  readonly roomId: string;
  readonly serverId: string;
  readonly revision: number;
  readonly projectId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A migrated reference is intentionally not a verified repository connection.
 * #82 is the only issue allowed to verify/onboard it or attach credentials. */
export interface RepositoryReferenceRecord {
  readonly schemaVersion: 1;
  readonly repositoryReferenceId: string;
  readonly projectId: string;
  readonly revision: number;
  readonly state: "unverified-legacy-placeholder";
  readonly localPath: string;
  readonly sanitizedRemoteIdentity: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SourceWorkBinding {
  readonly schemaVersion: 1;
  readonly kind: SourceWorkKind;
  readonly workId: string;
  readonly roomId: string;
  readonly projectId: string | null;
  readonly repositoryReferenceId: string | null;
  readonly repositoryReferenceRevision: number | null;
  readonly originTaskId: string | null;
  readonly originTaskRevision: number | null;
  readonly implementationJobId: string | null;
  readonly implementationWorkerId: string | null;
  readonly state: SourceWorkReconciliationState;
  readonly reasonCode: string | null;
  /** Server-only evidence. Never include this object in browser or model projections. */
  readonly evidence: Readonly<Record<string, string | number | boolean | null>>;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface IdentityMigrationEvidence {
  readonly schemaVersion: 1;
  readonly migrationVersion: typeof IDENTITY_MIGRATION_VERSION;
  readonly sourceKind: "sqlite-in-place" | "json-import";
  readonly sourceDigest: string;
  readonly counts: Readonly<Record<string, number>>;
  readonly identityDigest: string;
  readonly backupPath: string | null;
  readonly completedAt: string;
}

export interface StorageScope {
  readonly schemaVersion: 1;
  readonly serverId: string;
  readonly roomId: string;
  readonly projectId: string | null;
  readonly repositoryReferenceId: string | null;
  readonly repositoryReferenceRevision: number | null;
}

export interface IdentityRepository {
  getStorageScope(roomId: string): Promise<StorageScope | undefined>;
  getDurableServer(): Promise<DurableServerRecord>;
  getDurableRoom(roomId: string): Promise<DurableRoomRecord | undefined>;
  getDurableProject(projectId: string): Promise<DurableProjectRecord | undefined>;
  getRepositoryReference(repositoryReferenceId: string): Promise<RepositoryReferenceRecord | undefined>;
  getSourceWorkBinding(kind: SourceWorkKind, workId: string): Promise<SourceWorkBinding | undefined>;
  putSourceWorkBinding(binding: SourceWorkBinding): Promise<void>;
  identityMigrationEvidence(): Promise<IdentityMigrationEvidence | undefined>;
}

export function newDurableId() { return randomUUID(); }
export function identityDigest(value: unknown) { return createHash("sha256").update(canonicalJson(value)).digest("hex"); }

export function boundedReconciliationReason(value: string) {
  return value.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase().slice(0, 120) || "unresolved-provenance";
}

export function sourceWorkBindingAllowsAuthority(binding: SourceWorkBinding | undefined) {
  return Boolean(binding && binding.state === "bound" && binding.projectId && binding.repositoryReferenceId
    && binding.repositoryReferenceRevision && binding.implementationJobId && binding.implementationWorkerId);
}

export function sourceWorkAuthorityReason(binding: SourceWorkBinding | undefined) {
  if (!binding) return "source-work-binding-missing";
  if (binding.state === "terminal-history") return "source-work-terminal-history";
  if (binding.state === "needs-reconciliation") return binding.reasonCode || "source-work-needs-reconciliation";
  if (!binding.projectId || !binding.repositoryReferenceId || !binding.repositoryReferenceRevision) return "source-work-repository-binding-incomplete";
  if (!binding.implementationJobId || !binding.implementationWorkerId) return "source-work-job-binding-incomplete";
  return null;
}

/**
 * Compatibility-aware gate for runtime services. JSON has no cross-room authority
 * and cannot produce reconciliation overlays; SQLite overlays, when present, are
 * mandatory and fail closed until explicitly rebound by a trusted server flow.
 */
export async function sourceWorkReconciliationBlocker(repository: unknown, kind: SourceWorkKind, workId: string) {
  const bootAuthority = repository as { sourceWorkAuthorizedForCurrentBoot?: (kind: SourceWorkKind, workId: string) => boolean };
  if (bootAuthority.sourceWorkAuthorizedForCurrentBoot?.(kind, workId)) return null;
  const candidate = repository as Partial<Pick<IdentityRepository, "getSourceWorkBinding">>;
  if (typeof candidate.getSourceWorkBinding !== "function") return null;
  const binding = await candidate.getSourceWorkBinding(kind, workId);
  if (!binding) return "source-work-binding-missing";
  return sourceWorkAuthorityReason(binding);
}

export function authorizeSourceWorkForCurrentBoot(repository: unknown, kind: SourceWorkKind, workId: string) {
  const candidate = repository as { authorizeSourceWorkForCurrentBoot?: (kind: SourceWorkKind, workId: string) => void };
  candidate.authorizeSourceWorkForCurrentBoot?.(kind, workId);
}

export async function repositoryAuthorityBlocker(repository: unknown, roomId: string) {
  const candidate = repository as Partial<Pick<IdentityRepository, "getStorageScope" | "getRepositoryReference">> & {
    getVerifiedRepositoryConnection?: (projectId: string) => { readonly projectId: string; readonly revision: number; readonly state: string } | undefined;
  };
  if (typeof candidate.getStorageScope !== "function") return null;
  const scope = await candidate.getStorageScope(roomId);
  if (!scope?.projectId) return "room-has-no-project-authority";
  const verified = candidate.getVerifiedRepositoryConnection?.(scope.projectId);
  if (verified?.projectId === scope.projectId && verified.state === "verified" && verified.revision > 0) return null;
  if (!scope.repositoryReferenceId || !scope.repositoryReferenceRevision) return "project-has-no-repository-authority";
  if (typeof candidate.getRepositoryReference !== "function") return "repository-reference-unavailable";
  const reference = await candidate.getRepositoryReference(scope.repositoryReferenceId);
  if (!reference || reference.revision !== scope.repositoryReferenceRevision) return "repository-reference-missing-or-stale";
  if (String(reference.state) !== "verified") return "repository-reference-unverified";
  return null;
}

export async function requireReconciledSourceWork(repository: unknown, kind: SourceWorkKind, workId: string) {
  const reason = await sourceWorkReconciliationBlocker(repository, kind, workId);
  if (reason) throw new Error(`Source work ${kind}/${workId} is not authorized: ${boundedReconciliationReason(reason)}.`);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}
