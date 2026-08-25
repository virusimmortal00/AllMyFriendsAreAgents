import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, constants, lstat, readFile, realpath } from "node:fs/promises";
import { createConnection } from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import type { AssignmentGitClaims } from "./git-security-boundary.js";

const execFileAsync = promisify(execFile);
export const WRITER_BOUNDARY_REVISION = "confined-writer/v1" as const;
export const WRITER_BOUNDARY_ACTIVATION = "assignment-git-broker/v1" as const;

export interface ConfinedWriterGrant {
  readonly revision: typeof WRITER_BOUNDARY_REVISION;
  readonly claims: AssignmentGitClaims;
  readonly repositoryPath: string;
  readonly gitCommonDirectory: string;
  readonly brokerSocketPath: string;
  readonly brokerToken: string;
  readonly brokerRootPath: string;
  readonly gitShimDirectory: string;
  readonly gitShimDigest: string;
  readonly gitExecutablePath: string;
}

export type ConfinementBackend = "sandbox-exec" | "bwrap";

/** Explicit activation is necessary but not sufficient: the OS backend, broker
 * socket, canonical assignment workspace, and repository identity must verify. */
export async function verifyWriterConfinement(
  grant: ConfinedWriterGrant,
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<{ backend: ConfinementBackend; command: string; prefix: readonly string[] }> {
  if (environment.ALL_MY_FRIENDS_ARE_AGENTS_GIT_SECURITY_BOUNDARY !== WRITER_BOUNDARY_ACTIVATION) {
    throw new Error("Verified Git security boundary is not explicitly active");
  }
  if (grant.revision !== WRITER_BOUNDARY_REVISION || !path.isAbsolute(grant.brokerSocketPath)
    || !path.isAbsolute(grant.brokerRootPath) || !path.isAbsolute(grant.gitShimDirectory)
    || !path.isAbsolute(grant.gitExecutablePath) || grant.brokerToken.length < 32
    || !/^[0-9a-f]{64}$/.test(grant.gitShimDigest)) throw new Error("Git broker grant is unavailable or invalid");
  const [workspace, repository, common, gitExecutable] = await Promise.all([
    realpath(grant.claims.workspacePath), realpath(grant.repositoryPath), realpath(grant.gitCommonDirectory),
    realpath(grant.gitExecutablePath),
  ]);
  const gitExecutables = await resolveGitExecutablePaths(environment);
  if (!gitExecutables.includes(gitExecutable)) throw new Error("Git executable identity changed outside the verified PATH");
  if (workspace !== grant.claims.workspacePath || workspace === repository) throw new Error("Assignment ownership cannot be established");
  const [brokerRoot, socketCanonical, shimCanonical] = await Promise.all([
    realpath(grant.brokerRootPath), realpath(grant.brokerSocketPath), realpath(grant.gitShimDirectory),
  ]).catch(() => { throw new Error("Git broker is unavailable"); });
  if (path.dirname(grant.brokerSocketPath) !== grant.brokerRootPath || path.dirname(grant.gitShimDirectory) !== grant.brokerRootPath
    || socketCanonical !== path.join(brokerRoot, path.basename(grant.brokerSocketPath))
    || shimCanonical !== path.join(brokerRoot, path.basename(grant.gitShimDirectory))
    || within(workspace, brokerRoot) || brokerRoot === workspace) throw new Error("Git broker paths are not canonically contained");
  const socketPath = grant.brokerSocketPath;
  const shimDirectory = grant.gitShimDirectory;
  const shimPath = path.join(shimDirectory, process.platform === "win32" ? "git.cmd" : "git");
  const [rootInfo, socketInfo, shimInfo, shimSource] = await Promise.all([
    lstat(grant.brokerRootPath), lstat(socketPath), lstat(shimPath), readFile(shimPath),
  ]).catch(() => { throw new Error("Git broker or shim is unavailable"); });
  const expectedUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (!rootInfo.isDirectory() || !socketInfo.isSocket() || !shimInfo.isFile()
    || (rootInfo.mode & 0o777) !== 0o700 || (socketInfo.mode & 0o777) !== 0o600 || (shimInfo.mode & 0o777) !== 0o700
    || (expectedUid !== undefined && [rootInfo.uid, socketInfo.uid, shimInfo.uid].some((uid) => uid !== expectedUid))) {
    throw new Error("Git broker endpoint ownership, type, or mode is invalid");
  }
  if (createHash("sha256").update(shimSource).digest("hex") !== grant.gitShimDigest) throw new Error("Git broker shim identity is invalid");
  await verifyBrokerLiveness(socketPath, grant.brokerToken, grant.claims.assignmentId);

  if (platform === "darwin") {
    await execFileAsync("sandbox-exec", ["-n", "no-network", "/usr/bin/true"], { timeout: 5_000, env: environment });
    const profile = [
      "(version 1)", "(allow default)",
      `(deny file-write* (subpath ${quoteSandbox(repository)}))`,
      `(deny file-read* file-write* (subpath ${quoteSandbox(common)}))`,
      `(allow file-read* file-write* (subpath ${quoteSandbox(workspace)}))`,
      `(deny file-read* file-write* (literal ${quoteSandbox(path.join(workspace, ".git"))}))`,
      ...gitExecutables.map((candidate) => `(deny file-read* process-exec (literal ${quoteSandbox(candidate)}))`),
      `(allow file-read* (literal ${quoteSandbox(socketPath)}))`,
    ].join(" ");
    return { backend: "sandbox-exec", command: "sandbox-exec", prefix: ["-p", profile] };
  }
  if (platform === "linux") {
    await execFileAsync("bwrap", ["--version"], { timeout: 5_000, env: environment });
    return {
      backend: "bwrap", command: "bwrap",
      prefix: ["--die-with-parent", "--new-session", "--ro-bind", "/", "/", "--bind", workspace, workspace, "--ro-bind", "/dev/null", path.join(workspace, ".git"), ...gitExecutables.flatMap((candidate) => ["--ro-bind", "/dev/null", candidate]), "--ro-bind", grant.brokerRootPath, grant.brokerRootPath, "--chdir", workspace, "--"],
    };
  }
  throw new Error(`No supported writer confinement backend for ${platform}`);
}

export async function confinedWriterInvocation(
  command: string,
  args: readonly string[],
  grant: ConfinedWriterGrant,
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
) {
  if (!command || command === "git" || /(^|[/\\])git(?:\.exe)?$/.test(command)) throw new Error("Direct Git invocation is unavailable from the confined writer path");
  const confinement = await verifyWriterConfinement(grant, environment, platform);
  return {
    command: confinement.command,
    args: [...confinement.prefix, command, ...args],
    cwd: grant.claims.workspacePath,
    env: {
      PATH: `${grant.gitShimDirectory}${path.delimiter}${environment.PATH || "/usr/bin:/bin"}`, HOME: environment.HOME || "/var/empty",
      ALL_MY_FRIENDS_ARE_AGENTS_GIT_BROKER_SOCKET: grant.brokerSocketPath,
      ALL_MY_FRIENDS_ARE_AGENTS_GIT_BROKER_TOKEN: grant.brokerToken,
      ALL_MY_FRIENDS_ARE_AGENTS_ASSIGNMENT_ID: grant.claims.assignmentId,
      ALL_MY_FRIENDS_ARE_AGENTS_GIT_SECURITY_BOUNDARY: WRITER_BOUNDARY_ACTIVATION,
    },
  };
}

export async function resolveGitExecutablePath(environment: NodeJS.ProcessEnv = process.env) {
  const candidates = await resolveGitExecutablePaths(environment);
  if (candidates[0]) return candidates[0];
  throw new Error("Git executable identity cannot be established");
}

export async function resolveGitExecutablePaths(environment: NodeJS.ProcessEnv = process.env) {
  const candidates: string[] = [];
  for (const directory of (environment.PATH || "/usr/bin:/bin").split(path.delimiter)) {
    const candidate = path.join(directory, process.platform === "win32" ? "git.exe" : "git");
    if (!await access(candidate, constants.X_OK).then(() => true).catch(() => false)) continue;
    const canonical = await realpath(candidate);
    if (!candidates.includes(canonical)) candidates.push(canonical);
  }
  return candidates;
}

function quoteSandbox(value: string) { return JSON.stringify(value); }

function within(parent: string, child: string) {
  const relative = path.relative(parent, child);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function verifyBrokerLiveness(socketPath: string, token: string, assignmentId: string) {
  return new Promise<void>((resolve, reject) => {
    const socket = createConnection(socketPath);
    let output = ""; let settled = false;
    const timer = setTimeout(() => finish(new Error("Git broker liveness check timed out")), 5_000);
    const finish = (error?: Error) => {
      if (settled) return; settled = true; clearTimeout(timer); socket.destroy();
      error ? reject(error) : resolve();
    };
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify({ token, health: true })}\n`));
    socket.on("data", (chunk) => { output += chunk; });
    socket.on("end", () => {
      try {
        const response = JSON.parse(output) as { kind?: string; assignmentId?: string; boundaryRevision?: string };
        if (response.kind !== "health" || response.assignmentId !== assignmentId || response.boundaryRevision !== WRITER_BOUNDARY_ACTIVATION) {
          finish(new Error("Git broker authenticated liveness check failed"));
        } else finish();
      } catch { finish(new Error("Git broker authenticated liveness check failed")); }
    });
    socket.on("error", () => finish(new Error("Git broker is unavailable")));
  });
}
