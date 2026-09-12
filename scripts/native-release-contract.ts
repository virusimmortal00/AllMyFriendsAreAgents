import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const COMMIT = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/;
const REPOSITORY = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]+$/;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

type JsonObject = Record<string, unknown>;

export interface NativeTargetPolicy {
  readonly schemaVersion: 1;
  readonly applicationRepository: string;
  readonly immutableReleaseBase: string;
  readonly nodeRuntime: { readonly version: string };
  readonly downstreamEvidence: {
    readonly integrationContract: string;
    readonly containerBuild: string;
    readonly publicIssue: string;
    readonly branch: string;
    readonly verifiedBranchHead: string;
  };
  readonly targets: readonly {
    readonly id: string;
    readonly os: string;
    readonly architecture: string;
    readonly archiveExtension: string;
  }[];
  readonly deferredTargets: readonly { readonly id: string; readonly reason: string }[];
}

export interface NativeReleaseFile {
  readonly name: string;
  readonly url: string;
  readonly size: number;
  readonly sha256: string;
}

export interface NativeReleaseManifest {
  readonly schemaVersion: 1;
  readonly application: { readonly version: string; readonly commit: string; readonly repository: string };
  readonly downstream: {
    readonly repository: string;
    readonly commit: string;
    readonly version: string;
    readonly sdkVersion: string;
    readonly pluginVersion: string;
  };
  readonly targets: readonly {
    readonly id: string;
    readonly artifact: NativeReleaseFile;
    readonly sbom: NativeReleaseFile;
    readonly provenance: NativeReleaseFile;
  }[];
}

export interface NativeReleaseContext {
  readonly policy: NativeTargetPolicy;
  readonly integrationContract: JsonObject;
  readonly packageJson: JsonObject;
  readonly dockerfile: string;
}

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as JsonObject;
}

function exactKeys(value: JsonObject, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} contains missing or unknown fields.`);
  }
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${label} must be a non-empty string.`);
  return value;
}

function parseFile(value: unknown, label: string): NativeReleaseFile {
  const file = object(value, label);
  exactKeys(file, ["name", "url", "size", "sha256"], label);
  const name = string(file.name, `${label}.name`);
  const url = string(file.url, `${label}.url`);
  const size = file.size;
  const sha256 = string(file.sha256, `${label}.sha256`);
  if (!SAFE_NAME.test(name)) throw new Error(`${label}.name is malformed.`);
  if (!Number.isSafeInteger(size) || Number(size) < 1) throw new Error(`${label}.size must be a positive safe integer.`);
  if (!SHA256.test(sha256)) throw new Error(`${label}.sha256 must be a lowercase SHA-256 digest.`);
  return { name, url, size: Number(size), sha256 };
}

export function loadNativeReleaseContext(root = ROOT): NativeReleaseContext {
  const policy = JSON.parse(readFileSync(path.join(root, "release/native-target-policy.json"), "utf8")) as NativeTargetPolicy;
  const integrationContract = JSON.parse(readFileSync(path.join(root, policy.downstreamEvidence.integrationContract), "utf8")) as JsonObject;
  const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as JsonObject;
  const dockerfile = readFileSync(path.join(root, policy.downstreamEvidence.containerBuild), "utf8");
  assertNativeReleaseContext({ policy, integrationContract, packageJson, dockerfile });
  return { policy, integrationContract, packageJson, dockerfile };
}

export function assertNativeReleaseContext(context: NativeReleaseContext): void {
  const { policy, integrationContract, packageJson, dockerfile } = context;
  if (policy.schemaVersion !== 1) throw new Error("Unknown native target policy schema version.");
  if (policy.nodeRuntime.version !== "24.5.0") throw new Error("Native target policy must pin the reviewed Node.js runtime version.");
  if (!REPOSITORY.test(policy.applicationRepository)) throw new Error("Target policy application repository is malformed.");
  if (policy.immutableReleaseBase !== policy.applicationRepository.slice(0, -4) + "/releases/download") throw new Error("Target policy release base must belong to the application repository.");
  const targetIds = policy.targets.map((target) => target.id);
  const expected = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "windows-x64"];
  if (targetIds.length !== expected.length || targetIds.some((id, index) => id !== expected[index])) throw new Error("Native target policy must declare the complete ordered initial target matrix.");
  if (new Set(targetIds).size !== targetIds.length) throw new Error("Native target policy contains duplicate targets.");
  const windowsArm = policy.deferredTargets.find((target) => target.id === "windows-arm64");
  if (!windowsArm?.reason.trim()) throw new Error("Native target policy must explain the Windows ARM64 deferral.");

  const downstream = object(integrationContract.downstream, "integration contract downstream");
  const repository = string(downstream.repository, "integration contract downstream repository");
  const branch = string(downstream.branch, "integration contract downstream branch");
  const commit = string(downstream.headCommit, "integration contract downstream head commit");
  const version = string(downstream.version, "integration contract downstream version");
  const pluginVersion = string(downstream.pluginVersion, "integration contract plugin version");
  if (!REPOSITORY.test(repository) || !COMMIT.test(commit)) throw new Error("Integration contract downstream provenance is malformed.");
  if (branch !== policy.downstreamEvidence.branch || commit !== policy.downstreamEvidence.verifiedBranchHead) throw new Error("Target policy conflicts with the admitted downstream branch provenance.");
  const sdkVersion = object(packageJson.dependencies, "package dependencies")["@opencode-ai/sdk"];
  const installedPluginVersion = object(packageJson.devDependencies, "package development dependencies")["@opencode-ai/plugin"];
  if (sdkVersion !== pluginVersion || installedPluginVersion !== pluginVersion) throw new Error("SDK and plugin compatibility versions conflict with the integration contract.");
  for (const [key, expectedValue] of [["OPENCODE_REPOSITORY", repository], ["OPENCODE_COMMIT", commit], ["OPENCODE_VERSION", version]] as const) {
    const values = [...dockerfile.matchAll(new RegExp(`^ARG ${key}=(.+)$`, "gm"))].map((match) => match[1]);
    if (!values.length || values.some((value) => value !== expectedValue)) throw new Error(`Dockerfile ${key} conflicts with the integration contract.`);
  }
}

export function validateNativeReleaseManifest(value: unknown, context = loadNativeReleaseContext()): NativeReleaseManifest {
  assertNativeReleaseContext(context);
  const manifest = object(value, "manifest");
  exactKeys(manifest, ["schemaVersion", "application", "downstream", "targets"], "manifest");
  if (manifest.schemaVersion !== 1) throw new Error("Unknown native release manifest schema version.");

  const application = object(manifest.application, "manifest.application");
  exactKeys(application, ["version", "commit", "repository"], "manifest.application");
  const applicationVersion = string(application.version, "manifest.application.version");
  const applicationCommit = string(application.commit, "manifest.application.commit");
  const applicationRepository = string(application.repository, "manifest.application.repository");
  if (!SEMVER.test(applicationVersion)) throw new Error("Application version must be semantic versioning without build metadata.");
  if (applicationVersion !== context.packageJson.version) throw new Error("Application version conflicts with package provenance.");
  if (!COMMIT.test(applicationCommit)) throw new Error("Application commit must be a full lowercase commit SHA.");
  if (applicationRepository !== context.policy.applicationRepository) throw new Error("Application repository conflicts with the native target policy.");

  const downstream = object(manifest.downstream, "manifest.downstream");
  exactKeys(downstream, ["repository", "commit", "version", "sdkVersion", "pluginVersion"], "manifest.downstream");
  const contractDownstream = object(context.integrationContract.downstream, "integration contract downstream");
  const expectedDownstream = {
    repository: contractDownstream.repository,
    commit: contractDownstream.headCommit,
    version: contractDownstream.version,
    sdkVersion: object(context.packageJson.dependencies, "package dependencies")["@opencode-ai/sdk"],
    pluginVersion: object(context.packageJson.devDependencies, "package development dependencies")["@opencode-ai/plugin"],
  };
  for (const [key, expectedValue] of Object.entries(expectedDownstream)) {
    if (downstream[key] !== expectedValue) throw new Error(`Manifest downstream ${key} conflicts with admitted provenance or compatibility.`);
  }

  if (!Array.isArray(manifest.targets) || !manifest.targets.length) throw new Error("Manifest must contain at least one native target.");
  const supported = new Map(context.policy.targets.map((target, index) => [target.id, { ...target, index }]));
  const seenTargets = new Set<string>();
  const seenReferences = new Set<string>();
  const releaseBase = `${context.policy.immutableReleaseBase}/v${applicationVersion}`;
  const targets = manifest.targets.map((rawTarget, position) => {
    const target = object(rawTarget, `manifest.targets[${position}]`);
    exactKeys(target, ["id", "artifact", "sbom", "provenance"], `manifest.targets[${position}]`);
    const id = string(target.id, `manifest.targets[${position}].id`);
    const policyTarget = supported.get(id);
    if (!policyTarget) throw new Error(`Unsupported native release target: ${id}.`);
    if (seenTargets.has(id)) throw new Error(`Duplicate native release target: ${id}.`);
    seenTargets.add(id);
    const artifact = parseFile(target.artifact, `${id}.artifact`);
    const sbom = parseFile(target.sbom, `${id}.sbom`);
    const provenance = parseFile(target.provenance, `${id}.provenance`);
    const expectedName = `all-my-friends-are-agents-v${applicationVersion}-${id}${policyTarget.archiveExtension}`;
    if (artifact.name !== expectedName) throw new Error(`${id} artifact name is not the immutable canonical name.`);
    if (sbom.name !== `${expectedName}.spdx.json`) throw new Error(`${id} SBOM name is not bound to the artifact.`);
    if (provenance.name !== `${expectedName}.intoto.jsonl`) throw new Error(`${id} provenance name is not bound to the artifact.`);
    for (const file of [artifact, sbom, provenance]) {
      let parsed: URL;
      try { parsed = new URL(file.url); } catch { throw new Error(`${id} contains a malformed artifact reference.`); }
      if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.origin !== "https://github.com" || file.url !== `${releaseBase}/${file.name}`) {
        throw new Error(`${id} contains a mutable, credentialed, or malformed artifact reference.`);
      }
      for (const reference of [file.name, file.url]) {
        if (seenReferences.has(reference)) throw new Error(`Duplicate native release file reference: ${reference}.`);
        seenReferences.add(reference);
      }
    }
    return { id, artifact, sbom, provenance, order: policyTarget.index };
  });
  if (seenTargets.size !== supported.size) throw new Error("Manifest must contain the complete supported native target matrix.");
  targets.sort((left, right) => left.order - right.order);

  return {
    schemaVersion: 1,
    application: { version: applicationVersion, commit: applicationCommit, repository: applicationRepository },
    downstream: expectedDownstream as NativeReleaseManifest["downstream"],
    targets: targets.map(({ order: _order, ...target }) => target),
  };
}

export function generateNativeReleaseManifest(input: unknown, context = loadNativeReleaseContext()): NativeReleaseManifest {
  return validateNativeReleaseManifest(input, context);
}

export function serializeNativeReleaseManifest(input: unknown, context = loadNativeReleaseContext()): string {
  return `${JSON.stringify(generateNativeReleaseManifest(input, context), null, 2)}\n`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, inputPath, extra] = process.argv.slice(2);
  if (extra || !inputPath || (command !== "--validate" && command !== "--generate")) throw new Error("Usage: native-release-contract.ts --validate|--generate <manifest.json>");
  const input = JSON.parse(readFileSync(path.resolve(inputPath), "utf8"));
  const output = serializeNativeReleaseManifest(input);
  if (command === "--generate") process.stdout.write(output);
}
