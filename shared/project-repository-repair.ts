/** Paths are operator input; repository identity, policy and credentials remain server-owned. */
export interface RepairProjectRepositoryInput {
  readonly expectedBindingRevision: number;
  readonly expectedRepositoryRevision: number;
  readonly idempotencyKey: string;
  readonly checkoutPath: string;
  readonly worktreeRoot: string;
}

export interface RepositoryRepairStatus {
  readonly state: "available" | "blocked" | "unavailable";
  readonly authority: "verified" | "unverified" | "disabled" | "missing";
  readonly reason: string;
}
