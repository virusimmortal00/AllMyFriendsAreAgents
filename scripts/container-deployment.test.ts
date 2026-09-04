import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const temporary: string[] = [];
function fixture() { const directory = mkdtempSync(path.join(os.tmpdir(), "amfaa-container-")); temporary.push(directory); return directory; }
function environment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, HOME: process.env.HOME, ...extra };
}
afterEach(() => { for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function start(project: string) {
  return spawnSync("sh", [path.join(root, "scripts/container-entrypoint.sh"), process.execPath, "-e", 'console.log("started")'], {
    env: environment({ ALL_MY_FRIENDS_ARE_AGENTS_PROJECT_PATH: project }), encoding: "utf8",
  });
}

describe("container project preflight", () => {
  it("starts with an independent Git checkout", () => {
    const project = fixture();
    execFileSync("git", ["init", "--quiet", project], { env: environment() });
    const result = start(project);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("started");
  });
  it("allows a plain context directory without inventing Git capabilities", () => {
    expect(start(fixture()).status).toBe(0);
  });
  it("fails before startup for a host-only worktree pointer without exposing its path", () => {
    const project = fixture();
    const privatePath = path.join(project, "missing-private-git-directory");
    writeFileSync(path.join(project, ".git"), `gitdir: ${privatePath}\n`);
    const result = start(project);
    expect(result.status).toBe(78);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Mount a standalone checkout");
    expect(result.stderr).not.toContain(privatePath);
  });
  it("fails closed for a missing project directory", () => {
    const result = start(path.join(fixture(), "absent"));
    expect(result.status).toBe(78);
    expect(result.stdout).toBe("");
  });
});

const composeAvailable = spawnSync("docker", ["compose", "version"], { stdio: "ignore" }).status === 0;
describe.skipIf(!composeAvailable)("Compose configuration without live state", () => {
  function configuration(input: { application?: string; compose?: string } = {}) {
    const directory = fixture();
    writeFileSync(path.join(directory, "compose.yaml"), readFileSync(path.join(root, "compose.yaml")));
    if (input.application !== undefined) writeFileSync(path.join(directory, ".env.container"), input.application);
    if (input.compose !== undefined) writeFileSync(path.join(directory, ".env"), input.compose);
    return JSON.parse(execFileSync("docker", ["compose", "--project-directory", directory, "-f", path.join(directory, "compose.yaml"), "config", "--format", "json"], {
      env: environment(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    })).services.amfaa;
  }
  it("does not seed a hostname or contribution credentials and binds loopback", () => {
    const service = configuration();
    expect(service.environment.ALL_MY_FRIENDS_ARE_AGENTS_ALLOWED_HOSTS).toBeUndefined();
    expect(service.environment.ALL_MY_FRIENDS_ARE_AGENTS_GITHUB_REPOSITORY).toBeUndefined();
    expect(service.environment.ALL_MY_FRIENDS_ARE_AGENTS_GITHUB_TOKEN).toBeUndefined();
    expect(service.ports.every((port: { host_ip: string }) => port.host_ip === "127.0.0.1")).toBe(true);
  });
  it("honors private server configuration without masking it", () => {
    const service = configuration({ application: "ALL_MY_FRIENDS_ARE_AGENTS_ALLOWED_HOSTS=agents.example.test\nALL_MY_FRIENDS_ARE_AGENTS_GITHUB_REPOSITORY=example/project\nALL_MY_FRIENDS_ARE_AGENTS_GITHUB_TOKEN=synthetic-only-test-token\n" });
    expect(service.environment).toMatchObject({
      ALL_MY_FRIENDS_ARE_AGENTS_ALLOWED_HOSTS: "agents.example.test",
      ALL_MY_FRIENDS_ARE_AGENTS_GITHUB_REPOSITORY: "example/project",
      ALL_MY_FRIENDS_ARE_AGENTS_GITHUB_TOKEN: "synthetic-only-test-token",
    });
  });
  it("resolves private project and ports while retaining a non-creating read-only mount", () => {
    const project = fixture();
    const service = configuration({ compose: `AMFAA_PROJECT_PATH=${project}\nAMFAA_HOST_PORT=54147\nAMFAA_WEB_HOST_PORT=4273\n` });
    const projectMount = service.volumes.find((volume: { target: string }) => volume.target === "/workspace");
    expect(projectMount).toMatchObject({ source: project, read_only: true });
    // Compose omits false-valued bind options in its normalized JSON.
    expect(projectMount.bind?.create_host_path).not.toBe(true);
    expect(service.ports.map((port: { published: string }) => port.published).sort()).toEqual(["4273", "54147"]);
  });
});
