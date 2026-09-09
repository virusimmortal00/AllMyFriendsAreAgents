import { describe, expect, it } from "vitest";
import { resetContainerOwner } from "./reset-container-owner.mjs";

function fixture({ running = true, mounted = true, failRecovery = false, stillRunning = false } = {}) {
  const calls = [];
  const info = { Id: "container-id", Image: "sha256:exact-image", Config: { Env: ["ALL_MY_FRIENDS_ARE_AGENTS_DATA_DIR=/data"] }, Mounts: mounted ? [{ Destination: "/data", RW: true }] : [], State: { Running: running } };
  let inspections = 0;
  const run = (program, args, input) => {
    calls.push({ program, args, input });
    if (args[0] === "inspect") return JSON.stringify([{ ...info, State: { Running: inspections++ === 0 ? running : stillRunning } }]);
    if (args[0] === "run" && failRecovery) throw new Error("Recovery failed");
    return "";
  };
  return { calls, run };
}

describe("container owner recovery", () => {
  it("stops the writer, reuses its exact image and mounts, passes the password only through stdin, and restarts", () => {
    const { calls, run } = fixture();
    const password = "fictional-recovery-password";
    resetContainerOwner("example", password, run);
    expect(calls.map(({ args }) => args[0])).toEqual(["inspect", "stop", "inspect", "run", "start"]);
    const recovery = calls.find(({ args }) => args[0] === "run");
    expect(recovery.args).toEqual(expect.arrayContaining(["--network", "none", "--volumes-from", "container-id", "sha256:exact-image"]));
    expect(recovery.input).toBe(password);
    expect(JSON.stringify(calls.map(({ args }) => args))).not.toContain(password);
  });
  it("restores service after failed recovery", () => {
    const { calls, run } = fixture({ failRecovery: true });
    expect(() => resetContainerOwner("example", "fictional-password", run)).toThrow("Recovery failed");
    expect(calls.at(-1).args).toEqual(["start", "container-id"]);
  });
  it("keeps an originally stopped server stopped", () => {
    const { calls, run } = fixture({ running: false });
    resetContainerOwner("example", "fictional-password", run);
    expect(calls.map(({ args }) => args[0])).toEqual(["inspect", "inspect", "run"]);
  });
  it("refuses unmounted state before stopping the server", () => {
    const { calls, run } = fixture({ mounted: false });
    expect(() => resetContainerOwner("example", "fictional-password", run)).toThrow("existing writable mount");
    expect(calls).toHaveLength(1);
  });
  it("refuses to recover while a writer is running", () => {
    const { calls, run } = fixture({ stillRunning: true });
    expect(() => resetContainerOwner("example", "fictional-password", run)).toThrow("must remain stopped");
    expect(calls.some(({ args }) => args[0] === "run")).toBe(false);
  });
  it("rejects invalid input before invoking Docker", () => {
    const { calls, run } = fixture();
    expect(() => resetContainerOwner("example", "short", run)).toThrow("12 and 256");
    expect(() => resetContainerOwner("--all", "fictional-password", run)).toThrow("explicit container");
    expect(calls).toHaveLength(0);
  });
});
