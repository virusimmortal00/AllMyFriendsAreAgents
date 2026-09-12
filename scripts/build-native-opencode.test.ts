import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadNativeReleaseContext } from "./native-release-contract.js";
import { assertNativeHost, packageVerifiedExecutable, verifyExecutable, verifyNativeArtifactSet } from "./build-native-opencode.js";

const temporary: string[] = [];
const context = loadNativeReleaseContext();
const buildSource = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "build-native-opencode.ts"), "utf8");

function fixture(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "amfaa-native-build-test-"));
  temporary.push(directory);
  return directory;
}

function digest(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function hostTarget() {
  const platform = process.platform === "win32" ? "windows" : process.platform;
  return context.policy.targets.find((target) => target.os === platform && target.architecture === process.arch);
}

function fakeOpenCode(directory: string, mutation = false): string {
  const binary = path.join(directory, "opencode-fixture");
  writeFileSync(binary, `#!/bin/sh
${mutation ? 'printf "\\n# mutated" >> "$0"' : ""}
case "$1:$2" in
  --version:) echo "1.18.25-amfaa.2" ;;
  run:--help) echo "--format json --dir --agent --model --variant --session --auto" ;;
  models:--help) echo "models [provider] --verbose --refresh" ;;
  *) exit 2 ;;
esac
`);
  chmodSync(binary, 0o755);
  return binary;
}

function synthesizeSet(directory: string): void {
  const downstream = context.integrationContract.downstream as { headCommit: string; version: string };
  for (const target of context.policy.targets) {
    const archive = `all-my-friends-are-agents-v${String(context.packageJson.version)}-${target.id}${target.archiveExtension}`;
    const stage = fixture();
    const executable = target.os === "windows" ? "opencode.exe" : "opencode";
    const privateBinary = path.join(stage, "all-my-friends-are-agents/runtime", executable);
    mkdirSync(path.dirname(privateBinary), { recursive: true });
    writeFileSync(privateBinary, `${target.id}\n`);
    const archivePath = path.join(directory, archive);
    const args = target.archiveExtension === ".zip"
      ? ["-a", "-cf", archivePath, "-C", stage, "all-my-friends-are-agents"]
      : ["-czf", archivePath, "-C", stage, "all-my-friends-are-agents"];
    execFileSync("tar", args);
    const sha256 = digest(archivePath);
    writeFileSync(`${archivePath}.sha256`, `${sha256}  ${archive}\n`);
    writeFileSync(`${archivePath}.verification.json`, `${JSON.stringify({
      schemaVersion: 1,
      target: target.id,
      downstreamCommit: downstream.headCommit,
      downstreamVersion: downstream.version,
      archive,
      sha256,
      binarySha256: "a".repeat(64),
      executablePath: `all-my-friends-are-agents/runtime/${executable}`,
    }, null, 2)}\n`);
  }
}

afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("native OpenCode artifact build", () => {
  it("preserves the pinned downstream lockfile bytes across build hosts", () => {
    expect(buildSource.indexOf('config", "core.autocrlf", "false"')).toBeGreaterThan(-1);
    expect(buildSource.indexOf('config", "core.autocrlf", "false"')).toBeLessThan(buildSource.indexOf('checkout", "--detach", "FETCH_HEAD"'));
    expect(buildSource).toContain('"install", "--frozen-lockfile"');
    expect(buildSource).toContain('["install", "--no-save", "--ignore-scripts", "--backend=copyfile"]');
    expect(buildSource).toContain("readFileSync(lockfile).equals(lockedBytes)");
  });

  it("rejects a target that does not match the native verification host", () => {
    const wrong = context.policy.targets.find((target) => target.os !== (process.platform === "win32" ? "windows" : process.platform) || target.architecture !== process.arch)!;
    expect(() => assertNativeHost(wrong)).toThrow(/must be built and verified/);
  });

  it("rejects wrong versions and executables mutated by their verification run", () => {
    const directory = fixture();
    const wrong = path.join(directory, "wrong-version");
    writeFileSync(wrong, "#!/bin/sh\necho 1.18.25\n");
    chmodSync(wrong, 0o755);
    expect(() => verifyExecutable(wrong, "1.18.25-amfaa.2", () => undefined)).toThrow(/Expected OpenCode/);
    expect(() => verifyExecutable(fakeOpenCode(directory, true), "1.18.25-amfaa.2", () => undefined)).toThrow(/changed after verification/);
  });

  it.skipIf(process.platform === "win32" || !hostTarget())("packages a feasible local fixture only after the existing binary contract passes", () => {
    const directory = fixture();
    const output = fixture();
    const target = hostTarget()!;
    const evidence = packageVerifiedExecutable({ targetId: target.id, binary: fakeOpenCode(directory), outputDirectory: output });
    expect(evidence).toMatchObject({
      target: target.id,
      downstreamCommit: "6883ca5bd35a5494fb2759018373308911c79e01",
      downstreamVersion: "1.18.25-amfaa.2",
      executablePath: "all-my-friends-are-agents/runtime/opencode",
    });
    const listing = execFileSync("tar", ["-tf", path.join(output, evidence.archive)], { encoding: "utf8" });
    expect(listing).toContain("all-my-friends-are-agents/runtime/opencode");
    expect(readFileSync(path.join(output, `${evidence.archive}.sha256`), "utf8")).toBe(`${evidence.sha256}  ${evidence.archive}\n`);
  });

  it("accepts exactly one canonical archive and checksum for every supported target", () => {
    const directory = fixture();
    synthesizeSet(directory);
    expect(verifyNativeArtifactSet(directory).map((evidence) => evidence.target)).toEqual(context.policy.targets.map((target) => target.id));
  });

  it("rejects missing, duplicate-target, wrong-target, wrong-version, and mutated output", () => {
    const missing = fixture();
    synthesizeSet(missing);
    rmSync(path.join(missing, `all-my-friends-are-agents-v0.1.0-${context.policy.targets[0].id}${context.policy.targets[0].archiveExtension}.sha256`));
    expect(() => verifyNativeArtifactSet(missing)).toThrow(/missing canonical files/);

    const duplicate = fixture();
    synthesizeSet(duplicate);
    copyFileSync(path.join(duplicate, "all-my-friends-are-agents-v0.1.0-linux-x64.tar.gz.verification.json"), path.join(duplicate, "unexpected.verification.json"));
    expect(() => verifyNativeArtifactSet(duplicate)).toThrow(/unexpected or duplicate-target output/);

    const wrongTarget = fixture();
    synthesizeSet(wrongTarget);
    const evidencePath = path.join(wrongTarget, "all-my-friends-are-agents-v0.1.0-linux-x64.tar.gz.verification.json");
    const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
    evidence.target = "windows-arm64";
    writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    expect(() => verifyNativeArtifactSet(wrongTarget)).toThrow(/Wrong-target/);

    const wrongVersion = fixture();
    synthesizeSet(wrongVersion);
    const versionPath = path.join(wrongVersion, "all-my-friends-are-agents-v0.1.0-linux-x64.tar.gz.verification.json");
    const versionEvidence = JSON.parse(readFileSync(versionPath, "utf8"));
    versionEvidence.downstreamVersion = "1.18.25";
    writeFileSync(versionPath, `${JSON.stringify(versionEvidence, null, 2)}\n`);
    expect(() => verifyNativeArtifactSet(wrongVersion)).toThrow(/Wrong-version/);

    const mutated = fixture();
    synthesizeSet(mutated);
    const archive = path.join(mutated, "all-my-friends-are-agents-v0.1.0-linux-x64.tar.gz");
    writeFileSync(archive, Buffer.concat([readFileSync(archive), Buffer.from("mutated")]));
    expect(() => verifyNativeArtifactSet(mutated)).toThrow(/mutation or checksum mismatch/);
  });
});
