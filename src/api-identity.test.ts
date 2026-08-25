// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PARTICIPANT_STYLES } from "../shared/chat-style";
import { authorizeHeartbeat, emergencyStopHeartbeat, joinRoom, sendContinuationWorkRequest, sendMessage, updateMyStyle, updateSettings } from "./api";

afterEach(() => vi.unstubAllGlobals());

describe("browser identity requests", () => {
  it("reuses a continuation client message ID after an unknown outcome", async () => {
    const bodies: Array<Record<string, unknown>> = []; let attempt = 0;
    vi.stubGlobal("fetch", vi.fn(async (_path: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>; bodies.push(body); attempt += 1;
      if (attempt === 1) throw new TypeError("connection lost after send");
      return new Response(JSON.stringify({ accepted: true, duplicate: true, clientMessageId: body.clientMessageId, messageId: "room-message", continuation: { outcome: "queued", jobId: "job-1", status: "QUEUED" } }));
    }));
    const task = { taskId: "task-1", revision: 4, title: "Durable work" };
    await expect(sendContinuationWorkRequest(task, "assignment-ref", "Run checks")).rejects.toMatchObject({ outcomeUnknown: true });
    await expect(sendContinuationWorkRequest(task, "assignment-ref", "Run checks")).resolves.toMatchObject({ duplicate: true });
    expect(bodies).toHaveLength(2); expect(bodies[0]?.clientMessageId).toBe(bodies[1]?.clientMessageId);
  });

  it("never serializes a public participant ID as actor authority", async () => {
    const style = DEFAULT_PARTICIPANT_STYLES.you;
    const fetchMock = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === "/api/humans") return new Response(JSON.stringify({ id: "server-human", name: "Ada", style }), { status: 201 });
      if (path === "/api/messages") return new Response(JSON.stringify({ accepted: true, duplicate: false, clientMessageId: "message_123", messageId: "server-message" }));
      if (path === "/api/style") return new Response(JSON.stringify({ id: "server-human", name: "Ada", style }));
      return new Response(JSON.stringify({ settings: {} }));
    });
    vi.stubGlobal("fetch", fetchMock);

    await joinRoom({ id: "public-id-must-not-be-authority", name: "Ada", style });
    await sendMessage("Hello", "message_123");
    await updateMyStyle(style);
    await updateSettings({ writableAgent: "codex-sol" });
    await authorizeHeartbeat(3);
    await emergencyStopHeartbeat(4);

    const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);
    expect(bodies).toEqual([
      { name: "Ada", style },
      { text: "Hello", clientMessageId: "message_123", mentions: [] },
      { style },
      { writableAgent: "codex-sol" },
      { expectedRevision: 3, reason: "Explicitly authorized from the visible heartbeat control" },
      { expectedRevision: 4, reason: "Emergency stop requested from the visible control" },
    ]);
    for (const body of bodies) {
      expect(body).not.toHaveProperty("id");
      expect(body).not.toHaveProperty("humanId");
      expect(body).not.toHaveProperty("actorId");
    }
  });
});
