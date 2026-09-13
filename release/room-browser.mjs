import { spawn } from "node:child_process";

export function roomBrowserMode(environment = process.env, platform = process.platform) {
  if (environment.ALL_MY_FRIENDS_ARE_AGENTS_SETUP_SANDBOX === "1") return "container";
  if (environment.SSH_CONNECTION || environment.SSH_CLIENT || environment.SSH_TTY) return "remote";
  if (environment.ALL_MY_FRIENDS_ARE_AGENTS_NO_BROWSER === "1" || (platform === "linux" && !environment.DISPLAY && !environment.WAYLAND_DISPLAY)) return "manual";
  return "local";
}
export async function openRoomBrowser(url, { environment = process.env, platform = process.platform, spawnImpl = spawn } = {}) {
  if (roomBrowserMode(environment, platform) !== "local") return false;
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" || parsed.username || parsed.password) return false;
  const command = platform === "darwin" ? "/usr/bin/open" : platform === "win32" ? "rundll32.exe" : "xdg-open";
  const args = platform === "win32" ? ["url.dll,FileProtocolHandler", parsed.href] : [parsed.href];
  return new Promise(resolve => {
    let child;
    const timer = setTimeout(() => { child?.kill(); resolve(false); }, 5000);
    const finish = success => { clearTimeout(timer); resolve(success); };
    try {
      child = spawnImpl(command, args, { stdio: "ignore", shell: false });
      child.once("error", () => finish(false)); child.once("exit", code => finish(code === 0));
    } catch { finish(false); }
  });
}
