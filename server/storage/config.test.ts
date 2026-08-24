import path from "node:path";
import { mkdtemp, mkdir, realpath, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { prepareAssignmentWorktreesDirectory, resolveStorageConfiguration } from "./config.js";

const projectRoot = "/tmp/amfaa-project";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("storage configuration", () => {
  it("preserves the existing JSON store as the default", () => {
    expect(resolveStorageConfiguration(projectRoot, {})).toEqual({
      backend: "json",
      dataDirectory: path.join(projectRoot, ".allmyfriendsareagents"),
      assignmentWorktreesDirectory: "/tmp/.allmyfriendsareagents-worktrees/amfaa-project",
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
      assignmentWorktreesDirectory: "/tmp/.allmyfriendsareagents-worktrees/amfaa-project",
      databasePath: "/var/lib/amfaa/amfaa.sqlite",
    });
  });

  it("requires a PostgreSQL connection URL", () => {
    expect(() => resolveStorageConfiguration(projectRoot, {
      ALL_MY_FRIENDS_ARE_AGENTS_STORAGE_BACKEND: "postgres",
    })).toThrow("DATABASE_URL is required");
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

  it("resolves relative assignment storage outside the project root", () => {
    expect(resolveStorageConfiguration(projectRoot, {
      ALL_MY_FRIENDS_ARE_AGENTS_ASSIGNMENT_WORKTREES_DIR: "amfaa-worktrees",
    }).assignmentWorktreesDirectory).toBe("/tmp/amfaa-worktrees");
  });

  it("prepares a private external assignment directory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "amfaa-storage-")); roots.push(root);
    const project = path.join(root, "project"); await mkdir(project);
    const prepared = await prepareAssignmentWorktreesDirectory(project, path.join(root, "worktrees"));
    expect(prepared).toBe(await realpath(path.join(root, "worktrees")));
    expect((await stat(prepared)).mode & 0o777).toBe(0o700);
  });

  it("rejects direct and symlinked overlap with the live checkout", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "amfaa-storage-")); roots.push(root);
    const project = path.join(root, "project"); await mkdir(project);
    await expect(prepareAssignmentWorktreesDirectory(project, path.join(project, "nested"))).rejects.toThrow("must not overlap");
    const alias = path.join(root, "alias"); await symlink(project, alias);
    await expect(prepareAssignmentWorktreesDirectory(project, path.join(alias, "nested"))).rejects.toThrow("must not overlap");
  });
});
