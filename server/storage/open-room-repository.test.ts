import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { resolveStorageConfiguration } from "./config.js";
import { openRoomRepository } from "./open-room-repository.js";
import { __testing as agentRunnerTesting } from "../agent-runner.js";

const execFileAsync = promisify(execFile);

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("room repository factory", () => {
  it("opens the legacy JSON repository by default", async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), "amfaa-storage-"));
    temporaryDirectories.push(projectRoot);
    const repository = await openRoomRepository(projectRoot);

    expect(repository.snapshot().settings.roomName).toBe("The Agent Room");
    expect(repository.snapshot().settings.conversationEnergy).toBe("party");
  });

  it("opens SQLite only when it is explicitly selected", async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), "amfaa-sqlite-storage-"));
    temporaryDirectories.push(projectRoot);
    const configuration = resolveStorageConfiguration(projectRoot, {
      ALL_MY_FRIENDS_ARE_AGENTS_STORAGE_BACKEND: "sqlite",
    });

    const repository = await openRoomRepository(projectRoot, configuration);

    expect(repository.snapshot().settings.roomName).toBe("The Agent Room");
    expect(repository.snapshot().settings.conversationEnergy).toBe("party");
  });

  it("fails closed while the postgres adapter is incomplete", async () => {
    const environment = {
      ALL_MY_FRIENDS_ARE_AGENTS_STORAGE_BACKEND: "postgres",
      DATABASE_URL: "postgresql://localhost/amfaa",
    };
    const configuration = resolveStorageConfiguration("/tmp/amfaa-project", environment);

    await expect(openRoomRepository("/tmp/amfaa-project", configuration)).rejects.toThrow("adapter is not implemented yet");
  });

  it("preserves same-epoch sessions across restarts and classifies a new commit as stale", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "amfaa-epoch-restart-"));
    temporaryDirectories.push(base);
    const projectRoot = path.join(base, "project");
    const sourcePath = path.join(projectRoot, "source.txt");
    await execFileAsync("git", ["init", "-b", "main", projectRoot]);
    await execFileAsync("git", ["-C", projectRoot, "config", "user.email", "tests@example.invalid"]);
    await execFileAsync("git", ["-C", projectRoot, "config", "user.name", "Tests"]);
    await writeFile(sourcePath, "first\n", "utf8");
    await execFileAsync("git", ["-C", projectRoot, "add", "source.txt"]);
    await execFileAsync("git", ["-C", projectRoot, "commit", "-m", "first"]);
    const configuration = resolveStorageConfiguration(projectRoot, { ALL_MY_FRIENDS_ARE_AGENTS_DATA_DIR: path.join(base, "state") });

    const first = await openRoomRepository(projectRoot, configuration);
    const firstEpoch = first.snapshot().deployment!.epoch;
    await first.setSession("codex-sol", "same-epoch-session", "read-only", firstEpoch);
    const restarted = await openRoomRepository(projectRoot, configuration);
    const sameEpochSession = restarted.snapshot().sessions["codex-sol"]!;
    expect(restarted.snapshot().deployment?.epoch).toBe(firstEpoch);
    expect(sameEpochSession.codeEpoch).toBe(firstEpoch);
    expect(agentRunnerTesting.openCodeSessionDecision("codex-sol", restarted.snapshot().roster!.entries.find(({ agentId }) => agentId === "codex-sol")!, sameEpochSession, "read-only", restarted.snapshot().deployment)).toMatchObject({ kind: "reuse" });

    await writeFile(sourcePath, "second\n", "utf8");
    await execFileAsync("git", ["-C", projectRoot, "add", "source.txt"]);
    await execFileAsync("git", ["-C", projectRoot, "commit", "-m", "second"]);
    const updated = await openRoomRepository(projectRoot, configuration);
    const staleSession = updated.snapshot().sessions["codex-sol"]!;
    expect(updated.snapshot().deployment?.epoch).not.toBe(firstEpoch);
    expect(agentRunnerTesting.openCodeSessionDecision("codex-sol", updated.snapshot().roster!.entries.find(({ agentId }) => agentId === "codex-sol")!, staleSession, "read-only", updated.snapshot().deployment)).toEqual({ kind: "invalidate", reason: "deployment code epoch changed" });
  });
});
