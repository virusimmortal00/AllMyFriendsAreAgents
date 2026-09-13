import { launchSystemBrowser } from "./browser-launcher.mjs";

export function roomBrowserMode(environment = process.env, platform = process.platform) {
  if (environment.ALL_MY_FRIENDS_ARE_AGENTS_SETUP_SANDBOX === "1") return "container";
  if (environment.SSH_CONNECTION || environment.SSH_CLIENT || environment.SSH_TTY) return "remote";
  if (environment.ALL_MY_FRIENDS_ARE_AGENTS_NO_BROWSER === "1" || (platform === "linux" && !environment.DISPLAY && !environment.WAYLAND_DISPLAY)) return "manual";
  return "local";
}
export async function openRoomBrowser(url, { environment = process.env, platform = process.platform, spawnImpl } = {}) {
  if (roomBrowserMode(environment, platform) !== "local") return false;
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" || parsed.username || parsed.password) return false;
  return launchSystemBrowser(parsed.href, { platform, spawnImpl });
}
