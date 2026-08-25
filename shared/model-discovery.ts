export const HARNESS_IDS = ["codex", "claude", "cursor", "opencode"] as const;

export type HarnessId = (typeof HARNESS_IDS)[number];
export type DiscoveryStatus =
  | "available"
  | "cli_missing"
  | "authentication_required"
  | "configuration_required"
  | "discovery_unsupported"
  | "error";
export type ModelProvenance = "harness-catalog" | "documented-alias" | "configured-default";

export interface ModelReference {
  readonly harness: HarnessId;
  readonly providerId?: string;
  readonly modelId: string;
  readonly variant?: string;
  readonly reasoningEffort?: string;
}

export interface ModelVariant {
  readonly id: string;
  readonly displayName: string;
}

export interface DiscoveredModel {
  readonly harness: HarnessId;
  readonly providerId?: string;
  readonly modelId: string;
  readonly displayName: string;
  readonly variants?: readonly ModelVariant[];
  readonly provenance: ModelProvenance;
  readonly capabilities?: {
    readonly reasoningEffort?: readonly string[];
    readonly contextOptions?: readonly string[];
  };
}

export interface HarnessDiscoveryResult {
  readonly status: DiscoveryStatus;
  readonly models: readonly DiscoveredModel[];
  readonly configuredDefault?: ModelReference;
  readonly diagnostic?: string;
  readonly discoveredAt: string;
}

export interface ModelAvailability {
  readonly available: boolean;
  readonly reason?: "harness_unavailable" | "model_removed" | "provider_removed" | "variant_removed" | "reasoning_effort_removed" | "selection_unpinnable";
  readonly diagnostic?: string;
}

export function isHarnessId(value: unknown): value is HarnessId {
  return typeof value === "string" && (HARNESS_IDS as readonly string[]).includes(value);
}

export function validDiscoveryId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 200
    && /^[A-Za-z0-9][A-Za-z0-9._:/+@-]*$/.test(value);
}

export function modelKey(model: Pick<DiscoveredModel, "providerId" | "modelId">) {
  return `${model.providerId || ""}\u0000${model.modelId}`;
}

export function selectedModelAvailability(reference: ModelReference, result: HarnessDiscoveryResult): ModelAvailability {
  if (["cli_missing", "authentication_required", "configuration_required", "error"].includes(result.status)) {
    return { available: false, reason: "harness_unavailable", diagnostic: result.diagnostic };
  }
  const model = result.models.find((candidate) => candidate.modelId === reference.modelId
    && (candidate.providerId || "") === (reference.providerId || ""));
  if (!model) {
    if (result.status === "discovery_unsupported" && result.configuredDefault
      && result.configuredDefault.modelId === reference.modelId
      && (result.configuredDefault.providerId || "") === (reference.providerId || "")) return { available: true };
    return { available: false, reason: reference.providerId ? "provider_removed" : "model_removed" };
  }
  if (reference.variant && !model.variants?.some(({ id }) => id === reference.variant)) {
    return { available: false, reason: "variant_removed" };
  }
  if (reference.reasoningEffort && !model.capabilities?.reasoningEffort?.includes(reference.reasoningEffort)) {
    return { available: false, reason: "reasoning_effort_removed" };
  }
  return { available: true };
}
