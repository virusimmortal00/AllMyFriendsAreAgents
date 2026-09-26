import { createHash } from "node:crypto";
import {
  JEV_GATE_PROFILE_IDS,
  JEV_QUESTION_PROFILE_IDS,
  jevProfileMetadata,
} from "../server/jev-experiment-profiles.js";
import { DEFAULT_ROOM_BASE_PROMPT } from "../server/room-configuration.js";
import type { ConversationEnergy } from "../shared/conversation-energy.js";
import type { ActiveAgentId } from "../shared/participants.js";
import {
  buildLiveScenario,
  FIXTURE_AGENTS,
  type LiveScenario,
  ROUTING_DYNAMICS,
  ROUTING_ENERGIES,
  type RoutingDynamic,
  SCENARIO_PROFILE_IDS,
  type ScenarioProfileId,
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
  scenarioProfileId: "garden-chat-v2";
  arms: { a: StudyArmV2; b: StudyArmV2 };
}

export interface StudyPlanV2 extends Omit<StudyPlanV1, "schemaVersion" | "blocks"> {
  schemaVersion: 2;
  blocks: StudyBlockV2[];
}

export type StudyPlan = StudyPlanV1 | StudyPlanV2;

export interface StudyCaseMetadataV2 extends Omit<StudyCaseMetadataV1, "schemaVersion" | "factor"> {
  schemaVersion: 2;
  factor: "room-system";
  scenarioProfileId: "garden-chat-v2";
  scenarioProfileDigest: string;
  roomSystemProfileId: RoomSystemProfileId;
  roomSystemProfileDigest: string;
}

export type StudyCaseMetadata = StudyCaseMetadataV1 | StudyCaseMetadataV2;

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
    (top.schemaVersion !== 1 && top.schemaVersion !== 2) ||
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
      ...(top.schemaVersion === 2 ? ["scenarioProfileId"] : []),
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
      row.rosterOrder.length > 4 ||
      new Set(row.rosterOrder).size !== row.rosterOrder.length ||
      row.rosterOrder.some((agent) => !AGENT_IDS.includes(agent as ActiveAgentId))
    )
      throw new Error("Invalid closed study plan.");
    if (top.schemaVersion === 2 && row.scenarioProfileId !== "garden-chat-v2")
      throw new Error("Invalid closed study scenario profile.");
    const rosterOrder = row.rosterOrder as ActiveAgentId[];
    const expected = AGENT_IDS.slice(0, rosterOrder.length);
    if (expected.some((agent) => !rosterOrder.includes(agent))) throw new Error("Invalid closed study plan.");
    if (["multi-address", "disagreement"].includes(row.dynamic as string) && row.rosterOrder.length < 2)
      throw new Error("Invalid closed study plan.");
    if (
      (row.arcProfileId === "casual-thread-v1" && row.dynamic !== "casual") ||
      ((row.arcProfileId === "agent-exchange-v1" || row.arcProfileId === "agent-exchange-v2") &&
        row.dynamic !== "multi-address") ||
      (row.arcProfileId === "handoff-choice-v1" && row.dynamic !== "handoff") ||
      (row.arcProfileId === "dispute-resolution-v1" && (row.dynamic !== "disagreement" || row.rosterOrder.length < 3))
    )
      throw new Error("Invalid closed study plan.");
    const arms = object(row.arms, ["a", "b"]);
    if (top.schemaVersion === 2) {
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
    const a = top.schemaVersion === 2 ? profileArmV2(arms.a) : profileArm(arms.a);
    const b = top.schemaVersion === 2 ? profileArmV2(arms.b) : profileArm(arms.b);
    return {
      blockId: row.blockId,
      replicateId: row.replicateId,
      dynamic: row.dynamic,
      arcProfileId: row.arcProfileId,
      rosterOrder,
      energy: row.energy,
      arms: { a, b },
      ...(top.schemaVersion === 2 ? { scenarioProfileId: "garden-chat-v2" as const } : {}),
    };
  });
  if (new Set(blocks.map(({ blockId, replicateId }) => `${blockId}\0${replicateId}`)).size !== blocks.length)
    throw new Error("Duplicate study block and replicate.");
  return top.schemaVersion === 2
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
        scenarioProfileDigest: scenarioProfileDigest(),
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

export function scenarioProfileDigest(): string {
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
            scenarioProfileId: "garden-chat-v2",
          }).text,
      ),
  );
  const arcs = STUDY_ARC_PROFILES.map((arc) => buildStudyFollowups(arc, "", "garden-chat-v2").map(({ text }) => text));
  return createHash("sha256")
    .update(JSON.stringify({ id: "garden-chat-v2", selection, arcs }))
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
