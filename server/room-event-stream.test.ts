import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PARTICIPANT_STYLES } from "../shared/chat-style.js";
import { ROOM_PROTOCOL_VERSION } from "../shared/protocol.js";
import { ROOM_EVENT_HEARTBEAT_MS, RoomEventStream } from "./room-event-stream.js";
import type { PublicRoomState, RoomMessage } from "./types.js";

function message(id: string, text = id): RoomMessage {
  return { id, speaker: "you", text, timestamp: "2026-08-19T12:00:00Z" };
}

function room(messages: RoomMessage[], status: PublicRoomState["status"] = "idle"): PublicRoomState {
  return {
    messages,
    settings: {
      roomName: "The Agent Room",
      topic: "Open conversation",
      conversationEnergy: "balanced",
      participantStyles: structuredClone(DEFAULT_PARTICIPANT_STYLES),
    },
    status,
  };
}

function connection(lastEventId?: string) {
  const request = Object.assign(new EventEmitter(), {
    headers: lastEventId ? { "last-event-id": lastEventId } : {},
    socket: {
      setTimeout: vi.fn(),
      setNoDelay: vi.fn(),
      setKeepAlive: vi.fn(),
    },
  });
  const response = Object.assign(new EventEmitter(), {
    setHeader: vi.fn(),
    flushHeaders: vi.fn(),
    write: vi.fn(),
    writableEnded: false,
    destroyed: false,
  });
  return { request, response };
}

function dataEvents(response: ReturnType<typeof connection>["response"]) {
  return response.write.mock.calls
    .map(([encoded]) => encoded as string)
    .filter((encoded) => encoded.startsWith("id: "))
    .map((encoded) => JSON.parse(encoded.match(/\ndata: (.+)\n\n$/s)![1]));
}

afterEach(() => vi.useRealTimers());

describe("RoomEventStream protocol", () => {
  it("supersedes room protocol version 3", () => {
    expect(ROOM_PROTOCOL_VERSION).toBe(6);
  });

  it("sends one initial snapshot and then strictly ordered typed deltas", () => {
    const stream = new RoomEventStream("instance-a");
    const { request, response } = connection();
    const initial = room([message("one")]);

    stream.connect(request as never, response as never, initial);
    stream.broadcast(room([message("one")]));
    stream.broadcast(room([message("one"), message("two")], "working"));
    stream.broadcast(room([message("one"), message("two")], "idle"));

    const events = dataEvents(response);
    expect(events.map(({ kind, fromVersion, version }) => ({ kind, fromVersion, version }))).toEqual([
      { kind: "snapshot", fromVersion: undefined, version: 0 },
      { kind: "messages-appended", fromVersion: 0, version: 1 },
      { kind: "state-delta", fromVersion: 1, version: 2 },
      { kind: "state-delta", fromVersion: 2, version: 3 },
    ]);
    expect(events.filter(({ kind }) => kind === "snapshot")).toHaveLength(1);
    expect(events[1].messages).toEqual([message("two")]);
    expect(events[2].state).not.toHaveProperty("messages");
  });

  it("makes state deltas independent of transcript length", () => {
    const encodedSize = (count: number) => {
      const messages = Array.from({ length: count }, (_, index) => message(`message-${index}`, "x".repeat(2_000)));
      const stream = new RoomEventStream("fixed-stream");
      const { request, response } = connection();
      stream.connect(request as never, response as never, room(messages));
      stream.broadcast(room(messages, "working"));
      return Buffer.byteLength(response.write.mock.calls.at(-1)![0] as string);
    };

    expect(encodedSize(1)).toBe(encodedSize(500));
  });

  it("makes append delta growth depend only on appended messages", () => {
    const encodedSize = (count: number) => {
      const messages = Array.from({ length: count }, (_, index) => message(`message-${index}`, "x".repeat(2_000)));
      const stream = new RoomEventStream("fixed-stream");
      const { request, response } = connection();
      stream.connect(request as never, response as never, room(messages));
      stream.broadcast(room([...messages, message("appended", "new payload")]));
      return Buffer.byteLength(response.write.mock.calls.at(-1)![0] as string);
    };

    expect(encodedSize(1)).toBe(encodedSize(500));
  });

  it("falls back to an authoritative resync snapshot for replaced or edited history", () => {
    const stream = new RoomEventStream("instance-a");
    const { request, response } = connection();
    stream.connect(request as never, response as never, room([message("one"), message("two")]));

    stream.broadcast(room([message("replacement")]));

    expect(dataEvents(response).at(-1)).toMatchObject({
      kind: "snapshot",
      reason: "resync",
      continuity: "fresh",
      fromVersion: 0,
      version: 1,
      state: { messages: [message("replacement")] },
    });
  });

  it("identifies reconnects to the same stream and restarts as fresh streams", () => {
    const stream = new RoomEventStream("instance-a");
    const first = connection();
    stream.connect(first.request as never, first.response as never, room([]));
    stream.broadcast(room([message("one")]));

    const reconnect = connection("instance-a:1");
    stream.connect(reconnect.request as never, reconnect.response as never, room([message("one")]));
    expect(dataEvents(reconnect.response)[0]).toMatchObject({
      kind: "snapshot",
      continuity: "same-stream",
      fromVersion: 1,
      streamId: "instance-a",
      version: 1,
    });

    const restarted = new RoomEventStream("instance-b");
    const afterRestart = connection("instance-a:1");
    restarted.connect(afterRestart.request as never, afterRestart.response as never, room([message("one")]));
    expect(dataEvents(afterRestart.response)[0]).toMatchObject({
      kind: "snapshot",
      continuity: "fresh",
      streamId: "instance-b",
      version: 0,
    });
  });

  it("keeps the prior broadcast baseline when a new connection joins", () => {
    const stream = new RoomEventStream("instance-a");
    const existing = connection();
    stream.connect(existing.request as never, existing.response as never, room([]));
    const joined = { ...room([]), humans: [{ id: "human-a", name: "Ada", style: DEFAULT_PARTICIPANT_STYLES.you }] };
    const newcomer = connection();

    stream.connect(newcomer.request as never, newcomer.response as never, joined);
    stream.broadcast(joined);

    expect(dataEvents(existing.response).at(-1)).toMatchObject({ kind: "state-delta", version: 1 });
    expect(dataEvents(newcomer.response)).toMatchObject([{
      kind: "snapshot",
      version: 1,
      state: { humans: joined.humans },
    }]);
  });

  it("keeps connections alive and runs cleanup only once", () => {
    vi.useFakeTimers();
    const stream = new RoomEventStream("instance-a");
    const { request, response } = connection();
    const disconnect = vi.fn();
    stream.connect(request as never, response as never, room([]), disconnect);

    vi.advanceTimersByTime(ROOM_EVENT_HEARTBEAT_MS);
    expect(response.write).toHaveBeenCalledWith(expect.stringMatching(/^event: heartbeat\ndata: /));
    expect(request.socket.setTimeout).toHaveBeenCalledWith(0);
    expect(response.setHeader).toHaveBeenCalledWith("Cache-Control", "no-cache, no-transform");
    expect(response.setHeader).toHaveBeenCalledWith("X-Accel-Buffering", "no");

    request.emit("close");
    response.emit("close");
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(stream.clientCount).toBe(0);
  });
});
