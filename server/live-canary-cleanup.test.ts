import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

it.each(["SIGINT", "SIGTERM"] as const)("cleans up an interrupted live-canary startup on %s without provider calls", async (signal) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "amfaa-cleanup-test-"));
  const cli = path.join(root, "fixture.mjs"), pidFile = path.join(root, "pid");
  await writeFile(cli, `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nsetInterval(() => {}, 1000);\n`, { mode: 0o700 });
  const child = spawn(process.execPath, ["--import", "tsx", "scripts/room-tool-live-canary.ts"], {
    cwd: path.resolve(import.meta.dirname, ".."), stdio: "ignore",
    env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, TMP: root, TEMP: root, AMFAA_CANARY_ALLOW_REAL_PROVIDER: "true", AMFAA_CANARY_ROOM_MODEL: "openrouter/fixture", ALL_MY_FRIENDS_ARE_AGENTS_OPENCODE_COMMAND: cli },
  });
  let cliPid: number | undefined;
  const kill = (pid: number | undefined) => { if (pid) try { process.kill(pid, "SIGKILL"); } catch { /* Already exited. */ } };
  try {
    for (let i = 0; i < 100; i++) {
      cliPid = Number(await readFile(pidFile, "utf8").catch(() => "")) || undefined;
      if (cliPid) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(Boolean(cliPid)).toBe(true);
    const exited = once(child, "exit");
    child.kill(signal);
    const timeout = setTimeout(() => child.kill("SIGKILL"), 5_000);
    try { await exited; } finally { clearTimeout(timeout); }
    expect(child.signalCode).toBeNull();
    expect((await readdir(root)).filter((name) => name.startsWith("amfaa-live-room-tools-"))).toEqual([]);
    expect(() => process.kill(cliPid!, 0)).toThrow();
  } finally {
    if (child.exitCode === null && child.signalCode === null) kill(child.pid);
    kill(cliPid);
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
