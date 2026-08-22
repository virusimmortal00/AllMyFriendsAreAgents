import { access, copyFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { RoomStore } from "../room-store.js";
import { SqliteRoomRepository } from "./sqlite-room-repository.js";
import { WORKSPACE_JSON_FILENAME } from "./json-workspace-repository.js";

export interface JsonToSqliteImportOptions {
  projectRoot: string;
  sourceStateDirectory: string;
  databasePath: string;
  overwrite?: boolean;
}

export async function importJsonRoomToSqlite(options: JsonToSqliteImportOptions) {
  const sourcePath = path.join(options.sourceStateDirectory, "room.json");
  await access(sourcePath);

  const normalizationDirectory = await mkdtemp(path.join(os.tmpdir(), "amfaa-json-import-"));
  try {
    await copyFile(sourcePath, path.join(normalizationDirectory, "room.json"));
    await copyFile(path.join(options.sourceStateDirectory, "assignments.json"), path.join(normalizationDirectory, "assignments.json"))
      .catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    await copyFile(path.join(options.sourceStateDirectory, WORKSPACE_JSON_FILENAME), path.join(normalizationDirectory, WORKSPACE_JSON_FILENAME))
      .catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    const legacyStore = await RoomStore.open(options.projectRoot, normalizationDirectory);
    const state = legacyStore.snapshot();
    const assignments = await legacyStore.listAssignments();
    const workspace = await legacyStore.exportWorkspace();
    const sqliteStore = await SqliteRoomRepository.open(options.projectRoot, options.databasePath, {
      initializeDefaultRoom: false,
    });
    try {
      sqliteStore.replaceState(state, { overwrite: options.overwrite });
      for (const assignment of assignments) await sqliteStore.putAssignment(assignment);
      sqliteStore.importWorkspace(workspace);
    } finally {
      sqliteStore.close();
    }
    return { messages: state.messages.length, sessions: Object.keys(state.sessions).length, assignments: assignments.length, workspaceDocuments: workspace.documents.length, workspaceRevisions: workspace.revisions.length };
  } finally {
    await rm(normalizationDirectory, { recursive: true, force: true });
  }
}

function argument(name: string) {
  return process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
}

async function main() {
  const projectRoot = process.cwd();
  const sourceStateDirectory = path.resolve(argument("source") || path.join(projectRoot, ".allmyfriendsareagents"));
  const databasePath = path.resolve(argument("database") || path.join(sourceStateDirectory, "amfaa.sqlite"));
  const overwrite = process.argv.includes("--overwrite");
  const imported = await importJsonRoomToSqlite({ projectRoot, sourceStateDirectory, databasePath, overwrite });
  console.log(`Imported ${imported.messages} messages, ${imported.sessions} agent sessions, and ${imported.assignments} assignments into ${databasePath}`);
  console.log("The source JSON file was not modified. Set ALL_MY_FRIENDS_ARE_AGENTS_STORAGE_BACKEND=sqlite only after verification.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
