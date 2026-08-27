import { createHash } from "node:crypto";
import {
  CLIENT_CAPABILITIES_META_KEY,
  acceptedContent,
  createRequestStateCodec,
  fromJsonSchema,
  inputRequired,
  type JsonSchemaType,
  type McpServer,
  type RequestStateCodec,
  type ServerContext,
} from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import type { AuthenticatedDeveloper, DeveloperTeamRegistry } from "./developer-team.js";
import type { Consultation, ConsultationDialogueLimits, JsonValue } from "../shared/consultation-domain.js";
import type { ConsultationRunner } from "./consultation-service.js";
import type { ConsultationEvent, ConsultationRepository } from "./storage/consultation-repository.js";

export const CONSULTATION_TOOL_NAMES = [
  "start_room_consultation",
  "get_room_consultation",
  "respond_to_room_consultation",
  "cancel_room_consultation",
] as const;

const IDEMPOTENCY_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$";
const TERMINAL_STATES = new Set(["complete", "failed", "cancelled"]);
const responseForm = z.object({ response: z.string().min(1).max(4_000) });

interface StartInput {
  room_id: string;
  topic: string;
  context?: JsonValue;
  requested_participant_ids?: string[];
  dialogue?: Partial<ConsultationDialogueLimits> & { enabled?: boolean };
  idempotency_key: string;
}
interface GetInput { room_id: string; consultation_id: string; after_revision?: number; event_limit?: number }
interface RespondInput extends GetInput { expected_revision: number; response?: string; idempotency_key: string }
interface CancelInput extends GetInput { expected_revision: number; reason?: string; idempotency_key: string }
interface ConsultationRequestState {
  kind: "consultation-response";
  roomId: string;
  consultationId: string;
  expectedRevision: number;
  idempotencyKey: string;
  actorId: string;
}

export interface ConsultationRoomAuthorizer {
  authorizeRoom(roomId: string, developer: AuthenticatedDeveloper, capability: "read" | "consult" | "cancel"): boolean;
}

export type ConsultationMcpResult =
  | { readonly kind: "ok"; readonly consultation: Consultation; readonly events?: readonly ConsultationEvent[] }
  | { readonly kind: "not_found" }
  | { readonly kind: "idempotency_conflict" }
  | { readonly kind: "stale_revision"; readonly actualRevision: number }
  | { readonly kind: "invalid_state"; readonly state: string; readonly reason: string };

/** Portable MCP-facing adapter over the durable runner and repository. */
export class DurableConsultationMcpService {
  constructor(
    private readonly runner: ConsultationRunner,
    private readonly repository: ConsultationRepository,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async start(input: StartInput, developer: AuthenticatedDeveloper): Promise<ConsultationMcpResult> {
    const consultationId = stableUuid(input.room_id, developer.member.memberId, input.idempotency_key);
    const result = await this.runner.start({
      roomId: input.room_id,
      consultationId,
      idempotencyKey: input.idempotency_key,
      request: {
        topic: input.topic,
        context: input.context,
        requestedParticipantIds: input.requested_participant_ids,
      },
      provenance: {
        kind: "agent",
        actorId: developer.member.memberId,
        sourceId: `mcp:start:${digest(input.idempotency_key).slice(0, 24)}`,
        recordedAt: this.now(),
      },
      dialogue: input.dialogue,
    });
    if (result.kind === "idempotency_conflict" || result.kind === "identity_conflict") return { kind: "idempotency_conflict" };
    if (result.kind === "replayed") {
      const events = await this.repository.listConsultationEvents(result.consultation, { afterRevision: 0, limit: 3 });
      const acknowledgement = events.find(({ change }) => change !== "create" && change.kind === "record_execution")?.snapshot ?? events[0]?.snapshot ?? result.consultation;
      return { kind: "ok", consultation: acknowledgement };
    }
    return { kind: "ok", consultation: result.consultation };
  }

  async get(input: GetInput): Promise<ConsultationMcpResult> {
    const consultation = await this.runner.get({ roomId: input.room_id, consultationId: input.consultation_id });
    if (!consultation) return { kind: "not_found" };
    const afterRevision = input.after_revision ?? 0;
    if (afterRevision > consultation.revision) return { kind: "stale_revision", actualRevision: consultation.revision };
    const limit = Math.max(1, Math.min(50, Math.trunc(input.event_limit ?? 20)));
    const events = await this.repository.listConsultationEvents(consultation, { afterRevision, limit: limit + 1 });
    return { kind: "ok", consultation, events };
  }

  async respond(input: RespondInput, developer: AuthenticatedDeveloper): Promise<ConsultationMcpResult> {
    const identity = { roomId: input.room_id, consultationId: input.consultation_id };
    const current = await this.runner.get(identity);
    if (!current) return { kind: "not_found" };
    const response = input.response?.trim() ?? "";
    const inputId = mutationId("response", input.room_id, input.consultation_id, developer.member.memberId, input.idempotency_key);
    const replay = current.execution?.inputs.find((candidate) => candidate.inputId === inputId);
    if (replay) {
      if (replay.expectedRevision !== input.expected_revision || replay.actorId !== developer.member.memberId || replay.value !== response) return { kind: "idempotency_conflict" };
      const events = await this.repository.listConsultationEvents(identity, { afterRevision: replay.expectedRevision, limit: 3 });
      const acknowledgement = events.find(({ snapshot }) => snapshot.state === "discussing" && snapshot.execution?.inputs.some(({ inputId: candidate }) => candidate === inputId))?.snapshot ?? current;
      return { kind: "ok", consultation: acknowledgement };
    }
    if (current.revision !== input.expected_revision) return { kind: "stale_revision", actualRevision: current.revision };
    if (current.state !== "input_required") return { kind: "invalid_state", state: current.state, reason: "Consultation is not waiting for input." };
    const result = await this.runner.submitInput(identity, input.expected_revision, response, developer.member.memberId, inputId);
    if (result.kind === "not_found") return result;
    if (result.kind === "conflict") return { kind: "stale_revision", actualRevision: (await this.runner.get(identity))?.revision ?? input.expected_revision };
    if (result.kind !== "ok") return { kind: "invalid_state", state: current.state, reason: result.reason };
    return { kind: "ok", consultation: result.consultation };
  }

  async cancel(input: CancelInput, developer: AuthenticatedDeveloper): Promise<ConsultationMcpResult> {
    const identity = { roomId: input.room_id, consultationId: input.consultation_id };
    const current = await this.runner.get(identity);
    if (!current) return { kind: "not_found" };
    const requestDigest = digest(JSON.stringify([input.expected_revision, (input.reason ?? "").trim()]));
    const marker = `[mcp-cancel:${mutationId("cancel", input.room_id, input.consultation_id, developer.member.memberId, input.idempotency_key)}:${requestDigest.slice(0, 24)}]`;
    const transition = current.transitions.find(({ reason }) => reason.endsWith(marker));
    if (transition) {
      const sameRequest = transition.actorId === developer.member.memberId && transition.reason.endsWith(`:${requestDigest.slice(0, 24)}]`);
      return sameRequest ? { kind: "ok", consultation: current } : { kind: "idempotency_conflict" };
    }
    const reusedKey = current.transitions.find(({ reason }) => reason.includes(`[mcp-cancel:${mutationId("cancel", input.room_id, input.consultation_id, developer.member.memberId, input.idempotency_key)}:`));
    if (reusedKey) return { kind: "idempotency_conflict" };
    if (current.revision !== input.expected_revision) return { kind: "stale_revision", actualRevision: current.revision };
    if (TERMINAL_STATES.has(current.state)) return { kind: "invalid_state", state: current.state, reason: `Consultation already ${current.state}.` };
    const reason = `${(input.reason ?? "Cancelled through MCP.").trim().slice(0, 700) || "Cancelled through MCP."} ${marker}`;
    const result = await this.runner.cancel(identity, input.expected_revision, developer.member.memberId, reason);
    if (result.kind === "ok") return result;
    const winner = await this.runner.get(identity);
    if (winner?.state === "cancelled" && winner.transitions.some(({ reason: value }) => value.endsWith(marker))) return { kind: "ok", consultation: winner };
    if (result.kind === "not_found") return result;
    if (result.kind === "conflict") return { kind: "stale_revision", actualRevision: winner?.revision ?? input.expected_revision };
    return { kind: "invalid_state", state: winner?.state ?? current.state, reason: result.reason };
  }
}

const startInputSchema = fromJsonSchema<StartInput>({
  $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", additionalProperties: false,
  properties: {
    room_id: routeString("Opaque room ID returned by list_rooms."),
    topic: { type: "string", minLength: 1, maxLength: 8_000 },
    context: jsonValueSchema(),
    requested_participant_ids: { type: "array", maxItems: 32, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 256 } },
    dialogue: { type: "object", additionalProperties: false, properties: {
      enabled: { type: "boolean" }, participantLimit: boundedInteger(1, 8), turnLimit: boundedInteger(1, 24),
      roundLimit: boundedInteger(1, 4), concurrencyLimit: boundedInteger(1, 4), timeLimitMs: boundedInteger(1, 300_000),
    } },
    idempotency_key: idempotencySchema(),
  }, required: ["room_id", "topic", "idempotency_key"],
} as unknown as JsonSchemaType);

const getInputSchema = fromJsonSchema<GetInput>({
  $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", additionalProperties: false,
  properties: { room_id: routeString("Opaque room ID."), consultation_id: consultationIdSchema(), after_revision: boundedInteger(0, 2_147_483_647), event_limit: boundedInteger(1, 50) },
  required: ["room_id", "consultation_id"],
} as unknown as JsonSchemaType);

const respondInputSchema = fromJsonSchema<RespondInput>({
  $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", additionalProperties: false,
  properties: { room_id: routeString("Opaque room ID."), consultation_id: consultationIdSchema(), expected_revision: boundedInteger(1, 2_147_483_647), response: { type: "string", minLength: 1, maxLength: 4_000 }, idempotency_key: idempotencySchema() },
  required: ["room_id", "consultation_id", "expected_revision", "idempotency_key"],
} as unknown as JsonSchemaType);

const cancelInputSchema = fromJsonSchema<CancelInput>({
  $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", additionalProperties: false,
  properties: { room_id: routeString("Opaque room ID."), consultation_id: consultationIdSchema(), expected_revision: boundedInteger(1, 2_147_483_647), reason: { type: "string", minLength: 1, maxLength: 700 }, idempotency_key: idempotencySchema() },
  required: ["room_id", "consultation_id", "expected_revision", "idempotency_key"],
} as unknown as JsonSchemaType);

const outputSchema = fromJsonSchema<Record<string, unknown>>({
  $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", additionalProperties: false,
  properties: {
    room_id: { type: "string" }, consultation_id: { type: "string" }, state: { enum: ["queued", "discussing", "input_required", "complete", "failed", "cancelled"] },
    revision: { type: "integer", minimum: 1 }, progress: { type: "object" }, blocking_question: { type: ["string", "null"] }, final_artifact: { type: ["object", "null"] },
    transport: { type: "object", additionalProperties: false, properties: { mode: { enum: ["polling", "mcp_task"] }, task_id: { type: ["string", "null"] } }, required: ["mode", "task_id"] },
  }, required: ["room_id", "consultation_id", "state", "revision", "progress", "blocking_question", "final_artifact", "transport"],
} as unknown as JsonSchemaType);

export function registerConsultationMcpTools(options: {
  server: McpServer;
  service: DurableConsultationMcpService;
  developers: DeveloperTeamRegistry;
  authorization: string | undefined;
  rooms: ConsultationRoomAuthorizer;
  requestState: RequestStateCodec<ConsultationRequestState>;
}) {
  const { server, service, developers, authorization, rooms, requestState } = options;
  const startTool = server.registerTool(CONSULTATION_TOOL_NAMES[0], {
    title: "Start room consultation", description: "Start durable room consultation work and promptly return its ID for polling.", inputSchema: startInputSchema, outputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    _meta: { "io.modelcontextprotocol/tasks": { taskSupport: "optional" } },
  }, async (input, ctx) => invoke("CONSULTATION_WRITE", input.room_id, "consult", developers, authorization, rooms, async (developer) => service.start(input, developer), ctx));
  // The SDK's neutral registry retains 2025 MCP Tasks metadata while the 2026
  // wire projects the negotiated extension through _meta instead.
  startTool.execution = { taskSupport: "optional" };

  server.registerTool(CONSULTATION_TOOL_NAMES[1], {
    title: "Get room consultation", description: "Poll one durable consultation for bounded revision deltas, a blocking question, or its final artifact.", inputSchema: getInputSchema, outputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input, ctx) => invoke("CONSULTATION_READ", input.room_id, "read", developers, authorization, rooms, async () => service.get(input), ctx));

  server.registerTool(CONSULTATION_TOOL_NAMES[2], {
    title: "Respond to room consultation", description: "Resume an input-blocked consultation at an exact revision. Modern clients may omit response to negotiate signed multi-round-trip form input.", inputSchema: respondInputSchema, outputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input, ctx) => {
    const developer = developers.authenticate(authorization, "CONSULTATION_WRITE");
    if (!developer) return errorResult("FORBIDDEN", "This identity cannot create or respond to consultations.");
    if (!rooms.authorizeRoom(input.room_id, developer, "consult")) return roomNotFound();
    if (!input.response) {
      if (!supportsFormInput(ctx)) return errorResult("RESPONSE_REQUIRED", "Pass response explicitly; this client did not negotiate multi-round-trip form input.");
      const echoed = ctx.mcpReq.requestState<ConsultationRequestState>();
      const expected = { kind: "consultation-response" as const, roomId: input.room_id, consultationId: input.consultation_id, expectedRevision: input.expected_revision, idempotencyKey: input.idempotency_key, actorId: developer.member.memberId };
      if (echoed && JSON.stringify(echoed) !== JSON.stringify(expected)) return errorResult("REQUEST_STATE_CONFLICT", "The response state does not match this consultation request.");
      const response = acceptedContent(ctx.mcpReq.inputResponses, "consultation_response", responseForm);
      if (response) return present(await service.respond({ ...input, response: response.response }, developer), ctx);
      return inputRequired({
        inputRequests: { consultation_response: inputRequired.elicit({ message: "Answer the consultation's current blocking question.", requestedSchema: responseForm }) },
        requestState: await requestState.mint(expected, ctx),
      });
    }
    return present(await service.respond(input, developer), ctx);
  });

  server.registerTool(CONSULTATION_TOOL_NAMES[3], {
    title: "Cancel room consultation", description: "Cancel a non-terminal consultation at an exact revision with a durable idempotency key.", inputSchema: cancelInputSchema, outputSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async (input, ctx) => invoke("CONSULTATION_CANCEL", input.room_id, "cancel", developers, authorization, rooms, async (developer) => service.cancel(input, developer), ctx));
}

export function consultationRequestStateCodec(developers: DeveloperTeamRegistry) {
  const key = createHash("sha256").update("amfaa-consultation-request-state-v1\0").update(developers.revisions.map(({ tokenHash }) => tokenHash).sort().join("\0")).digest();
  return createRequestStateCodec<ConsultationRequestState>({
    key,
    ttlSeconds: 600,
    bind: (ctx) => `${ctx.mcpReq.method}\0${digest(ctx.http?.req?.headers.get("authorization") ?? "")}`,
  });
}

async function invoke(
  capability: "CONSULTATION_READ" | "CONSULTATION_WRITE" | "CONSULTATION_CANCEL",
  roomId: string,
  roomCapability: "read" | "consult" | "cancel",
  developers: DeveloperTeamRegistry,
  authorization: string | undefined,
  rooms: ConsultationRoomAuthorizer,
  operation: (developer: AuthenticatedDeveloper) => Promise<ConsultationMcpResult>,
  ctx: ServerContext,
) {
  const developer = developers.authenticate(authorization, capability);
  if (!developer) return errorResult("FORBIDDEN", "This identity does not have the required consultation scope.");
  if (!rooms.authorizeRoom(roomId, developer, roomCapability)) return roomNotFound();
  return present(await operation(developer), ctx);
}

function present(result: ConsultationMcpResult, ctx: ServerContext) {
  if (result.kind === "not_found") return roomNotFound();
  if (result.kind === "idempotency_conflict") return errorResult("IDEMPOTENCY_CONFLICT", "That idempotency key was already used for a different request.");
  if (result.kind === "stale_revision") return errorResult("STALE_REVISION", `Refresh the consultation; its current revision is ${result.actualRevision}.`);
  if (result.kind === "invalid_state") return errorResult("INVALID_STATE", result.reason);
  const events = result.events ?? [];
  const limit = Math.min(events.length, 50);
  const visible = events.slice(0, limit);
  const enhanced = supportsTasks(ctx);
  const value = {
    room_id: result.consultation.roomId,
    consultation_id: result.consultation.consultationId,
    state: result.consultation.state,
    revision: result.consultation.revision,
    progress: {
      events: visible.map(projectEvent),
      truncated: events.length > limit,
      next_revision: visible.at(-1)?.revision ?? result.consultation.revision,
    },
    blocking_question: result.consultation.execution?.blockingQuestion ?? null,
    final_artifact: result.consultation.finalArtifact,
    transport: { mode: enhanced ? "mcp_task" : "polling", task_id: enhanced ? result.consultation.consultationId : null },
  };
  return successResult(value);
}

function projectEvent(event: ConsultationEvent) {
  const change = event.change === "create" ? "create" : event.change.kind;
  return { revision: event.revision, at: event.at, actor_id: event.actorId, change, state: event.snapshot.state };
}
function supportsTasks(ctx: ServerContext) {
  const envelope = ctx.mcpReq.envelope as unknown as Record<string, unknown> | undefined;
  const capabilities = envelope?.[CLIENT_CAPABILITIES_META_KEY] as { tasks?: object; extensions?: Record<string, object> } | undefined;
  return Boolean(capabilities?.extensions?.["io.modelcontextprotocol/tasks"] || capabilities?.tasks);
}
function supportsFormInput(ctx: ServerContext) {
  const envelope = ctx.mcpReq.envelope as unknown as Record<string, unknown> | undefined;
  const capabilities = envelope?.[CLIENT_CAPABILITIES_META_KEY] as { elicitation?: { form?: object } } | undefined;
  return Boolean(capabilities?.elicitation?.form);
}
function successResult(value: Record<string, unknown>) { return { content: [{ type: "text" as const, text: JSON.stringify(value) }], structuredContent: value }; }
function errorResult(code: string, message: string) { const value = { error: { code, message } }; return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(value) }], structuredContent: value }; }
function roomNotFound() { return errorResult("ROOM_NOT_FOUND", "That room or consultation is not available. Refresh the room directory."); }
function stableUuid(...parts: string[]) { const hex = digest(parts.join("\0")); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`; }
function mutationId(kind: string, ...parts: string[]) { return `${kind}-${digest(parts.join("\0")).slice(0, 32)}`; }
function digest(value: string) { return createHash("sha256").update(value).digest("hex"); }
function boundedInteger(minimum: number, maximum: number) { return { type: "integer", minimum, maximum }; }
function routeString(description: string) { return { type: "string", minLength: 1, maxLength: 256, description, "x-mcp-header": "room-id" }; }
function consultationIdSchema() { return { type: "string", minLength: 1, maxLength: 256, "x-mcp-header": "consultation-id" }; }
function idempotencySchema() { return { type: "string", minLength: 1, maxLength: 128, pattern: IDEMPOTENCY_PATTERN, "x-mcp-header": "idempotency-key" }; }
function jsonValueSchema(): Record<string, unknown> { return { anyOf: [{ type: "null" }, { type: "boolean" }, { type: "number" }, { type: "string" }, { type: "array", items: {} }, { type: "object" }] }; }
