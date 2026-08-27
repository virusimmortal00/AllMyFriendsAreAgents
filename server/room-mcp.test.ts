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
  sendMessage.mockResolvedValue({ accepted: true });
  return {
    bridge: singleRoomMcpBridge({
      roomId: ROOM_ID,
      describe: () => ({ roomId: ROOM_ID, name: "The Room", topic: "Testing", status: "active", cursor: "m-2", busy: false }),
      read: (limit) => ({ roomId: ROOM_ID, messages: [{ id: "m-2" }].slice(-limit), cursor: "m-2" }),
      send: async (developer, text) => {
        const result = await sendMessage(ROOM_ID, developer, text);
        return result ?? { accepted: true };
      },
    }),
    sendMessage,
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
        expect(tools.find(({ name }) => name === "read_room")?.inputSchema.properties?.room_id).toMatchObject({ "x-mcp-header": "room-id" });
        expect(tools.find(({ name }) => name === "read_room")?.outputSchema).toBeDefined();
        expect(tools.find(({ name }) => name === "send_room_message")?.outputSchema).toBeDefined();

        const listed = await client.callTool({ name: "list_rooms", arguments: {} });
        expect(listed.structuredContent).toEqual({ rooms: [{ roomId: ROOM_ID, name: "The Room", topic: "Testing", status: "active", cursor: "m-2", busy: false }] });

        const read = await client.callTool({ name: "read_room", arguments: { room_id: ROOM_ID, limit: 1 } });
        expect(read.isError).not.toBe(true);
        expect(read.structuredContent).toMatchObject({ roomId: ROOM_ID, cursor: "m-2" });
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

  it("attributes messages and uses HTTP scope step-up for modern write authorization", async () => {
    const writable = bridge();
    await withMcp(developers(["ROOM_READ", "ROOM_CHAT"]), writable.bridge, async (baseUrl) => {
      await withClient(baseUrl, async (client) => {
        const sent = await client.callTool({ name: "send_room_message", arguments: { room_id: ROOM_ID, text: "Hello, actors." } });
        expect(sent.isError).not.toBe(true);
        expect(sent.structuredContent).toMatchObject({ accepted: true, roomId: ROOM_ID });
      });
    });
    expect(writable.sendMessage).toHaveBeenCalledWith(
      ROOM_ID,
      expect.objectContaining({ member: expect.objectContaining({ memberId: "remote-developer" }) }),
      "Hello, actors.",
    );

    const readOnly = bridge();
    await withMcp(developers(["ROOM_READ"]), readOnly.bridge, async (baseUrl) => {
      await withClient(baseUrl, async (client) => {
        await client.listTools();
        await expect(client.callTool({
          name: "send_room_message",
          arguments: { room_id: ROOM_ID, text: "No authority." },
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
          arguments: { room_id: ROOM_ID, text: "No authority." },
        });
        expect(denied.isError).toBe(true);
        expect(denied.structuredContent).toMatchObject({ error: { code: "FORBIDDEN" } });
      }, "legacy");
    });
    expect(legacy.sendMessage).not.toHaveBeenCalled();
  });
});
