import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  assertNativeReleaseContext,
  generateNativeReleaseManifest,
  loadNativeReleaseContext,
  serializeNativeReleaseManifest,
  validateNativeReleaseManifest,
  type NativeReleaseContext,
} from "./native-release-contract.js";
import { requiredAt } from "./type-invariants.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const context = loadNativeReleaseContext(root);
const applicationVersion = String(context.packageJson.version);
const digest = "a".repeat(64);

function file(name: string) {
  return {
    name,
    url: `https://github.com/virusimmortal00/AllMyFriendsAreAgents/releases/download/v${applicationVersion}/${name}`,
    size: 123,
    sha256: digest,
  };
}

function target(id: string, extension = id.startsWith("windows-") ? ".zip" : ".tar.gz") {
  const name = `all-my-friends-are-agents-v${applicationVersion}-${id}${extension}`;
  return { id, artifact: file(name), sbom: file(`${name}.spdx.json`), provenance: file(`${name}.intoto.jsonl`) };
}

function manifest() {
  return {
    schemaVersion: 1,
    application: {
      version: applicationVersion,
      commit: "b".repeat(40),
      repository: "https://github.com/virusimmortal00/AllMyFriendsAreAgents.git",
    },
    downstream: {
      repository: "https://github.com/virusimmortal00/opencode.git",
      commit: "6883ca5bd35a5494fb2759018373308911c79e01",
      version: "1.18.25-amfaa.2",
      sdkVersion: "1.18.25",
      pluginVersion: "1.18.25",
    },
    targets: [target("windows-x64"), target("linux-x64"), target("darwin-arm64"), target("linux-arm64"), target("darwin-x64")],
  };
}

function changedContext(change: Partial<NativeReleaseContext>): NativeReleaseContext {
  return { ...context, ...change };
}

describe("native release contract", () => {
  it("declares the complete initial matrix and documents the Windows ARM64 deferral", () => {
    expect(context.policy.targets.map((item) => item.id)).toEqual(["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "windows-x64"]);
    expect(context.policy.deferredTargets).toEqual([expect.objectContaining({ id: "windows-arm64", reason: expect.stringMatching(/process.*path.*cancellation.*confinement.*clean-install/i) })]);
  });

  it("keeps public downstream evidence, compatibility packages, and the Dockerfile on one exact identity", () => {
    expect(() => assertNativeReleaseContext(context)).not.toThrow();
    const conflictingContract = structuredClone(context.integrationContract);
    (conflictingContract.downstream as Record<string, unknown>).headCommit = "c".repeat(40);
    expect(() => assertNativeReleaseContext(changedContext({ integrationContract: conflictingContract }))).toThrow(/conflicts with the admitted downstream branch provenance/);
    expect(() => assertNativeReleaseContext(changedContext({ dockerfile: context.dockerfile.replaceAll("6883ca5bd35a5494fb2759018373308911c79e01", "c".repeat(40)) }))).toThrow(/Dockerfile OPENCODE_COMMIT conflicts/);
  });

  it("loads the checked-in JSON Schema with a closed, versioned root", () => {
    const schema = JSON.parse(readFileSync(path.join(root, "release/native-release-manifest.schema.json"), "utf8"));
    expect(schema).toMatchObject({ $schema: "https://json-schema.org/draft/2020-12/schema", additionalProperties: false, properties: { schemaVersion: { const: 1 } } });
  });

  it("generates canonical deterministic JSON from identical explicit inputs", () => {
    const first = serializeNativeReleaseManifest(manifest(), context);
    const second = serializeNativeReleaseManifest(structuredClone(manifest()), context);
    expect(first).toBe(second);
    expect(JSON.parse(first).targets.map((item: { id: string }) => item.id)).toEqual(context.policy.targets.map((item) => item.id));
    expect(first).not.toMatch(/Users\/|localhost|runner|token|credential|buildId|runId/);
  });

  it("rejects unknown schemas, unsupported targets, duplicates, and missing compatibility", () => {
    expect(() => validateNativeReleaseManifest({ ...manifest(), schemaVersion: 2 }, context)).toThrow(/Unknown native release manifest schema version/);
    expect(() => validateNativeReleaseManifest({ ...manifest(), targets: [target("windows-arm64")] }, context)).toThrow(/Unsupported native release target/);
    expect(() => validateNativeReleaseManifest({ ...manifest(), targets: [target("linux-x64"), target("linux-x64")] }, context)).toThrow(/Duplicate native release target/);
    expect(() => validateNativeReleaseManifest({ ...manifest(), targets: manifest().targets.slice(1) }, context)).toThrow(/complete supported native target matrix/);
    const missingSdk = manifest();
    delete (missingSdk.downstream as Partial<typeof missingSdk.downstream>).sdkVersion;
    expect(() => validateNativeReleaseManifest(missingSdk, context)).toThrow(/missing or unknown fields/);
  });

  it("rejects conflicting downstream provenance rather than encoding an unadmitted SHA", () => {
    const input = manifest();
    input.downstream.commit = "d".repeat(40);
    expect(() => generateNativeReleaseManifest(input, context)).toThrow(/commit conflicts with admitted provenance/);
    const wrongApplicationVersion = manifest();
    wrongApplicationVersion.application.version = "0.2.0";
    expect(() => generateNativeReleaseManifest(wrongApplicationVersion, context)).toThrow(/Application version conflicts with package provenance/);
  });

  it("rejects mutable, credentialed, malformed, or incomplete artifact evidence", () => {
    for (const url of [
      "https://github.com/virusimmortal00/AllMyFriendsAreAgents/releases/latest/download/file.zip",
      "https://user:secret@github.com/virusimmortal00/AllMyFriendsAreAgents/releases/download/v0.1.0/file.zip",
      "not a URL",
      "/tmp/native-release.zip",
      "https://localhost/releases/download/v0.1.0/file.zip",
    ]) {
      const invalidReference = manifest();
      requiredAt(invalidReference.targets, 0, "first release target").artifact.url = url;
      expect(() => validateNativeReleaseManifest(invalidReference, context)).toThrow(/mutable, credentialed, or malformed|malformed artifact reference/);
    }
    const invalidHash = manifest();
    requiredAt(invalidHash.targets, 0, "first release target").sbom.sha256 = "A".repeat(64);
    expect(() => validateNativeReleaseManifest(invalidHash, context)).toThrow(/lowercase SHA-256/);
    const invalidSize = manifest();
    requiredAt(invalidSize.targets, 0, "first release target").provenance.size = 0;
    expect(() => validateNativeReleaseManifest(invalidSize, context)).toThrow(/positive safe integer/);
    const missingProvenance = manifest();
    delete (requiredAt(missingProvenance.targets, 0, "first release target") as Partial<(typeof missingProvenance.targets)[number]>).provenance;
    expect(() => validateNativeReleaseManifest(missingProvenance, context)).toThrow(/missing or unknown fields/);
    expect(() => validateNativeReleaseManifest({ ...manifest(), buildId: "temporary-run-123" }, context)).toThrow(/missing or unknown fields/);
  });
});
