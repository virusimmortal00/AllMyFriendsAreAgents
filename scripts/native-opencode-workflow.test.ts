import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflow = readFileSync(path.join(root, ".github/workflows/build-native-opencode.yml"), "utf8");
const dockerfile = readFileSync(path.join(root, "Dockerfile"), "utf8");

describe("self-contained native application build workflow", () => {
  it("runs the complete supported native matrix on matching hosted architectures", () => {
    for (const pair of [
      "darwin-arm64\\n            runner: macos-15",
      "darwin-x64\\n            runner: macos-15-intel",
      "linux-arm64\\n            runner: ubuntu-24.04-arm",
      "linux-x64\\n            runner: ubuntu-24.04",
      "windows-x64\\n            runner: windows-2025",
    ]) expect(workflow).toMatch(new RegExp(pair));
    expect(workflow).not.toMatch(/target: windows-arm64/);
  });

  it("has read-only authority and uploads only run-scoped workflow artifacts", () => {
    expect(workflow).toMatch(/^permissions:\n  contents: read$/m);
    expect(workflow).not.toMatch(/packages:\s*write|contents:\s*write|id-token:\s*write|attestations:\s*write/);
    expect(workflow).not.toMatch(/gh release|npm publish|pnpm publish|docker push|create-release|release-action/i);
    expect(workflow).toContain("native-application-${{ matrix.target }}-${{ github.run_id }}-${{ github.run_attempt }}");
    expect(workflow).toContain("pattern: native-application-*-${{ github.run_id }}-${{ github.run_attempt }}");
  });

  it("pins build tools and uses the contract-aware verifier before upload and after download", () => {
    expect(workflow).toContain("bun-version: 1.3.14");
    expect(workflow.match(/node-version: 24\.5\.0/g)).toHaveLength(2);
    expect(workflow).toContain("build-native-opencode.ts build --target ${{ matrix.target }}");
    expect(workflow.indexOf("build-native-opencode.ts build")).toBeLessThan(workflow.indexOf("actions/upload-artifact@"));
    expect(workflow).toContain("package:native-application -- verify-set --directory native-application-artifacts");
    expect(workflow).toContain("--opencode-evidence \"$opencode_evidence\"");
    for (const reference of workflow.matchAll(/uses: [^\s]+@([^\s]+)/g)) expect(reference[1]).toMatch(/^[0-9a-f]{40}$/);
  });

  it("leaves the independently audited container runtime inputs pinned", () => {
    expect(dockerfile).toMatch(/^ARG OPENCODE_REPOSITORY=https:\/\/github\.com\/virusimmortal00\/opencode\.git$/m);
    expect(dockerfile.match(/^ARG OPENCODE_COMMIT=6883ca5bd35a5494fb2759018373308911c79e01$/gm)).toHaveLength(2);
    expect(dockerfile.match(/^ARG OPENCODE_VERSION=1\.18\.25-amfaa\.2$/gm)).toHaveLength(2);
    expect(dockerfile).toContain("test \"$(/out/opencode --version)\" = \"$OPENCODE_VERSION\"");
  });
});
