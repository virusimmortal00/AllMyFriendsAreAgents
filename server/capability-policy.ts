import type { ModelAvailability } from "../shared/model-discovery.js";
import type { AgentCapabilityName, AgentCapabilityStatus, CapabilityExclusion, CommandCapabilityStatus, EffectiveCapability } from "../shared/capabilities.js";
import type { RoomAgentRosterEntry } from "../shared/roster.js";
import { ROOM_COMMANDS } from "../shared/command-domain.js";

const guidance = {
  conversation: "Enable the agent and select a model currently available through OpenCode.",
  room_diagnostics: "Enable the participant with an available model and the server-owned diagnostics query service.",
  github_read: "Configure the server-only GitHub read token and owner/repository, then grant /gh to the agent.",
  project_write: "Project writes require the exclusive governed implementation-worker handoff; room agents stay read-only.",
} satisfies Record<AgentCapabilityName, string>;

export interface CapabilityPolicyInput {
  readonly entry: RoomAgentRosterEntry;
  readonly model: ModelAvailability;
  readonly runtimeAvailable: boolean;
  readonly githubReadConfigured: boolean;
  readonly githubReadGranted: boolean;
  readonly diagnosticsConfigured?: boolean;
  readonly exclusiveWritableAgent: string;
  readonly featureCompiled?: boolean;
  readonly serverCeiling?: readonly string[];
  readonly requestedGrants?: readonly string[];
  readonly catalogRevisionCurrent?: boolean;
  readonly providerSessionFresh?: boolean;
  readonly lease?: CommandCapabilityStatus["lease"];
  readonly lastManifestIssuance?: CommandCapabilityStatus["lastManifestIssuance"];
  readonly lastRejection?: CommandCapabilityStatus["lastRejection"];
}

function capability(configured: boolean, runtimeAvailable: boolean, reason: EffectiveCapability["reason"], name: AgentCapabilityName, contract?: "read-only"): EffectiveCapability {
  return { configured, runtimeAvailable, effective: configured && runtimeAvailable && reason === "available", reason, guidance: guidance[name], ...(contract ? { contract } : {}) };
}

/** Authoritative server-side capability resolution. Clients receive only this safe projection. */
export function resolveAgentCapabilities(input: CapabilityPolicyInput): AgentCapabilityStatus {
  const { entry } = input;
  const conversationReason: EffectiveCapability["reason"] = !entry.enabled ? "agent_disabled" : !input.model.available ? "model_unavailable" : !input.runtimeAvailable ? "runtime_unavailable" : "available";
  const diagnosticsReason: EffectiveCapability["reason"] = !entry.enabled ? "agent_disabled" : !input.diagnosticsConfigured ? "not_configured" : !input.model.available ? "model_unavailable" : !input.runtimeAvailable ? "runtime_unavailable" : "available";
  const ghConfigured = input.githubReadConfigured && input.githubReadGranted;
  const selectedWriter = input.exclusiveWritableAgent === entry.agentId;
  const writeReason: EffectiveCapability["reason"] = !entry.enabled ? "agent_disabled" : !selectedWriter && input.exclusiveWritableAgent !== "nobody" ? "exclusive_writer_elsewhere" : "governed_worker_only";
  const ceiling = input.serverCeiling || (input.githubReadConfigured ? ROOM_COMMANDS : ROOM_COMMANDS.filter((command) => command !== "gh"));
  const requested = input.requestedGrants || (input.githubReadGranted ? ["gh"] : []);
  const common = { featureCompiled: input.featureCompiled !== false, rosterEnabled: entry.enabled, providerSessionFresh: input.providerSessionFresh !== false, lease: input.lease || { status: "not-required" as const, issuedAt: null, expiresAt: null }, lastManifestIssuance: input.lastManifestIssuance || null, lastRejection: input.lastRejection || null, runtimeAvailable: input.runtimeAvailable, modelAvailable: input.model.available };
  const commands = Object.fromEntries(ROOM_COMMANDS.map((command) => [command, resolveCommandCapability({ ...common, requiredConfigPresent: command !== "gh" || input.githubReadConfigured, serverCeiling: ceiling.includes(command), requestedGrant: requested.includes(command), catalogRevisionCurrent: command !== "gh" || input.catalogRevisionCurrent !== false })]));
  const projectWrite = resolveCommandCapability({ ...common, featureCompiled: false, requiredConfigPresent: entry.supportsProjectWrites === true, serverCeiling: selectedWriter, requestedGrant: selectedWriter, catalogRevisionCurrent: true, lease: input.lease || { status: "missing", issuedAt: null, expiresAt: null }, requiresLease: true, requiresProviderSession: false, modelAvailable: true });
  commands.project_write = projectWrite;
  const ghCommand = commands.gh;
  const effectiveGhReason: EffectiveCapability["reason"] = ghCommand.effective ? "available"
    : ghCommand.exclusions.includes("agent-disabled") ? "agent_disabled"
      : ghCommand.exclusions.includes("model-unavailable") ? "model_unavailable"
        : ghCommand.exclusions.some((reason) => reason === "runtime-unavailable" || reason === "provider-session-stale" || reason === "lease-expired") ? "runtime_unavailable"
          : "not_configured";
  const githubCapability = capability(ghConfigured, input.runtimeAvailable && input.model.available, effectiveGhReason, "github_read", "read-only");
  return {
    agentId: entry.agentId,
    policyRevision: 1,
    capabilities: {
      conversation: capability(entry.enabled, input.runtimeAvailable && input.model.available, conversationReason, "conversation"),
      room_diagnostics: capability(input.diagnosticsConfigured === true, input.runtimeAvailable && input.model.available, diagnosticsReason, "room_diagnostics", "read-only"),
      github_read: { ...githubCapability, effective: commands.gh.effective },
      project_write: capability(selectedWriter && entry.supportsProjectWrites === true, false, writeReason, "project_write"),
    },
    effectiveCommands: ROOM_COMMANDS.filter((command) => commands[command]?.effective),
    commands,
  };
}

export function resolveCommandCapability(input: { featureCompiled: boolean; requiredConfigPresent: boolean; serverCeiling: boolean; rosterEnabled: boolean; requestedGrant: boolean; catalogRevisionCurrent: boolean; providerSessionFresh: boolean; runtimeAvailable: boolean; modelAvailable: boolean; lease: CommandCapabilityStatus["lease"]; lastManifestIssuance: CommandCapabilityStatus["lastManifestIssuance"]; lastRejection: CommandCapabilityStatus["lastRejection"]; requiresLease?: boolean; requiresProviderSession?: boolean }): CommandCapabilityStatus {
  const exclusions: CapabilityExclusion[] = [];
  if (!input.featureCompiled || !input.requiredConfigPresent) exclusions.push("missing-server-config");
  if (!input.serverCeiling || !input.requestedGrant) exclusions.push("permission-not-granted");
  if (!input.rosterEnabled) exclusions.push("agent-disabled");
  if (!input.catalogRevisionCurrent) exclusions.push("catalog-revision-stale");
  if ((input.requiresProviderSession ?? true) && !input.providerSessionFresh) exclusions.push("provider-session-stale");
  if (input.requiresLease && input.lease.status === "expired") exclusions.push("lease-expired");
  else if (input.requiresLease && input.lease.status !== "active") exclusions.push("missing-server-config");
  if (!input.runtimeAvailable) exclusions.push("runtime-unavailable");
  if (!input.modelAvailable) exclusions.push("model-unavailable");
  return { featureCompiled: input.featureCompiled, requiredConfigPresent: input.requiredConfigPresent, serverCeiling: input.serverCeiling, rosterEnabled: input.rosterEnabled, requestedGrant: input.requestedGrant, catalogRevisionCurrent: input.catalogRevisionCurrent, providerSessionFresh: input.providerSessionFresh, lease: input.lease, lastManifestIssuance: input.lastManifestIssuance, lastRejection: input.lastRejection, effective: exclusions.length === 0, exclusions };
}

export function capabilityEnabled(status: AgentCapabilityStatus | undefined, name: AgentCapabilityName) {
  return name === "github_read" ? status?.commands.gh?.effective === true : status?.capabilities[name].effective === true;
}
