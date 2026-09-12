import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyNativeArtifactSet } from "./build-native-opencode.js";
import { verifyNativeApplicationSet } from "./package-native-application.js";
import { loadNativeReleaseContext, serializeNativeReleaseManifest, validateNativeReleaseManifest } from "./native-release-contract.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;

type ArtifactKind = "runtime" | "application" | "installer";
type Candidate = { kind: ArtifactKind; target: string; source: string; relativePath: string };
type FileReference = { path: string; size: number; sha256: string };
type ArtifactEntry = FileReference & {
  kind: ArtifactKind;
  target: string;
  checksum: FileReference;
  sbom: FileReference;
  provenance: FileReference;
};

export interface WorkflowIdentity {
  repository: string;
  workflow: string;
  ref: string;
  sha: string;
  runId: string;
  runAttempt: string;
}

export interface NativeEvidenceManifest {
  schemaVersion: 1;
  source: { repository: string; commit: string };
  workflow: WorkflowIdentity;
  workflowAttestation: FileReference | null;
  releaseProjection: FileReference | null;
  artifacts: ArtifactEntry[];
}

function sha256Buffer(value: Buffer | string): string { return createHash("sha256").update(value).digest("hex"); }
function sha256File(file: string): string { return sha256Buffer(readFileSync(file)); }
function reference(root: string, relativePath: string): FileReference {
  const file = path.join(root, relativePath);
  return { path: relativePath.replaceAll(path.sep, "/"), size: statSync(file).size, sha256: sha256File(file) };
}
function exactKeys(value: Record<string, unknown>, expected: string[], label: string): void {
  const actual = Object.keys(value).sort(); const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((item, index) => item !== wanted[index])) throw new Error(`${label} contains missing or unexpected fields.`);
}
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}
function walk(root: string, relative = ""): string[] {
  return readdirSync(path.join(root, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
    const child = path.join(relative, entry.name);
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) throw new Error("Native evidence contains an unsupported filesystem entry.");
    return entry.isDirectory() ? walk(root, child) : [child.replaceAll(path.sep, "/")];
  });
}
function candidateSet(runtimeDirectory: string, applicationDirectory: string): Candidate[] {
  const context = loadNativeReleaseContext(ROOT);
  const version = String(context.packageJson.version);
  const candidates: Candidate[] = [];
  for (const target of context.policy.targets) {
    const name = `all-my-friends-are-agents-v${version}-${target.id}${target.archiveExtension}`;
    candidates.push({ kind: "runtime", target: target.id, source: path.join(runtimeDirectory, name), relativePath: `runtime/${name}` });
    candidates.push({ kind: "application", target: target.id, source: path.join(applicationDirectory, name), relativePath: `application/${name}` });
  }
  candidates.push(
    { kind: "installer", target: "darwin-linux", source: path.join(ROOT, "scripts/install-native.sh"), relativePath: "installers/install-native.sh" },
    { kind: "installer", target: "windows-x64", source: path.join(ROOT, "scripts/install-windows.ps1"), relativePath: "installers/install-windows.ps1" },
  );
  return candidates;
}
function sbom(candidate: Candidate, digest: string, sourceCommit: string): string {
  const id = `SPDXRef-${candidate.kind}-${candidate.target.replace(/[^A-Za-z0-9.-]/g, "-")}`;
  return `${JSON.stringify({
    spdxVersion: "SPDX-2.3", dataLicense: "CC0-1.0", SPDXID: "SPDXRef-DOCUMENT",
    name: `all-my-friends-are-agents-${candidate.kind}-${candidate.target}`,
    documentNamespace: `https://github.com/virusimmortal00/AllMyFriendsAreAgents/native-sbom/${sourceCommit}/${digest}`,
    creationInfo: { created: "1970-01-01T00:00:00Z", creators: ["Tool: scripts/native-release-evidence.ts"] },
    files: [{ SPDXID: id, fileName: candidate.relativePath, checksums: [{ algorithm: "SHA256", checksumValue: digest }] }],
    documentDescribes: [id],
  }, null, 2)}\n`;
}
function statement(candidate: Candidate, digest: string, source: NativeEvidenceManifest["source"], workflow: WorkflowIdentity) {
  return {
    _type: "https://in-toto.io/Statement/v1",
    subject: [{ name: path.basename(candidate.relativePath), digest: { sha256: digest } }],
    predicateType: "https://slsa.dev/provenance/v1",
    predicate: {
      buildDefinition: {
        buildType: "https://github.com/Attestations/GitHubActionsWorkflow@v1",
        externalParameters: { source, workflow },
        internalParameters: { evidenceAssembler: "scripts/native-release-evidence.ts" },
        resolvedDependencies: [{ uri: `${source.repository}@${source.commit}`, digest: { gitCommit: source.commit } }],
      },
      runDetails: { builder: { id: workflow.workflow }, metadata: { invocationId: `${workflow.repository}/actions/runs/${workflow.runId}/attempts/${workflow.runAttempt}` } },
    },
  };
}
function provenance(candidate: Candidate, digest: string, source: NativeEvidenceManifest["source"], workflow: WorkflowIdentity): string {
  return `${JSON.stringify(statement(candidate, digest, source, workflow))}\n`;
}

export function assembleNativeReleaseEvidence(input: {
  runtimeDirectory: string; applicationDirectory: string; outputDirectory: string; sourceCommit: string; workflow: WorkflowIdentity;
}): NativeEvidenceManifest {
  if (!COMMIT.test(input.sourceCommit) || input.workflow.sha !== input.sourceCommit) throw new Error("Source commit and workflow SHA must be the same full lowercase commit.");
  for (const value of Object.values(input.workflow)) if (typeof value !== "string" || !value) throw new Error("Workflow identity fields must be non-empty strings.");
  verifyNativeArtifactSet(input.runtimeDirectory);
  verifyNativeApplicationSet(input.applicationDirectory);
  const output = path.resolve(input.outputDirectory);
  if (existsSync(output) && readdirSync(output).length) throw new Error("Refusing to replace retained native release evidence.");
  mkdirSync(output, { recursive: true });
  const source = { repository: loadNativeReleaseContext(ROOT).policy.applicationRepository, commit: input.sourceCommit };
  const artifacts: ArtifactEntry[] = [];
  try {
    for (const candidate of candidateSet(input.runtimeDirectory, input.applicationDirectory)) {
      if (!existsSync(candidate.source) || !statSync(candidate.source).isFile()) throw new Error(`Missing native release input: ${candidate.relativePath}.`);
      const destination = path.join(output, candidate.relativePath); mkdirSync(path.dirname(destination), { recursive: true }); copyFileSync(candidate.source, destination, 0);
      const copied = reference(output, candidate.relativePath);
      if (copied.sha256 !== sha256File(candidate.source) || copied.size !== statSync(candidate.source).size) throw new Error(`Native release input changed while assembling: ${candidate.relativePath}.`);
      const checksumPath = `${candidate.relativePath}.sha256`;
      writeFileSync(path.join(output, checksumPath), `${copied.sha256}  ${path.basename(candidate.relativePath)}\n`, { flag: "wx" });
      const sbomPath = `${candidate.relativePath}.spdx.json`;
      writeFileSync(path.join(output, sbomPath), sbom(candidate, copied.sha256, input.sourceCommit), { flag: "wx" });
      const provenancePath = `${candidate.relativePath}.intoto.jsonl`;
      writeFileSync(path.join(output, provenancePath), provenance(candidate, copied.sha256, source, input.workflow), { flag: "wx" });
      artifacts.push({ ...copied, kind: candidate.kind, target: candidate.target, checksum: reference(output, checksumPath), sbom: reference(output, sbomPath), provenance: reference(output, provenancePath) });
    }
    const manifest: NativeEvidenceManifest = { schemaVersion: 1, source, workflow: input.workflow, workflowAttestation: null, releaseProjection: null, artifacts };
    writeFileSync(path.join(output, "native-evidence-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
    verifyNativeReleaseEvidence(output, input.sourceCommit, true);
    return manifest;
  } catch (error) {
    rmSync(output, { recursive: true, force: true });
    throw error;
  }
}

function assertReference(root: string, value: unknown, expectedPath: string, label: string): FileReference {
  const item = object(value, label); exactKeys(item, ["path", "size", "sha256"], label);
  if (item.path !== expectedPath || !Number.isSafeInteger(item.size) || Number(item.size) < 1 || typeof item.sha256 !== "string" || !SHA256.test(item.sha256)) throw new Error(`${label} is malformed or renamed.`);
  const actual = reference(root, expectedPath);
  if (actual.size !== item.size || actual.sha256 !== item.sha256) throw new Error(`${label} bytes do not match the manifest.`);
  return actual;
}

function attestedSubjects(value: unknown, depth = 0): Map<string, string> {
  if (depth > 8 || !value || typeof value !== "object") return new Map();
  const result = new Map<string, string>(); const item = value as Record<string, unknown>;
  if (Array.isArray(item.subject)) for (const raw of item.subject) {
    const subject = object(raw, "attestation subject"); const digest = object(subject.digest, "attestation subject digest");
    if (typeof subject.name === "string" && typeof digest.sha256 === "string") result.set(subject.name, digest.sha256);
  }
  if (typeof item.payload === "string") {
    try { for (const [name, digest] of attestedSubjects(JSON.parse(Buffer.from(item.payload, "base64").toString("utf8")), depth + 1)) result.set(name, digest); } catch { /* not a JSON DSSE payload */ }
  }
  for (const child of Object.values(item)) if (child && typeof child === "object") {
    for (const [name, digest] of attestedSubjects(child, depth + 1)) result.set(name, digest);
  }
  return result;
}

export function bindNativeWorkflowAttestation(directory: string, bundle: string): NativeEvidenceManifest {
  const root = path.resolve(directory); const manifestPath = path.join(root, "native-evidence-manifest.json");
  const manifest = verifyNativeReleaseEvidence(root, undefined, true);
  const destination = path.join(root, "workflow-provenance.sigstore.json");
  if (existsSync(destination)) throw new Error("Refusing to replace retained workflow attestation.");
  copyFileSync(path.resolve(bundle), destination, 0);
  manifest.workflowAttestation = reference(root, "workflow-provenance.sigstore.json");
  createReleaseProjection(root, manifest);
  manifest.releaseProjection = reference(root, "release-projection/native-release-manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return verifyNativeReleaseEvidence(root, manifest.source.commit);
}

export function writeNativeEvidenceSubjectChecksums(directory: string, output: string): void {
  const manifest = verifyNativeReleaseEvidence(directory, undefined, true);
  const subjects = manifest.artifacts.flatMap((entry) => [
    `${entry.sha256}  ${entry.path}`,
    ...(entry.kind === "application" ? [`${entry.sha256}  ${path.basename(entry.path)}`] : []),
  ]);
  writeFileSync(path.resolve(output), `${subjects.join("\n")}\n`, { flag: "wx" });
}

function createReleaseProjection(root: string, manifest: NativeEvidenceManifest): void {
  if (!manifest.workflowAttestation) throw new Error("Cannot project a release without trusted workflow provenance.");
  const context = loadNativeReleaseContext(ROOT); const output = path.join(root, "release-projection"); mkdirSync(output);
  const application = new Map(manifest.artifacts.filter((entry) => entry.kind === "application").map((entry) => [entry.target, entry]));
  const targets = context.policy.targets.map((target) => {
    const entry = application.get(target.id); if (!entry) throw new Error(`Missing accepted application archive for ${target.id}.`);
    const name = path.basename(entry.path); const archive = path.join(output, name); const sbomName = `${name}.spdx.json`; const provenanceName = `${name}.intoto.jsonl`;
    copyFileSync(path.join(root, entry.path), archive, 0);
    copyFileSync(path.join(root, entry.sbom.path), path.join(output, sbomName), 0);
    copyFileSync(path.join(root, manifest.workflowAttestation!.path), path.join(output, provenanceName), 0);
    const base = `${context.policy.immutableReleaseBase}/v${String(context.packageJson.version)}`;
    const releaseFile = (fileName: string) => ({ name: fileName, url: `${base}/${fileName}`, size: statSync(path.join(output, fileName)).size, sha256: sha256File(path.join(output, fileName)) });
    return { id: target.id, artifact: releaseFile(name), sbom: releaseFile(sbomName), provenance: releaseFile(provenanceName) };
  });
  for (const installer of manifest.artifacts.filter((entry) => entry.kind === "installer")) copyFileSync(path.join(root, installer.path), path.join(output, path.basename(installer.path)), 0);
  const downstream = context.integrationContract.downstream as Record<string, unknown>;
  const releaseManifest = {
    schemaVersion: 1,
    application: { version: context.packageJson.version, commit: manifest.source.commit, repository: context.policy.applicationRepository },
    downstream: { repository: downstream.repository, commit: downstream.headCommit, version: downstream.version, sdkVersion: (context.packageJson.dependencies as Record<string, unknown>)["@opencode-ai/sdk"], pluginVersion: (context.packageJson.devDependencies as Record<string, unknown>)["@opencode-ai/plugin"] },
    targets,
  };
  writeFileSync(path.join(output, "native-release-manifest.json"), serializeNativeReleaseManifest(releaseManifest, context), { flag: "wx" });
}

export function verifyNativeReleaseEvidence(directory: string, expectedCommit?: string, allowUnsigned = false): NativeEvidenceManifest {
  const root = path.resolve(directory);
  const manifest = object(JSON.parse(readFileSync(path.join(root, "native-evidence-manifest.json"), "utf8")), "manifest");
  exactKeys(manifest, ["schemaVersion", "source", "workflow", "workflowAttestation", "releaseProjection", "artifacts"], "manifest");
  if (manifest.schemaVersion !== 1) throw new Error("Unknown native evidence manifest schema version.");
  const source = object(manifest.source, "manifest.source"); exactKeys(source, ["repository", "commit"], "manifest.source");
  const workflow = object(manifest.workflow, "manifest.workflow"); exactKeys(workflow, ["repository", "workflow", "ref", "sha", "runId", "runAttempt"], "manifest.workflow");
  if (typeof source.repository !== "string" || !COMMIT.test(String(source.commit)) || source.commit !== workflow.sha || (expectedCommit && source.commit !== expectedCommit)) throw new Error("Evidence source commit does not match the workflow identity.");
  if (!Array.isArray(manifest.artifacts)) throw new Error("Manifest artifacts must be an array.");
  const expectedCandidates = candidateSet("/unused/runtime", "/unused/application").map(({ kind, target, relativePath }) => ({ kind, target, relativePath }));
  if (manifest.artifacts.length !== expectedCandidates.length) throw new Error("Native evidence manifest has a missing or extra artifact.");
  const expectedFiles = new Set(["native-evidence-manifest.json"]);
  for (let index = 0; index < expectedCandidates.length; index += 1) {
    const expected = expectedCandidates[index]; const entry = object(manifest.artifacts[index], `manifest.artifacts[${index}]`);
    exactKeys(entry, ["kind", "target", "path", "size", "sha256", "checksum", "sbom", "provenance"], `manifest.artifacts[${index}]`);
    if (entry.kind !== expected.kind || entry.target !== expected.target) throw new Error("Native evidence artifact order, kind, or target was changed.");
    const artifact = assertReference(root, { path: entry.path, size: entry.size, sha256: entry.sha256 }, expected.relativePath, `${expected.relativePath} artifact`);
    const companionPaths = { checksum: `${expected.relativePath}.sha256`, sbom: `${expected.relativePath}.spdx.json`, provenance: `${expected.relativePath}.intoto.jsonl` };
    const companions = Object.fromEntries(Object.entries(companionPaths).map(([name, item]) => [name, assertReference(root, entry[name], item, `${expected.relativePath} ${name}`)]));
    for (const file of [artifact.path, ...Object.values(companions).map((item) => item.path)]) expectedFiles.add(file);
    if (readFileSync(path.join(root, companions.checksum.path), "utf8") !== `${artifact.sha256}  ${path.basename(artifact.path)}\n`) throw new Error(`${artifact.path} checksum record is invalid.`);
    const parsedSbom = object(JSON.parse(readFileSync(path.join(root, companions.sbom.path), "utf8")), `${artifact.path} SBOM`);
    const sbomFile = object((parsedSbom.files as unknown[])?.[0], `${artifact.path} SBOM file`);
    const sbomChecksum = object((sbomFile.checksums as unknown[])?.[0], `${artifact.path} SBOM checksum`);
    if (sbomFile.fileName !== artifact.path || sbomChecksum.algorithm !== "SHA256" || sbomChecksum.checksumValue !== artifact.sha256) throw new Error(`${artifact.path} SBOM is not bound to the retained bytes.`);
    const attestation = object(JSON.parse(readFileSync(path.join(root, companions.provenance.path), "utf8")), `${artifact.path} provenance statement`);
    const subject = object((attestation.subject as unknown[])?.[0], `${artifact.path} provenance subject`); const subjectDigest = object(subject.digest, `${artifact.path} provenance digest`);
    const predicate = object(attestation.predicate, `${artifact.path} provenance predicate`); const definition = object(predicate.buildDefinition, `${artifact.path} provenance build definition`); const parameters = object(definition.externalParameters, `${artifact.path} provenance external parameters`);
    if (subject.name !== path.basename(artifact.path) || subjectDigest.sha256 !== artifact.sha256 || JSON.stringify(parameters.source) !== JSON.stringify(source) || JSON.stringify(parameters.workflow) !== JSON.stringify(workflow)) throw new Error(`${artifact.path} provenance is not bound to the source, workflow, and retained bytes.`);
  }
  if (manifest.workflowAttestation === null) {
    if (!allowUnsigned) throw new Error("Trusted workflow attestation is missing.");
    if (manifest.releaseProjection !== null) throw new Error("Unsigned native evidence cannot contain a release projection.");
  } else {
    const attestation = assertReference(root, manifest.workflowAttestation, "workflow-provenance.sigstore.json", "manifest.workflowAttestation"); expectedFiles.add(attestation.path);
    const bundle = JSON.parse(readFileSync(path.join(root, attestation.path), "utf8")); const subjects = attestedSubjects(bundle);
    for (const entry of manifest.artifacts as unknown as ArtifactEntry[]) if (subjects.get(entry.path) !== entry.sha256) throw new Error(`${entry.path} is missing from the trusted workflow attestation.`);
    const serialized = JSON.stringify(bundle);
    if (!serialized.includes("verificationMaterial") || !serialized.includes("tlogEntries")) throw new Error("Workflow attestation lacks Sigstore verification material.");
    const projection = assertReference(root, manifest.releaseProjection, "release-projection/native-release-manifest.json", "manifest.releaseProjection"); expectedFiles.add(projection.path);
    const release = validateNativeReleaseManifest(JSON.parse(readFileSync(path.join(root, projection.path), "utf8")));
    const application = new Map((manifest.artifacts as unknown as ArtifactEntry[]).filter((entry) => entry.kind === "application").map((entry) => [entry.target, entry]));
    for (const target of release.targets) {
      const entry = application.get(target.id); if (!entry) throw new Error(`Release projection contains an unaccepted target: ${target.id}.`);
      for (const [kind, releaseFile] of [["artifact", target.artifact], ["sbom", target.sbom], ["provenance", target.provenance]] as const) {
        const relative = `release-projection/${releaseFile.name}`; expectedFiles.add(relative);
        const actual = reference(root, relative);
        if (actual.size !== releaseFile.size || actual.sha256 !== releaseFile.sha256) throw new Error(`Release projection ${kind} bytes do not match its native release manifest entry.`);
      }
      if (sha256File(path.join(root, entry.path)) !== target.artifact.sha256 || sha256File(path.join(root, entry.sbom.path)) !== target.sbom.sha256) throw new Error(`${target.id} release projection is not byte-identical to accepted application evidence.`);
      const projectedBundle = JSON.parse(readFileSync(path.join(root, `release-projection/${target.provenance.name}`), "utf8"));
      if (attestedSubjects(projectedBundle).get(target.artifact.name) !== target.artifact.sha256) throw new Error(`${target.id} projected provenance does not contain its trusted canonical-name attestation.`);
    }
    for (const installer of (manifest.artifacts as unknown as ArtifactEntry[]).filter((entry) => entry.kind === "installer")) {
      const relative = `release-projection/${path.basename(installer.path)}`; expectedFiles.add(relative);
      if (sha256File(path.join(root, relative)) !== installer.sha256) throw new Error(`${relative} is not byte-identical to accepted installer evidence.`);
    }
  }
  const actualFiles = walk(root);
  if (actualFiles.length !== expectedFiles.size || actualFiles.some((item) => !expectedFiles.has(item))) throw new Error("Native evidence set contains a missing, extra, or renamed file.");
  return manifest as unknown as NativeEvidenceManifest;
}

function option(name: string): string | undefined { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; }
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  if (command === "assemble") {
    const names = ["runtime", "application", "output", "commit", "repository", "workflow", "ref", "run-id", "run-attempt"] as const;
    const values = Object.fromEntries(names.map((name) => [name, option(`--${name}`)]));
    if (Object.values(values).some((value) => !value)) throw new Error(`Usage: native-release-evidence.ts assemble ${names.map((name) => `--${name} <value>`).join(" ")}`);
    const result = assembleNativeReleaseEvidence({ runtimeDirectory: values.runtime!, applicationDirectory: values.application!, outputDirectory: values.output!, sourceCommit: values.commit!, workflow: { repository: values.repository!, workflow: values.workflow!, ref: values.ref!, sha: values.commit!, runId: values["run-id"]!, runAttempt: values["run-attempt"]! } });
    process.stdout.write(`Assembled ${result.artifacts.length} native release candidates pending trusted workflow attestation.\n`);
  } else if (command === "subjects") {
    const directory = option("--directory"); const output = option("--output"); if (!directory || !output) throw new Error("Usage: native-release-evidence.ts subjects --directory <directory> --output <checksums>");
    writeNativeEvidenceSubjectChecksums(directory, output);
  } else if (command === "bind-attestation") {
    const directory = option("--directory"); const bundle = option("--bundle"); if (!directory || !bundle) throw new Error("Usage: native-release-evidence.ts bind-attestation --directory <directory> --bundle <sigstore-bundle>");
    const result = bindNativeWorkflowAttestation(directory, bundle); process.stdout.write(`Bound trusted workflow provenance to ${result.artifacts.length} native release candidates.\n`);
  } else if (command === "verify") {
    const directory = option("--directory"); if (!directory) throw new Error("Usage: native-release-evidence.ts verify --directory <directory> [--commit <sha>]");
    const result = verifyNativeReleaseEvidence(directory, option("--commit")); process.stdout.write(`Verified ${result.artifacts.length} retained native release candidates.\n`);
  } else throw new Error("Usage: native-release-evidence.ts assemble|subjects|bind-attestation|verify ...");
}
