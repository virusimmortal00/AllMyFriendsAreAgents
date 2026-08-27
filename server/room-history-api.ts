import type express from "express";
import type { RoomRepository } from "./storage/room-repository.js";
import { projectVisibleRoomMessage } from "./message-visibility.js";

export function roomHistoryAfter(messages: ReturnType<RoomRepository["snapshot"]>["messages"], after: string | undefined, limit: number, viewerHumanId?: string) {
  const start = after ? messages.findIndex((message) => message.id === after) : -1;
  if (after && start < 0) return undefined;
  const projected: NonNullable<ReturnType<typeof projectVisibleRoomMessage>>[] = [];
  for (let index = start + 1; index < messages.length && projected.length < limit; index += 1) {
    const message = projectVisibleRoomMessage(messages[index]!, viewerHumanId);
    if (message) projected.push(message);
  }
  return projected;
}

export function registerRoomHistoryRoutes(options: {
  readonly app: express.Express;
  readonly store: RoomRepository;
  readonly authorize: (request: express.Request) => boolean | { readonly humanId?: string };
}) {
  options.app.get("/api/room/history", (request, response) => {
    const authorization = options.authorize(request);
    if (!authorization) return response.status(401).json({ error: "Authentication required." });
    const after = typeof request.query.after === "string" ? request.query.after.trim() : undefined;
    if (after !== undefined && (!after || after.length > 200)) return response.status(400).json({ error: "after must be a valid message ID." });
    const requestedLimit = Number(request.query.limit ?? 50);
    if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 100) return response.status(400).json({ error: "limit must be an integer from 1 to 100." });
    const viewerHumanId = typeof authorization === "object" ? authorization.humanId : undefined;
    const messages = roomHistoryAfter(options.store.snapshot().messages, after, requestedLimit, viewerHumanId);
    if (!messages) return response.status(404).json({ error: "The after message ID was not found." });
    response.set("Cache-Control", "no-store").json({
      messages,
      nextAfter: messages.at(-1)?.id ?? after ?? null,
    });
  });
}
