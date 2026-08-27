import type express from "express";
import type { RoomRepository } from "./storage/room-repository.js";

export function roomHistoryAfter(messages: ReturnType<RoomRepository["snapshot"]>["messages"], after: string | undefined, limit: number) {
  if (!after) return messages.slice(0, limit);
  const index = messages.findIndex((message) => message.id === after);
  if (index < 0) return undefined;
  return messages.slice(index + 1, index + 1 + limit);
}

export function registerRoomHistoryRoutes(options: {
  readonly app: express.Express;
  readonly store: RoomRepository;
  readonly authorize: (request: express.Request) => boolean;
}) {
  options.app.get("/api/room/history", (request, response) => {
    if (!options.authorize(request)) return response.status(401).json({ error: "Authentication required." });
    const after = typeof request.query.after === "string" ? request.query.after.trim() : undefined;
    if (after !== undefined && (!after || after.length > 200)) return response.status(400).json({ error: "after must be a valid message ID." });
    const requestedLimit = Number(request.query.limit ?? 50);
    if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 100) return response.status(400).json({ error: "limit must be an integer from 1 to 100." });
    const messages = roomHistoryAfter(options.store.snapshot().messages, after, requestedLimit);
    if (!messages) return response.status(404).json({ error: "The after message ID was not found." });
    response.set("Cache-Control", "no-store").json({
      messages,
      nextAfter: messages.at(-1)?.id ?? after ?? null,
    });
  });
}
