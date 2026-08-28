import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("bounded application service launch", () => {
  it("routes production diagnostics exclusively through Pino and disables supervisor output files", async () => {
    const root = path.resolve(import.meta.dirname, "..");
    const packageManifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as { scripts: Record<string, string> };
    const scriptPath = path.join(root, "scripts", "run-application-service.zsh");
    const script = await readFile(scriptPath, "utf8");
    const launchd = await readFile(path.join(root, "config", "launchd", "io.allmyfriendsareagents.server.plist.example"), "utf8");
    expect(packageManifest.scripts["service:start"]).toBe("zsh scripts/run-application-service.zsh");
    expect(script).toContain('exec "${AMFAA_PNPM_BIN:-pnpm}" start </dev/null >/dev/null 2>&1');
    expect((await stat(scriptPath)).mode & 0o111).not.toBe(0);
    expect(launchd.match(/<key>Standard(?:Out|Error)Path<\/key>\s*<string>\/dev\/null<\/string>/g)).toHaveLength(2);
    expect(launchd).toMatch(/<key>AMFAA_PNPM_BIN<\/key>\s*<string>\/absolute\/path\/to\/pnpm<\/string>/);
    expect(`${script}\n${launchd}`).not.toContain("live-dev.log");
  });
});
