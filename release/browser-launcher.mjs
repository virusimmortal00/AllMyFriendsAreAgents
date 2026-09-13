import { spawn } from "node:child_process";

/** Use OS-owned launchers, never a command selected through the caller's PATH. */
export function systemBrowserCommand(platform = process.platform) {
  if (platform === "darwin") return { command: "/usr/bin/open", prefix: [] };
  if (platform === "win32") return { command: "C:\\Windows\\System32\\rundll32.exe", prefix: ["C:\\Windows\\System32\\url.dll,FileProtocolHandler"] };
  return { command: "/usr/bin/xdg-open", prefix: [] };
}
/** A missing/nonstandard desktop launcher falls back to the printed browser URL. */
export function launchSystemBrowser(url, { platform = process.platform, spawnImpl = spawn } = {}) {
  const { command, prefix } = systemBrowserCommand(platform);
  return new Promise(resolve => {
    let child;
    const timer = setTimeout(() => { child?.kill(); resolve(false); }, 5000);
    const finish = success => { clearTimeout(timer); resolve(success); };
    try {
      child = spawnImpl(command, [...prefix, url], { stdio: "ignore", shell: false });
      child.once("error", () => finish(false)); child.once("exit", code => finish(code === 0));
    } catch { finish(false); }
  });
}
