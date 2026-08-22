import { JsonWorkspaceRepository } from "./json-workspace-repository.js";
import { DEFAULT_ROOM_ID, SqliteRoomRepository } from "./sqlite-room-repository.js";

/** Retry-safe workspace-only import for installations whose room data was imported earlier. */
export async function importJsonWorkspaceToSqlite(options: {
  readonly projectRoot: string;
  readonly sourceStateDirectory: string;
  readonly databasePath: string;
}) {
  const source = await JsonWorkspaceRepository.open(DEFAULT_ROOM_ID, options.sourceStateDirectory);
  const snapshot = await source.exportWorkspace();
  const target = await SqliteRoomRepository.open(options.projectRoot, options.databasePath);
  try { return target.importWorkspace(snapshot); }
  finally { target.close(); }
}
