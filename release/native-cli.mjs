import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { cp, lstat, mkdir, readFile, readdir, readlink, realpath, rename, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const EX_USAGE = 64;
const EX_DATAERR = 65;
const EX_UNAVAILABLE = 69;
const EX_SOFTWARE = 70;
const cliFile = fileURLToPath(import.meta.url);
const appRoot = path.dirname(cliFile);
const versionRoot = path.dirname(appRoot);
const installRoot = path.dirname(path.dirname(versionRoot));
const DATA_MARKER = ".amfaa-owned-data-root.json";
const DATA_MARKER_VALUE = { schemaVersion: 1, application: "all-my-friends-are-agents" };

async function json(file) { return JSON.parse(await readFile(file, "utf8")); }
async function digest(file) { return createHash("sha256").update(await readFile(file)).digest("hex"); }
function textDigest(value) { return createHash("sha256").update(value).digest("hex"); }
async function active(root = installRoot) {
  const versionDirectory = (await readFile(path.join(root, "active-version"), "utf8")).trim();
  if (!/^[A-Za-z0-9._-]+$/.test(versionDirectory)) throw new Error("Invalid active version metadata.");
  const record = { schemaVersion: 1, versionDirectory };
  return { record, versionRoot: path.join(root, "versions", record.versionDirectory) };
}
async function release(root = versionRoot) {
  const value = await json(path.join(root, "app/release.json"));
  if (value?.schemaVersion !== 1 || !value.application?.version || !/^[0-9a-f]{40}$/.test(value.application?.commit || "") || !value.downstream?.version || !/^[0-9a-f]{40}$/.test(value.downstream?.commit || "")) throw new Error("Invalid release metadata.");
  return value;
}
async function files(root, relative = "") {
  const result = [];
  for (const name of (await readdir(path.join(root, relative))).sort()) {
    const item = path.join(relative, name);
    const metadata = await lstat(path.join(root, item));
    const normalized = item.replaceAll(path.sep, "/");
    if (metadata.isSymbolicLink()) {
      const target = await readlink(path.join(root, item));
      const resolved = path.resolve(path.dirname(path.join(root, item)), target);
      const canonicalRoot = await realpath(root); const canonicalTarget = await realpath(resolved);
      if (path.isAbsolute(target) || (canonicalTarget !== canonicalRoot && !canonicalTarget.startsWith(`${canonicalRoot}${path.sep}`))) throw new Error("Release contains an unsafe symbolic link.");
      result.push({ path: normalized, type: "symlink", target });
    } else if (metadata.isDirectory()) result.push(...await files(root, item));
    else if (metadata.isFile()) result.push({ path: normalized, type: "file" });
    else throw new Error("Release contains an unsupported filesystem entry.");
  }
  return result;
}
async function verifyVersion(root) {
  const inventory = await json(path.join(root, "inventory.json"));
  if (inventory?.schemaVersion !== 1 || !Array.isArray(inventory.files)) throw new Error("Invalid release inventory.");
  const listed = inventory.files.map((entry) => ({ path: entry.path, type: entry.type, ...(entry.type === "symlink" ? { target: entry.target } : {}) }));
  const actual = (await files(root)).filter((item) => item.path !== "inventory.json");
  if (new Set(listed.map(({ path }) => path)).size !== listed.length || JSON.stringify(listed) !== JSON.stringify(actual)) throw new Error("Release inventory does not match the staged application.");
  for (const entry of inventory.files) {
    const actualDigest = entry.type === "symlink" ? textDigest(`symlink:${entry.target}`) : await digest(path.join(root, entry.path));
    if (!/^[0-9a-f]{64}$/.test(entry.sha256) || actualDigest !== entry.sha256) throw new Error("Release file verification failed.");
  }
  await release(root);
}
function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(signal ? 128 : code ?? EX_SOFTWARE));
  });
}
function publicIdentity(value) {
  return { application: { version: value.application.version, commit: value.application.commit }, downstream: { version: value.downstream.version, commit: value.downstream.commit } };
}
function defaultDataRoot() { return path.resolve(os.homedir(), ".all-my-friends-are-agents"); }
function ownedByCurrentUser(metadata) { return typeof process.getuid !== "function" || metadata.uid === process.getuid(); }
async function markOwnedDefaultDataRoot(dataRoot) {
  if (path.resolve(dataRoot) !== defaultDataRoot()) return;
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  const metadata = await lstat(dataRoot);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || !ownedByCurrentUser(metadata)) throw new Error("Unsafe application data root.");
  const marker = path.join(dataRoot, DATA_MARKER);
  await writeFile(marker, `${JSON.stringify(DATA_MARKER_VALUE)}\n`, { flag: "wx", mode: 0o600 }).catch(async (error) => {
    if (error?.code !== "EEXIST" || JSON.stringify(await json(marker)) !== JSON.stringify(DATA_MARKER_VALUE)) throw error;
  });
}
async function validatedPurgeRoot() {
  const configured = path.resolve(process.env.ALL_MY_FRIENDS_ARE_AGENTS_DATA_DIR || defaultDataRoot());
  if (configured !== defaultDataRoot()) throw new Error("Only the application-owned default data root can be purged.");
  const metadata = await lstat(configured);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || !ownedByCurrentUser(metadata)) throw new Error("Unsafe application data root.");
  const canonicalHome = await realpath(os.homedir()); const canonical = await realpath(configured);
  const expected = path.join(canonicalHome, ".all-my-friends-are-agents");
  if (canonical !== expected || canonical === canonicalHome || canonical === path.parse(canonical).root || canonical === await realpath(installRoot)) throw new Error("Unsafe application data root.");
  const markerPath = path.join(canonical, DATA_MARKER); const markerMetadata = await lstat(markerPath);
  if (!markerMetadata.isFile() || markerMetadata.isSymbolicLink() || !ownedByCurrentUser(markerMetadata) || JSON.stringify(await json(markerPath)) !== JSON.stringify(DATA_MARKER_VALUE)) throw new Error("Application data ownership marker is missing.");
  return canonical;
}
async function runtime() {
  const { resolveOpenCodeRuntime } = await import("./server/opencode-runtime.js");
  return resolveOpenCodeRuntime({ root: appRoot, override: "" });
}
async function commandStart(args) {
  if (args.length) return EX_USAGE;
  const project = process.cwd();
  process.env.NODE_ENV = "production";
  const dataRoot = process.env.ALL_MY_FRIENDS_ARE_AGENTS_DATA_DIR ||= path.join(os.homedir(), ".all-my-friends-are-agents");
  process.env.ALL_MY_FRIENDS_ARE_AGENTS_ASSIGNMENT_WORKTREES_DIR ||= path.join(dataRoot, "assignment-worktrees");
  process.env.ALL_MY_FRIENDS_ARE_AGENTS_PROJECT_PATH ||= project;
  await markOwnedDefaultDataRoot(dataRoot);
  process.chdir(appRoot);
  await import(pathToFileURL(path.join(appRoot, "server/index.js")).href);
  return 0;
}
async function commandAuth(args) {
  if (args.length) return EX_USAGE;
  const resolved = await runtime();
  if (resolved.state !== "ready") return EX_UNAVAILABLE;
  return run(resolved.command, ["auth", "login"]);
}
async function commandVersion(args) {
  if (args.length) return EX_USAGE;
  process.stdout.write(`${JSON.stringify(publicIdentity(await release()))}\n`);
  return 0;
}
async function commandDoctor(args) {
  if (args.length) return EX_USAGE;
  const identity = publicIdentity(await release());
  const resolved = await runtime();
  process.stdout.write(`${JSON.stringify({ ...identity, runtime: resolved.state === "ready" ? "ready" : "unavailable", ...(resolved.state === "unavailable" ? { reason: resolved.reason } : {}) })}\n`);
  return resolved.state === "ready" ? 0 : EX_UNAVAILABLE;
}
async function commandUpdate(args) {
  if (args.length !== 1) return EX_USAGE;
  const candidateRoot = path.resolve(args[0]);
  const candidate = await active(candidateRoot);
  await verifyVersion(candidate.versionRoot);
  const candidateRelease = await release(candidate.versionRoot);
  const currentRelease = await release();
  if (candidateRelease.target !== currentRelease.target) throw new Error("Update target does not match this installation.");
  const destination = path.join(installRoot, "versions", candidate.record.versionDirectory);
  const staging = `${destination}.stage-${process.pid}`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(path.dirname(staging), { recursive: true });
  await cp(candidate.versionRoot, staging, { recursive: true, errorOnExist: true });
  await verifyVersion(staging);
  await rename(staging, destination).catch(async (error) => {
    if (error?.code !== "EEXIST") throw error;
    await verifyVersion(destination);
    await rm(staging, { recursive: true, force: true });
  });
  const versionTemporary = path.join(installRoot, `.active-version-${process.pid}`);
  await writeFile(path.join(installRoot, "previous.json"), `${JSON.stringify({ schemaVersion: 1, versionDirectory: path.basename(versionRoot) })}\n`, { mode: 0o600 });
  await writeFile(versionTemporary, `${candidate.record.versionDirectory}\n`, { mode: 0o600 });
  await rename(versionTemporary, path.join(installRoot, "active-version"));
  return 0;
}
async function commandUninstall(args) {
  const purge = args.length === 2 && args[0] === "--purge-state" && args[1] === "CONFIRM";
  if (args.length && !purge) return EX_USAGE;
  const purgeRoot = purge ? await validatedPurgeRoot() : null;
  await rm(path.join(installRoot, "versions"), { recursive: true, force: true });
  await unlink(path.join(installRoot, "active-version")).catch((error) => { if (error?.code !== "ENOENT") throw error; });
  await unlink(path.join(installRoot, "previous.json")).catch((error) => { if (error?.code !== "ENOENT") throw error; });
  if (purgeRoot) await rm(purgeRoot, { recursive: true, force: true });
  for (const name of ["amfaa", "amfaa.cmd"]) await unlink(path.join(installRoot, name)).catch((error) => { if (error?.code !== "ENOENT") throw error; });
  return 0;
}

const commands = { start: commandStart, auth: commandAuth, doctor: commandDoctor, version: commandVersion, update: commandUpdate, uninstall: commandUninstall };
const [name = "start", ...args] = process.argv.slice(2);
try {
  const command = commands[name];
  process.exitCode = command ? await command(args) : EX_USAGE;
} catch {
  process.stderr.write("amfaa: operation failed safely\n");
  process.exitCode = EX_DATAERR;
}
