import { RoomStore } from "../room-store.js";
import { resolveStorageConfiguration, type StorageConfiguration } from "./config.js";
import type { RoomRepository } from "./room-repository.js";
import { deriveDeploymentProvenance } from "../deployment-provenance.js";

export async function openRoomRepository(
  projectRoot: string,
  configuration: StorageConfiguration = resolveStorageConfiguration(projectRoot),
): Promise<RoomRepository> {
  let repository: RoomRepository;
  if (configuration.backend === "json") {
    repository = await RoomStore.open(projectRoot, configuration.stateDirectory);
  } else if (configuration.backend === "sqlite") {
    const { SqliteRoomRepository } = await import("./sqlite-room-repository.js");
    repository = await SqliteRoomRepository.open(projectRoot, configuration.databasePath, { seedImprovements: true });
  } else {
    throw new Error(
      "postgres storage is configured but its adapter is not implemented yet. "
      + "Use ALL_MY_FRIENDS_ARE_AGENTS_STORAGE_BACKEND=json or sqlite while storage plumbing is under development.",
    );
  }
  await repository.setDeployment(await deriveDeploymentProvenance(repository.snapshot().settings.projectPath));
  return repository;
}
