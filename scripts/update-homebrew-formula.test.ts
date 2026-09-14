import { describe, expect, it } from "vitest";
import { generateHomebrewCask, parseHomebrewSourceManifest, renderHomebrewCask } from "./update-homebrew-formula.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

function file(name: string, sha256 = "a".repeat(64)) {
  return {
    name,
    url: `https://github.com/virusimmortal00/AllMyFriendsAreAgents/releases/download/v1.2.3/${name}`,
    size: 123,
    sha256,
  };
}

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    application: { version: "1.2.3", commit: "b".repeat(40) },
    targets: [
      { id: "darwin-arm64", artifact: file("all-my-friends-are-agents-v1.2.3-darwin-arm64.tar.gz", "1".repeat(64)) },
      { id: "darwin-x64", artifact: file("all-my-friends-are-agents-v1.2.3-darwin-x64.tar.gz", "2".repeat(64)) },
      { id: "linux-x64", artifact: file("all-my-friends-are-agents-v1.2.3-linux-x64.tar.gz", "3".repeat(64)) },
    ],
    ...overrides,
  };
}

describe("parseHomebrewSourceManifest", () => {
  it("accepts a well-formed manifest carrying both darwin targets", () => {
    const parsed = parseHomebrewSourceManifest(manifest());
    expect(parsed.application.version).toBe("1.2.3");
    expect(parsed.targets.map((target) => target.id)).toEqual(["darwin-arm64", "darwin-x64", "linux-x64"]);
  });

  it("rejects an unknown schema version", () => {
    expect(() => parseHomebrewSourceManifest(manifest({ schemaVersion: 2 }))).toThrow(/schema version/);
  });

  it("rejects a non-semantic-versioning application version", () => {
    expect(() => parseHomebrewSourceManifest(manifest({ application: { version: "v1.2.3", commit: "b".repeat(40) } }))).toThrow(/version/);
  });

  it("rejects a malformed commit", () => {
    expect(() => parseHomebrewSourceManifest(manifest({ application: { version: "1.2.3", commit: "not-a-sha" } }))).toThrow(/commit/);
  });

  it("rejects a manifest missing the darwin-arm64 target", () => {
    const withoutArm = manifest();
    withoutArm.targets = withoutArm.targets.filter((target) => target.id !== "darwin-arm64");
    expect(() => parseHomebrewSourceManifest(withoutArm)).toThrow(/darwin-arm64/);
  });

  it("rejects a manifest missing the darwin-x64 target", () => {
    const withoutIntel = manifest();
    withoutIntel.targets = withoutIntel.targets.filter((target) => target.id !== "darwin-x64");
    expect(() => parseHomebrewSourceManifest(withoutIntel)).toThrow(/darwin-x64/);
  });

  it("rejects an artifact with a non-hex sha256", () => {
    const bad = manifest();
    bad.targets = bad.targets.map((target) =>
      target.id === "darwin-arm64" ? { ...target, artifact: { ...target.artifact, sha256: "zz".repeat(32) } } : target,
    );
    expect(() => parseHomebrewSourceManifest(bad)).toThrow(/sha256/);
  });

  it("rejects an artifact URL outside the immutable release base", () => {
    const bad = manifest();
    bad.targets = bad.targets.map((target) =>
      target.id === "darwin-arm64" ? { ...target, artifact: { ...target.artifact, url: "https://example.com/evil.tar.gz" } } : target,
    );
    expect(() => parseHomebrewSourceManifest(bad)).toThrow(/immutable/);
  });
});

describe("renderHomebrewCask", () => {
  it("embeds the version and per-arch sha256 pairs, and an arch-interpolated url", () => {
    const parsed = parseHomebrewSourceManifest(manifest());
    const cask = renderHomebrewCask(parsed);
    expect(cask).toContain('cask "amfaa" do');
    expect(cask).toContain("published with v1.2.3");
    expect(cask).toContain('version "1.2.3"');
    expect(cask).toContain(`sha256 arm:   "${"1".repeat(64)}"`);
    expect(cask).toContain(`intel: "${"2".repeat(64)}"`);
    expect(cask).toContain('url "https://github.com/virusimmortal00/AllMyFriendsAreAgents/releases/download/v#{version}/all-my-friends-are-agents-v#{version}-#{arch}.tar.gz"');
  });

  it("rejects an artifact URL that does not match the expected release asset naming convention", () => {
    const bad = manifest();
    bad.targets = bad.targets.map((target) =>
      target.id === "darwin-arm64" ? { ...target, artifact: { ...target.artifact, url: target.artifact.url.replace("all-my-friends-are-agents-v1.2.3", "renamed") } } : target,
    );
    const parsed = parseHomebrewSourceManifest(bad);
    expect(() => renderHomebrewCask(parsed)).toThrow(/naming convention/);
  });

  it("never embeds a non-darwin target", () => {
    const parsed = parseHomebrewSourceManifest(manifest());
    const cask = renderHomebrewCask(parsed);
    expect(cask).not.toContain("linux-x64");
  });

  it("writes an exec wrapper into HOMEBREW_PREFIX/bin instead of using the binary stanza", () => {
    const parsed = parseHomebrewSourceManifest(manifest());
    const cask = renderHomebrewCask(parsed);
    expect(cask).toContain("postflight_steps do");
    expect(cask).toContain('write_file "bin/amfaa"');
    expect(cask).toContain("{{staged_path}}/all-my-friends-are-agents/amfaa");
    expect(cask).toContain('set_permissions "bin/amfaa", "0755"');
    expect(cask).not.toContain("binary ");
  });

  it("cleans up the installed launcher wrapper on uninstall", () => {
    const parsed = parseHomebrewSourceManifest(manifest());
    const cask = renderHomebrewCask(parsed);
    expect(cask).toContain('uninstall delete: "#{HOMEBREW_PREFIX}/bin/amfaa"');
  });
});

describe("generateHomebrewCask", () => {
  it("reads a manifest file from disk and renders the cask", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "amfaa-homebrew-"));
    const manifestPath = path.join(directory, "native-release-manifest.json");
    writeFileSync(manifestPath, JSON.stringify(manifest()));
    const cask = generateHomebrewCask(manifestPath);
    expect(cask).toContain("published with v1.2.3");
  });
});
