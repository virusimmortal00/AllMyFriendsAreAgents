import { describe, expect, it } from "vitest";
import {
  OPENCODE_CONTRACT_PATH,
  affectedSurfaces,
  changedPathsFromNameStatus,
  parseContract,
  pathMatches,
  requiredUpstreamPaths,
  surfacesForChanges,
  validatePullRequestEvidence,
  validateLocalPins,
  validateReview,
  type OpenCodeIntegrationContract,
} from "./check-integration-contracts.js";

const contract = parseContract(JSON.stringify({
  schemaVersion: 2,
  integration: "opencode",
  upstream: {
    repository: "https://github.com/anomalyco/opencode.git",
    minimumVersion: "1.18.18",
    auditedVersion: "1.18.25",
    auditedTag: "v1.18.25",
    auditedCommit: "a".repeat(40),
  },
  downstream: {
    repository: "https://github.com/example/opencode.git",
    branch: "codex/structured-output-1.18.25",
    version: "1.18.25-amfaa.1",
    baseCommit: "a".repeat(40),
    headCommit: "c".repeat(40),
    pluginVersion: "1.18.25",
    patches: ["b".repeat(40), "c".repeat(40)],
    paths: ["upstream/run.ts", "upstream/tool.ts"],
  },
  review: {
    revision: 3,
    reviewedOn: "2026-08-28",
    result: "The exact upstream behavior remained compatible after source review.",
    paths: ["upstream/run.ts", "upstream/tool.ts"],
  },
  surfaces: [
    { id: "runtime", description: "Runtime protocol boundary behavior.", local: ["server/runner.ts"], upstream: ["upstream/run.ts"], tests: ["server/runner.test.ts"] },
    { id: "tools", description: "Custom tool API boundary behavior.", local: ["server/tools/**"], upstream: ["upstream/tool.ts"], tests: ["server/tools.test.ts"] },
  ],
})) satisfies OpenCodeIntegrationContract;

describe("OpenCode integration contract guard", () => {
  it("matches exact files and bounded directory patterns", () => {
    expect(pathMatches("server/runner.ts", "server/runner.ts")).toBe(true);
    expect(pathMatches("server/tools/**", "server/tools/room.ts")).toBe(true);
    expect(pathMatches("server/tools/**", "server/tooling.ts")).toBe(false);
    expect(pathMatches("server/tools/**", "server/toolsmith.ts")).toBe(false);
    expect(pathMatches("server/tools/**", "server/tools")).toBe(false);
  });

  it("maps a diff to only the affected upstream surfaces", () => {
    expect(affectedSurfaces(contract, ["server/tools/room.ts"]).map(({ id }) => id)).toEqual(["tools"]);
    expect(affectedSurfaces(contract, ["src/App.tsx"])).toEqual([]);
    expect(requiredUpstreamPaths(contract.surfaces)).toEqual(["upstream/run.ts", "upstream/tool.ts"]);
  });

  it("audits every surface whenever the contract itself changes", () => {
    expect(surfacesForChanges(contract, [OPENCODE_CONTRACT_PATH, "server/runner.ts"]).map(({ id }) => id)).toEqual(["runtime", "tools"]);
  });

  it("keeps both sides of a rename so moved integration files remain affected", () => {
    const paths = changedPathsFromNameStatus("R100\tserver/tools/room.ts\tsrc/room.ts\nM\tsrc/App.tsx");
    expect(paths).toEqual(["server/tools/room.ts", "src/room.ts", "src/App.tsx"]);
    expect(affectedSurfaces(contract, paths).map(({ id }) => id)).toEqual(["tools"]);
  });

  it("requires a new review revision and every relevant upstream path", () => {
    const previousReview = { ...contract.review, revision: 2, reviewedOn: "2026-08-27", result: "The previous source audit documented a different implementation change." };
    expect(validateReview(contract, contract.surfaces, previousReview)).toEqual([]);
    expect(validateReview(contract, contract.surfaces, contract.review)).toContain("increment review.revision above 3");
    expect(validateReview(contract, contract.surfaces, { ...previousReview, result: contract.review.result })).toContain("replace review.result with fresh source-audit evidence");
    expect(validateReview(contract, contract.surfaces, { ...previousReview, reviewedOn: "2026-08-29" })).toContain("keep review.reviewedOn on or after 2026-08-29");
    const missing = { ...contract, review: { ...contract.review, revision: 4, paths: ["upstream/run.ts"] } };
    expect(validateReview(missing, contract.surfaces, previousReview)).toContain("record upstream review path upstream/tool.ts");
  });

  it("rejects a minimum version above the audited version", () => {
    expect(() => parseContract(JSON.stringify({
      ...contract,
      upstream: { ...contract.upstream, minimumVersion: "1.18.26" },
    }))).toThrow("minimum version cannot exceed its audited version");
  });

  it("requires immutable downstream provenance tied to the audited base", () => {
    expect(() => parseContract(JSON.stringify({
      ...contract,
      downstream: { ...contract.downstream, baseCommit: "d".repeat(40) },
    }))).toThrow("exact downstream version, branch, base, patch, path, and head provenance");
    expect(() => parseContract(JSON.stringify({
      ...contract,
      downstream: { ...contract.downstream, patches: ["b".repeat(40)] },
    }))).toThrow("exact downstream version, branch, base, patch, path, and head provenance");
  });

  it("validates durable pull-request evidence against the exact contract", () => {
    const body = `## OpenCode upstream review\nTag: v1.18.25\nCommit: ${"a".repeat(40)}\nSurfaces: runtime, tools\nResult: Confirmed the mapped behavior remains compatible with the local implementation.`;
    expect(validatePullRequestEvidence(contract, contract.surfaces, body)).toEqual([]);
    expect(validatePullRequestEvidence(contract, contract.surfaces, "")).not.toEqual([]);
    expect(validatePullRequestEvidence(contract, [contract.surfaces[0]], body)).toContain("record exactly these affected surfaces in the OpenCode upstream review section: runtime");
  });

  it("rejects valid-looking evidence outside the OpenCode review section", () => {
    const evidence = `Tag: v1.18.25\nCommit: ${"a".repeat(40)}\nSurfaces: runtime, tools\nResult: Confirmed the mapped behavior remains compatible with the local implementation.`;
    const body = `${evidence}\n\n## OpenCode upstream review\nTag: N/A\nCommit: N/A\nSurfaces: N/A\nResult: Not applicable; no mapped OpenCode integration surface changed.`;
    expect(validatePullRequestEvidence(contract, contract.surfaces, body)).toEqual([
      "record audited tag v1.18.25 in the OpenCode upstream review section",
      `record audited commit ${"a".repeat(40)} in the OpenCode upstream review section`,
      "record exactly these affected surfaces in the OpenCode upstream review section: runtime, tools",
      "add a substantive Result: line to the OpenCode upstream review section",
    ]);
  });

  it("keeps the package, compiler, install policy, and runtime range pinned together", () => {
    const valid = {
      packageText: JSON.stringify({ devDependencies: { "@opencode-ai/plugin": "1.18.25" } }),
      tsconfigText: JSON.stringify({ include: ["server/**/*.ts"] }),
      workspaceText: "msgpackr-extract: false\n  - '@opencode-ai/plugin@1.18.25'\n  - '@opencode-ai/sdk@1.18.25'",
      discoveryText: 'MINIMUM_OPENCODE_VERSION = "1.18.18"\nMAXIMUM_AUDITED_OPENCODE_VERSION = "1.18.25"\nAPPROVED_DOWNSTREAM_OPENCODE_VERSION = "1.18.25-amfaa.1"',
    };
    expect(validateLocalPins(contract, valid)).toEqual([]);
    expect(validateLocalPins(contract, { ...valid, packageText: JSON.stringify({ devDependencies: { "@opencode-ai/plugin": "1.18.24" } }) })).toContain("pin @opencode-ai/plugin to 1.18.25");
  });
});
