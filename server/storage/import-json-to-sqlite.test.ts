import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RoomStore } from "../room-store.js";
import { importJsonRoomToSqlite } from "./import-json-to-sqlite.js";
import { SqliteRoomRepository } from "./sqlite-room-repository.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("JSON to SQLite import", () => {
  it("copies normalized room state without modifying the source JSON", async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), "amfaa-json-import-test-"));
    temporaryDirectories.push(projectRoot);
    const sourceStateDirectory = path.join(projectRoot, "json-state");
    const databasePath = path.join(projectRoot, "sqlite-state", "amfaa.sqlite");
    const legacyStore = await RoomStore.open(projectRoot, sourceStateDirectory);
    await legacyStore.updateSettings({ roomName: "Imported Room" });
    await legacyStore.addMessage("you", "Keep this transcript", "chat", undefined, undefined, {
      id: "import-human-1234",
      name: "Importer",
    });
    await legacyStore.setSession("codex-terra", "imported-session", "read-only");
    const sourcePath = path.join(sourceStateDirectory, "room.json");
    const sourceBefore = await readFile(sourcePath, "utf8");

    const result = await importJsonRoomToSqlite({ projectRoot, sourceStateDirectory, databasePath });

    expect(result.messages).toBe(3);
    expect(result.sessions).toBe(1);
    expect(await readFile(sourcePath, "utf8")).toBe(sourceBefore);
    const importedStore = await SqliteRoomRepository.open(projectRoot, databasePath);
    expect(importedStore.snapshot().settings.roomName).toBe("Imported Room");
    expect(importedStore.snapshot().sessions["codex-terra"]?.id).toBe("imported-session");
    expect(importedStore.snapshot().messages.at(-1)).toMatchObject({
      text: "Keep this transcript",
      speakerName: "Importer",
    });
    importedStore.close();

    await expect(importJsonRoomToSqlite({ projectRoot, sourceStateDirectory, databasePath }))
      .rejects.toThrow("already contains the default room");
  });
});
