import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { launchSystemBrowser } from "./browser-launcher.mjs";
import { openSetupBrowser } from "./setup-auth.mjs";

describe("trusted desktop launcher", () => {
  it.each([
    ["darwin", "/usr/bin/open", []],
    ["linux", "/usr/bin/xdg-open", []],
    ["win32", "C:\\Windows\\System32\\rundll32.exe", ["C:\\Windows\\System32\\url.dll,FileProtocolHandler"]],
  ])("uses an absolute OS launcher on %s for authentication", async (platform, command, prefix) => {
    const spawnImpl = vi.fn(() => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", 0));
      return child;
    });
    const url = "https://openrouter.ai/auth?code_challenge=fixture";
    expect(openSetupBrowser).toBe(launchSystemBrowser);
    expect(await openSetupBrowser(url, { platform, spawnImpl })).toBe(true);
    expect(spawnImpl).toHaveBeenCalledWith(command, [...prefix, url], { stdio: "ignore", shell: false });
  });
  it("falls back to the displayed URL when a system launcher is unavailable", async () => {
    expect(await launchSystemBrowser("https://example.test", { spawnImpl: () => { throw new Error("unavailable"); } })).toBe(false);
  });
});
