import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]+$/;
const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/;
const RELEASE_URL = /^https:\/\/github\.com\/virusimmortal00\/AllMyFriendsAreAgents\/releases\/download\/v[^/?#]+\/[^/?#]+$/;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_FORMULA_PATH = path.join(ROOT, "homebrew/Formula/amfaa.rb");

// Homebrew targets covered today. The manifest also carries linux-arm64,
// linux-x64, and windows-x64, but the formula (and the tap plan in
// docs/operations/native-releases.md) defers those until Linuxbrew/Windows
// support is proven out -- see GitHub issue #200.
const HOMEBREW_TARGETS = [
  { id: "darwin-arm64", block: "on_arm" },
  { id: "darwin-x64", block: "on_intel" },
] as const;

interface ManifestFile {
  readonly name: string;
  readonly url: string;
  readonly size: number;
  readonly sha256: string;
}

interface ManifestTarget {
  readonly id: string;
  readonly artifact: ManifestFile;
}

export interface HomebrewSourceManifest {
  readonly schemaVersion: 1;
  readonly application: { readonly version: string; readonly commit: string };
  readonly targets: readonly ManifestTarget[];
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${label} must be a non-empty string.`);
  return value;
}

function parseFile(value: unknown, label: string): ManifestFile {
  const file = object(value, label);
  const name = string(file.name, `${label}.name`);
  const url = string(file.url, `${label}.url`);
  const size = file.size;
  const sha256 = string(file.sha256, `${label}.sha256`);
  if (!SAFE_NAME.test(name)) throw new Error(`${label}.name is malformed.`);
  if (!RELEASE_URL.test(url)) throw new Error(`${label}.url must be an immutable AllMyFriendsAreAgents release download URL.`);
  if (!Number.isSafeInteger(size) || Number(size) < 1) throw new Error(`${label}.size must be a positive safe integer.`);
  if (!SHA256.test(sha256)) throw new Error(`${label}.sha256 must be a lowercase SHA-256 digest.`);
  return { name, url, size: Number(size), sha256 };
}

/**
 * Parse and minimally validate a native-release-manifest.json payload for the
 * fields the Homebrew formula needs. This intentionally does not reuse the
 * stricter, repo-context-bound checks in scripts/native-release-contract.ts
 * (which assert the manifest matches the *current* checkout's package.json,
 * integration contract, and Dockerfile) -- bumping the formula is a
 * downstream, decoupled step that only needs the manifest to be well-formed.
 */
export function parseHomebrewSourceManifest(value: unknown): HomebrewSourceManifest {
  const manifest = object(value, "manifest");
  if (manifest.schemaVersion !== 1) throw new Error("Unknown native release manifest schema version.");
  const application = object(manifest.application, "manifest.application");
  const version = string(application.version, "manifest.application.version");
  const commit = string(application.commit, "manifest.application.commit");
  if (!SEMVER.test(version)) throw new Error("manifest.application.version must be semantic versioning without build metadata.");
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("manifest.application.commit must be a full lowercase commit SHA.");
  if (!Array.isArray(manifest.targets)) throw new Error("manifest.targets must be an array.");
  const targets = manifest.targets.map((raw, index) => {
    const target = object(raw, `manifest.targets[${index}]`);
    const id = string(target.id, `manifest.targets[${index}].id`);
    const artifact = parseFile(target.artifact, `manifest.targets[${index}].artifact`);
    return { id, artifact };
  });
  for (const { id } of HOMEBREW_TARGETS) {
    if (!targets.some((target) => target.id === id)) throw new Error(`manifest.targets is missing the required "${id}" target.`);
  }
  return { schemaVersion: 1, application: { version, commit }, targets };
}

export function loadHomebrewSourceManifest(manifestPath: string): HomebrewSourceManifest {
  return parseHomebrewSourceManifest(JSON.parse(readFileSync(manifestPath, "utf8")));
}

function findArtifact(manifest: HomebrewSourceManifest, id: string): ManifestFile {
  const target = manifest.targets.find((entry) => entry.id === id);
  if (!target) throw new Error(`manifest.targets is missing the required "${id}" target.`);
  return target.artifact;
}

/**
 * Render homebrew/Formula/amfaa.rb from a native release manifest. Keep this
 * formula's `install`/`test` shape in sync by hand when it needs to change;
 * only the version/url/sha256 fields are generated.
 */
export function renderHomebrewFormula(manifest: HomebrewSourceManifest): string {
  const { version } = manifest.application;
  const platforms = HOMEBREW_TARGETS.map(({ id, block }) => {
    const artifact = findArtifact(manifest, id);
    return `    ${block} do\n      url "${artifact.url}"\n      sha256 "${artifact.sha256}"\n    end`;
  }).join("\n\n");

  return `# frozen_string_literal: true

# Generated by scripts/update-homebrew-formula.ts from the
# native-release-manifest.json published with v${version}. Do not hand-edit the
# version/url/sha256 fields below -- rerun the script against a release
# manifest instead. See homebrew/README.md for how this formula is used until
# it moves to a dedicated tap repository.
class Amfaa < Formula
  desc "Multi-agent chatroom for coding with AI models (native app)"
  homepage "https://github.com/virusimmortal00/AllMyFriendsAreAgents"
  license "MIT"
  depends_on :macos

  on_macos do
${platforms}
  end

  def install
    # The published archive is a fully self-contained bundle: it ships its
    # own pinned Node.js runtime and the audited OpenCode runtime, so no
    # other dependency is declared here. Its "amfaa" launcher locates the
    # sibling active-version/versions/ directories relative to its own real
    # path (see scripts/install-native.sh), so it must keep living in
    # libexec -- write an exec wrapper into bin rather than a symlink.
    libexec.install Dir["*"]
    bin.write_exec_script libexec/"amfaa"
  end

  test do
    identity = JSON.parse(shell_output("#{bin}/amfaa version"))
    assert_equal version.to_s, identity.fetch("application").fetch("version")
  end
end
`;
}

export function generateHomebrewFormula(manifestPath: string): string {
  return renderHomebrewFormula(loadHomebrewSourceManifest(manifestPath));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [manifestArg, outArg] = process.argv.slice(2);
  if (!manifestArg) throw new Error("Usage: update-homebrew-formula.ts <native-release-manifest.json> [output-formula.rb]");
  const formula = generateHomebrewFormula(path.resolve(manifestArg));
  const outputPath = outArg ? path.resolve(outArg) : DEFAULT_FORMULA_PATH;
  writeFileSync(outputPath, formula);
  process.stdout.write(`Wrote ${path.relative(ROOT, outputPath)}\n`);
}
