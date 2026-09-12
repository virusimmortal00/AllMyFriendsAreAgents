import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setupNativeOpenCode } from "./setup-native-opencode.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const roots: string[] = [];
const sha = (value: Buffer) => createHash("sha256").update(value).digest("hex");

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "amfaa-source-setup-")); roots.push(root);
  await mkdir(path.join(root, "release"), { recursive: true }); await mkdir(path.join(root, "integration-contracts"), { recursive: true });
  await Promise.all([
    copyFile(path.join(repositoryRoot, "release/native-target-policy.json"), path.join(root, "release/native-target-policy.json")),
    copyFile(path.join(repositoryRoot, "integration-contracts/opencode.json"), path.join(root, "integration-contracts/opencode.json")),
    copyFile(path.join(repositoryRoot, "Dockerfile"), path.join(root, "Dockerfile")),
    copyFile(path.join(repositoryRoot, "package.json"), path.join(root, "package.json")),
  ]);
  const target = "linux-x64"; const archiveName = "all-my-friends-are-agents-v0.1.0-linux-x64.tar.gz";
  const staged = path.join(root, "archive", "all-my-friends-are-agents", "runtime", "opencode", "bin");
  await mkdir(staged, { recursive: true }); await writeFile(path.join(staged, "opencode"), "#!/bin/sh\necho 1.18.25-amfaa.2\n"); await chmod(path.join(staged, "opencode"), 0o755);
  const archive = path.join(root, archiveName); execFileSync("tar", ["-czf", archive, "-C", path.join(root, "archive"), "all-my-friends-are-agents"]);
  const artifact = await readFile(archive); const provenance = Buffer.from("verified provenance evidence\n");
  const file = (name: string, contents: Buffer) => ({ name, url: `https://github.com/virusimmortal00/AllMyFriendsAreAgents/releases/download/v0.1.0/${name}`, size: contents.length, sha256: sha(contents) });
  const dummy = Buffer.from("x");
  const targets = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "windows-x64"].map((id) => {
    const extension = id.startsWith("windows-") ? ".zip" : ".tar.gz"; const name = `all-my-friends-are-agents-v0.1.0-${id}${extension}`;
    return { id, artifact: id === target ? file(name, artifact) : file(name, dummy), sbom: file(`${name}.spdx.json`, dummy), provenance: id === target ? file(`${name}.intoto.jsonl`, provenance) : file(`${name}.intoto.jsonl`, dummy) };
  });
  const manifestPath = path.join(root, "manifest.json");
  await writeFile(manifestPath, `${JSON.stringify({ schemaVersion: 1, application: { version: "0.1.0", commit: "b".repeat(40), repository: "https://github.com/virusimmortal00/AllMyFriendsAreAgents.git" }, downstream: { repository: "https://github.com/virusimmortal00/opencode.git", commit: "6883ca5bd35a5494fb2759018373308911c79e01", version: "1.18.25-amfaa.2", sdkVersion: "1.18.25", pluginVersion: "1.18.25" }, targets })}\n`);
  const resources = new Map([[targets[3]!.artifact.url, artifact], [targets[3]!.sbom.url, dummy], [targets[3]!.provenance.url, provenance]]);
  const fetch = vi.fn(async (url: string | URL) => { const content = resources.get(String(url)); return content ? new Response(content) : new Response("missing", { status: 404 }); });
  return { root, manifestPath, fetch, targets };
}

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("source OpenCode setup", () => {
  it("installs the manifest-selected immutable artifact and reuses a verified installation", async () => {
    const value = await fixture(); const verify = vi.fn(async () => undefined);
    await expect(setupNativeOpenCode({ root: value.root, manifestPath: value.manifestPath, platform: "linux", architecture: "x64", fetch: value.fetch, verify })).resolves.toEqual({ reused: false, target: "linux-x64" });
    expect(value.fetch).toHaveBeenCalledTimes(3); expect(verify).toHaveBeenCalledOnce();
    expect(value.fetch).toHaveBeenCalledWith(expect.any(String), { redirect: "follow" });
    await expect(setupNativeOpenCode({ root: value.root, manifestPath: value.manifestPath, platform: "linux", architecture: "x64", fetch: value.fetch, verify })).resolves.toEqual({ reused: true, target: "linux-x64" });
    expect(value.fetch).toHaveBeenCalledTimes(3); expect(verify).toHaveBeenCalledTimes(2);
  });

  it("fails closed for unsupported hosts, bad hashes, and unavailable provenance", async () => {
    const value = await fixture(); const verify = async () => undefined;
    await expect(setupNativeOpenCode({ root: value.root, manifestPath: value.manifestPath, platform: "freebsd", architecture: "x64", fetch: value.fetch, verify })).rejects.toThrow(/Unsupported native runtime host/);
    const bad = JSON.parse(await readFile(value.manifestPath, "utf8")); bad.targets[3].artifact.sha256 = "0".repeat(64); await writeFile(value.manifestPath, JSON.stringify(bad));
    await expect(setupNativeOpenCode({ root: value.root, manifestPath: value.manifestPath, platform: "linux", architecture: "x64", fetch: value.fetch, verify })).rejects.toThrow(/SHA-256/);
    bad.targets[3].artifact.sha256 = sha(await readFile(path.join(value.root, "all-my-friends-are-agents-v0.1.0-linux-x64.tar.gz"))); await writeFile(value.manifestPath, JSON.stringify(bad));
    const unavailable = vi.fn(async () => new Response("missing", { status: 404 }));
    await expect(setupNativeOpenCode({ root: value.root, manifestPath: value.manifestPath, platform: "linux", architecture: "x64", fetch: unavailable, verify })).rejects.toThrow(/Could not download immutable release file/);
  });

  it("never activates an interrupted setup and recovers cleanly on the next run", async () => {
    const value = await fixture(); const verify = async () => undefined;
    await expect(setupNativeOpenCode({ root: value.root, manifestPath: value.manifestPath, platform: "linux", architecture: "x64", fetch: value.fetch, verify, interruptAfterDownload: true })).rejects.toThrow(/interrupted/);
    await expect(readFile(path.join(value.root, ".runtime", "opencode", "receipt.json"))).rejects.toThrow();
    await expect(setupNativeOpenCode({ root: value.root, manifestPath: value.manifestPath, platform: "linux", architecture: "x64", fetch: value.fetch, verify })).resolves.toEqual({ reused: false, target: "linux-x64" });
  });

  it("replaces unverified retained files and never activates a wrong-version binary", async () => {
    const value = await fixture(); const verify = vi.fn(async () => undefined);
    await setupNativeOpenCode({ root: value.root, manifestPath: value.manifestPath, platform: "linux", architecture: "x64", fetch: value.fetch, verify });
    await writeFile(path.join(value.root, ".runtime", "opencode", "receipt.json"), "{}\n");
    await expect(setupNativeOpenCode({ root: value.root, manifestPath: value.manifestPath, platform: "linux", architecture: "x64", fetch: value.fetch, verify })).resolves.toEqual({ reused: false, target: "linux-x64" });
    expect(value.fetch).toHaveBeenCalledTimes(6);
    const rejected = await fixture();
    await expect(setupNativeOpenCode({ root: rejected.root, manifestPath: rejected.manifestPath, platform: "linux", architecture: "x64", fetch: rejected.fetch, verify: async () => { throw new Error("Installed OpenCode version mismatch"); } })).rejects.toThrow(/version mismatch/);
    await expect(readFile(path.join(rejected.root, ".runtime", "opencode", "receipt.json"))).rejects.toThrow();
  });
});
