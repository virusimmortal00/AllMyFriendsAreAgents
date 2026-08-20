import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PARTICIPANT_STYLES } from "../shared/chat-style.js";
import { ROOM_EVENT_HEARTBEAT_MS, RoomEventStream } from "./room-event-stream.js";
import type { RoomState } from "./types.js";

function room(text: string): RoomState {
  return {
    messages: [{ id: text, speaker: "you", text, timestamp: "2026-08-19T12:00:00Z" }],
    sessions: {},
    settings: {
      topic: "Open conversation",
      writableAgent: "nobody",
      conversationEnergy: "balanced",
      projectPath: "/tmp",
      participantStyles: structuredClone(DEFAULT_PARTICIPANT_STYLES),
    },
    status: "idle",
  };
}

function connection() {
  const request = Object.assign(new EventEmitter(), {
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

afterEach(() => vi.useRealTimers());

describe("RoomEventStream", () => {
  it("keeps one connection alive across multiple later room broadcasts", () => {
    vi.useFakeTimers();
    const stream = new RoomEventStream();
    const { request, response } = connection();

    stream.connect(request as never, response as never, room("initial"));
    stream.broadcast(room("round one"));
    vi.advanceTimersByTime(ROOM_EVENT_HEARTBEAT_MS);
    stream.broadcast(room("round two"));

    expect(response.write.mock.calls.map(([event]) => event)).toEqual([
      "retry: 1000\n\n",
      expect.stringContaining('"text":"initial"'),
      expect.stringContaining('"text":"round one"'),
      expect.stringMatching(/^: keepalive /),
      expect.stringContaining('"text":"round two"'),
    ]);
    expect(request.socket.setTimeout).toHaveBeenCalledWith(0);
    expect(response.setHeader).toHaveBeenCalledWith("Cache-Control", "no-cache, no-transform");
    expect(response.setHeader).toHaveBeenCalledWith("X-Accel-Buffering", "no");
    expect(stream.clientCount).toBe(1);

    request.emit("close");
    expect(stream.clientCount).toBe(0);
  });
});
