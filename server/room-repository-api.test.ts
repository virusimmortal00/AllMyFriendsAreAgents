import express from "express";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONTROL_SESSION_COOKIE, ControlPlaneStore } from "./control-plane.js";
import { registerRoomRepositoryRoutes, type RoomGitHubReadStatus } from "./room-repository-api.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

describe("room repository control API", () => {
  it("requires integration visibility and lists each room with its project repository without paths or credentials", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "amfaa-room-repository-api-"));
    const control = await ControlPlaneStore.open(directory, "local-bootstrap-secret-with-32-characters");
    await control.bootstrap("local-bootstrap-secret-with-32-characters", "owner", "correct horse battery staple");
    const owner = await control.authenticate("owner", "correct horse battery staple"); if (!owner) throw new Error("owner login failed");
    const ownerCookie = `${CONTROL_SESSION_COOKIE}=${encodeURIComponent(owner.token)}`;
    const ownerActor = control.require({ header: (name: string) => name.toLowerCase() === "cookie" ? ownerCookie : undefined } as express.Request).principal;
    await control.createPrincipal(ownerActor, { username: "viewer", password: "viewer password long", role: "MEMBER", capabilities: ["INTEGRATION_VIEW"] });
    await control.createPrincipal(ownerActor, { username: "roster", password: "roster password long", role: "MEMBER", capabilities: ["ROSTER_MANAGE"] });
    const viewer = await control.authenticate("viewer", "viewer password long"); if (!viewer) throw new Error("viewer login failed");
    const roster = await control.authenticate("roster", "roster password long"); if (!roster) throw new Error("roster login failed");

    const rooms = [
      { roomId: "room-a", name: "Design Workshop", archivedAt: null, projectId: "project-one" },
      { roomId: "room-b", name: "Release Review", archivedAt: null, projectId: "project-one" },
      { roomId: "room-c", name: "Open Chat", archivedAt: null, projectId: null },
      { roomId: "room-d", name: "Old Room", archivedAt: "2026-09-01T00:00:00.000Z", projectId: "project-two" },
    ];
    const listRooms = vi.fn((includeArchived: boolean) => rooms.filter((room) => includeArchived || !room.archivedAt));
    const repositoryStatus = vi.fn((projectId: string | null): RoomGitHubReadStatus => projectId === "project-one"
      ? { state: "ready", reason: "ready", repository: "example/navigation" }
      : projectId === "project-two" ? { state: "unavailable", reason: "connection-disabled", repository: "example/archive" }
        : { state: "unavailable", reason: "general-room" });
    const app = express(); app.use(express.json());
    registerRoomRepositoryRoutes({ app, control, listRooms, repositoryStatus });
    const server = app.listen(0); await new Promise<void>((resolve) => server.once("listening", resolve));
    cleanups.push(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const call = (route: string, token = "") => fetch(`${base}${route}`, { headers: token ? { cookie: `${CONTROL_SESSION_COOKIE}=${encodeURIComponent(token)}` } : {} });

    expect((await call("/api/control/rooms")).status).toBe(401);
    expect((await call("/api/control/rooms", roster.token)).status).toBe(403);

    const active = await call("/api/control/rooms", viewer.token);
    expect(active.status).toBe(200);
    expect(active.headers.get("cache-control")).toBe("no-store");
    const body = await active.json();
    expect(body.items).toEqual([
      { roomId: "room-a", name: "Design Workshop", archived: false, projectId: "project-one", repository: "example/navigation", state: "ready", reason: "ready" },
      { roomId: "room-b", name: "Release Review", archived: false, projectId: "project-one", repository: "example/navigation", state: "ready", reason: "ready" },
      { roomId: "room-c", name: "Open Chat", archived: false, projectId: null, repository: null, state: "unavailable", reason: "general-room" },
    ]);
    // Rooms that share a project share one status lookup.
    expect(repositoryStatus).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(body)).not.toMatch(/checkout|worktree|credential/i);

    const all = await (await call("/api/control/rooms?archived=true", owner.token)).json();
    expect(listRooms).toHaveBeenLastCalledWith(true);
    expect(all.items.at(-1)).toMatchObject({ roomId: "room-d", archived: true, repository: "example/archive", state: "unavailable", reason: "connection-disabled" });
  });
});
