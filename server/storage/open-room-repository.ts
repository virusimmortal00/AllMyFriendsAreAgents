import { RoomStore } from "../room-store.js";
import { resolveStorageConfiguration, type StorageConfiguration } from "./config.js";
import type { RoomRepository } from "./room-repository.js";
import { CANONICAL_ROOM_ID } from "./room-repository.js";
import { deriveDeploymentProvenance } from "../deployment-provenance.js";

export async function openRoomRepository(
  projectRoot: string,
  configuration: StorageConfiguration = resolveStorageConfiguration(projectRoot),
  scope: { readonly roomId: string } = { roomId: CANONICAL_ROOM_ID },
): Promise<RoomRepository> {
  let repository: RoomRepository;
  if (configuration.backend === "json") {
    if (scope.roomId !== CANONICAL_ROOM_ID) throw new Error("JSON storage supports only the canonical room; migrate to SQLite before opening another durable room.");
    repository = await RoomStore.open(projectRoot, configuration.stateDirectory);
  } else if (configuration.backend === "sqlite") {
    const { SqliteRoomRepository } = await import("./sqlite-room-repository.js");
    repository = await SqliteRoomRepository.open(projectRoot, configuration.databasePath, { seedImprovements: true, roomId: scope.roomId });
  } else { throw new Error("Unsupported room storage backend"); }
  await repository.setDeployment(await deriveDeploymentProvenance(repository.snapshot().settings.projectPath));
  return repository;
}
