import { createHash } from "node:crypto";
import { chmod, copyFile, lstat, mkdtemp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { loadNativeReleaseContext, validateNativeReleaseManifest, type NativeReleaseFile, type NativeReleaseManifest } from "./native-release-contract.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export type SetupNativeOpenCodeOptions = {
  readonly root?: string;
  readonly manifestPath: string;
  readonly platform?: NodeJS.Platform;
  readonly architecture?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly verify?: (command: string) => Promise<void>;
  readonly interruptAfterDownload?: boolean;
};

export type SetupCurrentNativeOpenCodeOptions = Omit<SetupNativeOpenCodeOptions, "manifestPath">;

function hostTarget(platform: NodeJS.Platform, architecture: string, root: string): string {
  const osName = platform === "win32" ? "windows" : platform;
  if (!(["darwin", "linux", "windows"] as const).includes(osName as "darwin")) throw new Error(`Unsupported native runtime host: ${platform}/${architecture}.`);
  const id = `${osName}-${architecture}`;
  const supported = loadNativeReleaseContext(root).policy.targets.some((target) => target.id === id);
  if (!supported) throw new Error(`Unsupported native runtime host: ${platform}/${architecture}.`);
  return id;
}

async function digest(file: string) { return createHash("sha256").update(await readFile(file)).digest("hex"); }

async function download(file: NativeReleaseFile, destination: string, fetcher: typeof globalThis.fetch): Promise<void> {
  // GitHub release asset URLs redirect to content storage. Integrity remains
  // bound to the immutable manifest by the required size and SHA-256 checks.
  const response = await fetcher(file.url, { redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`Could not download immutable release file ${file.name}.`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length !== file.size) throw new Error(`Release file size verification failed for ${file.name}.`);
  await writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
  if (await digest(destination) !== file.sha256) throw new Error(`Release file SHA-256 verification failed for ${file.name}.`);
}

async function run(command: string, args: readonly string[], cwd: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (value) => { output += value; }); child.stderr.on("data", (value) => { output += value; });
    child.once("error", reject); child.once("close", (code) => code === 0 ? resolve(output) : reject(new Error(`${command} ${args.join(" ")} failed.`)));
  });
}

async function defaultVerify(command: string, root: string): Promise<void> {
  const version = (await run(command, ["--version"], root)).trim();
  const expected = String((loadNativeReleaseContext(root).integrationContract.downstream as { version: string }).version);
  if (version !== expected) throw new Error(`Installed OpenCode version mismatch: expected ${expected}, received ${version || "empty output"}.`);
  await run(process.platform === "win32" ? "pnpm.cmd" : "pnpm", ["run", "check:opencode-binary", "--", "--command", command], root);
}

async function isVerifiedInstallation(destination: string, target: NativeReleaseManifest["targets"][number], root: string, verify: (command: string) => Promise<void>): Promise<boolean> {
  const executable = path.join(destination, "bin", target.id.startsWith("windows-") ? "opencode.exe" : "opencode");
  const receipt = path.join(destination, "receipt.json");
  try {
    const saved = JSON.parse(await readFile(receipt, "utf8")) as { artifact: NativeReleaseFile; sbom: NativeReleaseFile; provenance: NativeReleaseFile; target: string };
    if (saved.target !== target.id || JSON.stringify(saved.artifact) !== JSON.stringify(target.artifact) || JSON.stringify(saved.sbom) !== JSON.stringify(target.sbom) || JSON.stringify(saved.provenance) !== JSON.stringify(target.provenance)) return false;
    await access(executable, target.id.startsWith("windows-") ? constants.F_OK : constants.X_OK);
    await verify(executable);
    return true;
  } catch { return false; }
}

export async function setupNativeOpenCode(options: SetupNativeOpenCodeOptions): Promise<{ reused: boolean; target: string }> {
  const root = path.resolve(options.root || ROOT);
  const platform = options.platform || process.platform;
  const architecture = options.architecture || process.arch;
  const targetId = hostTarget(platform, architecture, root);
  const context = loadNativeReleaseContext(root);
  const manifest = validateNativeReleaseManifest(JSON.parse(await readFile(path.resolve(options.manifestPath), "utf8")), context);
  const target = manifest.targets.find((item) => item.id === targetId);
  if (!target) throw new Error(`Release manifest does not contain host target ${targetId}.`);
  const destination = path.join(root, ".runtime", "opencode");
  const verify = options.verify || ((command) => defaultVerify(command, root));
  if (await isVerifiedInstallation(destination, target, root, verify)) return { reused: true, target: targetId };

  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(path.join(root, ".runtime", ".opencode-setup-"));
  try {
    const archive = path.join(temporary, target.artifact.name);
    const sbom = path.join(temporary, target.sbom.name);
    const provenance = path.join(temporary, target.provenance.name);
    await download(target.artifact, archive, options.fetch || globalThis.fetch);
    await download(target.sbom, sbom, options.fetch || globalThis.fetch);
    await download(target.provenance, provenance, options.fetch || globalThis.fetch);
    if (options.interruptAfterDownload) throw new Error("Setup interrupted before runtime activation.");
    const staging = path.join(temporary, "runtime"); await mkdir(staging);
    const executableName = targetId.startsWith("windows-") ? "opencode.exe" : "opencode";
    const legacy = `all-my-friends-are-agents/runtime/opencode/bin/${executableName}`;
    const applicationPattern = new RegExp(`^all-my-friends-are-agents/versions/[A-Za-z0-9][A-Za-z0-9._-]+/app/runtime/opencode/bin/${executableName.replace(".", "\\.")}$`);
    const entries = (await run("tar", ["-tf", archive], root)).split(/\r?\n/).map((entry) => entry.replace(/^\.\//, "").replace(/\\/g, "/")).filter(Boolean);
    const candidates = entries.filter((entry) => entry === legacy || applicationPattern.test(entry));
    if (candidates.length !== 1 || new Set(entries).size !== entries.length || entries.some((entry) => entry !== "all-my-friends-are-agents/" && !entry.startsWith("all-my-friends-are-agents/") || /(?:^|\/)\.\.(?:\/|$)/.test(entry))) throw new Error("Native archive has an unsafe application runtime layout.");
    await run("tar", ["-xf", archive, "-C", staging, candidates[0]], root).catch(async () => { await run("tar", ["-xzf", archive, "-C", staging, candidates[0]], root); });
    const selected = path.join(staging, ...candidates[0].split("/")); const selectedMetadata = await lstat(selected);
    if (!selectedMetadata.isFile() || selectedMetadata.isSymbolicLink()) throw new Error("Native archive OpenCode runtime is not a regular file.");
    const extracted = path.join(staging, "all-my-friends-are-agents", "runtime", "opencode", "bin", executableName);
    if (selected !== extracted) { await mkdir(path.dirname(extracted), { recursive: true }); await copyFile(selected, extracted); }
    await stat(extracted); if (!targetId.startsWith("windows-")) await chmod(extracted, 0o755); await verify(extracted);
    await writeFile(path.join(staging, "all-my-friends-are-agents", "runtime", "opencode", "receipt.json"), `${JSON.stringify({ target: target.id, artifact: target.artifact, sbom: target.sbom, provenance: target.provenance })}\n`, { mode: 0o600 });
    const stagedDestination = path.join(staging, "all-my-friends-are-agents", "runtime", "opencode");
    const previous = `${destination}.previous`;
    await rm(previous, { recursive: true, force: true });
    try { await rename(destination, previous); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    try { await rename(stagedDestination, destination); } catch (error) { await rename(previous, destination).catch(() => undefined); throw error; }
    await rm(previous, { recursive: true, force: true });
    return { reused: false, target: targetId };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

export async function setupCurrentNativeOpenCode(options: SetupCurrentNativeOpenCodeOptions = {}): Promise<{ reused: boolean; target: string }> {
  const root = path.resolve(options.root || ROOT);
  const context = loadNativeReleaseContext(root);
  const repository = context.policy.applicationRepository.slice(0, -4);
  const manifestUrl = `${repository}/releases/latest/download/native-release-manifest.json`;
  const response = await (options.fetch || globalThis.fetch)(manifestUrl, { redirect: "follow" });
  if (!response.ok || !response.body) throw new Error("Could not download the current native release manifest.");
  const declaredSize = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredSize) && declaredSize > 1_048_576) throw new Error("Native release manifest exceeds the size limit.");
  const contents = Buffer.from(await response.arrayBuffer());
  if (contents.length > 1_048_576) throw new Error("Native release manifest exceeds the size limit.");
  await mkdir(path.join(root, ".runtime"), { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(path.join(root, ".runtime", ".native-manifest-"));
  const manifestPath = path.join(temporary, "native-release-manifest.json");
  try {
    await writeFile(manifestPath, contents, { flag: "wx", mode: 0o600 });
    return await setupNativeOpenCode({ ...options, root, manifestPath });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf("--manifest"); const manifestPath = index < 0 ? undefined : process.argv[index + 1];
  if ((index >= 0 && (!manifestPath || process.argv.length !== 4)) || (index < 0 && process.argv.length !== 2)) throw new Error("Usage: setup-native-opencode.ts [--manifest <native-release-manifest.json>]");
  const result = manifestPath ? await setupNativeOpenCode({ manifestPath }) : await setupCurrentNativeOpenCode();
  process.stdout.write(`${result.reused ? "Reused" : "Installed"} verified OpenCode runtime for ${result.target}.\n`);
}
