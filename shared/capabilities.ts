export const AGENT_CAPABILITIES = ["conversation", "github_read", "project_write"] as const;
export type AgentCapabilityName = (typeof AGENT_CAPABILITIES)[number];

export interface EffectiveCapability {
  readonly configured: boolean;
  readonly runtimeAvailable: boolean;
  readonly effective: boolean;
  readonly reason: "available" | "agent_disabled" | "not_configured" | "runtime_unavailable" | "model_unavailable" | "governed_worker_only" | "exclusive_writer_elsewhere";
  readonly guidance: string;
  readonly contract?: "read-only";
}

export interface AgentCapabilityStatus {
  readonly agentId: string;
  readonly policyRevision: 1;
  readonly capabilities: Record<AgentCapabilityName, EffectiveCapability>;
  readonly effectiveCommands: readonly string[];
  readonly commands: Readonly<Record<string, CommandCapabilityStatus>>;
}

export const CAPABILITY_EXCLUSIONS = ["missing-server-config", "permission-not-granted", "agent-disabled", "catalog-revision-stale", "provider-session-stale", "lease-expired", "runtime-unavailable", "model-unavailable", "governed-worker-only", "exclusive-writer-elsewhere"] as const;
export type CapabilityExclusion = (typeof CAPABILITY_EXCLUSIONS)[number];
export interface CommandCapabilityStatus {
  readonly featureCompiled: boolean;
  readonly requiredConfigPresent: boolean;
  readonly serverCeiling: boolean;
  readonly rosterEnabled: boolean;
  readonly requestedGrant: boolean;
  readonly catalogRevisionCurrent: boolean;
  readonly providerSessionFresh: boolean;
  readonly lease: { readonly status: "not-required" | "active" | "missing" | "expired"; readonly issuedAt: string | null; readonly expiresAt: string | null };
  readonly lastManifestIssuance: { readonly revision: number; readonly issuedAt: string } | null;
  readonly lastRejection: { readonly at: string; readonly reason: CapabilityExclusion } | null;
  readonly effective: boolean;
  readonly exclusions: readonly CapabilityExclusion[];
}
