import { createHash } from "node:crypto";
import {
  TASK_TERMINAL_INSTRUCTIONS,
  TERMINAL_INSTRUCTION_PROFILES,
  type TerminalInstructionProfile,
} from "../server/conversation.js";
import {
  JEV_GATE_PROFILE_IDS,
  JEV_QUESTION_PROFILE_IDS,
  jevProfileMetadata,
} from "../server/jev-experiment-profiles.js";
import { DEFAULT_ROOM_BASE_PROMPT } from "../server/room-configuration.js";
import { CONVERSATION_OPTIONAL_SEATS, type ConversationEnergy } from "../shared/conversation-energy.js";
import type { ActiveAgentId } from "../shared/participants.js";
import {
  LARGE_STUDY_PROFILES,
  type LargeStudyProfileId,
  largeStudyProfile,
  largeStudyProfileDigest,
} from "./conversation-routing-live-large-fixtures.js";
import {
  buildLiveScenario,
  EVERYDAY_FIXTURE_AGENTS,
  FIXTURE_AGENTS,
  type LiveScenario,
  MODEL_SCENARIO_PROFILES,
  MODEL_SCENARIO_TEXT,
  type ModelScenarioProfileId,
  ROUTING_DYNAMICS,
  ROUTING_ENERGIES,
  type RoutingDynamic,
  SCENARIO_PROFILE_IDS,
  type ScenarioProfileId,
  TERMINAL_SCENARIO_PROFILES,
  TERMINAL_SCENARIO_TEXT,
  type TerminalScenarioProfileId,
} from "./conversation-routing-live-scenarios.js";

export const STUDY_JEV_PROFILES = ["off-v1", ...JEV_QUESTION_PROFILE_IDS] as const;
export const STUDY_GATE_PROFILES = JEV_GATE_PROFILE_IDS;
export const STUDY_AGENT_PROMPT_PROFILES = ["current-v1", "social-v1"] as const;
export const STUDY_ARC_PROFILES = [
  "single-v1",
  "casual-thread-v1",
  "agent-exchange-v1",
  "agent-exchange-v2",
  "handoff-choice-v1",
  "dispute-resolution-v1",
] as const;

export type JevProfileId = (typeof STUDY_JEV_PROFILES)[number];
export type GateProfileId = (typeof STUDY_GATE_PROFILES)[number];
export type AgentPromptProfileId = (typeof STUDY_AGENT_PROMPT_PROFILES)[number];
export type ArcProfileId = (typeof STUDY_ARC_PROFILES)[number];
export type StudyFactor = "jev" | "gate" | "agent-prompt";
export const STUDY_ROOM_SYSTEM_PROFILES = ["legacy-v1", "room-v1"] as const;
export type RoomSystemProfileId = (typeof STUDY_ROOM_SYSTEM_PROFILES)[number];
export const MAX_STUDY_CASES = 144;
export const MAX_STUDY_BLOCKS = MAX_STUDY_CASES / 2;

/** Closed, fixture-only room customization; no caller-supplied instruction text. */
export const STUDY_AGENT_BASE_PROMPTS: Record<AgentPromptProfileId, string> = {
  "current-v1": DEFAULT_ROOM_BASE_PROMPT,
  "social-v1": `${DEFAULT_ROOM_BASE_PROMPT}\n\nFor optional room reactions, keep each contribution brief and distinct. Leave silence when another participant has already covered the useful point.`,
};

export interface StudyArmV1 {
  jevProfileId: JevProfileId;
  gateProfileId: GateProfileId;
  agentPromptProfileId: AgentPromptProfileId;
}

export interface StudyBlockV1 {
  blockId: string;
  replicateId: string;
  dynamic: RoutingDynamic;
  arcProfileId: ArcProfileId;
  rosterOrder: ActiveAgentId[];
  energy: ConversationEnergy;
  arms: { a: StudyArmV1; b: StudyArmV1 };
}

export interface StudyPlanV1 {
  schemaVersion: 1;
  planId: string;
  orderSeed: number;
  maxCases: number;
  blocks: StudyBlockV1[];
}

export interface StudyCaseMetadataV1 extends StudyArmV1 {
  schemaVersion: 1;
  planId: string;
  planSha256: string;
  blockId: string;
  replicateId: string;
  pairId: string;
  caseId: string;
  arm: "a" | "b";
  factor: StudyFactor;
  order: "ab" | "ba";
  arcProfileId: ArcProfileId;
  jevProfileDigest: string;
  gateProfileDigest: string;
  agentPromptProfileDigest: string;
  rosterOrder: ActiveAgentId[];
}

export interface StudyArmV2 extends StudyArmV1 {
  roomSystemProfileId: RoomSystemProfileId;
}

export interface StudyBlockV2 extends Omit<StudyBlockV1, "arms"> {
  scenarioProfileId: "garden-chat-v2" | "everyday-chat-v3";
  arms: { a: StudyArmV2; b: StudyArmV2 };
}

export interface StudyPlanV2 extends Omit<StudyPlanV1, "schemaVersion" | "blocks"> {
  schemaVersion: 2;
  blocks: StudyBlockV2[];
}

export interface StudyArmV3 extends StudyArmV2 {
  terminalInstructionProfileId: TerminalInstructionProfile;
}
export interface StudyBlockV3 extends Omit<StudyBlockV2, "scenarioProfileId" | "arms"> {
  scenarioProfileId: TerminalScenarioProfileId;
  arms: { a: StudyArmV3; b: StudyArmV3 };
}
export interface StudyPlanV3 extends Omit<StudyPlanV2, "schemaVersion" | "blocks"> {
  schemaVersion: 3;
  blocks: StudyBlockV3[];
}
export const STUDY_ACTOR_MODELS = [
  "openrouter/anthropic/claude-haiku-4.5",
  "openrouter/anthropic/claude-sonnet-4.6",
] as const;
export type StudyActorModelId = (typeof STUDY_ACTOR_MODELS)[number];
export interface StudyArmV4 extends StudyArmV3 {
  actorModelId: StudyActorModelId;
}
export interface StudyBlockV4 extends Omit<StudyBlockV3, "scenarioProfileId" | "arms"> {
  scenarioProfileId: ModelScenarioProfileId;
  arms: { a: StudyArmV4; b: StudyArmV4 };
}
export interface StudyPlanV4 extends Omit<StudyPlanV3, "schemaVersion" | "blocks"> {
  schemaVersion: 4;
  blocks: StudyBlockV4[];
}

export interface StudyArmV5 extends StudyArmV3 {}
export interface StudyBlockV5 extends Omit<StudyBlockV3, "scenarioProfileId" | "arms"> {
  scenarioProfileId: LargeStudyProfileId;
  arms: { a: StudyArmV5; b: StudyArmV5 };
}
export interface StudyPlanV5 extends Omit<StudyPlanV3, "schemaVersion" | "blocks"> {
  schemaVersion: 5;
  blocks: StudyBlockV5[];
}
export type StudyPlan = StudyPlanV1 | StudyPlanV2 | StudyPlanV3 | StudyPlanV4 | StudyPlanV5;

export interface StudyCaseMetadataV2 extends Omit<StudyCaseMetadataV1, "schemaVersion" | "factor"> {
  schemaVersion: 2;
  factor: "room-system";
  scenarioProfileId: "garden-chat-v2" | "everyday-chat-v3";
  scenarioProfileDigest: string;
  roomSystemProfileId: RoomSystemProfileId;
  roomSystemProfileDigest: string;
}

export interface StudyCaseMetadataV3
  extends Omit<StudyCaseMetadataV2, "schemaVersion" | "factor" | "scenarioProfileId"> {
  schemaVersion: 3;
  factor: "terminal-instruction";
  scenarioProfileId: TerminalScenarioProfileId;
  terminalInstructionProfileId: TerminalInstructionProfile;
  terminalInstructionProfileDigest: string;
  terminalInstructionCharacters: number;
}
export interface StudyCaseMetadataV4
  extends Omit<StudyCaseMetadataV3, "schemaVersion" | "factor" | "scenarioProfileId"> {
  schemaVersion: 4;
  factor: "actor-model";
  scenarioProfileId: ModelScenarioProfileId;
  actorModelId: StudyActorModelId;
}
export interface StudyCaseMetadataV5
  extends Omit<StudyCaseMetadataV3, "schemaVersion" | "factor" | "scenarioProfileId"> {
  schemaVersion: 5;
  factor: StudyFactor;
  scenarioProfileId: LargeStudyProfileId;
  theme: "everyday" | "practical";
}
export type StudyCaseMetadata =
  | StudyCaseMetadataV1
  | StudyCaseMetadataV2
  | StudyCaseMetadataV3
  | StudyCaseMetadataV4
  | StudyCaseMetadataV5;

// IDs are deliberately short because trigger scenario IDs include all three components.
const SAFE_ID = /^[a-z][a-z0-9-]{0,11}$/;
const SHA = /^[a-f0-9]{64}$/;
const AGENT_IDS: readonly string[] = FIXTURE_AGENTS.map(({ agentId }) => agentId);

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid closed study plan.");
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== keys.length || Object.keys(row).some((key) => !keys.includes(key)))
    throw new Error("Invalid closed study plan.");
  return row;
}

function profileArm(value: unknown): StudyArmV1 {
  const row = object(value, ["jevProfileId", "gateProfileId", "agentPromptProfileId"]);
  if (
    !STUDY_JEV_PROFILES.includes(row.jevProfileId as JevProfileId) ||
    !STUDY_GATE_PROFILES.includes(row.gateProfileId as GateProfileId) ||
    !STUDY_AGENT_PROMPT_PROFILES.includes(row.agentPromptProfileId as AgentPromptProfileId) ||
    (row.gateProfileId === "relevance-v1" && row.jevProfileId !== "relevance-v1")
  )
    throw new Error("Invalid closed study plan.");
  return row as unknown as StudyArmV1;
}

function factorOf(a: StudyArmV1, b: StudyArmV1): StudyFactor {
  const changed = [
    a.jevProfileId !== b.jevProfileId ? "jev" : null,
    a.gateProfileId !== b.gateProfileId ? "gate" : null,
    a.agentPromptProfileId !== b.agentPromptProfileId ? "agent-prompt" : null,
  ].filter((value): value is StudyFactor => value !== null);
  if (changed.length !== 1) throw new Error("Study arms must differ in exactly one profile factor.");
  return changed[0]!;
}

/** Parse caller data before any credential/runtime access; reject arbitrary text and unknown keys. */
export function parseStudyPlan(input: unknown): StudyPlan {
  const top = object(input, ["schemaVersion", "planId", "orderSeed", "maxCases", "blocks"]);
  if (
    (top.schemaVersion !== 1 &&
      top.schemaVersion !== 2 &&
      top.schemaVersion !== 3 &&
      top.schemaVersion !== 4 &&
      top.schemaVersion !== 5) ||
    typeof top.planId !== "string" ||
    !SAFE_ID.test(top.planId) ||
    !Number.isSafeInteger(top.orderSeed) ||
    Number(top.orderSeed) < 0 ||
    Number(top.orderSeed) > 0xffffffff ||
    !Number.isSafeInteger(top.maxCases) ||
    Number(top.maxCases) < 2 ||
    Number(top.maxCases) > MAX_STUDY_CASES ||
    !Array.isArray(top.blocks) ||
    top.blocks.length < 1 ||
    top.blocks.length > MAX_STUDY_BLOCKS ||
    top.blocks.length * 2 > Number(top.maxCases)
  )
    throw new Error("Invalid closed study plan.");
  const blocks = top.blocks.map((value) => {
    const row = object(value, [
      "blockId",
      "replicateId",
      "dynamic",
      "arcProfileId",
      "rosterOrder",
      "energy",
      "arms",
      ...(top.schemaVersion !== 1 ? ["scenarioProfileId"] : []),
    ]);
    if (
      typeof row.blockId !== "string" ||
      !SAFE_ID.test(row.blockId) ||
      typeof row.replicateId !== "string" ||
      !SAFE_ID.test(row.replicateId) ||
      !ROUTING_DYNAMICS.includes(row.dynamic as RoutingDynamic) ||
      !STUDY_ARC_PROFILES.includes(row.arcProfileId as ArcProfileId) ||
      !ROUTING_ENERGIES.includes(row.energy as ConversationEnergy) ||
      !Array.isArray(row.rosterOrder) ||
      row.rosterOrder.length < 1 ||
      row.rosterOrder.length > (top.schemaVersion === 5 ? 3 : 4) ||
      new Set(row.rosterOrder).size !== row.rosterOrder.length ||
      row.rosterOrder.some((agent) => !AGENT_IDS.includes(agent as ActiveAgentId))
    )
      throw new Error("Invalid closed study plan.");
    if (
      top.schemaVersion === 2 &&
      row.scenarioProfileId !== "garden-chat-v2" &&
      row.scenarioProfileId !== "everyday-chat-v3"
    )
      throw new Error("Invalid closed study scenario profile.");
    if (
      top.schemaVersion === 3 &&
      !TERMINAL_SCENARIO_PROFILES.includes(row.scenarioProfileId as TerminalScenarioProfileId)
    )
      throw new Error("Invalid closed terminal scenario profile.");
    if (top.schemaVersion === 5 && !Object.hasOwn(LARGE_STUDY_PROFILES, row.scenarioProfileId as string))
      throw new Error("Invalid closed large-study scenario profile.");
    if (top.schemaVersion === 4 && !MODEL_SCENARIO_PROFILES.includes(row.scenarioProfileId as ModelScenarioProfileId))
      throw new Error("Invalid closed model scenario profile.");
    const rosterOrder = row.rosterOrder as ActiveAgentId[];
    const expected = AGENT_IDS.slice(0, rosterOrder.length);
    if (expected.some((agent) => !rosterOrder.includes(agent))) throw new Error("Invalid closed study plan.");
    if (["multi-address", "disagreement"].includes(row.dynamic as string) && row.rosterOrder.length < 2)
      throw new Error("Invalid closed study plan.");
    if (
      (top.schemaVersion === 3 || top.schemaVersion === 4) &&
      (row.dynamic !== "direct" ||
        row.arcProfileId !== "single-v1" ||
        row.rosterOrder.length !== 1 ||
        row.rosterOrder[0] !== "codex-sol" ||
        row.energy !== "low")
    )
      throw new Error("Terminal instruction study requires one fixed direct turn.");
    if (
      (row.arcProfileId === "casual-thread-v1" && row.dynamic !== "casual") ||
      ((row.arcProfileId === "agent-exchange-v1" || row.arcProfileId === "agent-exchange-v2") &&
        row.dynamic !== "multi-address") ||
      (row.arcProfileId === "handoff-choice-v1" && row.dynamic !== "handoff") ||
      (row.arcProfileId === "dispute-resolution-v1" && (row.dynamic !== "disagreement" || row.rosterOrder.length < 3))
    )
      throw new Error("Invalid closed study plan.");
    const arms = object(row.arms, ["a", "b"]);
    if (top.schemaVersion === 5) {
      const a = profileArmV3(arms.a),
        b = profileArmV3(arms.b);
      const factor = factorOf(a, b);
      const profile = largeStudyProfile(row.scenarioProfileId as string);
      const expectedSuffix = { jev: "j", gate: "g", "agent-prompt": "p" }[factor];
      const expectedArcAndMessages: Record<RoutingDynamic, readonly [ArcProfileId, number]> = {
        direct: ["single-v1", 1],
        broadcast: ["single-v1", 1],
        "quoted-name": ["single-v1", 1],
        casual: ["casual-thread-v1", 2],
        "multi-address": ["agent-exchange-v2", 2],
        handoff: ["handoff-choice-v1", 3],
        disagreement: ["dispute-resolution-v1", 3],
      };
      const [expectedArc, expectedMessages] = expectedArcAndMessages[profile.dynamic];
      if (
        !profile.id.endsWith(`-${expectedSuffix}`) ||
        profile.dynamic !== row.dynamic ||
        row.arcProfileId !== expectedArc ||
        profile.messages.length !== expectedMessages ||
        a.roomSystemProfileId !== "room-v1" ||
        b.roomSystemProfileId !== "room-v1" ||
        a.terminalInstructionProfileId !== "contribution-first-v1" ||
        b.terminalInstructionProfileId !== "contribution-first-v1" ||
        (factor === "jev" &&
          (a.jevProfileId !== "current-v1" ||
            b.jevProfileId !== "lean-v1" ||
            a.gateProfileId !== "current-v1" ||
            b.gateProfileId !== "current-v1")) ||
        (factor === "gate" &&
          (a.jevProfileId !== "relevance-v1" ||
            b.jevProfileId !== "relevance-v1" ||
            a.gateProfileId !== "current-v1" ||
            b.gateProfileId !== "relevance-v1" ||
            row.rosterOrder.length < 2 ||
            !profile.messages.some((message) => message.expectedDirectAgents.length < rosterOrder.length))) ||
        (factor === "agent-prompt" &&
          (a.jevProfileId !== "current-v1" ||
            b.jevProfileId !== "current-v1" ||
            a.gateProfileId !== "current-v1" ||
            b.gateProfileId !== "current-v1" ||
            a.agentPromptProfileId !== "current-v1" ||
            b.agentPromptProfileId !== "social-v1"))
      )
        throw new Error("Large study arms or scenario are outside the closed matrix.");
      if (
        (factor === "gate" || factor === "agent-prompt") &&
        profile.dynamic !== "broadcast" &&
        (CONVERSATION_OPTIONAL_SEATS[row.energy as ConversationEnergy] === 0 ||
          rosterOrder.length < 2 ||
          !profile.messages.some((message) => message.expectedDirectAgents.length < rosterOrder.length))
      )
        throw new Error("Non-broadcast treatment requires an optional-capable seat.");
      for (const item of profile.messages) {
        if (item.expectedDirectAgents.some((agent) => !rosterOrder.includes(agent)))
          throw new Error("Addressed agent is absent from large-study roster.");
      }
    } else if (top.schemaVersion === 4) {
      const a = profileArmV4(arms.a),
        b = profileArmV4(arms.b);
      if (
        a.actorModelId !== STUDY_ACTOR_MODELS[0] ||
        b.actorModelId !== STUDY_ACTOR_MODELS[1] ||
        a.terminalInstructionProfileId !== "contribution-first-v1" ||
        b.terminalInstructionProfileId !== "contribution-first-v1" ||
        a.roomSystemProfileId !== "room-v1" ||
        b.roomSystemProfileId !== "room-v1" ||
        a.jevProfileId !== "current-v1" ||
        b.jevProfileId !== "current-v1" ||
        a.gateProfileId !== "current-v1" ||
        b.gateProfileId !== "current-v1" ||
        a.agentPromptProfileId !== "current-v1" ||
        b.agentPromptProfileId !== "current-v1"
      )
        throw new Error("Model study arms must differ only in the pinned actor model.");
    } else if (top.schemaVersion === 3) {
      const a = profileArmV3(arms.a),
        b = profileArmV3(arms.b);
      if (
        a.terminalInstructionProfileId !== "current-v1" ||
        b.terminalInstructionProfileId !== "contribution-first-v1" ||
        a.roomSystemProfileId !== "room-v1" ||
        b.roomSystemProfileId !== "room-v1" ||
        a.jevProfileId !== b.jevProfileId ||
        a.gateProfileId !== b.gateProfileId ||
        a.agentPromptProfileId !== b.agentPromptProfileId
      )
        throw new Error("Terminal instruction arms must differ only in terminal instruction profile.");
    } else if (top.schemaVersion === 2) {
      const a = profileArmV2(arms.a),
        b = profileArmV2(arms.b);
      if (
        a.roomSystemProfileId !== "legacy-v1" ||
        b.roomSystemProfileId !== "room-v1" ||
        a.jevProfileId !== b.jevProfileId ||
        a.gateProfileId !== b.gateProfileId ||
        a.agentPromptProfileId !== b.agentPromptProfileId
      )
        throw new Error("Identity study arms must differ only in room system profile.");
    } else factorOf(profileArm(arms.a), profileArm(arms.b));
    const a =
      top.schemaVersion === 5
        ? profileArmV3(arms.a)
        : top.schemaVersion === 4
          ? profileArmV4(arms.a)
          : top.schemaVersion === 3
            ? profileArmV3(arms.a)
            : top.schemaVersion === 2
              ? profileArmV2(arms.a)
              : profileArm(arms.a);
    const b =
      top.schemaVersion === 5
        ? profileArmV3(arms.b)
        : top.schemaVersion === 4
          ? profileArmV4(arms.b)
          : top.schemaVersion === 3
            ? profileArmV3(arms.b)
            : top.schemaVersion === 2
              ? profileArmV2(arms.b)
              : profileArm(arms.b);
    return {
      blockId: row.blockId,
      replicateId: row.replicateId,
      dynamic: row.dynamic,
      arcProfileId: row.arcProfileId,
      rosterOrder,
      energy: row.energy,
      arms: { a, b },
      ...(top.schemaVersion !== 1
        ? {
            scenarioProfileId: row.scenarioProfileId as
              | StudyBlockV2["scenarioProfileId"]
              | TerminalScenarioProfileId
              | ModelScenarioProfileId
              | LargeStudyProfileId,
          }
        : {}),
    };
  });
  if (new Set(blocks.map(({ blockId, replicateId }) => `${blockId}\0${replicateId}`)).size !== blocks.length)
    throw new Error("Duplicate study block and replicate.");
  if (top.schemaVersion === 5) {
    const factors = blocks.map((block) => factorOf(block.arms.a, block.arms.b));
    const ids = blocks.map((block) => block.scenarioProfileId);
    if (
      top.maxCases !== 72 ||
      blocks.length !== 36 ||
      new Set(ids).size !== 36 ||
      (["jev", "gate", "agent-prompt"] as const).some((factor) => {
        const subset = blocks.filter((block, index) => factors[index] === factor);
        return (
          subset.length !== 12 ||
          subset.filter((block) => largeStudyProfile(block.scenarioProfileId as string).theme === "everyday").length !==
            6 ||
          ((factor === "gate" || factor === "agent-prompt") &&
            subset.filter((block) => largeStudyProfile(block.scenarioProfileId as string).dynamic === "broadcast")
              .length !== 2)
        );
      })
    )
      throw new Error("Large study requires all 36 distinct, theme-balanced pairs.");
  }
  if (
    top.schemaVersion === 3 &&
    (top.maxCases !== 6 ||
      blocks.length !== 3 ||
      new Set(blocks.map(({ scenarioProfileId }) => scenarioProfileId)).size !== 3)
  )
    throw new Error("Terminal instruction study requires all three independent domains.");
  if (
    top.schemaVersion === 4 &&
    (top.maxCases !== 6 ||
      blocks.length !== 3 ||
      new Set(blocks.map(({ scenarioProfileId }) => scenarioProfileId)).size !== 3)
  )
    throw new Error("Model study requires one known regression and two independent holdouts.");
  return top.schemaVersion === 5
    ? ({
        schemaVersion: 5,
        planId: top.planId,
        orderSeed: Number(top.orderSeed),
        maxCases: Number(top.maxCases),
        blocks,
      } as StudyPlanV5)
    : top.schemaVersion === 4
      ? ({
          schemaVersion: 4,
          planId: top.planId,
          orderSeed: Number(top.orderSeed),
          maxCases: Number(top.maxCases),
          blocks,
        } as StudyPlanV4)
      : top.schemaVersion === 3
        ? ({
            schemaVersion: 3,
            planId: top.planId,
            orderSeed: Number(top.orderSeed),
            maxCases: Number(top.maxCases),
            blocks,
          } as StudyPlanV3)
        : top.schemaVersion === 2
          ? ({
              schemaVersion: 2,
              planId: top.planId,
              orderSeed: Number(top.orderSeed),
              maxCases: Number(top.maxCases),
              blocks,
            } as StudyPlanV2)
          : ({
              schemaVersion: 1,
              planId: top.planId,
              orderSeed: Number(top.orderSeed),
              maxCases: Number(top.maxCases),
              blocks,
            } as StudyPlanV1);
}

function profileArmV4(value: unknown): StudyArmV4 {
  const row = object(value, [
    "jevProfileId",
    "gateProfileId",
    "agentPromptProfileId",
    "roomSystemProfileId",
    "terminalInstructionProfileId",
    "actorModelId",
  ]);
  const arm = profileArmV3({
    jevProfileId: row.jevProfileId,
    gateProfileId: row.gateProfileId,
    agentPromptProfileId: row.agentPromptProfileId,
    roomSystemProfileId: row.roomSystemProfileId,
    terminalInstructionProfileId: row.terminalInstructionProfileId,
  });
  if (!STUDY_ACTOR_MODELS.includes(row.actorModelId as StudyActorModelId))
    throw new Error("Invalid closed actor model profile.");
  return { ...arm, actorModelId: row.actorModelId as StudyActorModelId };
}

function profileArmV3(value: unknown): StudyArmV3 {
  const row = object(value, [
    "jevProfileId",
    "gateProfileId",
    "agentPromptProfileId",
    "roomSystemProfileId",
    "terminalInstructionProfileId",
  ]);
  const arm = profileArmV2({
    jevProfileId: row.jevProfileId,
    gateProfileId: row.gateProfileId,
    agentPromptProfileId: row.agentPromptProfileId,
    roomSystemProfileId: row.roomSystemProfileId,
  });
  if (!TERMINAL_INSTRUCTION_PROFILES.includes(row.terminalInstructionProfileId as TerminalInstructionProfile))
    throw new Error("Invalid closed terminal instruction profile.");
  return { ...arm, terminalInstructionProfileId: row.terminalInstructionProfileId as TerminalInstructionProfile };
}

function profileArmV2(value: unknown): StudyArmV2 {
  const row = object(value, ["jevProfileId", "gateProfileId", "agentPromptProfileId", "roomSystemProfileId"]);
  const arm = profileArm({
    jevProfileId: row.jevProfileId,
    gateProfileId: row.gateProfileId,
    agentPromptProfileId: row.agentPromptProfileId,
  });
  if (!STUDY_ROOM_SYSTEM_PROFILES.includes(row.roomSystemProfileId as RoomSystemProfileId))
    throw new Error("Invalid closed room system profile.");
  return { ...arm, roomSystemProfileId: row.roomSystemProfileId as RoomSystemProfileId };
}

export function studyPlanDigest(plan: StudyPlan): string {
  return createHash("sha256").update(JSON.stringify(plan)).digest("hex");
}

function nextRandom(seed: number) {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let mixed = Math.imul(value ^ (value >>> 15), value | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 0x100000000;
  };
}

/** The seed randomizes only block order and AB/BA order, never the product or model. */
export function expandStudyPlan(plan: StudyPlan): LiveScenario[] {
  if (plan.schemaVersion === 5) return expandLargeStudyPlan(plan);
  if (plan.schemaVersion === 4) return expandModelStudyPlan(plan);
  if (plan.schemaVersion === 3) return expandTerminalStudyPlan(plan);
  if (plan.schemaVersion === 2) return expandIdentityStudyPlan(plan);
  const digest = studyPlanDigest(plan);
  if (!SHA.test(digest)) throw new Error("Invalid study digest.");
  const random = nextRandom(plan.orderSeed);
  const blocks = [...plan.blocks];
  for (let index = blocks.length - 1; index > 0; index--) {
    const selected = Math.floor(random() * (index + 1));
    [blocks[index], blocks[selected]] = [blocks[selected]!, blocks[index]!];
  }
  const firstOrder: Record<StudyFactor, "ab" | "ba"> = {
    jev: random() < 0.5 ? "ab" : "ba",
    gate: random() < 0.5 ? "ab" : "ba",
    "agent-prompt": random() < 0.5 ? "ab" : "ba",
  };
  const factorCounts: Record<StudyFactor, number> = { jev: 0, gate: 0, "agent-prompt": 0 };
  return blocks.flatMap((block) => {
    const factor = factorOf(block.arms.a, block.arms.b);
    const factorIndex = factorCounts[factor]++;
    const order: "ab" | "ba" = factorIndex % 2 === 0 ? firstOrder[factor] : firstOrder[factor] === "ab" ? "ba" : "ab";
    return [...order].map((arm) => {
      const selected = block.arms[arm as "a" | "b"];
      const base = buildLiveScenario({
        dynamic: block.dynamic,
        agentCount: block.rosterOrder.length as LiveScenario["agentCount"],
        energy: block.energy,
        preflightMode: "enforce",
        classifierEnabled: selected.jevProfileId !== "off-v1",
      });
      const { followup: _legacyFollowup, ...baseWithoutFollowup } = base;
      const suffix = `-${plan.planId}-${block.blockId}-${block.replicateId}-${arm}`;
      const pairId = `${plan.planId}-${block.blockId}-${block.replicateId}`;
      const caseId = `${pairId}-${arm}`;
      const scriptedFollowups = buildStudyFollowups(block.arcProfileId, suffix);
      const study: StudyCaseMetadataV1 = {
        schemaVersion: 1,
        planId: plan.planId,
        planSha256: digest,
        blockId: block.blockId,
        replicateId: block.replicateId,
        pairId,
        caseId,
        arm: arm as "a" | "b",
        factor,
        order,
        arcProfileId: block.arcProfileId,
        ...selected,
        jevProfileDigest:
          selected.jevProfileId === "off-v1"
            ? createHash("sha256").update("off-v1").digest("hex")
            : jevProfileMetadata(selected.jevProfileId, selected.gateProfileId).jevProfileDigest,
        gateProfileDigest: jevProfileMetadata(
          selected.jevProfileId === "off-v1" ? "current-v1" : selected.jevProfileId,
          selected.gateProfileId,
        ).gateProfileDigest,
        agentPromptProfileDigest: createHash("sha256")
          .update(STUDY_AGENT_BASE_PROMPTS[selected.agentPromptProfileId])
          .digest("hex"),
        rosterOrder: [...block.rosterOrder],
      };
      return {
        ...baseWithoutFollowup,
        scenarioId: `${base.scenarioId}${suffix}`,
        ...(scriptedFollowups.length ? { scriptedFollowups } : {}),
        rosterOrder: [...block.rosterOrder],
        study,
      };
    });
  });
}

function expandLargeStudyPlan(plan: StudyPlanV5): LiveScenario[] {
  const digest = studyPlanDigest(plan);
  const random = nextRandom(plan.orderSeed);
  const blocks = [...plan.blocks];
  for (let index = blocks.length - 1; index > 0; index--) {
    const selected = Math.floor(random() * (index + 1));
    [blocks[index], blocks[selected]] = [blocks[selected]!, blocks[index]!];
  }
  const strata = (["jev", "gate", "agent-prompt"] as const).flatMap((factor) =>
    (["everyday", "practical"] as const).map((theme) => `${factor}:${theme}` as const),
  );
  const firstOrder = Object.fromEntries(strata.map((key) => [key, random() < 0.5 ? "ab" : "ba"])) as Record<
    (typeof strata)[number],
    "ab" | "ba"
  >;
  const counts = Object.fromEntries(strata.map((key) => [key, 0])) as Record<(typeof strata)[number], number>;
  return blocks.flatMap((block) => {
    const profile = largeStudyProfile(block.scenarioProfileId);
    const factor = factorOf(block.arms.a, block.arms.b);
    const stratum = `${factor}:${profile.theme}` as (typeof strata)[number];
    const index = counts[stratum]++;
    const order = index % 2 === 0 ? firstOrder[stratum] : firstOrder[stratum] === "ab" ? "ba" : "ab";
    const pairId = `${plan.planId}-${block.blockId}-${block.replicateId}`;
    return [...order].map((arm) => {
      const selected = block.arms[arm as "a" | "b"];
      const jev = jevProfileMetadata(
        selected.jevProfileId as "current-v1" | "lean-v1" | "relevance-v1",
        selected.gateProfileId,
      );
      const study: StudyCaseMetadataV5 = {
        schemaVersion: 5,
        planId: plan.planId,
        planSha256: digest,
        blockId: block.blockId,
        replicateId: block.replicateId,
        pairId,
        caseId: `${pairId}-${arm}`,
        arm: arm as "a" | "b",
        factor,
        order,
        arcProfileId: block.arcProfileId,
        ...selected,
        scenarioProfileId: block.scenarioProfileId,
        scenarioProfileDigest: largeStudyProfileDigest(block.scenarioProfileId),
        theme: profile.theme,
        roomSystemProfileDigest: roomSystemProfileDigest("room-v1"),
        terminalInstructionProfileDigest: terminalInstructionProfileDigest("contribution-first-v1"),
        terminalInstructionCharacters: TASK_TERMINAL_INSTRUCTIONS["contribution-first-v1"].length,
        jevProfileDigest: jev.jevProfileDigest,
        gateProfileDigest: jev.gateProfileDigest,
        agentPromptProfileDigest: createHash("sha256")
          .update(STUDY_AGENT_BASE_PROMPTS[selected.agentPromptProfileId])
          .digest("hex"),
        rosterOrder: [...block.rosterOrder],
      };
      const suffix = `-${study.caseId}`;
      return {
        scenarioId: `${block.dynamic}-${block.rosterOrder.length}-${block.energy}-enforce${suffix}`,
        variant: "jev-on" as const,
        dynamic: block.dynamic,
        agentCount: block.rosterOrder.length as LiveScenario["agentCount"],
        energy: block.energy,
        preflightMode: "enforce" as const,
        classifierEnabled: true,
        text: profile.messages[0]!.text,
        expectedDirectAgents: [...profile.messages[0]!.expectedDirectAgents],
        ...(profile.messages.length > 1
          ? {
              scriptedFollowups: profile.messages.slice(1).map((message, messageIndex) => ({
                scenarioId: `followup-${messageIndex + 1}${suffix}`,
                text: message.text,
                expectedDirectAgents: [...message.expectedDirectAgents],
              })),
            }
          : {}),
        rosterOrder: [...block.rosterOrder],
        scenarioProfileId: block.scenarioProfileId,
        study,
      };
    });
  });
}

export function terminalInstructionProfileDigest(id: TerminalInstructionProfile): string {
  if (!TERMINAL_INSTRUCTION_PROFILES.includes(id)) throw new Error("Invalid closed terminal instruction profile.");
  return createHash("sha256").update(TASK_TERMINAL_INSTRUCTIONS[id]).digest("hex");
}

export function terminalScenarioProfileDigest(id: TerminalScenarioProfileId): string {
  if (!TERMINAL_SCENARIO_PROFILES.includes(id)) throw new Error("Invalid closed terminal scenario profile.");
  return createHash("sha256").update(TERMINAL_SCENARIO_TEXT[id]).digest("hex");
}

export function modelScenarioProfileDigest(id: ModelScenarioProfileId): string {
  if (!MODEL_SCENARIO_PROFILES.includes(id)) throw new Error("Invalid closed model scenario profile.");
  return createHash("sha256").update(MODEL_SCENARIO_TEXT[id]).digest("hex");
}

function expandModelStudyPlan(plan: StudyPlanV4): LiveScenario[] {
  const digest = studyPlanDigest(plan);
  const random = nextRandom(plan.orderSeed);
  const blocks = [...plan.blocks];
  for (let index = blocks.length - 1; index > 0; index--) {
    const selected = Math.floor(random() * (index + 1));
    [blocks[index], blocks[selected]] = [blocks[selected]!, blocks[index]!];
  }
  const firstOrder = random() < 0.5 ? "ab" : "ba";
  return blocks.flatMap((block, index) => {
    const order = index % 2 === 0 ? firstOrder : firstOrder === "ab" ? "ba" : "ab";
    return [...order].map((arm) => {
      const selected = block.arms[arm as "a" | "b"];
      const profile = jevProfileMetadata("current-v1", "current-v1");
      const pairId = `${plan.planId}-${block.blockId}-${block.replicateId}`;
      const study: StudyCaseMetadataV4 = {
        schemaVersion: 4,
        planId: plan.planId,
        planSha256: digest,
        blockId: block.blockId,
        replicateId: block.replicateId,
        pairId,
        caseId: `${pairId}-${arm}`,
        arm: arm as "a" | "b",
        factor: "actor-model",
        order,
        arcProfileId: block.arcProfileId,
        ...selected,
        scenarioProfileId: block.scenarioProfileId,
        scenarioProfileDigest: modelScenarioProfileDigest(block.scenarioProfileId),
        roomSystemProfileDigest: roomSystemProfileDigest("room-v1"),
        terminalInstructionProfileDigest: terminalInstructionProfileDigest("contribution-first-v1"),
        terminalInstructionCharacters: TASK_TERMINAL_INSTRUCTIONS["contribution-first-v1"].length,
        jevProfileDigest: profile.jevProfileDigest,
        gateProfileDigest: profile.gateProfileDigest,
        agentPromptProfileDigest: createHash("sha256").update(STUDY_AGENT_BASE_PROMPTS["current-v1"]).digest("hex"),
        rosterOrder: [...block.rosterOrder],
      };
      return {
        scenarioId: `direct-1-low-enforce-${study.caseId}`,
        variant: "jev-on" as const,
        dynamic: "direct" as const,
        agentCount: 1 as const,
        energy: "low" as const,
        preflightMode: "enforce" as const,
        classifierEnabled: true,
        text: MODEL_SCENARIO_TEXT[block.scenarioProfileId],
        expectedDirectAgents: ["codex-sol" as const],
        rosterOrder: [...block.rosterOrder],
        scenarioProfileId: block.scenarioProfileId,
        study,
      };
    });
  });
}

function expandTerminalStudyPlan(plan: StudyPlanV3): LiveScenario[] {
  const digest = studyPlanDigest(plan);
  const random = nextRandom(plan.orderSeed);
  const blocks = [...plan.blocks];
  for (let index = blocks.length - 1; index > 0; index--) {
    const selected = Math.floor(random() * (index + 1));
    [blocks[index], blocks[selected]] = [blocks[selected]!, blocks[index]!];
  }
  const firstOrder = random() < 0.5 ? "ab" : "ba";
  return blocks.flatMap((block, index) => {
    const order = index % 2 === 0 ? firstOrder : firstOrder === "ab" ? "ba" : "ab";
    return [...order].map((arm) => {
      const selected = block.arms[arm as "a" | "b"];
      const profile = jevProfileMetadata(
        selected.jevProfileId === "off-v1" ? "current-v1" : selected.jevProfileId,
        selected.gateProfileId,
      );
      const pairId = `${plan.planId}-${block.blockId}-${block.replicateId}`;
      const study: StudyCaseMetadataV3 = {
        schemaVersion: 3,
        planId: plan.planId,
        planSha256: digest,
        blockId: block.blockId,
        replicateId: block.replicateId,
        pairId,
        caseId: `${pairId}-${arm}`,
        arm: arm as "a" | "b",
        factor: "terminal-instruction",
        order,
        arcProfileId: block.arcProfileId,
        ...selected,
        scenarioProfileId: block.scenarioProfileId,
        scenarioProfileDigest: terminalScenarioProfileDigest(block.scenarioProfileId),
        roomSystemProfileDigest: roomSystemProfileDigest("room-v1"),
        terminalInstructionProfileDigest: terminalInstructionProfileDigest(selected.terminalInstructionProfileId),
        terminalInstructionCharacters: TASK_TERMINAL_INSTRUCTIONS[selected.terminalInstructionProfileId].length,
        jevProfileDigest:
          selected.jevProfileId === "off-v1"
            ? createHash("sha256").update("off-v1").digest("hex")
            : profile.jevProfileDigest,
        gateProfileDigest: profile.gateProfileDigest,
        agentPromptProfileDigest: createHash("sha256")
          .update(STUDY_AGENT_BASE_PROMPTS[selected.agentPromptProfileId])
          .digest("hex"),
        rosterOrder: [...block.rosterOrder],
      };
      return {
        scenarioId: `direct-1-low-enforce-${study.caseId}`,
        variant: selected.jevProfileId === "off-v1" ? "jev-off" : "jev-on",
        dynamic: "direct" as const,
        agentCount: 1 as const,
        energy: "low" as const,
        preflightMode: "enforce" as const,
        classifierEnabled: selected.jevProfileId !== "off-v1",
        text: TERMINAL_SCENARIO_TEXT[block.scenarioProfileId],
        expectedDirectAgents: ["codex-sol" as const],
        rosterOrder: [...block.rosterOrder],
        scenarioProfileId: block.scenarioProfileId,
        study,
      };
    });
  });
}

/** V2 remains a separate path so V1 ordering, digests, and metadata stay byte-for-byte stable. */
function expandIdentityStudyPlan(plan: StudyPlanV2): LiveScenario[] {
  const digest = studyPlanDigest(plan);
  const random = nextRandom(plan.orderSeed);
  const blocks = [...plan.blocks];
  for (let index = blocks.length - 1; index > 0; index--) {
    const selected = Math.floor(random() * (index + 1));
    [blocks[index], blocks[selected]] = [blocks[selected]!, blocks[index]!];
  }
  const firstOrder: "ab" | "ba" = random() < 0.5 ? "ab" : "ba";
  return blocks.flatMap((block, index) => {
    const order: "ab" | "ba" = index % 2 === 0 ? firstOrder : firstOrder === "ab" ? "ba" : "ab";
    return [...order].map((arm) => {
      const selected = block.arms[arm as "a" | "b"];
      const base = buildLiveScenario({
        dynamic: block.dynamic,
        agentCount: block.rosterOrder.length as LiveScenario["agentCount"],
        energy: block.energy,
        preflightMode: "enforce",
        classifierEnabled: selected.jevProfileId !== "off-v1",
        scenarioProfileId: block.scenarioProfileId,
      });
      const { followup: _legacyFollowup, ...baseWithoutFollowup } = base;
      const suffix = `-${plan.planId}-${block.blockId}-${block.replicateId}-${arm}`;
      const pairId = `${plan.planId}-${block.blockId}-${block.replicateId}`;
      const scriptedFollowups = buildStudyFollowups(block.arcProfileId, suffix, block.scenarioProfileId);
      const profile = jevProfileMetadata(
        selected.jevProfileId === "off-v1" ? "current-v1" : selected.jevProfileId,
        selected.gateProfileId,
      );
      const study: StudyCaseMetadataV2 = {
        schemaVersion: 2,
        planId: plan.planId,
        planSha256: digest,
        blockId: block.blockId,
        replicateId: block.replicateId,
        pairId,
        caseId: `${pairId}-${arm}`,
        arm: arm as "a" | "b",
        factor: "room-system",
        order,
        arcProfileId: block.arcProfileId,
        ...selected,
        scenarioProfileId: block.scenarioProfileId,
        scenarioProfileDigest: scenarioProfileDigest(block.scenarioProfileId),
        roomSystemProfileDigest: roomSystemProfileDigest(selected.roomSystemProfileId),
        jevProfileDigest:
          selected.jevProfileId === "off-v1"
            ? createHash("sha256").update("off-v1").digest("hex")
            : profile.jevProfileDigest,
        gateProfileDigest: profile.gateProfileDigest,
        agentPromptProfileDigest: createHash("sha256")
          .update(STUDY_AGENT_BASE_PROMPTS[selected.agentPromptProfileId])
          .digest("hex"),
        rosterOrder: [...block.rosterOrder],
      };
      return {
        ...baseWithoutFollowup,
        scenarioId: `${base.scenarioId}${suffix}`,
        ...(scriptedFollowups.length ? { scriptedFollowups } : {}),
        rosterOrder: [...block.rosterOrder],
        study,
      };
    });
  });
}

export function roomSystemProfileDigest(id: RoomSystemProfileId): string {
  if (!STUDY_ROOM_SYSTEM_PROFILES.includes(id)) throw new Error("Invalid closed room system profile.");
  return createHash("sha256").update(`room-system-selector-v1\0${id}`).digest("hex");
}

export function scenarioProfileDigest(id: StudyBlockV2["scenarioProfileId"] = "garden-chat-v2"): string {
  const selection = ROUTING_DYNAMICS.flatMap((dynamic) =>
    [1, 2, 3, 4]
      .filter((agentCount) => (dynamic === "multi-address" || dynamic === "disagreement" ? agentCount >= 2 : true))
      .map(
        (agentCount) =>
          buildLiveScenario({
            dynamic,
            agentCount: agentCount as LiveScenario["agentCount"],
            energy: "balanced",
            preflightMode: "enforce",
            classifierEnabled: true,
            scenarioProfileId: id,
          }).text,
      ),
  );
  const arcs = STUDY_ARC_PROFILES.map((arc) => buildStudyFollowups(arc, "", id).map(({ text }) => text));
  return createHash("sha256")
    .update(
      JSON.stringify({
        id,
        selection,
        arcs,
        ...(id === "everyday-chat-v3" ? { cardNames: EVERYDAY_FIXTURE_AGENTS } : {}),
      }),
    )
    .digest("hex");
}

/** Closed fixture arcs; the opt-in chat profile is pure until a plan selector is wired. */
export function buildStudyFollowups(
  arc: ArcProfileId,
  suffix: string,
  scenarioProfileId: ScenarioProfileId = "garden-v1",
): NonNullable<LiveScenario["scriptedFollowups"]> {
  if (!STUDY_ARC_PROFILES.includes(arc) || !SCENARIO_PROFILE_IDS.includes(scenarioProfileId))
    throw new Error("Invalid closed study arc profile.");
  const followups: Record<ArcProfileId, NonNullable<LiveScenario["scriptedFollowups"]>> = {
    "single-v1": [],
    "casual-thread-v1": [
      {
        scenarioId: `casual-continuation${suffix}`,
        text: "The fictional sign is now readable from the path; I think the layout is close.",
        expectedDirectAgents: [],
      },
    ],
    "agent-exchange-v1": [
      {
        scenarioId: `agent-exchange${suffix}`,
        text: "Sol and Nova, respond to any useful difference between your ideas for the fictional path. Keep it brief.",
        expectedDirectAgents: ["codex-sol", "claude-sonnet"],
      },
    ],
    "agent-exchange-v2": [
      {
        scenarioId: `agent-exchange-own-tradeoff${suffix}`,
        text: "Sol and Nova, each give your own tradeoff between durability and cost for the fictional path material. Answer independently of any earlier reply and keep it brief.",
        expectedDirectAgents: ["codex-sol", "claude-sonnet"],
      },
    ],
    "handoff-choice-v1": [
      {
        scenarioId: `handoff-choice${suffix}`,
        text: "Sol, I prefer the simpler of the two fictional sign options. Can you confirm the next choice briefly?",
        expectedDirectAgents: ["codex-sol"],
      },
      {
        scenarioId: `handoff-closure${suffix}`,
        text: "Thanks, that is enough for now.",
        expectedDirectAgents: [],
      },
    ],
    "dispute-resolution-v1": [
      {
        scenarioId: `dispute-mediator${suffix}`,
        text: "Terra, given the fictional wooden and metal sign ideas above, describe a practical compromise and what Avery should decide.",
        expectedDirectAgents: ["claude-opus"],
      },
      {
        scenarioId: `dispute-choice${suffix}`,
        text: "I choose the fictional option that will be easier for volunteers to maintain. Please close any remaining material disagreement briefly.",
        expectedDirectAgents: [],
      },
    ],
  };
  if (scenarioProfileId === "garden-v1") return followups[arc];
  if (scenarioProfileId === "everyday-chat-v3") {
    const everydayFollowups: Record<ArcProfileId, NonNullable<LiveScenario["scriptedFollowups"]>> = {
      "single-v1": [],
      "casual-thread-v1": [
        {
          scenarioId: `casual-continuation${suffix}`,
          text: "The rest of the clothes are on the rack indoors, away from the rain.",
          expectedDirectAgents: [],
        },
      ],
      "agent-exchange-v1": [
        {
          scenarioId: `agent-exchange${suffix}`,
          text: "Riley and Jordan, should our shared notes stay in one long document or move to separate pages by topic? Compare how easy each would be to update. If either of you has raised a point, you can respond to it.",
          expectedDirectAgents: ["codex-sol", "claude-sonnet"],
        },
      ],
      "agent-exchange-v2": [
        {
          scenarioId: `agent-exchange-own-tradeoff${suffix}`,
          text: "Riley and Jordan, for our shared notes, would you keep one long document or separate pages by topic? Compare how easy each would be to update, and respond to a point from the other person if one was made.",
          expectedDirectAgents: ["codex-sol", "claude-sonnet"],
        },
      ],
      "handoff-choice-v1": [
        {
          scenarioId: `handoff-choice${suffix}`,
          text: "Riley, I need about 10 minutes at the station before my 9:00 train, and travel usually takes 25 minutes. Should I leave at 8:10 or 8:25?",
          expectedDirectAgents: ["codex-sol"],
        },
        {
          scenarioId: `handoff-closure${suffix}`,
          text: "I'll leave at 8:10 so I have time at the station. Thanks.",
          expectedDirectAgents: [],
        },
      ],
      "dispute-resolution-v1": [
        {
          scenarioId: `dispute-mediator${suffix}`,
          text: "Casey, our planning meeting starts at 4. Would you choose the quiet room that closes at 4:30 or a video call that can run until 5 but has a spotty connection? Please weigh focus and time.",
          expectedDirectAgents: ["claude-opus"],
        },
        {
          scenarioId: `dispute-choice${suffix}`,
          text: "I've booked the quiet room for the planning meeting. We'll keep it to 30 minutes.",
          expectedDirectAgents: [],
        },
      ],
    };
    return everydayFollowups[arc];
  }
  const chatFollowups: Record<ArcProfileId, NonNullable<LiveScenario["scriptedFollowups"]>> = {
    "single-v1": [],
    "casual-thread-v1": [
      {
        scenarioId: `casual-continuation${suffix}`,
        text: "The sign is readable from the path now. I think the layout is close.",
        expectedDirectAgents: [],
      },
    ],
    "agent-exchange-v1": [
      {
        scenarioId: `agent-exchange${suffix}`,
        text: "Sol and Nova, where do your suggestions for the path differ? Keep it brief.",
        expectedDirectAgents: ["codex-sol", "claude-sonnet"],
      },
    ],
    "agent-exchange-v2": [
      {
        scenarioId: `agent-exchange-own-tradeoff${suffix}`,
        text: "Sol and Nova, each give your own tradeoff between durability and cost for the path material. Answer independently of any earlier reply and keep it brief.",
        expectedDirectAgents: ["codex-sol", "claude-sonnet"],
      },
    ],
    "handoff-choice-v1": [
      {
        scenarioId: `handoff-choice${suffix}`,
        text: "Sol, I prefer the simpler sign option. Can you confirm what I need to choose next?",
        expectedDirectAgents: ["codex-sol"],
      },
      { scenarioId: `handoff-closure${suffix}`, text: "Thanks, that is enough for now.", expectedDirectAgents: [] },
    ],
    "dispute-resolution-v1": [
      {
        scenarioId: `dispute-mediator${suffix}`,
        text: "Terra, given the wooden and metal sign ideas above, what compromise would work? What should I decide?",
        expectedDirectAgents: ["claude-opus"],
      },
      {
        scenarioId: `dispute-choice${suffix}`,
        text: "I choose the option that will be easier for volunteers to maintain. Please close any remaining disagreement briefly.",
        expectedDirectAgents: [],
      },
    ],
  };
  return chatFollowups[arc];
}
