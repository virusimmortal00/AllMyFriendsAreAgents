import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadNativeReleaseContext, type NativeReleaseContext } from "./native-release-contract.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PRIVATE_ROOT = "all-my-friends-are-agents";
const PRIVATE_RUNTIME = `${PRIVATE_ROOT}/runtime`;
const BUILD_BUN_VERSION = "1.3.14";

export interface NativeBuildEvidence {
  readonly schemaVersion: 1;
  readonly target: string;
  readonly downstreamCommit: string;
  readonly downstreamVersion: string;
  readonly archive: string;
  readonly sha256: string;
  readonly binarySha256: string;
  readonly executablePath: string;
}

type Target = NativeReleaseContext["policy"]["targets"][number];
type CommandVerifier = (binary: string) => void;

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function run(command: string, args: readonly string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): string {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status}: ${result.stderr || result.stdout}`);
  return `${result.stdout || ""}${result.stderr || ""}`;
}

function contractDownstream(context: NativeReleaseContext) {
  return context.integrationContract.downstream as { repository: string; headCommit: string; version: string };
}

function targetById(context: NativeReleaseContext, id: string): Target {
  const matches = context.policy.targets.filter((target) => target.id === id);
  if (matches.length !== 1) throw new Error(`Unsupported or duplicate native target: ${id}.`);
  return matches[0];
}

function hostOs(platform: NodeJS.Platform): string {
  if (platform === "win32") return "windows";
  return platform;
}

export function assertNativeHost(target: Target, platform = process.platform, architecture = process.arch): void {
  if (hostOs(platform) !== target.os || architecture !== target.architecture) {
    throw new Error(`Target ${target.id} must be built and verified on ${target.os}/${target.architecture}; this host is ${hostOs(platform)}/${architecture}.`);
  }
}

function executableName(target: Target): string {
  return target.os === "windows" ? "opencode.exe" : "opencode";
}

function expectedArchiveName(context: NativeReleaseContext, target: Target): string {
  return `all-my-friends-are-agents-v${String(context.packageJson.version)}-${target.id}${target.archiveExtension}`;
}

function outputPaths(context: NativeReleaseContext, target: Target, outputDirectory: string) {
  const archive = expectedArchiveName(context, target);
  return {
    archive,
    archivePath: path.join(outputDirectory, archive),
    checksumPath: path.join(outputDirectory, `${archive}.sha256`),
    evidencePath: path.join(outputDirectory, `${archive}.verification.json`),
  };
}

function ensureUnretained(paths: ReturnType<typeof outputPaths>): void {
  for (const file of [paths.archivePath, paths.checksumPath, paths.evidencePath]) {
    if (existsSync(file)) throw new Error(`Refusing to replace retained native artifact evidence: ${path.basename(file)}.`);
  }
}

function defaultContractVerifier(binary: string): void {
  const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  run(pnpm, ["run", "check:opencode-binary", "--", "--command", binary], { cwd: ROOT });
}

export function verifyExecutable(binary: string, expectedVersion: string, verifyContract: CommandVerifier = defaultContractVerifier): string {
  if (!existsSync(binary) || !statSync(binary).isFile()) throw new Error("Expected native executable is missing.");
  const before = sha256(binary);
  const version = run(binary, ["--version"]).trim();
  if (version !== expectedVersion) throw new Error(`Expected OpenCode ${expectedVersion}, received ${version || "empty output"}.`);
  verifyContract(binary);
  const after = sha256(binary);
  if (after !== before) throw new Error("Native executable changed after verification; refusing to retain it.");
  return after;
}

function archiveEntries(archive: string): string[] {
  return run("tar", ["-tf", archive]).split(/\r?\n/).map((entry) => entry.replaceAll("\\", "/").replace(/^\.\//, "")).filter(Boolean);
}

function assertArchiveLayout(archive: string, executable: string): void {
  const expectedFile = `${PRIVATE_RUNTIME}/${executable}`;
  const allowed = new Set([`${PRIVATE_ROOT}/`, `${PRIVATE_RUNTIME}/`, expectedFile]);
  const entries = archiveEntries(archive);
  if (entries.filter((entry) => entry === expectedFile).length !== 1) throw new Error("Native archive is missing its single application-private executable.");
  if (new Set(entries).size !== entries.length) throw new Error("Native archive contains duplicate entries.");
  if (entries.some((entry) => !allowed.has(entry))) throw new Error("Native archive contains a file outside the application-private runtime layout.");
}

function createArchive(stagingDirectory: string, archive: string, extension: string): void {
  const args = extension === ".zip"
    ? ["-a", "-cf", archive, "-C", stagingDirectory, PRIVATE_ROOT]
    : ["-czf", archive, "-C", stagingDirectory, PRIVATE_ROOT];
  run("tar", args);
}

function verifyArchive(archive: string, target: Target, expectedVersion: string, verifyContract: CommandVerifier): void {
  assertArchiveLayout(archive, executableName(target));
  const before = sha256(archive);
  const extraction = mkdtempSync(path.join(os.tmpdir(), "amfaa-native-verify-"));
  try {
    run("tar", ["-xf", archive, "-C", extraction]);
    const binary = path.join(extraction, PRIVATE_RUNTIME, executableName(target));
    verifyExecutable(binary, expectedVersion, verifyContract);
  } finally {
    rmSync(extraction, { recursive: true, force: true });
  }
  if (sha256(archive) !== before) throw new Error("Native archive changed after verification; refusing to retain it.");
}

export function packageVerifiedExecutable(input: {
  context?: NativeReleaseContext;
  targetId: string;
  binary: string;
  outputDirectory: string;
  verifyContract?: CommandVerifier;
}): NativeBuildEvidence {
  const context = input.context || loadNativeReleaseContext(ROOT);
  const target = targetById(context, input.targetId);
  assertNativeHost(target);
  const downstream = contractDownstream(context);
  const paths = outputPaths(context, target, path.resolve(input.outputDirectory));
  ensureUnretained(paths);
  mkdirSync(path.resolve(input.outputDirectory), { recursive: true });
  const work = mkdtempSync(path.join(path.resolve(input.outputDirectory), ".amfaa-native-package-"));
  try {
    const stagedBinary = path.join(work, PRIVATE_RUNTIME, executableName(target));
    mkdirSync(path.dirname(stagedBinary), { recursive: true });
    copyFileSync(path.resolve(input.binary), stagedBinary);
    if (target.os !== "windows") chmodSync(stagedBinary, 0o755);
    const verifier = input.verifyContract || defaultContractVerifier;
    const binarySha256 = verifyExecutable(stagedBinary, downstream.version, verifier);
    const temporaryArchive = path.join(work, paths.archive);
    createArchive(work, temporaryArchive, target.archiveExtension);
    verifyArchive(temporaryArchive, target, downstream.version, verifier);
    const archiveSha256 = sha256(temporaryArchive);
    const evidence: NativeBuildEvidence = {
      schemaVersion: 1,
      target: target.id,
      downstreamCommit: downstream.headCommit,
      downstreamVersion: downstream.version,
      archive: paths.archive,
      sha256: archiveSha256,
      binarySha256,
      executablePath: `${PRIVATE_RUNTIME}/${executableName(target)}`,
    };
    const temporaryChecksum = path.join(work, `${paths.archive}.sha256`);
    const temporaryEvidence = path.join(work, `${paths.archive}.verification.json`);
    writeFileSync(temporaryChecksum, `${archiveSha256}  ${paths.archive}\n`, { flag: "wx" });
    writeFileSync(temporaryEvidence, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx" });
    renameSync(temporaryArchive, paths.archivePath);
    renameSync(temporaryChecksum, paths.checksumPath);
    renameSync(temporaryEvidence, paths.evidencePath);
    return evidence;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function sourceBinaryPath(source: string, target: Target): string {
  const name = `opencode-${target.os === "windows" ? "windows" : target.os}-${target.architecture}`;
  return path.join(source, "packages/opencode/dist", name, "bin", executableName(target));
}

export function buildNativeTarget(input: { targetId: string; outputDirectory: string; context?: NativeReleaseContext }): NativeBuildEvidence {
  const context = input.context || loadNativeReleaseContext(ROOT);
  const target = targetById(context, input.targetId);
  assertNativeHost(target);
  const downstream = contractDownstream(context);
  const bunVersion = run("bun", ["--version"]).trim();
  if (bunVersion !== BUILD_BUN_VERSION) throw new Error(`Native builds require Bun ${BUILD_BUN_VERSION}; received ${bunVersion || "unknown"}.`);
  const checkout = mkdtempSync(path.join(os.tmpdir(), "amfaa-opencode-source-"));
  try {
    run("git", ["init", checkout]);
    run("git", ["-C", checkout, "config", "core.autocrlf", "false"]);
    run("git", ["-C", checkout, "remote", "add", "origin", downstream.repository]);
    run("git", ["-C", checkout, "fetch", "--depth", "1", "origin", downstream.headCommit]);
    run("git", ["-C", checkout, "checkout", "--detach", "FETCH_HEAD"]);
    const checkedOut = run("git", ["-C", checkout, "rev-parse", "HEAD"]).trim();
    if (checkedOut !== downstream.headCommit) throw new Error("Fetched OpenCode source does not match the manifest-pinned commit.");
    // pnpm exports INIT_CWD for its own checkout. Bun uses that value while
    // linking workspaces, which breaks when a Windows temp checkout is on a
    // different drive. Anchor install subprocesses to the pinned checkout.
    const env = { ...process.env, HUSKY: "0", INIT_CWD: checkout };
    const lockfile = path.join(checkout, "bun.lock"); const lockedBytes = readFileSync(lockfile);
    // Bun 1.3.14 can falsely reject its platform-normalized text lock on native
    // Windows (oven-sh/bun#20913). --no-save still consumes the existing lock;
    // byte comparison prevents the workaround from accepting a rewrite.
    const installArguments = target.os === "windows"
      ? ["install", "--no-save", "--ignore-scripts"]
      : ["install", "--frozen-lockfile"];
    run("bun", installArguments, { cwd: checkout, env });
    if (!readFileSync(lockfile).equals(lockedBytes)) throw new Error("Pinned downstream lockfile changed during dependency installation.");
    run("bun", ["run", "packages/opencode/script/build.ts", "--single", "--skip-install", "--skip-embed-web-ui"], {
      cwd: checkout,
      env: { ...env, OPENCODE_CHANNEL: "latest", OPENCODE_VERSION: downstream.version },
    });
    return packageVerifiedExecutable({ context, targetId: target.id, binary: sourceBinaryPath(checkout, target), outputDirectory: input.outputDirectory });
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
}

function parseEvidence(file: string): NativeBuildEvidence {
  const value = JSON.parse(readFileSync(file, "utf8")) as NativeBuildEvidence;
  const keys = Object.keys(value).sort();
  const expected = ["archive", "binarySha256", "downstreamCommit", "downstreamVersion", "executablePath", "schemaVersion", "sha256", "target"].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) throw new Error(`Malformed verification evidence: ${path.basename(file)}.`);
  if (value.schemaVersion !== 1 || !/^[0-9a-f]{64}$/.test(value.sha256) || !/^[0-9a-f]{64}$/.test(value.binarySha256)) {
    throw new Error(`Malformed verification evidence: ${path.basename(file)}.`);
  }
  return value;
}

export function verifyNativeArtifactSet(directory: string, context = loadNativeReleaseContext(ROOT)): NativeBuildEvidence[] {
  const root = path.resolve(directory);
  const downstream = contractDownstream(context);
  const expectedFiles = new Set<string>();
  for (const target of context.policy.targets) {
    const archive = expectedArchiveName(context, target);
    expectedFiles.add(archive);
    expectedFiles.add(`${archive}.sha256`);
    expectedFiles.add(`${archive}.verification.json`);
  }
  const actualFiles = readdirSync(root).filter((name) => !name.startsWith(".")).sort();
  if (actualFiles.length !== expectedFiles.size || actualFiles.some((name) => !expectedFiles.has(name))) {
    throw new Error("Native artifact set is missing canonical files or contains unexpected or duplicate-target output.");
  }
  const seenTargets = new Set<string>();
  return context.policy.targets.map((target) => {
    const paths = outputPaths(context, target, root);
    const evidence = parseEvidence(paths.evidencePath);
    if (seenTargets.has(evidence.target)) throw new Error(`Duplicate native target evidence: ${evidence.target}.`);
    seenTargets.add(evidence.target);
    if (evidence.target !== target.id) throw new Error(`Wrong-target artifact evidence for ${target.id}.`);
    if (evidence.downstreamCommit !== downstream.headCommit || evidence.downstreamVersion !== downstream.version) throw new Error(`Wrong-version or wrong-commit artifact evidence for ${target.id}.`);
    if (evidence.archive !== paths.archive || evidence.executablePath !== `${PRIVATE_RUNTIME}/${executableName(target)}`) throw new Error(`Noncanonical artifact layout evidence for ${target.id}.`);
    const digest = sha256(paths.archivePath);
    const checksum = readFileSync(paths.checksumPath, "utf8");
    if (evidence.sha256 !== digest || checksum !== `${digest}  ${paths.archive}\n`) throw new Error(`Post-verification mutation or checksum mismatch for ${target.id}.`);
    assertArchiveLayout(paths.archivePath, executableName(target));
    if (sha256(paths.archivePath) !== digest) throw new Error(`Post-verification mutation or checksum mismatch for ${target.id}.`);
    return evidence;
  });
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  if (command === "build") {
    const targetId = option("--target");
    const outputDirectory = option("--output");
    if (!targetId || !outputDirectory) throw new Error("Usage: build-native-opencode.ts build --target <id> --output <directory>");
    const evidence = buildNativeTarget({ targetId, outputDirectory });
    process.stdout.write(`${evidence.archive} ${evidence.sha256}\n`);
  } else if (command === "verify-set") {
    const directory = option("--directory");
    if (!directory) throw new Error("Usage: build-native-opencode.ts verify-set --directory <directory>");
    process.stdout.write(`Verified ${verifyNativeArtifactSet(directory).length} native OpenCode archives.\n`);
  } else {
    throw new Error("Usage: build-native-opencode.ts build|verify-set ...");
  }
}
