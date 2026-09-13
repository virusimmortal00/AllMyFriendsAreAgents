import { createHash } from "node:crypto";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import { promisify } from "node:util";
import { withLifecycleLock } from "../release/lifecycle-lock.mjs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadNativeReleaseContext } from "./native-release-contract.js";
import { archiveListInvocation, isForbiddenApplicationArchiveEntry, nativePackageCommand, packageNativeApplication, tarInvocation } from "./package-native-application.js";

const context = loadNativeReleaseContext();
const temporary: string[] = [];

it("uses Windows bsdtar for ZIP support even when invoked from Git Bash", () => {
  expect(tarInvocation(["-xf", "D:\\artifact.zip"], "win32", "C:\\Windows")).toEqual({
    command: "C:\\Windows\\System32\\tar.exe",
    args: ["-xf", "D:\\artifact.zip"],
  });
  expect(tarInvocation(["-xf", "/tmp/artifact.zip"], "linux")).toEqual({ command: "tar", args: ["-xf", "/tmp/artifact.zip"] });
  expect(archiveListInvocation("/tmp/windows.zip", "linux")).toEqual({ command: "unzip", args: ["-Z1", "/tmp/windows.zip"] });
});

it("accepts pnpm's argument separator before the verify-set command", () => {
  expect(nativePackageCommand(["--", "verify-set", "--directory", "artifacts"])).toBe("verify-set");
  expect(nativePackageCommand(["--", "--target", "linux-x64"])).toBe("--target");
});

it("rejects app-owned tests without rejecting dependency source fixtures", () => {
  expect(isForbiddenApplicationArchiveEntry("product/versions/v/app/server/room.test.js")).toBe(true);
  expect(isForbiddenApplicationArchiveEntry("product/versions/v/app/node_modules/.pnpm/zod/node_modules/zod/src/value.test.ts")).toBe(false);
  expect(isForbiddenApplicationArchiveEntry("product/versions/v/app/node_modules/.bin/tsx")).toBe(true);
});

function fixture() { const value = mkdtempSync(path.join(os.tmpdir(), "amfaa-native-application-test-")); temporary.push(value); return value; }
function digest(file: string) { return createHash("sha256").update(readFileSync(file)).digest("hex"); }
function hostTarget() { const osName = process.platform === "win32" ? "windows" : process.platform; return context.policy.targets.find((target) => target.os === osName && target.architecture === process.arch); }

function application(root: string) {
  for (const directory of ["dist", "node_modules", "server", "shared"]) mkdirSync(path.join(root, directory), { recursive: true });
  writeFileSync(path.join(root, "dist/index.html"), "<!doctype html><title>fixture</title>");
  writeFileSync(path.join(root, "shared/fixture.js"), "export {};\n");
  writeFileSync(path.join(root, "package.json"), `${JSON.stringify({ name: "all-my-friends-are-agents", private: true, type: "module", version: context.packageJson.version })}\n`);
  writeFileSync(path.join(root, "server/index.js"), 'process.stdout.write(`${JSON.stringify({project:process.env.ALL_MY_FRIENDS_ARE_AGENTS_PROJECT_PATH,data:process.env.ALL_MY_FRIENDS_ARE_AGENTS_DATA_DIR})}\\n`);\n');
  writeFileSync(path.join(root, "server/opencode-runtime.js"), `import path from "node:path"; export async function resolveOpenCodeRuntime({root}) { return {state:"ready",command:path.join(root,"runtime/opencode/bin/opencode"),source:"packaged",version:"1.18.25-amfaa.2",checkedAt:new Date(0).toISOString()}; }\n`);
}
function nodeFixture(root: string) {
  const file = path.join(root, "node");
  writeFileSync(file, `#!/bin/sh\nif [ "\${1-}" = "--version" ]; then echo v24.5.0; exit 0; fi\nexec ${JSON.stringify(process.execPath)} "$@"\n`);
  chmodSync(file, 0o755); return file;
}
function openCodeFixture(root: string, target: NonNullable<ReturnType<typeof hostTarget>>) {
  const stage = path.join(root, "stage/all-my-friends-are-agents/runtime"); mkdirSync(stage, { recursive: true });
  const name = target.os === "windows" ? "opencode.exe" : "opencode"; const binary = path.join(stage, name);
  writeFileSync(binary, '#!/bin/sh\ncase "${1-}:${2-}" in --version:) echo 1.18.25-amfaa.2;; run:--help) echo "--format json --dir --agent --model --variant --session --auto";; models:--help) echo "models [provider] --verbose --refresh";; auth:login) [ "${3-}:${4-}" = "--provider:openrouter" ] || exit 2; exit 0;; *) exit 2;; esac\n'); chmodSync(binary, 0o755);
  const archive = path.join(root, `opencode-${target.id}${target.archiveExtension}`);
  execFileSync("tar", target.archiveExtension === ".zip" ? ["-a", "-cf", archive, "-C", path.join(root, "stage"), "all-my-friends-are-agents"] : ["-czf", archive, "-C", path.join(root, "stage"), "all-my-friends-are-agents"]);
  const proof = path.join(root, "evidence.json");
  writeFileSync(proof, JSON.stringify({ schemaVersion: 1, target: target.id, downstreamCommit: "6883ca5bd35a5494fb2759018373308911c79e01", downstreamVersion: "1.18.25-amfaa.2", archive: path.basename(archive), sha256: digest(archive), binarySha256: digest(binary), executablePath: `all-my-friends-are-agents/runtime/${name}` }));
  return { archive, proof };
}
function build(commit: string) {
  const root = fixture(); const app = path.join(root, "app"); mkdirSync(app); application(app);
  const target = hostTarget()!; const runtime = openCodeFixture(root, target); const output = path.join(root, "output");
  const result = packageNativeApplication({ targetId: target.id, applicationDirectory: app, applicationCommit: commit, nodeBinary: nodeFixture(root), openCodeArchive: runtime.archive, openCodeEvidence: runtime.proof, outputDirectory: output });
  const extract = path.join(root, "extract"); mkdirSync(extract); execFileSync("tar", ["-xf", path.join(output, result.archive), "-C", extract]);
  return { root, install: path.join(extract, "all-my-friends-are-agents"), result };
}
function invoke(install: string, args: string[], cwd = install, environment: NodeJS.ProcessEnv = {}) {
  return execFileSync(path.join(install, "amfaa"), args, { cwd, env: { HOME: environment.HOME || fixture(), PATH: "/path-with-no-node-pnpm-or-opencode", ...environment }, encoding: "utf8" });
}

afterEach(() => { for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe.skipIf(process.platform === "win32" || !hostTarget())("self-contained native application bundle", () => {
  it("contains only the launcher, active metadata, and an inventoried production version", () => {
    const built = build("b".repeat(40));
    expect(execFileSync("tar", ["-tf", path.join(built.root, "output", built.result.archive)], { encoding: "utf8" })).not.toMatch(/(?:^|\/)pnpm(?:$|\/)|typescript|\.test\.|opencode-fixture/);
    expect(existsSync(path.join(built.install, "active.json"))).toBe(false);
    const version = JSON.parse(invoke(built.install, ["version"]));
    expect(version).toEqual({ application: { version: context.packageJson.version, commit: "b".repeat(40) }, downstream: { version: "1.18.25-amfaa.2", commit: "6883ca5bd35a5494fb2759018373308911c79e01" } });
  });

  it("runs doctor, auth, and start without Node.js, pnpm, or OpenCode on PATH and keeps reports sanitized", () => {
    const built = build("c".repeat(40)); const project = fixture(); const home = fixture();
    const doctor = invoke(built.install, ["doctor"], built.install, { HOME: home }); expect(JSON.parse(doctor)).toMatchObject({ runtime: "ready", application: { version: context.packageJson.version }, downstream: { version: "1.18.25-amfaa.2" } });
    expect(doctor).not.toMatch(/Users\/|tmp\/|PATH|HOME|credential|token/);
    expect(() => invoke(built.install, ["auth"], built.install, { HOME: home })).not.toThrow();
    expect(existsSync(path.join(home, ".all-my-friends-are-agents/.amfaa-setup.json"))).toBe(true);
    const started = JSON.parse(invoke(built.install, ["start", "--foreground"], project, { HOME: home }));
    expect(realpathSync(started.project)).toBe(realpathSync(project));
    expect(started.data).toBe(path.join(home, ".all-my-friends-are-agents"));
  });

  it("normalizes a configured data root before setup state and server startup consume it", () => {
    const built = build("7".repeat(40)); const home = fixture(); const project = fixture(); const relativeDataRoot = "relative-state";
    invoke(built.install, ["auth"], project, { HOME: home, ALL_MY_FRIENDS_ARE_AGENTS_DATA_DIR: relativeDataRoot });
    const started = JSON.parse(invoke(built.install, ["start", "--foreground"], project, { HOME: home, ALL_MY_FRIENDS_ARE_AGENTS_DATA_DIR: relativeDataRoot }));
    expect(realpathSync(started.data)).toBe(realpathSync(path.join(project, relativeDataRoot)));
  });

  it("offers a non-mutating setup walkthrough and blocks unattended first launch", () => {
    const built = build("6".repeat(40)); const home = fixture();
    const preview = spawnSync(path.join(built.install, "amfaa"), ["setup", "--preview"], {
      cwd: built.install, env: { HOME: home, PATH: "/path-with-no-node-pnpm-or-opencode" }, input: "\n\n\n\n", encoding: "utf8",
    });
    expect(preview.status).toBe(0);
    expect(preview.stdout).toContain("SETUP · PREVIEW");
    expect(preview.stdout).toContain("Continue preview");
    expect(preview.stdout).toContain("Ready to meet the gang?");
    expect(preview.stdout).toContain("no credentials, files, or services were changed");
    expect(existsSync(path.join(home, ".all-my-friends-are-agents"))).toBe(false);

    const launch = spawnSync(path.join(built.install, "amfaa"), [], {
      cwd: built.install, env: { HOME: home, PATH: "/path-with-no-node-pnpm-or-opencode" }, encoding: "utf8",
    });
    expect(launch.status).toBe(78);
    expect(launch.stderr).toBe("amfaa: first-time setup is required; run `amfaa` in an interactive terminal\n");
  });

  it.each(["update", "uninstall"])("checks service state under the lifecycle lock before %s", async command => {
    const built = build("8".repeat(40)); const home = fixture();
    const root = path.join(home, ".all-my-friends-are-agents"); mkdirSync(root);
    let pending: Promise<unknown>;
    await withLifecycleLock(root, async () => {
      pending = promisify(execFile)(path.join(built.install, "amfaa"), command === "update" ? [command, built.install] : [command], {
        cwd: built.install, env: { HOME: home, PATH: "/path-with-no-node-pnpm-or-opencode" },
      }).then(() => ({ code: 0 }), error => error);
      // Publish a live startup while the competing command waits for ownership.
      await new Promise(resolve => setTimeout(resolve, 150));
      writeFileSync(path.join(root, ".amfaa-service.json"), JSON.stringify({ version: 1, token: "a".repeat(64), port: 0, created: Date.now(), pid: process.pid }), { mode: 0o600 });
    });
    expect(await pending!).toMatchObject({ code: 69, stderr: "Stop AMFAA with amfaa stop before updating or uninstalling.\n" });
    expect(existsSync(path.join(built.install, "versions"))).toBe(true);
    expect(existsSync(path.join(built.install, "active-version"))).toBe(true);
  });

  it("activates a completely verified update, retains rollback metadata, and preserves durable state during default uninstall", () => {
    const first = build("d".repeat(40)); const second = build("e".repeat(40)); const home = fixture(); const project = fixture();
    const state = path.join(home, ".all-my-friends-are-agents"); mkdirSync(state); writeFileSync(path.join(state, "room.json"), "durable");
    invoke(first.install, ["update", second.install], first.install, { HOME: home });
    expect(JSON.parse(invoke(first.install, ["version"], first.install, { HOME: home })).application.commit).toBe("e".repeat(40));
    expect(JSON.parse(readFileSync(path.join(first.install, "previous.json"), "utf8")).versionDirectory).toContain("dddddddddddd");
    expect(realpathSync(JSON.parse(invoke(first.install, ["start", "--foreground"], project, { HOME: home })).project)).toBe(realpathSync(project));
    expect(existsSync(path.join(home, ".all-my-friends-are-agents/.amfaa-setup.json"))).toBe(true);
    invoke(first.install, ["uninstall"], first.install, { HOME: home });
    expect(readFileSync(path.join(state, "room.json"), "utf8")).toBe("durable");
  });

  it("rejects wrong Node and mismatched OpenCode identities before retaining an archive", () => {
    const root = fixture(); const app = path.join(root, "app"); mkdirSync(app); application(app); const target = hostTarget()!; const runtime = openCodeFixture(root, target);
    writeFileSync(nodeFixture(root), "#!/bin/sh\necho v24.4.0\n");
    expect(() => packageNativeApplication({ targetId: target.id, applicationDirectory: app, applicationCommit: "f".repeat(40), nodeBinary: path.join(root, "node"), openCodeArchive: runtime.archive, openCodeEvidence: runtime.proof, outputDirectory: path.join(root, "out") })).toThrow(/Expected Node.js/);
    const bad = JSON.parse(readFileSync(runtime.proof, "utf8")); bad.downstreamCommit = "a".repeat(40); writeFileSync(runtime.proof, JSON.stringify(bad));
    expect(() => packageNativeApplication({ targetId: target.id, applicationDirectory: app, applicationCommit: "f".repeat(40), nodeBinary: nodeFixture(root), openCodeArchive: runtime.archive, openCodeEvidence: runtime.proof, outputDirectory: path.join(root, "out") })).toThrow(/manifest-selected/);
  });

  it("permits only portable application-internal dependency links", () => {
    const root = fixture(); const app = path.join(root, "app"); mkdirSync(app); application(app); const target = hostTarget()!; const runtime = openCodeFixture(root, target);
    mkdirSync(path.join(app, "node_modules/.store/pkg"), { recursive: true }); writeFileSync(path.join(app, "node_modules/.store/pkg/index.js"), "export {};\n");
    symlinkSync(".store/pkg", path.join(app, "node_modules/pkg"));
    expect(() => packageNativeApplication({ targetId: target.id, applicationDirectory: app, applicationCommit: "1".repeat(40), nodeBinary: nodeFixture(root), openCodeArchive: runtime.archive, openCodeEvidence: runtime.proof, outputDirectory: path.join(root, "safe") })).not.toThrow();
    unlinkSync(path.join(app, "node_modules/pkg")); symlinkSync(path.join(root, "node"), path.join(app, "node_modules/pkg"));
    expect(() => packageNativeApplication({ targetId: target.id, applicationDirectory: app, applicationCommit: "2".repeat(40), nodeBinary: nodeFixture(root), openCodeArchive: runtime.archive, openCodeEvidence: runtime.proof, outputDirectory: path.join(root, "unsafe") })).toThrow(/unsafe symbolic link/);
  });

  it("rejects arbitrary and symlinked purge roots before removing application files", () => {
    for (const dataRoot of ["/", path.join(fixture(), "custom-data")]) {
      const built = build("3".repeat(40));
      const result = spawnSync(path.join(built.install, "amfaa"), ["uninstall", "--purge-state", "CONFIRM"], { cwd: built.install, env: { HOME: fixture(), PATH: "/path-with-no-node-pnpm-or-opencode", ALL_MY_FRIENDS_ARE_AGENTS_DATA_DIR: dataRoot }, encoding: "utf8" });
      expect(result.status).toBe(65); expect(result.stderr).toBe("amfaa: operation failed safely\n"); expect(existsSync(path.join(built.install, "versions"))).toBe(true);
    }
    const built = build("4".repeat(40)); const home = fixture(); const outside = fixture();
    writeFileSync(path.join(outside, ".amfaa-owned-data-root.json"), '{"schemaVersion":1,"application":"all-my-friends-are-agents"}\n');
    symlinkSync(outside, path.join(home, ".all-my-friends-are-agents"));
    const linked = spawnSync(path.join(built.install, "amfaa"), ["uninstall", "--purge-state", "CONFIRM"], { cwd: built.install, env: { HOME: home, PATH: "/path-with-no-node-pnpm-or-opencode" }, encoding: "utf8" });
    expect(linked.status).toBe(65); expect(existsSync(path.join(outside, ".amfaa-owned-data-root.json"))).toBe(true); expect(existsSync(path.join(built.install, "versions"))).toBe(true);
  });

  it("purges only a marked default data root after separate exact confirmation", () => {
    const built = build("5".repeat(40)); const home = fixture(); const project = fixture();
    invoke(built.install, ["auth"], built.install, { HOME: home });
    invoke(built.install, ["start", "--foreground"], project, { HOME: home });
    const dataRoot = path.join(home, ".all-my-friends-are-agents"); writeFileSync(path.join(dataRoot, "room.json"), "durable");
    invoke(built.install, ["uninstall", "--purge-state", "CONFIRM"], built.install, { HOME: home });
    expect(existsSync(dataRoot)).toBe(false); expect(existsSync(path.join(built.install, "versions"))).toBe(false);
  });
});
