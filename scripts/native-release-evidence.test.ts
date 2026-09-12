import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assembleNativeReleaseEvidence, bindNativeWorkflowAttestation, verifyNativeReleaseEvidence } from "./native-release-evidence.js";
import { loadNativeReleaseContext } from "./native-release-contract.js";

const context = loadNativeReleaseContext();
const temporary: string[] = [];
function fixture() { const value = mkdtempSync(path.join(os.tmpdir(), "amfaa-native-evidence-test-")); temporary.push(value); return value; }
function digest(file: string) { return createHash("sha256").update(readFileSync(file)).digest("hex"); }
function archive(stage: string, destination: string, extension: string) {
  execFileSync("tar", extension === ".zip" ? ["-a", "-cf", destination, "-C", stage, "all-my-friends-are-agents"] : ["-czf", destination, "-C", stage, "all-my-friends-are-agents"]);
}
function acceptedInputs(root: string) {
  const runtime = path.join(root, "runtime"); const application = path.join(root, "application"); mkdirSync(runtime); mkdirSync(application);
  const downstream = context.integrationContract.downstream as { headCommit: string; version: string };
  for (const target of context.policy.targets) {
    const name = `all-my-friends-are-agents-v${String(context.packageJson.version)}-${target.id}${target.archiveExtension}`;
    const runtimeStage = path.join(root, `runtime-${target.id}`); const executable = target.os === "windows" ? "opencode.exe" : "opencode";
    const runtimeBinary = path.join(runtimeStage, "all-my-friends-are-agents/runtime", executable); mkdirSync(path.dirname(runtimeBinary), { recursive: true }); writeFileSync(runtimeBinary, `${target.id}\n`);
    const runtimeArchive = path.join(runtime, name); archive(runtimeStage, runtimeArchive, target.archiveExtension); const runtimeDigest = digest(runtimeArchive);
    writeFileSync(`${runtimeArchive}.sha256`, `${runtimeDigest}  ${name}\n`);
    writeFileSync(`${runtimeArchive}.verification.json`, `${JSON.stringify({ schemaVersion: 1, target: target.id, downstreamCommit: downstream.headCommit, downstreamVersion: downstream.version, archive: name, sha256: runtimeDigest, binarySha256: digest(runtimeBinary), executablePath: `all-my-friends-are-agents/runtime/${executable}` }, null, 2)}\n`);

    const appStage = path.join(root, `application-${target.id}`); const product = path.join(appStage, "all-my-friends-are-agents");
    const version = `0.1.0-${"a".repeat(12)}`; const appRoot = path.join(product, "versions", version, "app");
    const node = path.join(appRoot, `runtime/node/bin/${target.os === "windows" ? "node.exe" : "node"}`); const opencode = path.join(appRoot, `runtime/opencode/bin/${executable}`);
    mkdirSync(path.dirname(node), { recursive: true }); mkdirSync(path.dirname(opencode), { recursive: true }); writeFileSync(node, "node\n"); writeFileSync(opencode, "opencode\n");
    writeFileSync(path.join(product, "active-version"), `${version}\n`); writeFileSync(path.join(product, target.os === "windows" ? "amfaa.cmd" : "amfaa"), "launcher\n");
    const appArchive = path.join(application, name); archive(appStage, appArchive, target.archiveExtension); writeFileSync(`${appArchive}.sha256`, `${digest(appArchive)}  ${name}\n`);
  }
  return { runtime, application };
}
function assemble() {
  const root = fixture(); const inputs = acceptedInputs(root); const output = path.join(root, "output"); const commit = "b".repeat(40);
  const assembled = assembleNativeReleaseEvidence({ ...inputs, runtimeDirectory: inputs.runtime, applicationDirectory: inputs.application, outputDirectory: output, sourceCommit: commit, workflow: { repository: "virusimmortal00/AllMyFriendsAreAgents", workflow: "virusimmortal00/AllMyFriendsAreAgents/.github/workflows/build-native-opencode.yml@refs/heads/main", ref: "refs/heads/main", sha: commit, runId: "123", runAttempt: "1" } });
  const bundle = path.join(root, "sigstore.json");
  const payload = { _type: "https://in-toto.io/Statement/v1", subject: assembled.artifacts.map((entry) => ({ name: entry.path, digest: { sha256: entry.sha256 } })), predicateType: "https://slsa.dev/provenance/v1", predicate: {} };
  writeFileSync(bundle, JSON.stringify({ mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json", verificationMaterial: { tlogEntries: [{}] }, dsseEnvelope: { payloadType: "application/vnd.in-toto+json", payload: Buffer.from(JSON.stringify(payload)).toString("base64"), signatures: [{ sig: "fixture" }] } }));
  bindNativeWorkflowAttestation(output, bundle);
  return { output, commit };
}

afterEach(() => { for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe("native release evidence retention", () => {
  it("does not treat locally assembled predicates as trusted workflow signatures", () => {
    const root = fixture(); const inputs = acceptedInputs(root); const output = path.join(root, "unsigned"); const commit = "d".repeat(40);
    assembleNativeReleaseEvidence({ runtimeDirectory: inputs.runtime, applicationDirectory: inputs.application, outputDirectory: output, sourceCommit: commit, workflow: { repository: "virusimmortal00/AllMyFriendsAreAgents", workflow: "workflow", ref: "refs/heads/main", sha: commit, runId: "1", runAttempt: "1" } });
    expect(() => verifyNativeReleaseEvidence(output, commit)).toThrow(/Trusted workflow attestation is missing/);
  });

  it("retains exact accepted archives and installers with checksums, SBOMs, and signed provenance", () => {
    const { output, commit } = assemble(); const manifest = verifyNativeReleaseEvidence(output, commit);
    expect(manifest.artifacts).toHaveLength(context.policy.targets.length * 2 + 2);
    expect(manifest.artifacts.map(({ kind }) => kind)).toEqual([...context.policy.targets.map(() => "runtime"), ...context.policy.targets.map(() => "application")].flatMap((_value, index) => index < context.policy.targets.length ? ["runtime", "application"] : []).concat(["installer", "installer"]));
    for (const entry of manifest.artifacts) {
      expect(readFileSync(path.join(output, entry.checksum.path), "utf8")).toBe(`${entry.sha256}  ${path.basename(entry.path)}\n`);
      expect(JSON.parse(readFileSync(path.join(output, entry.sbom.path), "utf8"))).toMatchObject({ spdxVersion: "SPDX-2.3" });
      expect(JSON.parse(readFileSync(path.join(output, entry.provenance.path), "utf8"))).toMatchObject({ _type: "https://in-toto.io/Statement/v1", predicateType: "https://slsa.dev/provenance/v1" });
    }
  });

  it.each(["missing", "extra", "renamed", "mutated", "bad-provenance", "bad-attestation"])("rejects a %s retained set", (failure) => {
    const { output, commit } = assemble(); const manifest = JSON.parse(readFileSync(path.join(output, "native-evidence-manifest.json"), "utf8")); const artifact = path.join(output, manifest.artifacts[0].path);
    if (failure === "missing") rmSync(artifact);
    if (failure === "extra") writeFileSync(path.join(output, "unexpected"), "extra");
    if (failure === "renamed") copyFileSync(artifact, `${artifact}.renamed`), rmSync(artifact);
    if (failure === "mutated") writeFileSync(artifact, Buffer.concat([readFileSync(artifact), Buffer.from("mutated")]));
    if (failure === "bad-provenance") {
      const proof = path.join(output, manifest.artifacts[0].provenance.path); const statement = JSON.parse(readFileSync(proof, "utf8")); statement.predicate.buildDefinition.externalParameters.source.commit = "c".repeat(40); writeFileSync(proof, `${JSON.stringify(statement)}\n`);
      manifest.artifacts[0].provenance.size = statSize(proof); manifest.artifacts[0].provenance.sha256 = digest(proof); writeFileSync(path.join(output, "native-evidence-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    }
    if (failure === "bad-attestation") {
      const bundle = path.join(output, manifest.workflowAttestation.path); const signed = JSON.parse(readFileSync(bundle, "utf8")); signed.dsseEnvelope.payload = Buffer.from(JSON.stringify({ subject: [] })).toString("base64"); writeFileSync(bundle, JSON.stringify(signed));
      manifest.workflowAttestation.size = statSize(bundle); manifest.workflowAttestation.sha256 = digest(bundle); writeFileSync(path.join(output, "native-evidence-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    }
    expect(() => verifyNativeReleaseEvidence(output, commit)).toThrow();
  });

  it("rejects evidence replayed under another source commit", () => {
    const { output } = assemble(); expect(() => verifyNativeReleaseEvidence(output, "c".repeat(40))).toThrow(/source commit/);
  });
});

function statSize(file: string) { return readFileSync(file).length; }
