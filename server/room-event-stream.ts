import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import type { RoomProtocolEvent } from "../shared/protocol.js";
import type { PublicRoomState } from "./types.js";

export const ROOM_EVENT_HEARTBEAT_MS = 3_000;

export class RoomEventStream {
  private readonly clients = new Set<Response>();
  private heartbeat?: NodeJS.Timeout;
  private state?: PublicRoomState;
  private version = 0;

  constructor(readonly streamId: string = randomUUID()) {}

  connect(request: Request, response: Response, initialState: PublicRoomState, onDisconnect?: () => void) {
    response.setHeader("Content-Type", "text/event-stream");
    response.setHeader("Cache-Control", "no-cache, no-transform");
    response.setHeader("Connection", "keep-alive");
    response.setHeader("X-Accel-Buffering", "no");
    request.socket.setTimeout(0);
    request.socket.setNoDelay(true);
    request.socket.setKeepAlive(true);
    response.flushHeaders();

    this.publish(this.eventsFor(initialState));
    const requestedPosition = parseEventId(request.headers?.["last-event-id"] ?? request.query?.lastEventId);
    const continuity = requestedPosition?.streamId === this.streamId && requestedPosition.version <= this.version
      ? "same-stream"
      : "fresh";
    this.clients.add(response);
    response.write("retry: 1000\n\n");
    this.write(response, this.serialize({
      kind: "snapshot",
      reason: "initial",
      continuity,
      ...(continuity === "same-stream" ? { fromVersion: requestedPosition!.version } : {}),
      streamId: this.streamId,
      version: this.version,
      state: initialState,
    }));
    this.startHeartbeat();

    let disconnected = false;
    const disconnect = () => {
      if (disconnected) return;
      disconnected = true;
      this.disconnect(response);
      onDisconnect?.();
    };
    request.once("close", disconnect);
    request.once("aborted", disconnect);
    response.once("close", disconnect);
    response.once("error", disconnect);
  }

  broadcast(state: PublicRoomState) {
    const events = this.eventsFor(state);
    this.publish(events);
    return events;
  }

  private publish(events: RoomProtocolEvent<PublicRoomState>[]) {
    for (const event of events) {
      const encoded = this.serialize(event);
      for (const client of [...this.clients]) this.write(client, encoded);
    }
  }

  get clientCount() {
    return this.clients.size;
  }

  private eventsFor(next: PublicRoomState): RoomProtocolEvent<PublicRoomState>[] {
    const previous = this.state;
    if (!previous) {
      this.state = structuredClone(next);
      return [];
    }

    if (!isExactMessagePrefix(previous.messages, next.messages)) {
      const fromVersion = this.version;
      this.version += 1;
      this.state = structuredClone(next);
      return [{
        kind: "snapshot",
        reason: "resync",
        continuity: "fresh",
        fromVersion,
        streamId: this.streamId,
        version: this.version,
        state: next,
      }];
    }

    const events: RoomProtocolEvent<PublicRoomState>[] = [];
    const appended = next.messages.slice(previous.messages.length);
    if (appended.length > 0) {
      const fromVersion = this.version;
      this.version += 1;
      events.push({
        kind: "messages-appended",
        fromVersion,
        streamId: this.streamId,
        version: this.version,
        messages: appended,
      });
    }

    const previousState = withoutMessages(previous);
    const nextState = withoutMessages(next);
    if (!sameValue(previousState, nextState)) {
      const fromVersion = this.version;
      this.version += 1;
      events.push({
        kind: "state-delta",
        fromVersion,
        streamId: this.streamId,
        version: this.version,
        state: nextState,
      });
    }
    this.state = structuredClone(next);
    return events;
  }

  private serialize(event: RoomProtocolEvent<PublicRoomState>) {
    return `id: ${event.streamId}:${event.version}\ndata: ${JSON.stringify(event)}\n\n`;
  }

  private write(client: Response, event: string) {
    if (client.writableEnded || client.destroyed) {
      this.disconnect(client);
      return;
    }
    try {
      client.write(event);
    } catch {
      this.disconnect(client);
    }
  }

  private startHeartbeat() {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => {
      const event = `event: heartbeat\ndata: ${new Date().toISOString()}\n\n`;
      for (const client of [...this.clients]) this.write(client, event);
    }, ROOM_EVENT_HEARTBEAT_MS);
    this.heartbeat.unref();
  }

  private disconnect(client: Response) {
    this.clients.delete(client);
    if (this.clients.size > 0 || !this.heartbeat) return;
    clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }
}

function withoutMessages(state: PublicRoomState): Omit<PublicRoomState, "messages"> {
  const { messages: _messages, ...rest } = state;
  return rest;
}

function sameValue(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isExactMessagePrefix(previous: PublicRoomState["messages"], next: PublicRoomState["messages"]) {
  return previous.length <= next.length
    && previous.every((message, index) => sameValue(message, next[index]));
}

function parseEventId(value: unknown) {
  const eventId = Array.isArray(value) ? value.find((entry): entry is string => typeof entry === "string") : value;
  if (typeof eventId !== "string") return undefined;
  const match = eventId?.match(/^(.+):(\d+)$/);
  if (!match) return undefined;
  const version = Number(match[2]);
  return Number.isSafeInteger(version) ? { streamId: match[1], version } : undefined;
}
