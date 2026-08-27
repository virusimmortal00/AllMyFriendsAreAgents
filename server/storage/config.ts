import path from "node:path";
import { chmod, mkdir, realpath, stat } from "node:fs/promises";

export const STORAGE_BACKENDS = ["json", "sqlite"] as const;
export type StorageBackend = typeof STORAGE_BACKENDS[number];

interface StorageConfigurationBase {
  backend: StorageBackend;
  dataDirectory: string;
  assignmentWorktreesDirectory: string;
}

export interface JsonStorageConfiguration extends StorageConfigurationBase {
  backend: "json";
  stateDirectory: string;
}

export interface SqliteStorageConfiguration extends StorageConfigurationBase {
  backend: "sqlite";
  databasePath: string;
}

export type StorageConfiguration = JsonStorageConfiguration | SqliteStorageConfiguration;

function overlaps(left: string, right: string) {
  const relative = path.relative(left, right);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

async function canonicalCandidate(value: string) {
  let existing = value; const suffix: string[] = [];
  while (!await stat(existing).then(() => true).catch(() => false)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    suffix.unshift(path.basename(existing)); existing = parent;
  }
  return path.join(await realpath(existing), ...suffix);
}

export async function prepareAssignmentWorktreesDirectory(projectRoot: string, configured: string) {
  const requested = path.resolve(configured);
  const canonicalProject = await realpath(projectRoot);
  const candidate = await canonicalCandidate(requested);
  if (overlaps(canonicalProject, candidate) || overlaps(candidate, canonicalProject)) {
    throw new Error("Assignment worktrees directory must not overlap the live project checkout.");
  }
  await mkdir(requested, { recursive: true, mode: 0o700 });
  await chmod(requested, 0o700);
  const canonical = await realpath(requested);
  if (overlaps(canonicalProject, canonical) || overlaps(canonical, canonicalProject)) {
    throw new Error("Assignment worktrees directory must not overlap the live project checkout.");
  }
  return canonical;
}

function configuredPath(projectRoot: string, value: string | undefined, fallback: string) {
  if (!value?.trim()) return fallback;
  return path.isAbsolute(value) ? value : path.resolve(projectRoot, value);
}

export function resolveStorageConfiguration(
  projectRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
): StorageConfiguration {
  const requestedBackend = environment.ALL_MY_FRIENDS_ARE_AGENTS_STORAGE_BACKEND?.trim().toLowerCase() || "json";
  if (!STORAGE_BACKENDS.includes(requestedBackend as StorageBackend)) {
    throw new Error(
      `Unsupported storage backend "${requestedBackend}". Expected one of: ${STORAGE_BACKENDS.join(", ")}.`,
    );
  }

  const backend = requestedBackend as StorageBackend;
  const dataDirectory = configuredPath(
    projectRoot,
    environment.ALL_MY_FRIENDS_ARE_AGENTS_DATA_DIR,
    path.join(projectRoot, ".allmyfriendsareagents"),
  );
  const assignmentWorktreesDirectory = configuredPath(
    path.dirname(projectRoot),
    environment.ALL_MY_FRIENDS_ARE_AGENTS_ASSIGNMENT_WORKTREES_DIR,
    path.join(path.dirname(projectRoot), ".allmyfriendsareagents-worktrees", path.basename(projectRoot)),
  );

  if (backend === "sqlite") {
    return {
      backend,
      dataDirectory,
      assignmentWorktreesDirectory,
      databasePath: configuredPath(
        projectRoot,
        environment.ALL_MY_FRIENDS_ARE_AGENTS_SQLITE_PATH,
        path.join(dataDirectory, "amfaa.sqlite"),
      ),
    };
  }
  return { backend, dataDirectory, assignmentWorktreesDirectory, stateDirectory: dataDirectory };
}
