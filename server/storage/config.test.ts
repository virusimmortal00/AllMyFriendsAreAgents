import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveStorageConfiguration } from "./config.js";

const projectRoot = "/tmp/amfaa-project";

describe("storage configuration", () => {
  it("preserves the existing JSON store as the default", () => {
    expect(resolveStorageConfiguration(projectRoot, {})).toEqual({
      backend: "json",
      dataDirectory: path.join(projectRoot, ".allmyfriendsareagents"),
      stateDirectory: path.join(projectRoot, ".allmyfriendsareagents"),
    });
  });

  it("resolves an isolated relative data directory from the project root", () => {
    expect(resolveStorageConfiguration(projectRoot, {
      ALL_MY_FRIENDS_ARE_AGENTS_DATA_DIR: ".runtime/storage-test",
    })).toMatchObject({
      backend: "json",
      dataDirectory: path.join(projectRoot, ".runtime/storage-test"),
    });
  });

  it("builds a SQLite configuration without opening a database", () => {
    expect(resolveStorageConfiguration(projectRoot, {
      ALL_MY_FRIENDS_ARE_AGENTS_STORAGE_BACKEND: "sqlite",
      ALL_MY_FRIENDS_ARE_AGENTS_DATA_DIR: "/var/lib/amfaa",
    })).toEqual({
      backend: "sqlite",
      dataDirectory: "/var/lib/amfaa",
      databasePath: "/var/lib/amfaa/amfaa.sqlite",
    });
  });

  it("requires a PostgreSQL connection URL", () => {
    expect(() => resolveStorageConfiguration(projectRoot, {
      ALL_MY_FRIENDS_ARE_AGENTS_STORAGE_BACKEND: "postgres",
    })).toThrow("DATABASE_URL is required");
  });

  it("accepts a complete positive workspace quota configuration", () => {
    expect(resolveStorageConfiguration(projectRoot, {
      ALL_MY_FRIENDS_ARE_AGENTS_WORKSPACE_DOCUMENT_LIMIT: "2",
      ALL_MY_FRIENDS_ARE_AGENTS_WORKSPACE_CONTENT_BYTES: "10",
      ALL_MY_FRIENDS_ARE_AGENTS_WORKSPACE_REVISION_LIMIT: "3",
      ALL_MY_FRIENDS_ARE_AGENTS_WORKSPACE_ROOM_BYTES: "20",
    })).toMatchObject({ workspaceQuotas: { documentCount: 2, contentSizeBytes: 10, revisionCount: 3, aggregateRoomBytes: 20 } });
    expect(() => resolveStorageConfiguration(projectRoot, { ALL_MY_FRIENDS_ARE_AGENTS_WORKSPACE_DOCUMENT_LIMIT: "2" })).toThrow("positive safe integers");
  });

  it("accepts a PostgreSQL URL without exposing it in an error", () => {
    const connectionString = "postgresql://amfaa:secret@amfaa-db.sayers.io/amfaa";
    expect(resolveStorageConfiguration(projectRoot, {
      ALL_MY_FRIENDS_ARE_AGENTS_STORAGE_BACKEND: "postgres",
      DATABASE_URL: connectionString,
    })).toMatchObject({ backend: "postgres", connectionString });
  });

  it("rejects unsupported backends", () => {
    expect(() => resolveStorageConfiguration(projectRoot, {
      ALL_MY_FRIENDS_ARE_AGENTS_STORAGE_BACKEND: "redis",
    })).toThrow("Unsupported storage backend");
  });
});
