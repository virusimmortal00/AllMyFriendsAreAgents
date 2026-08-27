import type express from "express";
import { hostHeaderValidation, originValidation, toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, fromJsonSchema, McpServer, type JsonSchemaType } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import type { AuthenticatedDeveloper, DeveloperTeamRegistry } from "./developer-team.js";

const MCP_SERVER_NAME = "all-my-friends-are-agents-room-bridge";
const MCP_SERVER_VERSION = "0.1.0";

export interface McpRoomDescriptor {
  readonly roomId: string;
  readonly name: string;
  readonly topic: string;
  readonly status: "active";
  readonly cursor?: string;
  readonly busy: boolean;
}

export interface RoomMcpBridge {
  listRooms(): readonly McpRoomDescriptor[];
  readRoom(roomId: string, limit: number): Record<string, unknown> | undefined;
  sendMessage(
    roomId: string,
    developer: AuthenticatedDeveloper,
    text: string,
  ): Promise<Record<string, unknown> | undefined>;
}

interface SingleRoomMcpBridgeOptions {
  readonly roomId: string;
  readonly describe: () => McpRoomDescriptor;
  readonly read: (limit: number) => Record<string, unknown>;
  readonly send: (developer: AuthenticatedDeveloper, text: string) => Promise<Record<string, unknown>>;
}

interface ReadRoomInput {
  readonly room_id: string;
  readonly limit?: number;
}

interface SendRoomMessageInput {
  readonly room_id: string;
  readonly text: string;
}

const roomDescriptorSchema = z.object({
  roomId: z.string(),
  name: z.string(),
  topic: z.string(),
  status: z.literal("active"),
  cursor: z.string().optional(),
  busy: z.boolean(),
});

const listRoomsOutputSchema = z.object({ rooms: z.array(roomDescriptorSchema) });
const readRoomOutputSchema = z.object({ roomId: z.string() }).loose();
const sendRoomMessageOutputSchema = z.object({ accepted: z.boolean(), roomId: z.string() }).loose();

const readRoomInputSchema = fromJsonSchema<ReadRoomInput>({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    room_id: {
      type: "string",
      minLength: 1,
      description: "Opaque room ID returned by list_rooms.",
      "x-mcp-header": "room-id",
    },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: 200,
      description: "Maximum recent messages to return; defaults to 50.",
    },
  },
  required: ["room_id"],
  additionalProperties: false,
} as unknown as JsonSchemaType);

const sendRoomMessageInputSchema = fromJsonSchema<SendRoomMessageInput>({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    room_id: {
      type: "string",
      minLength: 1,
      description: "Opaque room ID returned by list_rooms.",
      "x-mcp-header": "room-id",
    },
    text: {
      type: "string",
      minLength: 1,
      maxLength: 16_000,
      description: "Message to send to the selected room.",
    },
  },
  required: ["room_id", "text"],
  additionalProperties: false,
} as unknown as JsonSchemaType);

/**
 * Adapts today's single room to the same directory contract a multi-room
 * repository will implement. MCP callers never receive or rely on an implicit
 * "current room".
 */
export function singleRoomMcpBridge(options: SingleRoomMcpBridgeOptions): RoomMcpBridge {
  const matches = (roomId: string) => roomId === options.roomId;
  return {
    listRooms: () => [options.describe()],
    readRoom: (roomId, limit) => matches(roomId) ? options.read(limit) : undefined,
    sendMessage: (roomId, developer, text) => matches(roomId) ? options.send(developer, text) : Promise.resolve(undefined),
  };
}

function textContent(value: unknown) {
  return { type: "text" as const, text: JSON.stringify(value) };
}

function success(value: Record<string, unknown>) {
  return { content: [textContent(value)], structuredContent: value };
}

function toolError(code: string, message: string) {
  const error = { error: { code, message } };
  return { isError: true, content: [textContent(error)], structuredContent: error };
}

function createRoomMcpServer(
  bridge: RoomMcpBridge,
  developers: DeveloperTeamRegistry,
  authorization: string | undefined,
) {
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    {
      capabilities: { tools: { listChanged: false } },
      instructions: "Every room operation requires an explicit opaque room_id. Call list_rooms whenever the user has not selected a room; never infer or cache a singleton room. The server currently exposes one room, but the returned directory may contain multiple rooms without a tool-contract change.",
      cacheHints: {
        "server/discover": { ttlMs: 300_000, cacheScope: "private" },
        "tools/list": { ttlMs: 300_000, cacheScope: "private" },
      },
    },
  );

  server.registerTool("list_rooms", {
    title: "List actor chat rooms",
    description: "List rooms available on this server. Call this before read_room or send_room_message when room_id is unknown. Room IDs are opaque.",
    inputSchema: z.object({}),
    outputSchema: listRoomsOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async () => success({
    rooms: [...bridge.listRooms()].sort((left, right) => left.roomId.localeCompare(right.roomId)),
  }));

  server.registerTool("read_room", {
    title: "Read an actor chat room",
    description: "Read recent state and messages from one room. Pass a room_id returned by list_rooms; do not invent or infer it.",
    inputSchema: readRoomInputSchema,
    outputSchema: readRoomOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ room_id: roomId, limit = 50 }) => {
    const room = bridge.readRoom(roomId, limit);
    return room ? success({ ...room, roomId }) : toolError("ROOM_NOT_FOUND", `Room ${roomId} is not available. Call list_rooms to refresh the room directory.`);
  });

  server.registerTool("send_room_message", {
    title: "Send a message to an actor chat room",
    description: "Send a developer-authored chat message to one room and start its normal actor conversation. Pass a room_id returned by list_rooms.",
    inputSchema: sendRoomMessageInputSchema,
    outputSchema: sendRoomMessageOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ room_id: roomId, text }) => {
    const developer = developers.authenticate(authorization, "ROOM_CHAT");
    if (!developer) return toolError("FORBIDDEN", "This developer identity cannot send room messages.");
    const result = await bridge.sendMessage(roomId, developer, text.trim());
    return result
      ? success({ ...result, roomId })
      : toolError("ROOM_NOT_FOUND", `Room ${roomId} is not available. Call list_rooms to refresh the room directory.`);
  });

  return server;
}

function bearerChallenge(scope?: string) {
  const base = 'Bearer realm="all-my-friends-are-agents-mcp"';
  return scope ? `${base}, error="insufficient_scope", scope="${scope}"` : base;
}

export function registerRoomMcpRoutes(options: {
  readonly app: express.Express;
  readonly developers: DeveloperTeamRegistry;
  readonly bridge: RoomMcpBridge;
  readonly allowedHostnames?: readonly string[];
}) {
  const handler = createMcpHandler(({ requestInfo }) => createRoomMcpServer(
    options.bridge,
    options.developers,
    requestInfo?.headers.get("authorization") ?? undefined,
  ), {
    legacy: "stateless",
    responseMode: "auto",
  });
  const nodeHandler = toNodeHandler(handler);
  const allowedHostnames = [...(options.allowedHostnames ?? ["localhost", "127.0.0.1", "[::1]"])];
  const validateHost = hostHeaderValidation(allowedHostnames);
  const validateOrigin = originValidation(allowedHostnames);

  options.app.all("/mcp", async (request, response) => {
    if (!validateHost(request, response) || !validateOrigin(request, response)) return;

    const authorization = request.header("authorization");
    if (!options.developers.authenticate(authorization, "ROOM_READ")) {
      response
        .status(401)
        .set("Cache-Control", "no-store")
        .set("WWW-Authenticate", bearerChallenge())
        .json({ error: "A room bridge credential with ROOM_READ is required." });
      return;
    }

    const routedWrite = request.header("mcp-method") === "tools/call"
      && request.header("mcp-name") === "send_room_message";
    if (routedWrite && !options.developers.authenticate(authorization, "ROOM_CHAT")) {
      response
        .status(403)
        .set("Cache-Control", "no-store")
        .set("WWW-Authenticate", bearerChallenge("rooms:chat"))
        .json({ error: "This developer identity cannot send room messages." });
      return;
    }

    await nodeHandler(request, response, request.body);
  });

  return { close: handler.close };
}
