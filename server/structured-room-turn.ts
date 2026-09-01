import { z } from "zod";
import { stripUnsupportedEmoji } from "../shared/aim-smileys.js";
import { AIM_5_COLOR_PALETTE, CHAT_FONT_FAMILIES, sanitizeChatStyle, type ChatStyle } from "../shared/chat-style.js";
import { stripAgentSelfLabel, YIELD_REASONS } from "../shared/message-format.js";
import { AGENT_IDS, AGENT_PROFILES, type AgentId } from "../shared/participants.js";
import type { InvestigationRequest, ParsedAgentTurn } from "./conversation.js";

const MAX_STRUCTURED_MESSAGE_CHARACTERS = 12_000;
const CONTINUATION_CUE = /\?|\b(?:actually|but|counterpoint|curious|disagree|however|not sure|on the other hand)\b/i;

const styleSchema = z.object({
  fontFamily: z.enum(CHAT_FONT_FAMILIES),
  fontSize: z.number().int().min(12).max(28),
  textColor: z.string().refine((value) => AIM_5_COLOR_PALETTE.includes(value as (typeof AIM_5_COLOR_PALETTE)[number])),
  backgroundColor: z.string().refine((value) => AIM_5_COLOR_PALETTE.includes(value as (typeof AIM_5_COLOR_PALETTE)[number])),
  bold: z.boolean(),
  italic: z.boolean(),
  underline: z.boolean(),
}).strict();

const evidenceReferenceSchema = z.object({
  kind: z.enum(["project_artifact", "observability"]),
  ref: z.string().trim().min(1).max(1_000),
  label: z.string().trim().min(1).max(500).optional(),
}).strict();

const investigationRequestSchema = z.object({
  objective: z.string().trim().min(1).max(4_000),
  trigger: z.string().trim().min(1).max(1_000),
  evidenceRefs: z.array(evidenceReferenceSchema).max(16),
}).strict();

export const structuredRoomTurnOutput = z.discriminatedUnion("action", [
  z.object({
    schemaVersion: z.literal(1),
    action: z.literal("yield"),
    reason: z.enum(YIELD_REASONS),
  }).strict(),
  z.object({
    schemaVersion: z.literal(1),
    action: z.literal("speak"),
    messages: z.array(z.string().trim().min(1).max(MAX_STRUCTURED_MESSAGE_CHARACTERS)).min(1).max(3),
    conversationState: z.enum(["settled", "open", "blocked"]),
    style: styleSchema.optional(),
    investigationRequest: investigationRequestSchema.optional(),
  }).strict(),
]);

export type StructuredRoomTurnOutput = z.infer<typeof structuredRoomTurnOutput>;

const structuredRoomTurnWireOutput = z.object({
  schemaVersion: z.literal(1),
  action: z.enum(["yield", "speak"]),
  reason: z.enum(YIELD_REASONS).nullable(),
  messages: z.array(z.string().trim().min(1).max(MAX_STRUCTURED_MESSAGE_CHARACTERS)).max(3),
  conversationState: z.enum(["settled", "open", "blocked"]).nullable(),
  style: styleSchema.optional(),
  investigationRequest: investigationRequestSchema.optional(),
}).strict();

const styleProperties = {
  fontFamily: { type: "string", enum: [...CHAT_FONT_FAMILIES] },
  fontSize: { type: "integer", minimum: 12, maximum: 28 },
  textColor: { type: "string", enum: [...AIM_5_COLOR_PALETTE] },
  backgroundColor: { type: "string", enum: [...AIM_5_COLOR_PALETTE] },
  bold: { type: "boolean" },
  italic: { type: "boolean" },
  underline: { type: "boolean" },
} as const;

export const STRUCTURED_ROOM_TURN_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "action", "reason", "messages", "conversationState"],
  properties: {
    schemaVersion: { type: "integer", enum: [1] },
    action: { type: "string", enum: ["yield", "speak"] },
    reason: { type: ["string", "null"], enum: [...YIELD_REASONS, null], description: "Use one yield reason for action yield; use null for action speak." },
    messages: { type: "array", minItems: 0, maxItems: 3, items: { type: "string", minLength: 1, maxLength: MAX_STRUCTURED_MESSAGE_CHARACTERS }, description: "Use an empty array for action yield and one to three visible messages for action speak." },
    conversationState: { type: ["string", "null"], enum: ["settled", "open", "blocked", null], description: "Use null for action yield and a conversation state for action speak." },
    style: {
      type: "object",
      additionalProperties: false,
      required: Object.keys(styleProperties),
      properties: styleProperties,
    },
    investigationRequest: {
      type: "object",
      additionalProperties: false,
      required: ["objective", "trigger", "evidenceRefs"],
      properties: {
        objective: { type: "string", minLength: 1, maxLength: 4_000 },
        trigger: { type: "string", minLength: 1, maxLength: 1_000 },
        evidenceRefs: {
          type: "array",
          maxItems: 16,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["kind", "ref"],
            properties: {
              kind: { type: "string", enum: ["project_artifact", "observability"] },
              ref: { type: "string", minLength: 1, maxLength: 1_000 },
              label: { type: "string", minLength: 1, maxLength: 500 },
            },
          },
        },
      },
    },
  },
} as const;

export function validateStructuredRoomTurn(value: unknown): StructuredRoomTurnOutput {
  const result = structuredRoomTurnOutput.safeParse(value);
  if (result.success) return result.data;
  const wire = structuredRoomTurnWireOutput.safeParse(value);
  if (!wire.success) throw new Error("OpenCode returned an invalid structured room turn.");
  if (wire.data.action === "yield") {
    if (!wire.data.reason || wire.data.messages.length || wire.data.conversationState || wire.data.style || wire.data.investigationRequest) throw new Error("OpenCode returned an invalid structured room turn.");
    return { schemaVersion: 1, action: "yield", reason: wire.data.reason };
  }
  if (wire.data.reason || !wire.data.messages.length || !wire.data.conversationState) throw new Error("OpenCode returned an invalid structured room turn.");
  return {
    schemaVersion: 1,
    action: "speak",
    messages: wire.data.messages,
    conversationState: wire.data.conversationState,
    ...(wire.data.style ? { style: wire.data.style } : {}),
    ...(wire.data.investigationRequest ? { investigationRequest: wire.data.investigationRequest } : {}),
  };
}

export function interpretStructuredRoomTurn(
  agent: AgentId,
  value: unknown,
  currentStyle?: ChatStyle,
  visibleMessageLimit = 3,
  roomAgents: readonly AgentId[] = AGENT_IDS,
): ParsedAgentTurn {
  let output: StructuredRoomTurnOutput;
  try {
    output = validateStructuredRoomTurn(value);
  } catch {
    return { visibleMessages: [], replyCandidates: [], mentionedAgents: [], visibleMessageCount: 0, continuationWorthy: false, dispositionMalformed: true };
  }
  if (output.action === "yield") {
    return { visibleMessages: [], replyCandidates: [], mentionedAgents: [], visibleMessageCount: 0, continuationWorthy: false, yieldReason: output.reason };
  }
  const speakerName = AGENT_PROFILES[agent]?.conversationalName;
  const visibleMessages = output.messages
    .map((message) => stripAgentSelfLabel(message, speakerName))
    .map(stripUnsupportedEmoji)
    .filter(Boolean)
    .slice(0, Math.max(0, Math.min(3, visibleMessageLimit)));
  if (!visibleMessages.length) {
    return { visibleMessages: [], replyCandidates: [], mentionedAgents: [], visibleMessageCount: 0, continuationWorthy: false, dispositionMalformed: true };
  }
  const combinedText = visibleMessages.join("\n");
  const otherAgents = roomAgents.filter((candidate) => candidate !== agent);
  const mentionedAgents = otherAgents.filter((candidate) => new RegExp(`\\b${AGENT_PROFILES[candidate].conversationalName}\\b`, "i").test(combinedText));
  return {
    visibleMessages,
    replyCandidates: otherAgents,
    mentionedAgents,
    visibleMessageCount: visibleMessages.length,
    continuationWorthy: mentionedAgents.length > 0 || CONTINUATION_CUE.test(combinedText),
    conversationState: output.conversationState,
    ...(currentStyle && output.style ? { styleUpdate: sanitizeChatStyle(output.style, currentStyle) } : {}),
    ...(output.investigationRequest ? { investigationRequest: output.investigationRequest as InvestigationRequest } : {}),
    disposition: "speak",
  };
}
