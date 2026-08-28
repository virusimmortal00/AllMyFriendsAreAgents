import { describe, expect, it } from "vitest";
import { resolveAgentCapabilities, resolveCommandCapability } from "./capability-policy.js";

const entry = { agentId: "codex-sol", conversationalName: "Sol", providerId: "openai", modelId: "gpt-5.6-sol", enabled: true, supportsProjectWrites: true };
const available = { available: true as const };

describe("authoritative agent capability policy", () => {
  it("requires configuration, model/runtime availability, and preserves read-only GitHub", () => {
    const result = resolveAgentCapabilities({ entry, model: available, runtimeAvailable: true, githubReadConfigured: true, githubReadGranted: true, exclusiveWritableAgent: "nobody" });
    expect(result.capabilities.conversation.effective).toBe(true);
    expect(result.capabilities.github_read).toMatchObject({ effective: true, contract: "read-only", reason: "available" });
    expect(result.capabilities.project_write).toMatchObject({ effective: false, reason: "governed_worker_only" });
    expect(result.commands.gh).toMatchObject({ featureCompiled: true, requiredConfigPresent: true, serverCeiling: true, rosterEnabled: true, requestedGrant: true, catalogRevisionCurrent: true, providerSessionFresh: true, effective: true, exclusions: [] });
    expect(result.effectiveCommands).toContain("gh");
  });

  it("reports every stable command gate and preserves bounded lease/manifest/rejection evidence", () => {
    const issuedAt = "2026-08-27T00:00:00.000Z"; const expiresAt = "2026-08-27T01:00:00.000Z";
    const status = resolveCommandCapability({ featureCompiled: false, requiredConfigPresent: false, serverCeiling: false, rosterEnabled: false, requestedGrant: false, catalogRevisionCurrent: false, providerSessionFresh: false, runtimeAvailable: false, modelAvailable: false, requiresLease: true, lease: { status: "expired", issuedAt, expiresAt }, lastManifestIssuance: { revision: 7, issuedAt }, lastRejection: { at: issuedAt, reason: "lease-expired" } });
    expect(status.effective).toBe(false);
    expect(status.exclusions).toEqual(["missing-server-config", "permission-not-granted", "agent-disabled", "catalog-revision-stale", "provider-session-stale", "lease-expired", "runtime-unavailable", "model-unavailable"]);
    expect(status.lease).toEqual({ status: "expired", issuedAt, expiresAt });
    expect(status.lastManifestIssuance).toEqual({ revision: 7, issuedAt });
    expect(status.lastRejection).toEqual({ at: issuedAt, reason: "lease-expired" });
  });

  it("makes the public GitHub capability follow the full command gate, including catalog and session freshness", () => {
    const result = resolveAgentCapabilities({ entry, model: available, runtimeAvailable: true, githubReadConfigured: true, githubReadGranted: true, exclusiveWritableAgent: "nobody", serverCeiling: ["gh"], requestedGrants: ["gh"], catalogRevisionCurrent: false, providerSessionFresh: false });
    expect(result.capabilities.github_read.effective).toBe(false);
    expect(result.commands.gh.exclusions).toEqual(["catalog-revision-stale", "provider-session-stale"]);
    expect(result.effectiveCommands).not.toContain("gh");
  });

  it("fails closed for disabled agents, missing models, runtime, grants, and writer exclusivity", () => {
    expect(resolveAgentCapabilities({ entry: { ...entry, enabled: false }, model: available, runtimeAvailable: true, githubReadConfigured: true, githubReadGranted: true, exclusiveWritableAgent: "nobody" }).capabilities.github_read.reason).toBe("agent_disabled");
    expect(resolveAgentCapabilities({ entry, model: { available: false, reason: "model_removed", diagnostic: "removed" }, runtimeAvailable: true, githubReadConfigured: true, githubReadGranted: true, exclusiveWritableAgent: "nobody" }).capabilities.conversation.reason).toBe("model_unavailable");
    expect(resolveAgentCapabilities({ entry, model: available, runtimeAvailable: false, githubReadConfigured: true, githubReadGranted: true, exclusiveWritableAgent: "nobody" }).capabilities.github_read.reason).toBe("runtime_unavailable");
    expect(resolveAgentCapabilities({ entry, model: available, runtimeAvailable: true, githubReadConfigured: true, githubReadGranted: false, exclusiveWritableAgent: "claude-opus" }).capabilities).toMatchObject({ github_read: { effective: false, reason: "not_configured" }, project_write: { effective: false, reason: "exclusive_writer_elsewhere" } });
  });
});
