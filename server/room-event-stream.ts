import type { Request, Response } from "express";
import type { RoomState } from "./types.js";

export const ROOM_EVENT_HEARTBEAT_MS = 15_000;

export class RoomEventStream {
  private readonly clients = new Set<Response>();
  private heartbeat?: NodeJS.Timeout;

  connect(request: Request, response: Response, initialState: RoomState) {
    response.setHeader("Content-Type", "text/event-stream");
    response.setHeader("Cache-Control", "no-cache, no-transform");
    response.setHeader("Connection", "keep-alive");
    response.setHeader("X-Accel-Buffering", "no");
    request.socket.setTimeout(0);
    request.socket.setNoDelay(true);
    request.socket.setKeepAlive(true);
    response.flushHeaders();

    this.clients.add(response);
    response.write("retry: 1000\n\n");
    this.write(response, this.stateEvent(initialState));
    this.startHeartbeat();

    const disconnect = () => this.disconnect(response);
    request.once("close", disconnect);
    request.once("aborted", disconnect);
    response.once("close", disconnect);
    response.once("error", disconnect);
  }

  broadcast(state: RoomState) {
    const event = this.stateEvent(state);
    for (const client of [...this.clients]) this.write(client, event);
  }

  get clientCount() {
    return this.clients.size;
  }

  private stateEvent(state: RoomState) {
    return `data: ${JSON.stringify(state)}\n\n`;
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
      const event = `: keepalive ${new Date().toISOString()}\n\n`;
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
