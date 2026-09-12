import { describe, expect, it, vi } from "vitest";
import { authenticateWithSelectedOpenCode } from "./auth-native-opencode.js";

describe("source OpenCode authentication handoff", () => {
  it("launches authentication through the runtime selected by server preflight", async () => {
    const run = vi.fn(async () => 0);
    const resolve = async () => ({ state: "ready", command: "/application/.runtime/opencode/bin/opencode", source: "source-setup", version: "1.18.25-amfaa.2", checkedAt: new Date(0).toISOString() } as const);
    await expect(authenticateWithSelectedOpenCode({ resolve, run })).resolves.toBe(0);
    expect(run).toHaveBeenCalledWith("/application/.runtime/opencode/bin/opencode", ["auth", "login"]);
  });

  it("fails before launching a command when runtime preflight is unavailable", async () => {
    const run = vi.fn(async () => 0);
    const resolve = async () => ({ state: "unavailable", reason: "binary_contract_failed", checkedAt: new Date(0).toISOString() } as const);
    await expect(authenticateWithSelectedOpenCode({ resolve, run })).rejects.toThrow(/pnpm setup/);
    expect(run).not.toHaveBeenCalled();
  });

  it("preserves the interactive command exit status", async () => {
    const resolve = async () => ({ state: "ready", command: "operator-opencode", source: "operator-override", version: "1.18.25", checkedAt: new Date(0).toISOString() } as const);
    await expect(authenticateWithSelectedOpenCode({ resolve, run: async () => 23 })).resolves.toBe(23);
  });
});
