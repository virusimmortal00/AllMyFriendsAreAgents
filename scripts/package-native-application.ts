import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertNativeHost, type NativeBuildEvidence } from "./build-native-opencode.js";
import { loadNativeReleaseContext, type NativeReleaseContext } from "./native-release-contract.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PRODUCT = "all-my-friends-are-agents";
const APP_ENTRIES = ["dist", "node_modules", "package.json", "server", "shared"];

function sha256(file: string) { return createHash("sha256").update(readFileSync(file)).digest("hex"); }
function run(command: string, args: string[]) {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 8 * 1024 * 1024 });
}
export function tarInvocation(
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
  systemRoot = process.env.SystemRoot,
): { command: string; args: string[] } {
  return platform === "win32"
    ? { command: path.win32.join(systemRoot || "C:\\Windows", "System32", "tar.exe"), args: [...args] }
    : { command: "tar", args: [...args] };
}
function runTar(args: string[]) { const invocation = tarInvocation(args); return run(invocation.command, invocation.args); }
export function archiveListInvocation(archive: string, platform: NodeJS.Platform = process.platform) {
  return archive.endsWith(".zip") && platform !== "win32"
    ? { command: "unzip", args: ["-Z1", archive] }
    : tarInvocation(["-tf", archive], platform);
}
export function nativePackageCommand(args: readonly string[]): string | undefined { return args.filter((arg) => arg !== "--")[0]; }
export function isForbiddenApplicationArchiveEntry(entry: string): boolean {
  return /(?:^|\/)(?:pnpm|node_modules\/\.bin\/tsx)(?:$|\/)/.test(entry)
    || /\/app\/(?:dist|server|shared)\/.*\.test\.[cm]?[jt]sx?$/.test(entry);
}
type InventoryItem = { path: string; type: "file" } | { path: string; type: "symlink"; target: string };
function files(root: string, relative = ""): InventoryItem[] {
  return readdirSync(path.join(root, relative)).sort().flatMap((name) => {
    const item = path.join(relative, name); const metadata = lstatSync(path.join(root, item));
    const normalized = item.replaceAll(path.sep, "/");
    if (metadata.isSymbolicLink()) {
      const target = readlinkSync(path.join(root, item)); const resolved = path.resolve(path.dirname(path.join(root, item)), target); const canonicalRoot = realpathSync(root); const canonicalTarget = realpathSync(resolved);
      if (path.isAbsolute(target) || (canonicalTarget !== canonicalRoot && !canonicalTarget.startsWith(`${canonicalRoot}${path.sep}`))) throw new Error("Native bundle input contains an unsafe symbolic link.");
      return [{ path: normalized, type: "symlink" as const, target }];
    }
    if (!metadata.isFile() && !metadata.isDirectory()) throw new Error("Native bundle input contains an unsupported filesystem entry.");
    return metadata.isDirectory() ? files(root, item) : [{ path: normalized, type: "file" as const }];
  });
}
function executable(target: { os: string }, name: "node" | "opencode") { return target.os === "windows" ? `${name}.exe` : name; }
function evidence(file: string): NativeBuildEvidence { return JSON.parse(readFileSync(file, "utf8")) as NativeBuildEvidence; }

export function packageNativeApplication(input: { context?: NativeReleaseContext; targetId: string; applicationDirectory: string; applicationCommit: string; nodeBinary: string; openCodeArchive: string; openCodeEvidence: string; outputDirectory: string }) {
  const context = input.context || loadNativeReleaseContext(ROOT);
  const target = context.policy.targets.find(({ id }) => id === input.targetId);
  if (!target) throw new Error(`Unsupported native target: ${input.targetId}.`);
  assertNativeHost(target);
  if (!/^[0-9a-f]{40}$/.test(input.applicationCommit)) throw new Error("Application commit must be a full lowercase commit SHA.");
  const appInput = path.resolve(input.applicationDirectory);
  if (readdirSync(appInput).sort().join("\n") !== [...APP_ENTRIES].sort().join("\n")) throw new Error("Application input must contain only the closed production file set.");
  const nodeVersion = run(path.resolve(input.nodeBinary), ["--version"]).trim();
  if (nodeVersion !== `v${context.policy.nodeRuntime.version}`) throw new Error(`Expected Node.js ${context.policy.nodeRuntime.version}, received ${nodeVersion || "unknown"}.`);
  const downstream = context.integrationContract.downstream as { headCommit: string; version: string };
  const proof = evidence(input.openCodeEvidence);
  if (proof.target !== target.id || proof.downstreamCommit !== downstream.headCommit || proof.downstreamVersion !== downstream.version || proof.sha256 !== sha256(input.openCodeArchive)) throw new Error("OpenCode artifact does not match the manifest-selected verified identity.");

  const output = path.resolve(input.outputDirectory); mkdirSync(output, { recursive: true });
  const archiveName = `all-my-friends-are-agents-v${String(context.packageJson.version)}-${target.id}${target.archiveExtension}`;
  const archivePath = path.join(output, archiveName);
  if (existsSync(archivePath)) throw new Error(`Refusing to replace retained native application archive: ${archiveName}.`);
  const work = mkdtempSync(path.join(output, ".amfaa-application-package-"));
  try {
    const install = path.join(work, PRODUCT); const versionDirectory = `${String(context.packageJson.version)}-${input.applicationCommit.slice(0, 12)}`;
    const versionRoot = path.join(install, "versions", versionDirectory); const app = path.join(versionRoot, "app");
    mkdirSync(app, { recursive: true });
    // Validate links before Windows packaging materializes them. Otherwise an
    // escaping source link could become an apparently ordinary archived file.
    files(appInput);
    for (const entry of APP_ENTRIES) cpSync(path.join(appInput, entry), path.join(app, entry), {
      recursive: true,
      verbatimSymlinks: target.os !== "windows",
      dereference: target.os === "windows",
      errorOnExist: true,
    });
    mkdirSync(path.join(app, "runtime/node/bin"), { recursive: true });
    const nodeDestination = path.join(app, "runtime/node/bin", executable(target, "node")); cpSync(path.resolve(input.nodeBinary), nodeDestination); if (target.os !== "windows") chmodSync(nodeDestination, 0o755);
    const extraction = path.join(work, "opencode"); mkdirSync(extraction); runTar(["-xf", path.resolve(input.openCodeArchive), "-C", extraction]);
    const sourceBinary = path.join(extraction, proof.executablePath); if (!statSync(sourceBinary).isFile()) throw new Error("Verified OpenCode archive is missing its executable.");
    const opencodeDestination = path.join(app, "runtime/opencode/bin", executable(target, "opencode")); mkdirSync(path.dirname(opencodeDestination), { recursive: true }); cpSync(sourceBinary, opencodeDestination); if (target.os !== "windows") chmodSync(opencodeDestination, 0o755);
    cpSync(path.join(ROOT, "release/native-cli.mjs"), path.join(app, "native-cli.mjs"));
    cpSync(path.join(ROOT, "release/setup-wizard.mjs"), path.join(app, "setup-wizard.mjs"));
    cpSync(path.join(ROOT, "release/setup-auth.mjs"), path.join(app, "setup-auth.mjs"));
    cpSync(path.join(ROOT, "release/background-service.mjs"), path.join(app, "background-service.mjs"));
    cpSync(path.join(ROOT, "release/room-browser.mjs"), path.join(app, "room-browser.mjs"));
    writeFileSync(path.join(app, "release.json"), `${JSON.stringify({ schemaVersion: 1, target: target.id, application: { version: context.packageJson.version, commit: input.applicationCommit }, node: { version: context.policy.nodeRuntime.version }, downstream: { version: downstream.version, commit: downstream.headCommit, artifactSha256: proof.sha256 } }, null, 2)}\n`);
    const inventory = files(versionRoot).map((item) => ({ ...item, sha256: item.type === "symlink" ? createHash("sha256").update(`symlink:${item.target}`).digest("hex") : sha256(path.join(versionRoot, item.path)) }));
    writeFileSync(path.join(versionRoot, "inventory.json"), `${JSON.stringify({ schemaVersion: 1, files: inventory }, null, 2)}\n`);
    writeFileSync(path.join(install, "active-version"), `${versionDirectory}\n`);
    if (target.os === "windows") writeFileSync(path.join(install, "amfaa.cmd"), `@echo off\r\nset "ROOT=%~dp0"\r\nset /p VERSION=<"%ROOT%active-version"\r\n"%ROOT%versions\\%VERSION%\\app\\runtime\\node\\bin\\node.exe" "%ROOT%versions\\%VERSION%\\app\\native-cli.mjs" %*\r\nexit /b %ERRORLEVEL%\r\n`);
    else { writeFileSync(path.join(install, "amfaa"), `#!/bin/sh\nset -eu\ncase "$0" in */*) ROOT=\${0%/*} ;; *) exit 65 ;; esac\nIFS= read -r VERSION < "$ROOT/active-version"\ncase "$VERSION" in *[!A-Za-z0-9._-]*|'') exit 65 ;; esac\nexec "$ROOT/versions/$VERSION/app/runtime/node/bin/node" "$ROOT/versions/$VERSION/app/native-cli.mjs" "$@"\n`); chmodSync(path.join(install, "amfaa"), 0o755); }
    runTar(target.archiveExtension === ".zip" ? ["-a", "-cf", archivePath, "-C", work, PRODUCT] : ["-czf", archivePath, "-C", work, PRODUCT]);
    const digest = sha256(archivePath); writeFileSync(`${archivePath}.sha256`, `${digest}  ${archiveName}\n`);
    return { archive: archiveName, sha256: digest, versionDirectory };
  } finally { rmSync(work, { recursive: true, force: true }); }
}

export function verifyNativeApplicationSet(directory: string, context = loadNativeReleaseContext(ROOT)) {
  const root = path.resolve(directory);
  const expected = new Set(context.policy.targets.flatMap((target) => {
    const archive = `all-my-friends-are-agents-v${String(context.packageJson.version)}-${target.id}${target.archiveExtension}`;
    return [archive, `${archive}.sha256`];
  }));
  const actual = readdirSync(root).filter((name) => !name.startsWith(".")).sort();
  if (actual.length !== expected.size || actual.some((name) => !expected.has(name))) throw new Error("Native application artifact set is incomplete or contains unexpected files.");
  return context.policy.targets.map((target) => {
    const archive = `all-my-friends-are-agents-v${String(context.packageJson.version)}-${target.id}${target.archiveExtension}`;
    const archivePath = path.join(root, archive); const digest = sha256(archivePath);
    if (readFileSync(`${archivePath}.sha256`, "utf8") !== `${digest}  ${archive}\n`) throw new Error(`Native application checksum mismatch for ${target.id}.`);
    const list = archiveListInvocation(archivePath); const listing = run(list.command, list.args).split(/\r?\n/).map((item) => item.replaceAll("\\", "/")).filter(Boolean);
    const prefix = `${PRODUCT}/versions/`; const node = `/app/runtime/node/bin/${executable(target, "node")}`; const opencode = `/app/runtime/opencode/bin/${executable(target, "opencode")}`;
    if (!listing.includes(`${PRODUCT}/${target.os === "windows" ? "amfaa.cmd" : "amfaa"}`) || !listing.includes(`${PRODUCT}/active-version`)
      || listing.filter((item) => item.startsWith(prefix) && item.endsWith(node)).length !== 1 || listing.filter((item) => item.startsWith(prefix) && item.endsWith(opencode)).length !== 1
      || listing.some(isForbiddenApplicationArchiveEntry)) throw new Error(`Native application archive layout is invalid for ${target.id}.`);
    return { target: target.id, archive, sha256: digest };
  });
}

function option(name: string) { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; }
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (nativePackageCommand(process.argv.slice(2)) === "verify-set") {
    const directory = option("--directory");
    if (!directory) throw new Error("Usage: package-native-application.ts verify-set --directory <directory>");
    process.stdout.write(`Verified ${verifyNativeApplicationSet(directory).length} native application archives.\n`);
  } else {
  const required = ["target", "application", "commit", "node", "opencode-archive", "opencode-evidence", "output"] as const;
  const values = Object.fromEntries(required.map((name) => [name, option(`--${name}`)]));
  if (Object.values(values).some((value) => !value)) throw new Error(`Usage: package-native-application.ts ${required.map((name) => `--${name} <value>`).join(" ")}`);
  const result = packageNativeApplication({ targetId: values.target!, applicationDirectory: values.application!, applicationCommit: values.commit!, nodeBinary: values.node!, openCodeArchive: values["opencode-archive"]!, openCodeEvidence: values["opencode-evidence"]!, outputDirectory: values.output! });
  process.stdout.write(`${result.archive} ${result.sha256}\n`);
  }
}
