import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]+$/;
const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/;
const RELEASE_URL = /^https:\/\/github\.com\/virusimmortal00\/AllMyFriendsAreAgents\/releases\/download\/v[^/?#]+\/[^/?#]+$/;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_CASK_PATH = path.join(ROOT, "homebrew/Casks/amfaa.rb");

// Homebrew targets covered today. The manifest also carries linux-arm64,
// linux-x64, and windows-x64, but the cask (and the tap plan in
// docs/operations/native-releases.md) defers those until Linuxbrew/Windows
// support is proven out -- see GitHub issue #200.
const HOMEBREW_TARGETS = [
  { id: "darwin-arm64", archKey: "arm" },
  { id: "darwin-x64", archKey: "intel" },
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
 * fields the Homebrew cask needs. This intentionally does not reuse the
 * stricter, repo-context-bound checks in scripts/native-release-contract.ts
 * (which assert the manifest matches the *current* checkout's package.json,
 * integration contract, and Dockerfile) -- bumping the cask is a
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
 * Render homebrew/Casks/amfaa.rb from a native release manifest. Keep this
 * cask's `postflight_steps`/`uninstall` shape in sync by hand when it needs
 * to change; only the version/url/sha256 fields are generated.
 *
 * This ships as a Cask, not a Formula: Homebrew's Mach-O linkage-fixing pass
 * (which every from-source Formula install runs unconditionally) rewrites
 * embedded dylib IDs to match the install path, and can overflow a vendored
 * native addon's Mach-O header padding once rewritten against this bundle's
 * deeply nested Caskroom path -- observed with the published archive's
 * bundled @rollup/rollup-darwin-arm64 native addon. Casks stage files as-is
 * with no relinking.
 */
export function renderHomebrewCask(manifest: HomebrewSourceManifest): string {
  const { version } = manifest.application;
  const arm = findArtifact(manifest, "darwin-arm64");
  const intel = findArtifact(manifest, "darwin-x64");
  // Cask's `url` stanza has no per-arch filter keyword (a two-stanza,
  // `arch:`-qualified form looks valid to `brew style` but fails to load
  // with "unknown keyword: :arch" -- verified against a real `brew audit`).
  // Interpolate the `arch` DSL method into one url instead, matching the
  // release asset naming convention scripts/install-native.sh also assumes
  // (`all-my-friends-are-agents-v<version>-<target>.tar.gz`). Both artifacts'
  // real URLs are still checked against that same convention below so a
  // manifest that ever deviates from it fails loudly instead of silently
  // generating a cask that points at the wrong bytes.
  const expectedUrl = (artifact: ManifestFile, target: string) => {
    const expected = `https://github.com/virusimmortal00/AllMyFriendsAreAgents/releases/download/v${version}/all-my-friends-are-agents-v${version}-${target}.tar.gz`;
    if (artifact.url !== expected) throw new Error(`manifest artifact url for "${target}" does not match the expected release asset naming convention.`);
  };
  expectedUrl(arm, "darwin-arm64");
  expectedUrl(intel, "darwin-x64");

  return `# frozen_string_literal: true

# Generated by scripts/update-homebrew-formula.ts from the
# native-release-manifest.json published with v${version}. Do not hand-edit the
# version/url/sha256 fields below -- rerun the script against a release
# manifest instead. See homebrew/README.md for how this cask is used until it
# moves to a dedicated tap repository.
cask "amfaa" do
  arch arm: "darwin-arm64", intel: "darwin-x64"

  version "${version}"
  sha256 arm:   "${arm.sha256}",
         intel: "${intel.sha256}"

  url "https://github.com/virusimmortal00/AllMyFriendsAreAgents/releases/download/v#{version}/all-my-friends-are-agents-v#{version}-#{arch}.tar.gz"
  name "All My Friends Are Agents"
  desc "Multi-agent chatroom for coding with AI models (native app)"
  homepage "https://github.com/virusimmortal00/AllMyFriendsAreAgents"

  # This is a Cask, not a Formula, specifically to avoid Homebrew's Mach-O
  # linkage-fixing pass, which every from-source Formula install runs
  # unconditionally: the published archive is a fully self-contained bundle
  # (its own pinned Node.js runtime, the audited OpenCode runtime, and a full
  # production node_modules tree), and rewriting embedded dylib IDs to this
  # bundle's deeply nested Caskroom path can overflow a vendored native
  # addon's Mach-O header padding. Casks stage files as-is with no relinking.
  #
  # The "amfaa" launcher locates its sibling active-version/versions/
  # directories relative to its own real invocation path (see
  # scripts/install-native.sh), so it must keep living in the stable
  # per-version Caskroom directory -- write an exec wrapper into
  # HOMEBREW_PREFIX/bin rather than using the \`binary\` stanza, which would
  # symlink it there instead. \`{{staged_path}}\` is expanded by Homebrew's
  # install-steps runner to this cask's actual Caskroom directory.
  postflight_steps do
    write_file "bin/amfaa", <<~SH, base: "homebrew_prefix"
      #!/bin/sh
      # AMFAA Homebrew Cask-managed launcher
      exec "{{staged_path}}/all-my-friends-are-agents/amfaa" "$@"
    SH
    set_permissions "bin/amfaa", "0755", base: "homebrew_prefix", recursive: false
  end

  uninstall delete: "#{HOMEBREW_PREFIX}/bin/amfaa"

  caveats do
    <<~EOS
      Run "amfaa" from the project directory you want agents to inspect to
      finish first-time setup. See the Quick start section of
      https://github.com/virusimmortal00/AllMyFriendsAreAgents#readme
    EOS
  end
end
`;
}

export function generateHomebrewCask(manifestPath: string): string {
  return renderHomebrewCask(loadHomebrewSourceManifest(manifestPath));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [manifestArg, outArg] = process.argv.slice(2);
  if (!manifestArg) throw new Error("Usage: update-homebrew-formula.ts <native-release-manifest.json> [output-cask.rb]");
  const cask = generateHomebrewCask(path.resolve(manifestArg));
  const outputPath = outArg ? path.resolve(outArg) : DEFAULT_CASK_PATH;
  writeFileSync(outputPath, cask);
  process.stdout.write(`Wrote ${path.relative(ROOT, outputPath)}\n`);
}
