import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DiscoveryExecutor } from "./model-discovery.js";
import { openCodeRuntimePaths, OpenCodeRuntimeMonitor, publicOpenCodeRuntimeStatus, resolveOpenCodeRuntime, runtimeAvailability } from "./opencode-runtime.js";

const roots: string[] = [];
const version = "1.18.25-amfaa.2\n";
const runHelp = "--format json --dir --agent --model --variant --session --auto\n";
const modelsHelp = "models [provider] --verbose --refresh\n";

async function root() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "amfaa-runtime-"));
  roots.push(directory);
  return directory;
}

async function executable(command: string, mode = 0o755) {
  await mkdir(path.dirname(command), { recursive: true });
  await writeFile(command, "fixture");
  await chmod(command, mode);
}

function successfulExecutor(calls: Array<{ command: string; args: readonly string[] }> = []): DiscoveryExecutor {
  return async (command, args) => {
    calls.push({ command, args });
    return { stdout: args[0] === "--version" ? version : args[0] === "run" ? runHelp : modelsHelp, stderr: "" };
  };
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("OpenCode runtime resolution", () => {
  it("prefers the packaged runtime and never consults an unrelated newer global binary", async () => {
    const directory = await root();
    const paths = openCodeRuntimePaths(directory);
    const global = path.join(directory, "global", "opencode");
    await Promise.all([executable(paths.packaged), executable(paths.sourceSetup), executable(global)]);
    const calls: Array<{ command: string; args: readonly string[] }> = [];

    const resolution = await resolveOpenCodeRuntime({
      root: directory,
      environment: { PATH: path.dirname(global) },
      execute: successfulExecutor(calls),
      now: () => 0,
    });

    expect(resolution).toEqual({ state: "ready", command: paths.packaged, source: "packaged", version: version.trim(), checkedAt: "1970-01-01T00:00:00.000Z" });
    expect(calls.map(({ command }) => command)).toEqual([paths.packaged, paths.packaged, paths.packaged]);
    expect(calls.some(({ command }) => command === global || command === "opencode")).toBe(false);
    const status = publicOpenCodeRuntimeStatus(resolution);
    expect(runtimeAvailability(["codex-sol", "claude-opus"], status)).toEqual({ "codex-sol": true, "claude-opus": true });
  });

  it("uses the source-setup runtime only when no packaged executable is present", async () => {
    const directory = await root();
    const paths = openCodeRuntimePaths(directory);
    await executable(paths.sourceSetup);
    const calls: Array<{ command: string; args: readonly string[] }> = [];

    await expect(resolveOpenCodeRuntime({ root: directory, environment: { PATH: "/unrelated" }, execute: successfulExecutor(calls), now: () => 0 }))
      .resolves.toMatchObject({ state: "ready", command: paths.sourceSetup, source: "source-setup" });
    expect(calls.every(({ command }) => command === paths.sourceSetup)).toBe(true);
  });

  it("treats an explicit operator override as authoritative without falling through", async () => {
    const directory = await root();
    const paths = openCodeRuntimePaths(directory);
    const override = path.join(directory, "operator", "opencode");
    await Promise.all([executable(paths.packaged), executable(override)]);
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const execute: DiscoveryExecutor = async (command, args) => {
      calls.push({ command, args });
      return { stdout: args[0] === "--version" ? "9.0.0\n" : "", stderr: "" };
    };

    await expect(resolveOpenCodeRuntime({ root: directory, override, execute, now: () => 0 })).resolves.toEqual({ state: "unavailable", reason: "binary_contract_failed", checkedAt: "1970-01-01T00:00:00.000Z" });
    expect(calls.map(({ command }) => command)).toEqual([override, override, override]);
  });

  it("reserves the audited stock runtime for an explicit operator override", async () => {
    const directory = await root();
    const paths = openCodeRuntimePaths(directory);
    await executable(paths.sourceSetup);
    const stock: DiscoveryExecutor = async (_command, args) => ({ stdout: args[0] === "--version" ? "1.18.25\n" : args[0] === "run" ? runHelp : modelsHelp, stderr: "" });

    await expect(resolveOpenCodeRuntime({ root: directory, execute: stock, now: () => 0 })).resolves.toEqual({ state: "unavailable", reason: "binary_contract_failed", checkedAt: "1970-01-01T00:00:00.000Z" });
    await expect(resolveOpenCodeRuntime({ root: directory, override: "operator-opencode", execute: stock, now: () => 0 })).resolves.toMatchObject({ state: "ready", command: "operator-opencode", source: "operator-override", version: "1.18.25" });
  });

  it("fails closed for a non-executable packaged candidate instead of selecting source setup", async () => {
    const directory = await root();
    const paths = openCodeRuntimePaths(directory);
    await Promise.all([executable(paths.packaged, 0o644), executable(paths.sourceSetup)]);
    const execute = vi.fn<DiscoveryExecutor>(successfulExecutor());

    await expect(resolveOpenCodeRuntime({ root: directory, execute, now: () => 0 })).resolves.toEqual({ state: "unavailable", reason: "not_executable", checkedAt: "1970-01-01T00:00:00.000Z" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("fails closed when app-owned candidates are missing or the binary contract is incomplete", async () => {
    const directory = await root();
    const paths = openCodeRuntimePaths(directory);
    const missingExecute = vi.fn<DiscoveryExecutor>(successfulExecutor());
    await expect(resolveOpenCodeRuntime({ root: directory, environment: { PATH: "/global-only" }, execute: missingExecute, now: () => 0 })).resolves.toEqual({ state: "unavailable", reason: "command_not_found", checkedAt: "1970-01-01T00:00:00.000Z" });
    expect(missingExecute).not.toHaveBeenCalled();

    await executable(paths.sourceSetup);
    const incomplete: DiscoveryExecutor = async (_command, args) => ({ stdout: args[0] === "--version" ? version : "incomplete help", stderr: "" });
    await expect(resolveOpenCodeRuntime({ root: directory, execute: incomplete, now: () => 0 })).resolves.toEqual({ state: "unavailable", reason: "binary_contract_failed", checkedAt: "1970-01-01T00:00:00.000Z" });
  });

  it("settles at the hard preflight deadline and coalesces monitor refreshes", async () => {
    vi.useFakeTimers();
    const directory = await root();
    const paths = openCodeRuntimePaths(directory);
    const execute = vi.fn<DiscoveryExecutor>(() => new Promise(() => {}));
    const timedOut = resolveOpenCodeRuntime({ root: directory, override: "operator-opencode", execute, now: () => 0, timeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(100);
    await expect(timedOut).resolves.toEqual({ state: "unavailable", reason: "timed_out", checkedAt: "1970-01-01T00:00:00.000Z" });
    expect(execute).toHaveBeenCalledWith("operator-opencode", ["--version"], expect.objectContaining({ aborted: true }));

    const ready = { state: "ready", command: paths.packaged, source: "packaged", version: version.trim(), checkedAt: new Date(30_001).toISOString() } as const;
    const inspect = vi.fn(async () => ready);
    const initial = { state: "unavailable", reason: "command_failed", checkedAt: new Date(0).toISOString() } as const;
    const monitor = new OpenCodeRuntimeMonitor(initial, inspect, () => 30_001, 30_000);
    await expect(Promise.all([monitor.refresh(), monitor.refresh()])).resolves.toEqual([ready, ready]);
    expect(inspect).toHaveBeenCalledOnce();
  });
});
