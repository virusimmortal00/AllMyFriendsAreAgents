import { access, copyFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { RoomStore } from "../room-store.js";
import { SqliteRoomRepository } from "./sqlite-room-repository.js";

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
    await copyFile(path.join(options.sourceStateDirectory, "tasks.json"), path.join(normalizationDirectory, "tasks.json"))
      .catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    await copyFile(path.join(options.sourceStateDirectory, "continuations.json"), path.join(normalizationDirectory, "continuations.json"))
      .catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    const legacyStore = await RoomStore.open(options.projectRoot, normalizationDirectory);
    const state = legacyStore.snapshot();
    const assignments = await legacyStore.listAssignments();
    const tasks = (await legacyStore.listTasks()).items;
    const taskEvents = (await Promise.all(tasks.map((task) => legacyStore.listTaskEvents(task)))).flat();
    const continuationPolicy = await legacyStore.getContinuationPolicy();
    const continuations = await legacyStore.listContinuations();
    const continuationInbox = (await Promise.all([...new Set(continuations.map((job) => job.owner))].map((owner) => legacyStore.listContinuationInbox(owner)))).flat();
    const sqliteStore = await SqliteRoomRepository.open(options.projectRoot, options.databasePath, {
      initializeDefaultRoom: false,
    });
    try {
      if (!sqliteStore.hasPersistedRoom() || options.overwrite) {
        sqliteStore.replaceState(state, { overwrite: options.overwrite });
      } else if (!sameRoomState(sqliteStore.snapshot(), state)) {
        throw new Error("The SQLite database already contains a different default room. Pass overwrite=true to replace it.");
      }
      for (const assignment of assignments) await sqliteStore.putAssignment(assignment);
      sqliteStore.importTasks(tasks, taskEvents);
      sqliteStore.importContinuations(continuationPolicy, continuations, continuationInbox);
    } finally {
      sqliteStore.close();
    }
    return { messages: state.messages.length, sessions: Object.keys(state.sessions).length, assignments: assignments.length, tasks: tasks.length, taskEvents: taskEvents.length, continuations: continuations.length, continuationInbox: continuationInbox.length };
  } finally {
    await rm(normalizationDirectory, { recursive: true, force: true });
  }
}

function sameRoomState(left: ReturnType<RoomStore["snapshot"]>, right: ReturnType<RoomStore["snapshot"]>) {
  return JSON.stringify(left.messages) === JSON.stringify(right.messages)
    && JSON.stringify(left.sessions) === JSON.stringify(right.sessions)
    && JSON.stringify(left.settings) === JSON.stringify(right.settings)
    && left.status === right.status
    && left.activeAgent === right.activeAgent
    && left.error === right.error;
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
  console.log(`Imported ${imported.messages} messages, ${imported.sessions} agent sessions, ${imported.assignments} assignments, ${imported.tasks} tasks, and ${imported.continuations} continuations into ${databasePath}`);
  console.log("The source JSON file was not modified. Set ALL_MY_FRIENDS_ARE_AGENTS_STORAGE_BACKEND=sqlite only after verification.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
