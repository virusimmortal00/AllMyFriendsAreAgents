import type express from "express";
import { createHash } from "node:crypto";
import { hostHeaderValidation, originValidation, toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, fromJsonSchema, McpServer, type JsonSchemaType } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import type { AuthenticatedDeveloper, DeveloperTeamRegistry } from "./developer-team.js";
import {
  consultationRequestStateCodec,
  registerConsultationMcpTools,
  type ConsultationRoomAuthorizer,
  type DurableConsultationMcpService,
} from "./consultation-mcp.js";

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

export interface RoomMcpBridge extends ConsultationRoomAuthorizer {
  listRooms(developer: AuthenticatedDeveloper): readonly McpRoomDescriptor[];
  authorizeRoom(roomId: string, developer: AuthenticatedDeveloper, capability: "read" | "chat" | "consult" | "cancel"): boolean;
  readRoom(roomId: string, limit: number, afterMessageId?: string | null): RoomMcpReadResult;
  sendMessage(
    roomId: string,
    developer: AuthenticatedDeveloper,
    text: string,
    idempotency: RoomMcpIdempotency,
  ): Promise<RoomMcpSendResult>;
}

interface SingleRoomMcpBridgeOptions {
  readonly roomId: string;
  readonly describe: () => McpRoomDescriptor;
  readonly read: (limit: number, afterMessageId?: string | null) => RoomMcpReadResult;
  readonly send: (developer: AuthenticatedDeveloper, text: string, idempotency: RoomMcpIdempotency) => Promise<RoomMcpSendResult>;
}

interface ReadRoomInput {
  readonly room_id: string;
  readonly limit?: number;
  readonly cursor?: string;
}

interface SendRoomMessageInput {
  readonly room_id: string;
  readonly text: string;
  readonly idempotency_key: string;
}

export type RoomMcpReadResult =
  | { readonly kind: "ok"; readonly value: Record<string, unknown>; readonly continuationMessageId: string | null }
  | { readonly kind: "stale_cursor" };

export interface RoomMcpIdempotency {
  readonly key: string;
  readonly requestDigest: string;
}

export type RoomMcpSendResult =
  | { readonly kind: "ok"; readonly value: Record<string, unknown> }
  | { readonly kind: "idempotency_conflict" }
  | { readonly kind: "not_found" };

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
    cursor: {
      type: "string",
      minLength: 1,
      maxLength: 2048,
      description: "Opaque room-scoped continuation cursor returned by an earlier read_room call.",
      "x-mcp-header": "cursor",
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
    idempotency_key: {
      type: "string",
      minLength: 1,
      maxLength: 128,
      pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
      description: "Caller-generated retry key. Exact reuse replays the original acknowledgement; reuse with different input is rejected.",
      "x-mcp-header": "idempotency-key",
    },
  },
  required: ["room_id", "text", "idempotency_key"],
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
    authorizeRoom: (roomId) => matches(roomId),
    readRoom: (roomId, limit, afterMessageId) => matches(roomId) ? options.read(limit, afterMessageId) : { kind: "stale_cursor" },
    sendMessage: (roomId, developer, text, idempotency) => matches(roomId) ? options.send(developer, text, idempotency) : Promise.resolve({ kind: "not_found" }),
  };
}

interface CursorPayload {
  readonly version: 1;
  readonly roomId: string;
  readonly afterMessageId: string | null;
}

function cursorDigest(encodedPayload: string) {
  return createHash("sha256").update(`amfaa-room-cursor-v1\0${encodedPayload}`).digest("base64url").slice(0, 22);
}

function encodeCursor(roomId: string, afterMessageId: string | null) {
  const payload: CursorPayload = { version: 1, roomId, afterMessageId };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `amfaa1.${encoded}.${cursorDigest(encoded)}`;
}

function decodeCursor(cursor: string, roomId: string): string | null | undefined {
  const [prefix, encoded, digest, extra] = cursor.split(".");
  if (prefix !== "amfaa1" || !encoded || !digest || extra || digest !== cursorDigest(encoded)) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Partial<CursorPayload>;
    if (parsed.version !== 1 || parsed.roomId !== roomId || (parsed.afterMessageId !== null && typeof parsed.afterMessageId !== "string")) return undefined;
    return parsed.afterMessageId;
  } catch {
    return undefined;
  }
}

interface IdempotencyEntry {
  readonly digest: string;
  readonly acknowledgement: Promise<RoomMcpSendResult>;
  settled: boolean;
}
export const MAX_MESSAGE_IDEMPOTENCY_ENTRIES = 1_024;

function requestDigest(roomId: string, developer: AuthenticatedDeveloper, text: string) {
  return createHash("sha256").update(JSON.stringify([roomId, developer.member.memberId, text])).digest("base64url");
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
  idempotency: Map<string, IdempotencyEntry>,
  consultationService?: DurableConsultationMcpService,
  requestState = consultationRequestStateCodec(developers),
  idempotencyLimit = MAX_MESSAGE_IDEMPOTENCY_ENTRIES,
) {
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    {
      capabilities: { tools: { listChanged: false }, extensions: { "io.modelcontextprotocol/tasks": { version: "1" } } },
      instructions: "Every room operation requires an explicit opaque room_id. Call list_rooms whenever the user has not selected a room; never infer or cache a singleton room. The server currently exposes one room, but the returned directory may contain multiple rooms without a tool-contract change.",
      cacheHints: {
        "server/discover": { ttlMs: 300_000, cacheScope: "private" },
        "tools/list": { ttlMs: 300_000, cacheScope: "private" },
      },
      requestState: { verify: requestState.verify },
    },
  );

  server.registerTool("list_rooms", {
    title: "List actor chat rooms",
    description: "List rooms available on this server. Call this before read_room or send_room_message when room_id is unknown. Room IDs are opaque.",
    inputSchema: z.object({}),
    outputSchema: listRoomsOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async () => {
    const developer = developers.authenticate(authorization, "ROOM_READ");
    if (!developer) return toolError("FORBIDDEN", "This developer identity cannot read rooms.");
    const rooms = [...bridge.listRooms(developer)]
      .sort((left, right) => left.roomId.localeCompare(right.roomId))
      .map((room) => ({ ...room, cursor: encodeCursor(room.roomId, room.cursor ?? null) }));
    return success({ rooms });
  });

  server.registerTool("read_room", {
    title: "Read an actor chat room",
    description: "Read recent state and messages from one room. Pass a room_id returned by list_rooms; pass the returned opaque cursor to continue, and omit it to refresh.",
    inputSchema: readRoomInputSchema,
    outputSchema: readRoomOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ room_id: roomId, limit = 50, cursor }) => {
    const developer = developers.authenticate(authorization, "ROOM_READ");
    if (!developer || !bridge.authorizeRoom(roomId, developer, "read")) {
      return toolError("ROOM_NOT_FOUND", "That room is not available. Call list_rooms to refresh the room directory.");
    }
    const afterMessageId = cursor === undefined ? undefined : decodeCursor(cursor, roomId);
    if (cursor !== undefined && afterMessageId === undefined) {
      return toolError("CURSOR_REFRESH_REQUIRED", "The continuation cursor cannot be used. Call read_room again without a cursor.");
    }
    const room = bridge.readRoom(roomId, limit, afterMessageId);
    return room.kind === "ok"
      ? success({ ...room.value, roomId, cursor: encodeCursor(roomId, room.continuationMessageId) })
      : toolError("CURSOR_REFRESH_REQUIRED", "The continuation cursor cannot be used. Call read_room again without a cursor.");
  });

  server.registerTool("send_room_message", {
    title: "Send a message to an actor chat room",
    description: "Send a developer-authored chat message to one room and start its normal actor conversation. Pass a room_id returned by list_rooms and a stable idempotency_key for safe retries.",
    inputSchema: sendRoomMessageInputSchema,
    outputSchema: sendRoomMessageOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ room_id: roomId, text, idempotency_key: idempotencyKey }) => {
    const developer = developers.authenticate(authorization, "ROOM_CHAT");
    if (!developer) return toolError("FORBIDDEN", "This developer identity cannot send room messages.");
    if (!bridge.authorizeRoom(roomId, developer, "chat")) {
      return toolError("ROOM_NOT_FOUND", "That room is not available. Call list_rooms to refresh the room directory.");
    }
    const normalizedText = text.trim();
    const lookupKey = JSON.stringify([roomId, developer.member.memberId, idempotencyKey]);
    const digest = requestDigest(roomId, developer, normalizedText);
    const replay = idempotency.get(lookupKey);
    if (replay && replay.digest !== digest) {
      return toolError("IDEMPOTENCY_CONFLICT", "That idempotency key was already used for a different request.");
    }
    let acknowledgement = replay?.acknowledgement;
    if (replay) { idempotency.delete(lookupKey); idempotency.set(lookupKey, replay); }
    if (!acknowledgement) {
      if (idempotency.size >= idempotencyLimit) {
        const evictable = [...idempotency].find(([, entry]) => entry.settled);
        if (!evictable) return toolError("SERVER_BUSY", "Too many message submissions are still in flight; retry later with the same key.");
        idempotency.delete(evictable[0]);
      }
      acknowledgement = bridge.sendMessage(roomId, developer, normalizedText, { key: idempotencyKey, requestDigest: digest });
      const entry: IdempotencyEntry = { digest, acknowledgement, settled: false };
      idempotency.set(lookupKey, entry);
      acknowledgement.then(() => { entry.settled = true; }, () => undefined);
      acknowledgement.catch(() => {
        if (idempotency.get(lookupKey)?.acknowledgement === acknowledgement) idempotency.delete(lookupKey);
      });
    }
    const result = await acknowledgement;
    if (result.kind === "idempotency_conflict") {
      return toolError("IDEMPOTENCY_CONFLICT", "That idempotency key was already used for a different request.");
    }
    return result.kind === "ok"
      ? success({ ...result.value, roomId })
      : toolError("ROOM_NOT_FOUND", "That room is not available. Call list_rooms to refresh the room directory.");
  });

  if (consultationService) registerConsultationMcpTools({
    server,
    service: consultationService,
    developers,
    authorization,
    rooms: bridge,
    requestState,
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
  readonly consultationService?: DurableConsultationMcpService;
  readonly allowedHostnames?: readonly string[];
  readonly messageIdempotencyLimit?: number;
}) {
  const idempotency = new Map<string, IdempotencyEntry>();
  const requestState = consultationRequestStateCodec(options.developers);
  const handler = createMcpHandler(({ requestInfo }) => createRoomMcpServer(
    options.bridge,
    options.developers,
    requestInfo?.headers.get("authorization") ?? undefined,
    idempotency,
    options.consultationService,
    requestState,
    Math.max(1, options.messageIdempotencyLimit ?? MAX_MESSAGE_IDEMPOTENCY_ENTRIES),
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
    if (!options.developers.authenticateAny(authorization)) {
      response
        .status(401)
        .set("Cache-Control", "no-store")
        .set("WWW-Authenticate", bearerChallenge())
        .json({ error: "A valid room bridge bearer credential is required." });
      return;
    }

    const routedTool = request.header("mcp-method") === "tools/call" ? request.header("mcp-name") : undefined;
    const requiredCapability = routedTool === "send_room_message" ? "ROOM_CHAT"
      : routedTool === "start_room_consultation" || routedTool === "respond_to_room_consultation" ? "CONSULTATION_WRITE"
      : routedTool === "cancel_room_consultation" ? "CONSULTATION_CANCEL"
      : routedTool === "get_room_consultation" ? "CONSULTATION_READ"
      : undefined;
    if (requiredCapability && !options.developers.authenticate(authorization, requiredCapability)) {
      const scope = requiredCapability === "ROOM_CHAT" ? "rooms:chat"
        : requiredCapability === "CONSULTATION_CANCEL" ? "consultations:cancel"
        : requiredCapability === "CONSULTATION_WRITE" ? "consultations:write"
        : "consultations:read";
      response
        .status(403)
        .set("Cache-Control", "no-store")
        .set("WWW-Authenticate", bearerChallenge(scope))
        .json({ error: "This developer identity lacks the required scope." });
      return;
    }

    await nodeHandler(request, response, request.body);
  });

  return { close: handler.close };
}
