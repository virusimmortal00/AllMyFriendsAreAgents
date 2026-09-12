import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadNativeReleaseContext } from "./native-release-contract.js";
import { packageNativeApplication } from "./package-native-application.js";

const context = loadNativeReleaseContext();
const temporary: string[] = [];
function fixture() { const value = mkdtempSync(path.join(os.tmpdir(), "amfaa-native-application-test-")); temporary.push(value); return value; }
function digest(file: string) { return createHash("sha256").update(readFileSync(file)).digest("hex"); }
function hostTarget() { const osName = process.platform === "win32" ? "windows" : process.platform; return context.policy.targets.find((target) => target.os === osName && target.architecture === process.arch); }

function application(root: string) {
  for (const directory of ["dist", "node_modules", "server", "shared"]) mkdirSync(path.join(root, directory), { recursive: true });
  writeFileSync(path.join(root, "dist/index.html"), "<!doctype html><title>fixture</title>");
  writeFileSync(path.join(root, "shared/fixture.js"), "export {};\n");
  writeFileSync(path.join(root, "package.json"), '{"name":"all-my-friends-are-agents","private":true,"type":"module","version":"0.1.0"}\n');
  writeFileSync(path.join(root, "server/index.js"), 'process.stdout.write(`${process.env.ALL_MY_FRIENDS_ARE_AGENTS_PROJECT_PATH}\\n`);\n');
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
  writeFileSync(binary, '#!/bin/sh\ncase "${1-}:${2-}" in --version:) echo 1.18.25-amfaa.2;; run:--help) echo "--format json --dir --agent --model --variant --session --auto";; models:--help) echo "models [provider] --verbose --refresh";; auth:login) exit 0;; *) exit 2;; esac\n'); chmodSync(binary, 0o755);
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
    expect(version).toEqual({ application: { version: "0.1.0", commit: "b".repeat(40) }, downstream: { version: "1.18.25-amfaa.2", commit: "6883ca5bd35a5494fb2759018373308911c79e01" } });
  });

  it("runs doctor, auth, and start without Node.js, pnpm, or OpenCode on PATH and keeps reports sanitized", () => {
    const built = build("c".repeat(40)); const project = fixture();
    const doctor = invoke(built.install, ["doctor"]); expect(JSON.parse(doctor)).toMatchObject({ runtime: "ready", application: { version: "0.1.0" }, downstream: { version: "1.18.25-amfaa.2" } });
    expect(doctor).not.toMatch(/Users\/|tmp\/|PATH|HOME|credential|token/);
    expect(() => invoke(built.install, ["auth"])).not.toThrow();
    expect(realpathSync(invoke(built.install, ["start"], project).trim())).toBe(realpathSync(project));
  });

  it("activates a completely verified update, retains rollback metadata, and preserves durable state during default uninstall", () => {
    const first = build("d".repeat(40)); const second = build("e".repeat(40)); const home = fixture();
    const state = path.join(home, ".all-my-friends-are-agents"); mkdirSync(state); writeFileSync(path.join(state, "room.json"), "durable");
    invoke(first.install, ["update", second.install], first.install, { HOME: home });
    expect(JSON.parse(invoke(first.install, ["version"], first.install, { HOME: home })).application.commit).toBe("e".repeat(40));
    expect(JSON.parse(readFileSync(path.join(first.install, "previous.json"), "utf8")).versionDirectory).toContain("dddddddddddd");
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
    rmSync(path.join(app, "node_modules/pkg")); symlinkSync(path.join(root, "node"), path.join(app, "node_modules/pkg"));
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
    invoke(built.install, ["start"], project, { HOME: home });
    const dataRoot = path.join(home, ".all-my-friends-are-agents"); writeFileSync(path.join(dataRoot, "room.json"), "durable");
    invoke(built.install, ["uninstall", "--purge-state", "CONFIRM"], built.install, { HOME: home });
    expect(existsSync(dataRoot)).toBe(false); expect(existsSync(path.join(built.install, "versions"))).toBe(false);
  });
});
