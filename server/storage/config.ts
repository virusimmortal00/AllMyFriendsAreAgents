import path from "node:path";
import type { WorkspaceQuotas } from "./workspace-repository.js";

export const STORAGE_BACKENDS = ["json", "sqlite", "postgres"] as const;
export type StorageBackend = typeof STORAGE_BACKENDS[number];

interface StorageConfigurationBase {
  backend: StorageBackend;
  dataDirectory: string;
  workspaceQuotas?: WorkspaceQuotas;
}

export interface JsonStorageConfiguration extends StorageConfigurationBase {
  backend: "json";
  stateDirectory: string;
}

export interface SqliteStorageConfiguration extends StorageConfigurationBase {
  backend: "sqlite";
  databasePath: string;
}

export interface PostgresStorageConfiguration extends StorageConfigurationBase {
  backend: "postgres";
  connectionString: string;
}

export type StorageConfiguration = JsonStorageConfiguration | SqliteStorageConfiguration | PostgresStorageConfiguration;

function configuredPath(projectRoot: string, value: string | undefined, fallback: string) {
  if (!value?.trim()) return fallback;
  return path.isAbsolute(value) ? value : path.resolve(projectRoot, value);
}

function postgresConnectionString(value: string | undefined) {
  if (!value?.trim()) {
    throw new Error("DATABASE_URL is required when the storage backend is postgres.");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL URL.");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("DATABASE_URL must use the postgres:// or postgresql:// scheme.");
  }
  return value;
}

function workspaceQuotas(environment: NodeJS.ProcessEnv): WorkspaceQuotas | undefined {
  const names = [
    "ALL_MY_FRIENDS_ARE_AGENTS_WORKSPACE_DOCUMENT_LIMIT",
    "ALL_MY_FRIENDS_ARE_AGENTS_WORKSPACE_CONTENT_BYTES",
    "ALL_MY_FRIENDS_ARE_AGENTS_WORKSPACE_REVISION_LIMIT",
    "ALL_MY_FRIENDS_ARE_AGENTS_WORKSPACE_ROOM_BYTES",
  ] as const;
  if (!names.some((name) => environment[name]?.trim())) return undefined;
  const values = names.map((name) => Number(environment[name]));
  if (values.some((value) => !Number.isSafeInteger(value) || value <= 0)) throw new Error("Workspace quota settings must all be positive safe integers.");
  return { documentCount: values[0], contentSizeBytes: values[1], revisionCount: values[2], aggregateRoomBytes: values[3] };
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
  const configuredWorkspaceQuotas = workspaceQuotas(environment);
  const dataDirectory = configuredPath(
    projectRoot,
    environment.ALL_MY_FRIENDS_ARE_AGENTS_DATA_DIR,
    path.join(projectRoot, ".allmyfriendsareagents"),
  );

  if (backend === "sqlite") {
    return {
      backend,
      dataDirectory,
      databasePath: configuredPath(
        projectRoot,
        environment.ALL_MY_FRIENDS_ARE_AGENTS_SQLITE_PATH,
        path.join(dataDirectory, "amfaa.sqlite"),
      ),
      ...(configuredWorkspaceQuotas ? { workspaceQuotas: configuredWorkspaceQuotas } : {}),
    };
  }
  if (backend === "postgres") {
    return {
      backend,
      dataDirectory,
      connectionString: postgresConnectionString(environment.DATABASE_URL),
      ...(configuredWorkspaceQuotas ? { workspaceQuotas: configuredWorkspaceQuotas } : {}),
    };
  }
  return { backend, dataDirectory, stateDirectory: dataDirectory, ...(configuredWorkspaceQuotas ? { workspaceQuotas: configuredWorkspaceQuotas } : {}) };
}
