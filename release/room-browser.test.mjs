import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { openRoomBrowser, roomBrowserMode } from "./room-browser.mjs";
describe("setup browser handoff", () => {
  it.each([{ SSH_CONNECTION: "fixture" }, { SSH_TTY: "fixture" }, { ALL_MY_FRIENDS_ARE_AGENTS_SETUP_SANDBOX: "1" }, { ALL_MY_FRIENDS_ARE_AGENTS_NO_BROWSER: "1" }])("does not launch a browser for a remote, sandbox, or opted-out session", async environment => {
    const spawnImpl = vi.fn();
    expect(await openRoomBrowser("http://127.0.0.1:53147", { environment, platform: "darwin", spawnImpl })).toBe(false);
    expect(spawnImpl).not.toHaveBeenCalled();
  });
  it("recognizes headless Linux and launches a desktop browser without a shell", async () => {
    expect(roomBrowserMode({}, "linux")).toBe("manual");
    const spawnImpl = vi.fn(() => { const child = new EventEmitter(); queueMicrotask(() => child.emit("exit", 0)); return child; });
    expect(await openRoomBrowser("http://127.0.0.1:54147", { environment: { DISPLAY: ":0" }, platform: "linux", spawnImpl })).toBe(true);
    expect(spawnImpl).toHaveBeenCalledWith("/usr/bin/xdg-open", ["http://127.0.0.1:54147/"], { stdio: "ignore", shell: false });
  });
  it("handles a missing browser and rejects external URLs", async () => {
    const spawnImpl = vi.fn(() => { const child = new EventEmitter(); queueMicrotask(() => child.emit("error", new Error("missing"))); return child; });
    expect(await openRoomBrowser("http://127.0.0.1:53147", { environment: {}, platform: "darwin", spawnImpl })).toBe(false);
    spawnImpl.mockClear();
    expect(await openRoomBrowser("https://example.test", { environment: {}, platform: "darwin", spawnImpl })).toBe(false);
    expect(spawnImpl).not.toHaveBeenCalled();
  });
});
