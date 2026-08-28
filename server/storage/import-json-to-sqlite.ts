import { createHash } from "node:crypto";
import { access, copyFile, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
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
  const jsonImportManifest = await sourceManifest(options.sourceStateDirectory);

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
    const continuationAudit = (await Promise.all(continuations.map((job) => legacyStore.listContinuationAudit(job.jobId)))).flat();
    const sqliteStore = await SqliteRoomRepository.open(options.projectRoot, options.databasePath, {
      initializeDefaultRoom: false,
      deferIdentityMigration: true,
    });
    try {
      sqliteStore.verifyJsonImportManifest(jsonImportManifest.sourceDigest);
      await sqliteStore.importRoomData({ state, assignments, tasks, taskEvents, continuationPolicy, continuations, continuationInbox, continuationAudit, overwrite: options.overwrite });
      await sqliteStore.migrateDurableIdentities(null, "json-import", options.sourceStateDirectory, jsonImportManifest, options.overwrite === true);
    } finally {
      sqliteStore.close();
    }
    return { messages: state.messages.length, sessions: Object.keys(state.sessions).length, assignments: assignments.length, tasks: tasks.length, taskEvents: taskEvents.length, continuations: continuations.length, continuationInbox: continuationInbox.length, continuationAudit: continuationAudit.length };
  } finally {
    await rm(normalizationDirectory, { recursive: true, force: true });
  }
}

async function sourceManifest(directory: string) {
  const files = (await readdir(directory)).filter((filename) => filename.endsWith(".json")).sort();
  const hashes: Record<string, string> = {};
  for (const filename of files) {
    const value = JSON.parse(await readFile(path.join(directory, filename), "utf8")) as Record<string, unknown>;
    if (filename === "room.json" && value.deployment && typeof value.deployment === "object") {
      value.deployment = { ...(value.deployment as Record<string, unknown>), observedAt: undefined };
    }
    hashes[filename] = createHash("sha256").update(canonicalJson(value)).digest("hex");
  }
  const manifest = { schemaVersion: 1, kind: "json-files", files: hashes } as const;
  return { sourceDigest: createHash("sha256").update(canonicalJson(manifest)).digest("hex"), manifest };
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
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
  console.log("The source JSON file was not modified. The SQLite identity evidence has been verified; retain the JSON source as the rollback copy until you switch ALL_MY_FRIENDS_ARE_AGENTS_STORAGE_BACKEND=sqlite.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
