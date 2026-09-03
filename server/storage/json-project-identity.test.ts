import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RoomStore } from "../room-store.js";
import { openJsonProjectIdentity } from "./json-project-identity.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const idFor = (value: string) => `legacy-project:${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "amfaa-json-project-"))); roots.push(root);
  const data = path.join(root, "data"), original = path.join(root, "original"), relocated = path.join(root, "relocated");
  await mkdir(original); await mkdir(data);
  return { root, data, original, relocated, file: path.join(data, "project-identity.json") };
}

async function savedBindings(data: string, projectIds: string[]) {
  const now = "2026-09-02T12:00:00.000Z";
  await writeFile(path.join(data, "github-integrations.json"), JSON.stringify({ schemaVersion: 1, catalogs: [],
    connections: [{ schemaVersion: 1, connectionId: "fixture-connection", revision: 1, authMode: "github-device-user", state: "ready",
      githubUser: { id: 1, login: "fixture" }, secretReference: "fixture-vault-pointer", connectedAt: now, lastValidatedAt: now, updatedAt: now }],
    bindings: projectIds.map((projectId, index) => ({ schemaVersion: 1, bindingId: `fixture-binding-${index}`, projectId, revision: 1, state: "ready",
      connectionId: "fixture-connection", installationId: 1, githubRepositoryId: index + 1, repository: "github.com/example/repository", createdAt: now, updatedAt: now })),
  }));
}

describe("persistent JSON project identity", () => {
  it("keeps the existing hash, publishes one complete private record under concurrent open, and survives moves", async () => {
    const f = await fixture();
    const ids = await Promise.all(Array.from({ length: 5 }, () => openJsonProjectIdentity(f.data, f.original)));
    expect(new Set(ids)).toEqual(new Set([idFor(f.original)]));
    const before = await readFile(f.file, "utf8");
    expect(JSON.parse(before)).toEqual({ schemaVersion: 1, projectId: idFor(f.original) });
    expect((await stat(f.file)).mode & 0o777).toBe(0o600);
    await rename(f.original, f.relocated);
    expect(await openJsonProjectIdentity(f.data, f.relocated)).toBe(ids[0]);
    expect(await readFile(f.file, "utf8")).toBe(before);
  });

  it("uses the original room path before startup normalization, even when that path no longer exists", async () => {
    const f = await fixture();
    const room = await RoomStore.open(f.original, f.data);
    await room.addMessage("system", "Preserved history");
    await rename(f.original, f.relocated);
    expect(await openJsonProjectIdentity(f.data, f.relocated)).toBe(idFor(f.original));
    const reopened = await RoomStore.open(f.relocated, f.data);
    expect(reopened.snapshot().settings.projectPath).toBe(f.relocated);
    expect(reopened.snapshot().messages).toEqual(room.snapshot().messages);
    expect(await openJsonProjectIdentity(f.data, f.relocated)).toBe(idFor(f.original));
  });

  it("recovers a binding-only legacy key after an older startup has already replaced the path", async () => {
    const f = await fixture();
    await RoomStore.open(f.relocated, f.data);
    await savedBindings(f.data, [idFor(f.original)]);
    const bindings = await readFile(path.join(f.data, "github-integrations.json"), "utf8");
    expect(await openJsonProjectIdentity(f.data, f.relocated)).toBe(idFor(f.original));
    expect(await readFile(path.join(f.data, "github-integrations.json"), "utf8")).toBe(bindings);
  });

  it("rejects ambiguous legacy keys without choosing a project or changing room state", async () => {
    const f = await fixture();
    await RoomStore.open(f.original, f.data);
    await savedBindings(f.data, [idFor(f.original), idFor(f.relocated)]);
    const before = await readFile(path.join(f.data, "room.json"), "utf8");
    await expect(openJsonProjectIdentity(f.data, f.relocated)).rejects.toThrow(/ambiguous/);
    await expect(stat(f.file)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(f.data, "room.json"), "utf8")).toBe(before);
  });

  it.each(["not-json", "null", '{"schemaVersion":2,"projectId":"legacy-project:invalid"}', '{"schemaVersion":1,"projectId":"other-project"}'])("fails closed on invalid persisted identity %s", async (value) => {
    const f = await fixture(); await writeFile(f.file, value);
    await expect(openJsonProjectIdentity(f.data, f.original)).rejects.toThrow(/malformed/);
    expect(await readFile(f.file, "utf8")).toBe(value);
  });

  it("rejects malformed legacy authority stores rather than manufacturing a replacement key", async () => {
    const f = await fixture();
    await writeFile(path.join(f.data, "project-repository-connections.json"), '{"schemaVersion":1,"connections":[{}]}');
    await expect(openJsonProjectIdentity(f.data, f.original)).rejects.toThrow(/invalid/);
    await expect(stat(f.file)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
