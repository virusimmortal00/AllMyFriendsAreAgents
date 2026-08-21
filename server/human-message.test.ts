import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_PARTICIPANT_STYLES } from "../shared/chat-style.js";
import { addHumanMessageOnce } from "./human-message.js";
import { RoomStore } from "./room-store.js";
import { SqliteRoomRepository } from "./storage/sqlite-room-repository.js";
import type { RoomRepository } from "./storage/room-repository.js";

const temporaryDirectories: string[] = [];
const human = {
  id: "retry-human-1234",
  name: "Retry Tester",
  style: DEFAULT_PARTICIPANT_STYLES.you,
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function repositories() {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "amfaa-human-message-"));
  temporaryDirectories.push(projectRoot);
  return [
    await RoomStore.open(projectRoot, path.join(projectRoot, "json")),
    await SqliteRoomRepository.open(projectRoot, path.join(projectRoot, "sqlite", "amfaa.sqlite")),
  ] satisfies RoomRepository[];
}

describe("human message idempotency", () => {
  it("turns an outcome-unknown retry into one logical message on JSON and SQLite", async () => {
    for (const store of await repositories()) {
      const attempts = await Promise.all([
        addHumanMessageOnce(store, human, "Did this land?", "message_retry_1234"),
        addHumanMessageOnce(store, human, "Did this land?", "message_retry_1234"),
      ]);

      expect(attempts.filter(({ inserted }) => inserted)).toHaveLength(1);
      expect(attempts[0].message.id).toBe(attempts[1].message.id);
      expect(store.snapshot().messages.filter(({ clientMessageId }) => clientMessageId === "message_retry_1234"))
        .toHaveLength(1);
      if (store instanceof SqliteRoomRepository) store.close();
    }
  });
});
