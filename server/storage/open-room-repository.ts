import { RoomStore } from "../room-store.js";
import { resolveStorageConfiguration, type StorageConfiguration } from "./config.js";
import type { RoomRepository } from "./room-repository.js";

export async function openRoomRepository(
  projectRoot: string,
  configuration: StorageConfiguration = resolveStorageConfiguration(projectRoot),
): Promise<RoomRepository> {
  if (configuration.backend === "json") {
    return RoomStore.open(projectRoot, configuration.stateDirectory);
  }
  if (configuration.backend === "sqlite") {
    const { SqliteRoomRepository } = await import("./sqlite-room-repository.js");
    return SqliteRoomRepository.open(projectRoot, configuration.databasePath);
  }
  throw new Error(
    "postgres storage is configured but its adapter is not implemented yet. "
    + "Use ALL_MY_FRIENDS_ARE_AGENTS_STORAGE_BACKEND=json or sqlite while storage plumbing is under development.",
  );
}
