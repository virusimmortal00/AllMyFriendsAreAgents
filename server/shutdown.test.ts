import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

it("shares the real server shutdown completion between signal and service callers", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "amfaa-shutdown-"));
  const project = path.join(directory, "project");
  await mkdir(project);
  try {
    const { stdout } = await promisify(execFile)(process.execPath, [
      "--import", "tsx", "--import", "./server/fixtures/server-isolation.mjs",
      "--input-type=module", "--eval", `
        import assert from 'node:assert/strict';
        const { ready, shutdown } = await import('./server/index.ts');
        await ready;
        const signalShutdown = shutdown('SIGTERM');
        const serviceShutdown = shutdown('service-stop');
        assert.equal(serviceShutdown, signalShutdown);
        await serviceShutdown;
        console.log('shared shutdown completed');
      `,
    ], {
      cwd: path.resolve(import.meta.dirname, ".."), timeout: 15000,
      env: {
        PATH: process.env.PATH, NODE_ENV: "test", AMFAA_TEST_DIRECTORY: directory,
        ALL_MY_FRIENDS_ARE_AGENTS_HOST: "127.0.0.1", ALL_MY_FRIENDS_ARE_AGENTS_PORT: "0",
        ALL_MY_FRIENDS_ARE_AGENTS_DATA_DIR: path.join(directory, "data"),
        ALL_MY_FRIENDS_ARE_AGENTS_PROJECT_PATH: project,
        ALL_MY_FRIENDS_ARE_AGENTS_ASSIGNMENT_WORKTREES_DIR: path.join(directory, "worktrees"),
        ALL_MY_FRIENDS_ARE_AGENTS_OPENCODE_COMMAND: path.join(directory, "missing-opencode"),
        ALL_MY_FRIENDS_ARE_AGENTS_STORAGE_BACKEND: "json",
      },
    });
    expect(stdout).toContain("shared shutdown completed");
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 20000);
