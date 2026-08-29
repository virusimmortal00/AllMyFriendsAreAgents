import { describe, expect, it } from "vitest";
import {
  affectedSurfaces,
  changedPathsFromNameStatus,
  parseContract,
  pathMatches,
  requiredUpstreamPaths,
  validatePullRequestEvidence,
  validateLocalPins,
  validateReview,
  type OpenCodeIntegrationContract,
} from "./check-integration-contracts.js";

const contract = parseContract(JSON.stringify({
  schemaVersion: 1,
  integration: "opencode",
  upstream: {
    repository: "https://github.com/anomalyco/opencode.git",
    minimumVersion: "1.18.18",
    auditedVersion: "1.18.25",
    auditedTag: "v1.18.25",
    auditedCommit: "a".repeat(40),
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

  it("keeps both sides of a rename so moved integration files remain affected", () => {
    const paths = changedPathsFromNameStatus("R100\tserver/tools/room.ts\tsrc/room.ts\nM\tsrc/App.tsx");
    expect(paths).toEqual(["server/tools/room.ts", "src/room.ts", "src/App.tsx"]);
    expect(affectedSurfaces(contract, paths).map(({ id }) => id)).toEqual(["tools"]);
  });

  it("requires a new review revision and every relevant upstream path", () => {
    expect(validateReview(contract, contract.surfaces, 2)).toEqual([]);
    expect(validateReview(contract, contract.surfaces, 3)).toContain("increment review.revision above 3");
    const missing = { ...contract, review: { ...contract.review, revision: 4, paths: ["upstream/run.ts"] } };
    expect(validateReview(missing, contract.surfaces, 3)).toContain("record upstream review path upstream/tool.ts");
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
      discoveryText: 'MINIMUM_OPENCODE_VERSION = "1.18.18"\nMAXIMUM_AUDITED_OPENCODE_VERSION = "1.18.25"',
    };
    expect(validateLocalPins(contract, valid)).toEqual([]);
    expect(validateLocalPins(contract, { ...valid, packageText: JSON.stringify({ devDependencies: { "@opencode-ai/plugin": "1.18.24" } }) })).toContain("pin @opencode-ai/plugin to 1.18.25");
  });
});
