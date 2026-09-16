import type express from "express";
import { controlRoute, type ControlPlaneStore } from "./control-plane.js";

export interface RoomGitHubReadStatus {
  readonly state: "ready" | "unavailable";
  readonly reason: string;
  /** `owner/name` of the attached project repository; never a local path or credential reference. */
  readonly repository?: string;
}

export interface RoomRepositorySource {
  readonly roomId: string;
  readonly name: string;
  readonly archivedAt: string | null;
  readonly projectId: string | null;
}

export interface RoomRepositoryListing {
  readonly roomId: string;
  readonly name: string;
  readonly archived: boolean;
  readonly projectId: string | null;
  readonly repository: string | null;
  readonly state: RoomGitHubReadStatus["state"];
  readonly reason: string;
}

/**
 * Administrator view of which repository each room reads from. Repository authority
 * belongs to projects; rooms inherit it through their project attachment.
 */
export function registerRoomRepositoryRoutes(input: {
  readonly app: express.Express;
  readonly control: ControlPlaneStore;
  readonly listRooms: (includeArchived: boolean) => readonly RoomRepositorySource[];
  readonly repositoryStatus: (projectId: string | null) => RoomGitHubReadStatus;
}) {
  const { app, control, listRooms, repositoryStatus } = input;
  app.get("/api/control/rooms", controlRoute(async (request, response) => {
    control.require(request, "INTEGRATION_VIEW");
    const statuses = new Map<string | null, RoomGitHubReadStatus>();
    const items: RoomRepositoryListing[] = listRooms(request.query.archived === "true").map((room) => {
      if (!statuses.has(room.projectId)) statuses.set(room.projectId, repositoryStatus(room.projectId));
      const status = statuses.get(room.projectId)!;
      return { roomId: room.roomId, name: room.name, archived: Boolean(room.archivedAt), projectId: room.projectId,
        repository: status.repository ?? null, state: status.state, reason: status.reason };
    });
    response.set("Cache-Control", "no-store").json({ items });
  }));
}
