import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveStorageConfiguration } from "./config.js";
import { openRoomRepository } from "./open-room-repository.js";

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
  });

  it("opens SQLite only when it is explicitly selected", async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), "amfaa-sqlite-storage-"));
    temporaryDirectories.push(projectRoot);
    const configuration = resolveStorageConfiguration(projectRoot, {
      ALL_MY_FRIENDS_ARE_AGENTS_STORAGE_BACKEND: "sqlite",
    });

    const repository = await openRoomRepository(projectRoot, configuration);

    expect(repository.snapshot().settings.roomName).toBe("The Agent Room");
  });

  it("fails closed while the postgres adapter is incomplete", async () => {
    const environment = {
      ALL_MY_FRIENDS_ARE_AGENTS_STORAGE_BACKEND: "postgres",
      DATABASE_URL: "postgresql://localhost/amfaa",
    };
    const configuration = resolveStorageConfiguration("/tmp/amfaa-project", environment);

    await expect(openRoomRepository("/tmp/amfaa-project", configuration)).rejects.toThrow("adapter is not implemented yet");
  });
});
