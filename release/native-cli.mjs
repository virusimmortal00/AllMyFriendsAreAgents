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
const EX_CONFIG = 78;
const cliFile = fileURLToPath(import.meta.url);
const appRoot = path.dirname(cliFile);
const versionRoot = path.dirname(appRoot);
const installRoot = path.dirname(path.dirname(versionRoot));
const DATA_MARKER = ".amfaa-owned-data-root.json";
const DATA_MARKER_VALUE = { schemaVersion: 1, application: "all-my-friends-are-agents" };
const SETUP_MARKER = ".amfaa-setup.json";
const SETUP_MARKER_VALUE = { schemaVersion: 1, application: "all-my-friends-are-agents", completed: true };

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
function configuredDataRoot() {
  const dataRoot = path.resolve(process.env.ALL_MY_FRIENDS_ARE_AGENTS_DATA_DIR || defaultDataRoot());
  process.env.ALL_MY_FRIENDS_ARE_AGENTS_DATA_DIR = dataRoot;
  return dataRoot;
}
function ownedByCurrentUser(metadata) { return typeof process.getuid !== "function" || metadata.uid === process.getuid(); }
async function prepareDataRoot(dataRoot) {
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  const metadata = await lstat(dataRoot);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || !ownedByCurrentUser(metadata)) throw new Error("Unsafe application data root.");
}
async function markOwnedDefaultDataRoot(dataRoot) {
  await prepareDataRoot(dataRoot);
  if (path.resolve(dataRoot) !== defaultDataRoot()) return;
  const marker = path.join(dataRoot, DATA_MARKER);
  await writeFile(marker, `${JSON.stringify(DATA_MARKER_VALUE)}\n`, { flag: "wx", mode: 0o600 }).catch(async (error) => {
    if (error?.code !== "EEXIST" || JSON.stringify(await json(marker)) !== JSON.stringify(DATA_MARKER_VALUE)) throw error;
  });
}
async function setupComplete(dataRoot = configuredDataRoot()) {
  try {
    const marker = path.join(dataRoot, SETUP_MARKER);
    const metadata = await lstat(marker);
    if (!metadata.isFile() || metadata.isSymbolicLink() || !ownedByCurrentUser(metadata)) return false;
    return JSON.stringify(await json(marker)) === JSON.stringify(SETUP_MARKER_VALUE);
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return false;
    throw error;
  }
}
async function persistSetup(dataRoot = configuredDataRoot()) {
  await markOwnedDefaultDataRoot(dataRoot);
  const temporary = path.join(dataRoot, `.amfaa-setup-${process.pid}`);
  await writeFile(temporary, `${JSON.stringify(SETUP_MARKER_VALUE)}\n`, { flag: "wx", mode: 0o600 });
  try { await rename(temporary, path.join(dataRoot, SETUP_MARKER)); }
  catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
}
async function upgradedInstallation() {
  try {
    const previous = await json(path.join(installRoot, "previous.json"));
    return previous?.schemaVersion === 1
      && typeof previous.versionDirectory === "string"
      && /^[A-Za-z0-9._-]+$/.test(previous.versionDirectory)
      && (await lstat(path.join(installRoot, "versions", previous.versionDirectory))).isDirectory();
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return false;
    throw error;
  }
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
async function startServer(args) {
  if (args.length) return EX_USAGE;
  const project = process.cwd();
  process.env.NODE_ENV = "production";
  const dataRoot = process.env.ALL_MY_FRIENDS_ARE_AGENTS_DATA_DIR ||= path.join(os.homedir(), ".all-my-friends-are-agents");
  process.env.ALL_MY_FRIENDS_ARE_AGENTS_ASSIGNMENT_WORKTREES_DIR ||= path.join(dataRoot, "assignment-worktrees");
  process.env.ALL_MY_FRIENDS_ARE_AGENTS_PROJECT_PATH ||= project;
  await markOwnedDefaultDataRoot(dataRoot);
  process.chdir(appRoot);
  return import(pathToFileURL(path.join(appRoot, "server/index.js")).href);
}
async function commandAuth(args) {
  if (args.length) return EX_USAGE;
  const resolved = await runtime();
  if (resolved.state !== "ready") return EX_UNAVAILABLE;
  const code = await run(resolved.command, ["auth", "login", "--provider", "openrouter"]);
  if (code === 0) await persistSetup();
  return code;
}
async function setup(preview) {
  const { runSetupWizard } = await import("./setup-wizard.mjs");
  return runSetupWizard({
    preview,
    sandbox: process.env.ALL_MY_FRIENDS_ARE_AGENTS_SETUP_SANDBOX === "1",
    port: process.env.ALL_MY_FRIENDS_ARE_AGENTS_PORT || process.env.AGENTWIRE_PORT,
    project: process.env.ALL_MY_FRIENDS_ARE_AGENTS_PROJECT_PATH || process.cwd(),
    runtimeReady: async () => (await runtime()).state === "ready",
    configured: async () => {
      const { withSetupRuntime } = await import("./setup-auth.mjs");
      const resolved = await runtime();
      return resolved.state === "ready" && withSetupRuntime(resolved.command, process.env.ALL_MY_FRIENDS_ARE_AGENTS_PROJECT_PATH || process.cwd(), client => client.configured());
    },
    authenticate: async (method, { write }) => {
      const { withSetupRuntime, readSetupSecret, connectOpenRouter } = await import("./setup-auth.mjs");
      const controller = new AbortController();
      const cancel = () => controller.abort();
      process.once("SIGINT", cancel);
      try {
        const key = method === "key" ? await readSetupSecret({ signal: controller.signal })
          : await connectOpenRouter({ write, headless: method === "headless", signal: controller.signal });
        if (controller.signal.aborted) return 1;
        const resolved = await runtime();
        if (resolved.state !== "ready") return EX_UNAVAILABLE;
        await withSetupRuntime(resolved.command, process.env.ALL_MY_FRIENDS_ARE_AGENTS_PROJECT_PATH || process.cwd(), client => client.save(key));
        return 0;
      } finally { process.removeListener("SIGINT", cancel); }
    },
    persist: persistSetup,
  });
}
function interactiveTerminal() { return process.stdin.isTTY === true && process.stdout.isTTY === true; }
async function commandSetup(args) {
  const preview = args.length === 1 && args[0] === "--preview";
  if (args.length && !preview) return EX_USAGE;
  if (!preview && !interactiveTerminal()) {
    process.stderr.write("amfaa: setup needs an interactive terminal; run `amfaa setup --preview` to inspect the flow\n");
    return EX_CONFIG;
  }
  const result = await setup(preview);
  if (result.code !== 0 || !result.completed || !result.start) return result.code;
  return launchService(true);
}
async function commandStart(args) {
  if (args.length === 1 && args[0] === "--foreground") {
    if (!await setupComplete()) { if (await upgradedInstallation()) await persistSetup(); else return EX_CONFIG; }
    await startServer([]); return 0;
  }
  if (args.length) return EX_USAGE;
  if (await setupComplete()) return launchService();
  if (await upgradedInstallation()) {
    await persistSetup();
    return launchService();
  }
  if (!interactiveTerminal()) {
    process.stderr.write("amfaa: first-time setup is required; run `amfaa` in an interactive terminal\n");
    return EX_CONFIG;
  }
  const result = await setup(false);
  if (result.code !== 0 || !result.completed || !result.start) return result.code;
  return launchService(true);
}
async function launchService(openBrowser = false) {
  const { startService } = await import("./background-service.mjs");
  const root = configuredDataRoot();
  await markOwnedDefaultDataRoot(root);
  try {
    const result = await startService({ root, cliFile, project: process.env.ALL_MY_FRIENDS_ARE_AGENTS_PROJECT_PATH || process.cwd() });
    process.stdout.write(`\n  [ ^‿^ ] Your room is running!\n\n  Open: ${result.url}\n  ${process.env.ALL_MY_FRIENDS_ARE_AGENTS_SETUP_SANDBOX === "1" ? "Back to the sandbox shell. Keep this container open." : "You can close this terminal."}\n\n  Check on it:  amfaa status\n  Stop it:      amfaa stop\n  Start again:  amfaa start\n\n  Start from your project folder next time.\n  After a computer restart, run amfaa start again.\n\n`);
    if (openBrowser) {
      const { openRoomBrowser, roomBrowserMode } = await import("./room-browser.mjs");
      const mode = roomBrowserMode();
      if (mode === "remote" || mode === "manual") {
        const port = new URL(result.url).port;
        process.stdout.write(`  On another computer? Forward the port over SSH:\n  ssh -N -L ${port}:127.0.0.1:${port} <user>@<host>\n  Then open ${result.url} on your computer.\n\n`);
      } else if (mode === "local" && !await openRoomBrowser(result.url)) {
        process.stdout.write("  I couldn't open a browser here. Use the Open link above.\n");
      }
    }
    return 0;
  } catch (error) { process.stderr.write(`${error.message}\n`); return EX_UNAVAILABLE; }
}
async function commandStatus(args) {
  if (args.length) return EX_USAGE;
  const { serviceStatus } = await import("./background-service.mjs");
  const result = await serviceStatus(configuredDataRoot());
  process.stdout.write(result.state === "running" ? `AMFAA is running: ${result.url}\nStop: amfaa stop\n` : `AMFAA is ${result.state}. Start: amfaa start\n`);
  return 0;
}
async function commandStop(args) {
  if (args.length) return EX_USAGE;
  const { stopService } = await import("./background-service.mjs");
  try { await stopService(configuredDataRoot()); process.stdout.write("AMFAA is stopped. Your room and connection are saved. Start again: amfaa start\n"); return 0; }
  catch (error) { process.stderr.write(`${error.message}\n`); return EX_UNAVAILABLE; }
}
async function commandServe(args) {
  if (args.length || !process.send) return EX_USAGE;
  const { serveBackground } = await import("./background-service.mjs");
  await serveBackground({ root: configuredDataRoot(), start: () => startServer([]) });
  return 0;
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
async function serviceMustBeStopped() {
  const { serviceStatus } = await import("./background-service.mjs");
  if ((await serviceStatus(configuredDataRoot())).state !== "stopped") {
    process.stderr.write("Stop AMFAA with amfaa stop before updating or uninstalling.\n");
    return false;
  }
  return true;
}
async function commandUpdate(args) {
  if (!await serviceMustBeStopped()) return EX_UNAVAILABLE;
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
  if (!await serviceMustBeStopped()) return EX_UNAVAILABLE;
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

const commands = { status: commandStatus, stop: commandStop, __serve: commandServe, start: commandStart, setup: commandSetup, auth: commandAuth, doctor: commandDoctor, version: commandVersion, update: commandUpdate, uninstall: commandUninstall };
const [name = "start", ...args] = process.argv.slice(2);
try {
  const command = commands[name];
  process.exitCode = command ? await command(args) : EX_USAGE;
} catch {
  process.stderr.write("amfaa: operation failed safely\n");
  process.exitCode = EX_DATAERR;
}
