import { describe, expect, it, vi } from "vitest";
import type { DiscoveryExecutor } from "./model-discovery.js";
import { inspectOpenCodeRuntime, OpenCodeRuntimeMonitor, runtimeAvailability } from "./opencode-runtime.js";

describe("OpenCode runtime preflight", () => {
  it("accepts an approved runtime and projects its availability to configured agents", async () => {
    const execute = vi.fn<DiscoveryExecutor>(async () => ({ stdout: "1.18.25\n", stderr: "" }));
    const status = await inspectOpenCodeRuntime(execute, () => 0);

    expect(status).toEqual({ state: "ready", version: "1.18.25", checkedAt: "1970-01-01T00:00:00.000Z" });
    expect(execute).toHaveBeenCalledWith(expect.any(String), ["--version"], expect.any(AbortSignal));
    expect(runtimeAvailability(["codex-sol", "claude-opus"], status)).toEqual({ "codex-sol": true, "claude-opus": true });
  });

  it("fails closed for unsupported or malformed runtime identities", async () => {
    const execute = vi.fn<DiscoveryExecutor>(async () => ({ stdout: "1.18.26\n", stderr: "" }));

    await expect(inspectOpenCodeRuntime(execute, () => 0)).resolves.toEqual({ state: "unavailable", reason: "unsupported_version", checkedAt: "1970-01-01T00:00:00.000Z" });
  });

  it.each([
    [Object.assign(new Error("the binary name is private"), { code: "ENOENT" }), "command_not_found"],
    [Object.assign(new Error("permission denied"), { code: "EACCES" }), "not_executable"],
    [Object.assign(new Error("Command failed: opencode --version"), { code: null, killed: true, signal: "SIGTERM" }), "timed_out"],
    [new Error("command timed out after 10 seconds"), "timed_out"],
    [new Error("token=super-secret-value"), "command_failed"],
  ] as const)("returns only a safe reason for a failed command", async (error, reason) => {
    const execute = vi.fn<DiscoveryExecutor>(async () => { throw error; });
    const status = await inspectOpenCodeRuntime(execute, () => 0);

    expect(status).toEqual({ state: "unavailable", reason, checkedAt: "1970-01-01T00:00:00.000Z" });
    expect(JSON.stringify(status)).not.toContain("super-secret-value");
    expect(runtimeAvailability(["codex-sol"], status)).toEqual({ "codex-sol": false });
  });

  it("settles at the hard preflight deadline when the executable ignores cancellation", async () => {
    vi.useFakeTimers();
    const execute = vi.fn<DiscoveryExecutor>(() => new Promise(() => {}));
    const status = inspectOpenCodeRuntime(execute, () => 0, 100);

    await vi.advanceTimersByTimeAsync(100);
    await expect(status).resolves.toEqual({ state: "unavailable", reason: "timed_out", checkedAt: "1970-01-01T00:00:00.000Z" });
    expect(execute).toHaveBeenCalledWith(expect.any(String), ["--version"], expect.objectContaining({ aborted: true }));
    vi.useRealTimers();
  });

  it("coalesces stale refreshes and serves the latest bounded result from cache", async () => {
    let resolve: ((status: { state: "ready"; version: string; checkedAt: string }) => void) | undefined;
    const inspect = vi.fn(() => new Promise<{ state: "ready"; version: string; checkedAt: string }>((done) => { resolve = done; }));
    const monitor = new OpenCodeRuntimeMonitor(
      { state: "unavailable", reason: "command_failed", checkedAt: new Date(0).toISOString() },
      inspect,
      () => 30_001,
      30_000,
    );

    const first = monitor.refresh();
    const second = monitor.refresh();
    expect(inspect).toHaveBeenCalledOnce();
    resolve?.({ state: "ready", version: "1.18.25", checkedAt: new Date(30_001).toISOString() });
    await expect(Promise.all([first, second])).resolves.toEqual([
      { state: "ready", version: "1.18.25", checkedAt: new Date(30_001).toISOString() },
      { state: "ready", version: "1.18.25", checkedAt: new Date(30_001).toISOString() },
    ]);
    await expect(monitor.refresh()).resolves.toEqual(monitor.snapshot());
    expect(inspect).toHaveBeenCalledOnce();
  });
});
