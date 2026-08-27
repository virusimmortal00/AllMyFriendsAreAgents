import path from "node:path";
import { resolveStorageConfiguration, type StorageConfiguration } from "./config.js";
import type { ConsultationRepository } from "./consultation-repository.js";
import { JsonConsultationRepository } from "./json-consultation-repository.js";

/** Opens the consultation boundary against the same configured durable backend as the room. */
export async function openConsultationRepository(
  projectRoot: string,
  configuration: StorageConfiguration = resolveStorageConfiguration(projectRoot),
): Promise<ConsultationRepository> {
  if (configuration.backend === "json") return JsonConsultationRepository.open(path.join(configuration.stateDirectory, "consultations.json"));
  if (configuration.backend === "sqlite") {
    const { SqliteConsultationRepository } = await import("./sqlite-consultation-repository.js");
    return SqliteConsultationRepository.open(configuration.databasePath);
  }
  throw new Error(`Unsupported consultation storage backend: ${(configuration as { backend: string }).backend}`);
}
