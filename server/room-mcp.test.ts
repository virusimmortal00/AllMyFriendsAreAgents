import type { AddressInfo } from "node:net";
import { request as httpRequest } from "node:http";
import express from "express";
import { Client, InsufficientScopeError, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";
import { DeveloperTeamRegistry, hashToken, type DeveloperCapability } from "./developer-team.js";
import { registerRoomMcpRoutes, singleRoomMcpBridge, type RoomMcpBridge } from "./room-mcp.js";

const TOKEN = "room-mcp-test-token-with-at-least-thirty-two-characters";
const ROOM_ID = "00000000-0000-4000-8000-000000000001";

function developers(capabilities: readonly DeveloperCapability[]) {
  return new DeveloperTeamRegistry([{
    memberId: "remote-developer",
    revision: 1,
    displayName: "Remote Developer",
    roles: ["AUTHOR"],
    capabilities,
    tokenHash: hashToken(TOKEN),
    createdAt: "2026-08-27T00:00:00.000Z",
  }]);
}

function bridge(sendMessage = vi.fn<RoomMcpBridge["sendMessage"]>()) {
  sendMessage.mockResolvedValue({ kind: "ok", value: { accepted: true } });
  const messages = [{ id: "m-1" }, { id: "m-2" }];
  return {
    bridge: singleRoomMcpBridge({
      roomId: ROOM_ID,
      describe: () => ({ roomId: ROOM_ID, name: "The Room", topic: "Testing", status: "active", cursor: "m-2", busy: false }),
      read: (limit, afterMessageId) => {
        const afterIndex = afterMessageId == null ? -1 : messages.findIndex(({ id }) => id === afterMessageId);
        if (afterMessageId != null && afterIndex < 0) return { kind: "stale_cursor" };
        const page = afterMessageId === undefined ? messages.slice(-limit) : messages.slice(afterIndex + 1, afterIndex + 1 + limit);
        return {
          kind: "ok",
          value: { messages: page },
          continuationMessageId: page.at(-1)?.id ?? afterMessageId ?? null,
        };
      },
      send: async (developer, text, idempotency) => {
        const result = await sendMessage(ROOM_ID, developer, text, idempotency);
        return result ?? { kind: "ok", value: { accepted: true } };
      },
    }),
    sendMessage,
    messages,
  };
}

async function withMcp(
  registry: DeveloperTeamRegistry,
  roomBridge: RoomMcpBridge,
  run: (baseUrl: string, requests: readonly Record<string, string | undefined>[]) => Promise<void>,
  allowedHostnames?: readonly string[],
) {
  const app = express();
  const requests: Record<string, string | undefined>[] = [];
  app.use((request, _response, next) => {
    requests.push({
      method: request.header("mcp-method"),
      name: request.header("mcp-name"),
      roomId: request.header("mcp-param-room-id"),
      cursor: request.header("mcp-param-cursor"),
      idempotencyKey: request.header("mcp-param-idempotency-key"),
      protocolVersion: request.header("mcp-protocol-version"),
    });
    next();
  });
  const jsonBodyParser = express.json();
  app.use((request, response, next) => request.path === "/mcp" ? next() : jsonBodyParser(request, response, next));
  const registration = registerRoomMcpRoutes({ app, developers: registry, bridge: roomBridge, allowedHostnames });
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests);
  } finally {
    await registration.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function withClient(
  baseUrl: string,
  run: (client: Client) => Promise<void>,
  era: "modern" | "legacy" = "modern",
) {
  const client = new Client(
    { name: "room-mcp-test", version: "0.1.0" },
    era === "modern" ? { versionNegotiation: { mode: "auto" } } : {},
  );
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
  });
  await client.connect(transport);
  try {
    await run(client);
  } finally {
    await client.close();
  }
}

async function rawPost(url: string, headers: Record<string, string>, body: string) {
  return new Promise<number>((resolve, reject) => {
    const request = httpRequest(url, { method: "POST", headers }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode ?? 0));
    });
    request.once("error", reject);
    request.end(body);
  });
}

describe("room MCP bridge", () => {
  it("requires a bearer identity before either MCP protocol era can negotiate", async () => {
    const { bridge: roomBridge } = bridge();
    await withMcp(developers(["ROOM_READ"]), roomBridge, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } } }),
      });
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toContain("Bearer");
    });
  });

  it("rejects untrusted Host and Origin headers before authentication", async () => {
    const { bridge: roomBridge } = bridge();
    await withMcp(developers(["ROOM_READ"]), roomBridge, async (baseUrl) => {
      const headers = {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      };
      const body = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } },
      });
      const badHostStatus = await rawPost(`${baseUrl}/mcp`, { ...headers, Host: "attacker.example" }, body);
      expect(badHostStatus).toBe(403);

      const badOrigin = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: { ...headers, Origin: "https://attacker.example" },
        body,
      });
      expect(badOrigin.status).toBe(403);
    });

    await withMcp(developers(["ROOM_READ"]), roomBridge, async (baseUrl) => {
      const status = await rawPost(`${baseUrl}/mcp`, {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Host: "rooms.example.test",
        Origin: "https://rooms.example.test",
      }, JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "initialize",
        params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } },
      }));
      expect(status).toBe(200);
    }, ["rooms.example.test"]);
  });

  it("serves MCP 2026-07-28 with discovery, cache hints, schemas, and routable room headers", async () => {
    const { bridge: roomBridge } = bridge();
    await withMcp(developers(["ROOM_READ", "ROOM_CHAT"]), roomBridge, async (baseUrl, requests) => {
      await withClient(baseUrl, async (client) => {
        expect(client.getProtocolEra()).toBe("modern");
        expect(client.getDiscoverResult()).toMatchObject({
          capabilities: { tools: { listChanged: false } },
          ttlMs: 300_000,
          cacheScope: "private",
        });

        const listedTools = await client.listTools();
        expect(listedTools).toMatchObject({ ttlMs: 300_000, cacheScope: "private" });
        const tools = listedTools.tools;
        expect(tools.map(({ name }) => name)).toEqual(["list_rooms", "read_room", "send_room_message"]);
        expect(tools.find(({ name }) => name === "read_room")?.inputSchema.required).toContain("room_id");
        expect(tools.find(({ name }) => name === "send_room_message")?.inputSchema.required).toContain("room_id");
        expect(tools.find(({ name }) => name === "send_room_message")?.inputSchema.required).toContain("idempotency_key");
        expect(tools.find(({ name }) => name === "read_room")?.inputSchema.properties?.room_id).toMatchObject({ "x-mcp-header": "room-id" });
        expect(tools.find(({ name }) => name === "read_room")?.inputSchema.properties?.cursor).toMatchObject({ "x-mcp-header": "cursor" });
        expect(tools.find(({ name }) => name === "send_room_message")?.inputSchema.properties?.idempotency_key).toMatchObject({
          maxLength: 128,
          "x-mcp-header": "idempotency-key",
        });
        expect(tools.find(({ name }) => name === "read_room")?.outputSchema).toBeDefined();
        expect(tools.find(({ name }) => name === "send_room_message")?.outputSchema).toBeDefined();

        const listed = await client.callTool({ name: "list_rooms", arguments: {} });
        expect(listed.structuredContent).toEqual({ rooms: [{ roomId: ROOM_ID, name: "The Room", topic: "Testing", status: "active", cursor: expect.stringMatching(/^amfaa1\./), busy: false }] });

        const read = await client.callTool({ name: "read_room", arguments: { room_id: ROOM_ID, limit: 1 } });
        expect(read.isError).not.toBe(true);
        expect(read.structuredContent).toMatchObject({ roomId: ROOM_ID, cursor: expect.stringMatching(/^amfaa1\./) });
        expect(requests).toContainEqual(expect.objectContaining({
          method: "tools/call",
          name: "read_room",
          roomId: ROOM_ID,
          protocolVersion: "2026-07-28",
        }));

        const missing = await client.callTool({ name: "read_room", arguments: { room_id: "future-room" } });
        expect(missing.isError).toBe(true);
        expect(missing.structuredContent).toMatchObject({ error: { code: "ROOM_NOT_FOUND" } });
      });
    });
  });

  it("returns deterministic opaque room cursors and continues after the bound message", async () => {
    const readable = bridge();
    await withMcp(developers(["ROOM_READ"]), readable.bridge, async (baseUrl) => {
      await withClient(baseUrl, async (client) => {
        const first = await client.callTool({ name: "read_room", arguments: { room_id: ROOM_ID, limit: 1 } });
        const repeated = await client.callTool({ name: "read_room", arguments: { room_id: ROOM_ID, limit: 1 } });
        const cursor = (first.structuredContent as { cursor: string }).cursor;
        expect(cursor).toMatch(/^amfaa1\./);
        expect((repeated.structuredContent as { cursor: string }).cursor).toBe(cursor);

        readable.messages.push({ id: "m-3" });
        const continued = await client.callTool({ name: "read_room", arguments: { room_id: ROOM_ID, cursor, limit: 1 } });
        expect(continued.structuredContent).toMatchObject({ roomId: ROOM_ID, messages: [{ id: "m-3" }] });
        expect((continued.structuredContent as { cursor: string }).cursor).not.toBe(cursor);
      });
    });
  });

  it("returns the same typed refresh error for malformed, stale, and cross-room cursors", async () => {
    const secondRoom = "00000000-0000-4000-8000-000000000002";
    const pages = new Map([
      [ROOM_ID, [{ id: "room-one-message" }]],
      [secondRoom, [{ id: "room-two-message" }]],
    ]);
    const roomBridge: RoomMcpBridge = {
      listRooms: () => [ROOM_ID, secondRoom].map((roomId) => ({ roomId, name: roomId, topic: "Testing", status: "active", cursor: pages.get(roomId)!.at(-1)?.id, busy: false })),
      authorizeRoom: (roomId) => pages.has(roomId),
      readRoom: (roomId, limit, afterMessageId) => {
        const messages = pages.get(roomId)!;
        const afterIndex = afterMessageId == null ? -1 : messages.findIndex(({ id }) => id === afterMessageId);
        if (afterMessageId != null && afterIndex < 0) return { kind: "stale_cursor" };
        const page = afterMessageId === undefined ? messages.slice(-limit) : messages.slice(afterIndex + 1, afterIndex + 1 + limit);
        return { kind: "ok", value: { messages: page }, continuationMessageId: page.at(-1)?.id ?? afterMessageId ?? null };
      },
      sendMessage: async () => ({ kind: "ok", value: { accepted: true } }),
    };
    await withMcp(developers(["ROOM_READ"]), roomBridge, async (baseUrl) => {
      await withClient(baseUrl, async (client) => {
        const first = await client.callTool({ name: "read_room", arguments: { room_id: ROOM_ID } });
        const cursor = (first.structuredContent as { cursor: string }).cursor;
        pages.set(ROOM_ID, []);
        const stale = await client.callTool({ name: "read_room", arguments: { room_id: ROOM_ID, cursor } });
        const malformed = await client.callTool({ name: "read_room", arguments: { room_id: ROOM_ID, cursor: "not-a-cursor" } });

        pages.set(ROOM_ID, [{ id: "room-one-message" }]);
        const roomOne = await client.callTool({ name: "read_room", arguments: { room_id: ROOM_ID } });
        const crossRoom = await client.callTool({
          name: "read_room",
          arguments: { room_id: secondRoom, cursor: (roomOne.structuredContent as { cursor: string }).cursor },
        });
        for (const result of [stale, malformed, crossRoom]) {
          expect(result.isError).toBe(true);
          expect(result.structuredContent).toEqual({ error: {
            code: "CURSOR_REFRESH_REQUIRED",
            message: "The continuation cursor cannot be used. Call read_room again without a cursor.",
          } });
        }

        const unauthorized = await client.callTool({
          name: "read_room",
          arguments: { room_id: "unavailable-room", cursor: "not-a-cursor" },
        });
        expect(unauthorized.structuredContent).toMatchObject({ error: { code: "ROOM_NOT_FOUND" } });
      });
    });
  });

  it("replays exact sends, rejects conflicting reuse, and scopes retry keys to authorized rooms", async () => {
    const secondRoom = "00000000-0000-4000-8000-000000000002";
    const authorizedRooms = new Set([ROOM_ID, secondRoom]);
    const sendMessage = vi.fn<RoomMcpBridge["sendMessage"]>(async (roomId, _developer, text) => ({ kind: "ok", value: { accepted: true, acknowledgementId: `${roomId}:${text}` } }));
    const roomBridge: RoomMcpBridge = {
      listRooms: () => [],
      authorizeRoom: (roomId) => authorizedRooms.has(roomId),
      readRoom: () => ({ kind: "ok", value: { messages: [] }, continuationMessageId: null }),
      sendMessage,
    };
    await withMcp(developers(["ROOM_READ", "ROOM_CHAT"]), roomBridge, async (baseUrl) => {
      await withClient(baseUrl, async (client) => {
        const input = { room_id: ROOM_ID, text: "Retry me", idempotency_key: "stable-send-key" };
        const first = await client.callTool({ name: "send_room_message", arguments: input });
        const replay = await client.callTool({ name: "send_room_message", arguments: input });
        expect(replay.structuredContent).toEqual(first.structuredContent);
        expect(sendMessage).toHaveBeenCalledTimes(1);

        const conflict = await client.callTool({ name: "send_room_message", arguments: { ...input, text: "Different" } });
        expect(conflict.structuredContent).toMatchObject({ error: { code: "IDEMPOTENCY_CONFLICT" } });
        expect(sendMessage).toHaveBeenCalledTimes(1);

        const otherRoom = await client.callTool({ name: "send_room_message", arguments: { ...input, room_id: secondRoom, text: "Other room" } });
        expect(otherRoom.structuredContent).toMatchObject({ accepted: true, roomId: secondRoom });
        expect(sendMessage).toHaveBeenCalledTimes(2);

        authorizedRooms.delete(secondRoom);
        const hidden = await client.callTool({ name: "send_room_message", arguments: { ...input, room_id: secondRoom, text: "Conflict probe" } });
        expect(hidden.structuredContent).toMatchObject({ error: { code: "ROOM_NOT_FOUND" } });
        expect(sendMessage).toHaveBeenCalledTimes(2);
      });
    });
  });

  it("attributes messages and uses HTTP scope step-up for modern write authorization", async () => {
    const writable = bridge();
    await withMcp(developers(["ROOM_READ", "ROOM_CHAT"]), writable.bridge, async (baseUrl, requests) => {
      await withClient(baseUrl, async (client) => {
        const sent = await client.callTool({ name: "send_room_message", arguments: { room_id: ROOM_ID, text: "Hello, actors.", idempotency_key: "send-modern-1" } });
        expect(sent.isError).not.toBe(true);
        expect(sent.structuredContent).toMatchObject({ accepted: true, roomId: ROOM_ID });
        expect(requests).toContainEqual(expect.objectContaining({
          method: "tools/call",
          name: "send_room_message",
          roomId: ROOM_ID,
          idempotencyKey: "send-modern-1",
        }));
      });
    });
    expect(writable.sendMessage).toHaveBeenCalledWith(
      ROOM_ID,
      expect.objectContaining({ member: expect.objectContaining({ memberId: "remote-developer" }) }),
      "Hello, actors.",
      expect.objectContaining({ key: "send-modern-1", requestDigest: expect.any(String) }),
    );

    const readOnly = bridge();
    await withMcp(developers(["ROOM_READ"]), readOnly.bridge, async (baseUrl) => {
      await withClient(baseUrl, async (client) => {
        await client.listTools();
        await expect(client.callTool({
          name: "send_room_message",
          arguments: { room_id: ROOM_ID, text: "No authority.", idempotency_key: "send-denied-1" },
        })).rejects.toBeInstanceOf(InsufficientScopeError);
      });
    });
    expect(readOnly.sendMessage).not.toHaveBeenCalled();
  });

  it("retains stateless compatibility with 2025-era MCP clients", async () => {
    const legacy = bridge();
    await withMcp(developers(["ROOM_READ"]), legacy.bridge, async (baseUrl) => {
      await withClient(baseUrl, async (client) => {
        expect(client.getProtocolEra()).toBe("legacy");
        const rooms = await client.callTool({ name: "list_rooms", arguments: {} });
        expect(rooms.structuredContent).toMatchObject({ rooms: [{ roomId: ROOM_ID }] });

        const denied = await client.callTool({
          name: "send_room_message",
          arguments: { room_id: ROOM_ID, text: "No authority.", idempotency_key: "send-legacy-denied-1" },
        });
        expect(denied.isError).toBe(true);
        expect(denied.structuredContent).toMatchObject({ error: { code: "FORBIDDEN" } });
      }, "legacy");
    });
    expect(legacy.sendMessage).not.toHaveBeenCalled();

    const writable = bridge();
    await withMcp(developers(["ROOM_READ", "ROOM_CHAT"]), writable.bridge, async (baseUrl) => {
      await withClient(baseUrl, async (client) => {
        const read = await client.callTool({ name: "read_room", arguments: { room_id: ROOM_ID, limit: 1 } });
        expect((read.structuredContent as { cursor: string }).cursor).toMatch(/^amfaa1\./);
        const input = { room_id: ROOM_ID, text: "Legacy retry.", idempotency_key: "send-legacy-1" };
        const first = await client.callTool({ name: "send_room_message", arguments: input });
        const replay = await client.callTool({ name: "send_room_message", arguments: input });
        expect(replay.structuredContent).toEqual(first.structuredContent);
      }, "legacy");
    });
    expect(writable.sendMessage).toHaveBeenCalledTimes(1);
  });
});
