import type { ConversationEnergy } from "../shared/conversation-energy.js";
import type { ActiveAgentId } from "../shared/participants.js";
import type { PreflightMode } from "../shared/preflight.js";
import type { StudyCaseMetadata } from "./conversation-routing-live-study.js";

export type RoutingDynamic =
  | "direct"
  | "multi-address"
  | "broadcast"
  | "casual"
  | "handoff"
  | "disagreement"
  | "quoted-name";

export const SCENARIO_PROFILE_IDS = ["garden-v1", "garden-chat-v2", "everyday-chat-v3"] as const;
export type ScenarioProfileId = (typeof SCENARIO_PROFILE_IDS)[number];
export const TERMINAL_SCENARIO_PROFILES = ["brief-v1", "comparison-v1", "draft-v1"] as const;
export type TerminalScenarioProfileId = (typeof TERMINAL_SCENARIO_PROFILES)[number];
export const TERMINAL_SCENARIO_TEXT: Record<TerminalScenarioProfileId, string> = {
  "brief-v1":
    "Riley, our book club can meet Tuesday at 6 or Thursday at 7. Which would you recommend if most members finish work at 6, and why?",
  "comparison-v1":
    "Riley, compare a 20-minute walk and a 20-minute bike ride for a short local errand. Which usually covers more distance?",
  "draft-v1":
    "Riley, draft a short, friendly message asking the neighbors to bring reusable cups to Saturday's picnic.",
};
export const MODEL_SCENARIO_PROFILES = ["draft-known-v1", "meal-holdout-v1", "travel-holdout-v1"] as const;
export type ModelScenarioProfileId = (typeof MODEL_SCENARIO_PROFILES)[number];
/** One known V3 regression prompt and two previously unused, self-contained practical prompts. */
export const MODEL_SCENARIO_TEXT: Record<ModelScenarioProfileId, string> = {
  "draft-known-v1": TERMINAL_SCENARIO_TEXT["draft-v1"],
  "meal-holdout-v1":
    "Riley, I have rice, canned beans, a tomato, and frozen spinach. Suggest a simple dinner for two using these ingredients, with no shopping trip.",
  "travel-holdout-v1":
    "Riley, the bus leaves at 8:40, the walk to the stop takes 12 minutes, and I want a 5-minute buffer. What time should I leave home?",
};
export function usesEverydayFixtureNames(id: LiveScenario["scenarioProfileId"]) {
  return (
    id === "everyday-chat-v3" ||
    TERMINAL_SCENARIO_PROFILES.includes(id as TerminalScenarioProfileId) ||
    MODEL_SCENARIO_PROFILES.includes(id as ModelScenarioProfileId)
  );
}

export interface LiveScenario {
  scenarioId: string;
  variant: "jev-on" | "jev-off";
  dynamic: RoutingDynamic;
  agentCount: 1 | 2 | 3 | 4;
  energy: ConversationEnergy;
  preflightMode: PreflightMode;
  classifierEnabled: boolean;
  text: string;
  /** Fixture judgment about explicit address syntax, not a prediction of replies. */
  expectedDirectAgents: ActiveAgentId[];
  followup?: { text: string; expectedDirectAgents: ActiveAgentId[]; scenarioId: string };
  /** Study plans may use two or three scripted human messages instead of the legacy follow-up. */
  scriptedFollowups?: Array<{ text: string; expectedDirectAgents: ActiveAgentId[]; scenarioId: string }>;
  rosterOrder?: ActiveAgentId[];
  scenarioProfileId?: ScenarioProfileId | TerminalScenarioProfileId | ModelScenarioProfileId;
  study?: StudyCaseMetadata;
}

export const FIXTURE_AGENTS = [
  { agentId: "codex-sol", name: "Sol" },
  { agentId: "claude-sonnet", name: "Nova" },
  { agentId: "claude-opus", name: "Terra" },
  { agentId: "cursor-grok", name: "Mira" },
] as const;

/** Profile-local card names; canonical agent IDs and older study cards stay unchanged. */
export const EVERYDAY_FIXTURE_AGENTS = [
  { agentId: "codex-sol", name: "Riley" },
  { agentId: "claude-sonnet", name: "Jordan" },
  { agentId: "claude-opus", name: "Casey" },
  { agentId: "cursor-grok", name: "Morgan" },
] as const;

export const ROUTING_DYNAMICS: readonly RoutingDynamic[] = [
  "direct",
  "multi-address",
  "broadcast",
  "casual",
  "handoff",
  "disagreement",
  "quoted-name",
];
export const ROUTING_ENERGIES: readonly ConversationEnergy[] = ["low", "balanced", "lively", "party"];
export const ROUTING_MODES: readonly PreflightMode[] = ["off", "shadow", "enforce"];

export interface ScenarioSelection {
  dynamic: RoutingDynamic;
  agentCount: 1 | 2 | 3 | 4;
  energy: ConversationEnergy;
  preflightMode: PreflightMode;
  classifierEnabled: boolean;
  scenarioProfileId?: ScenarioProfileId;
}

/** Every example is fictional and independent of any real room transcript. */
export function buildLiveScenario(selection: ScenarioSelection): LiveScenario {
  const { dynamic, agentCount, energy, preflightMode, classifierEnabled } = selection;
  const scenarioProfileId = selection.scenarioProfileId ?? "garden-v1";
  if (
    !ROUTING_DYNAMICS.includes(dynamic) ||
    !ROUTING_ENERGIES.includes(energy) ||
    !ROUTING_MODES.includes(preflightMode) ||
    ![1, 2, 3, 4].includes(agentCount) ||
    typeof classifierEnabled !== "boolean" ||
    !SCENARIO_PROFILE_IDS.includes(scenarioProfileId)
  )
    throw new Error("Invalid scenario selection.");
  if (["multi-address", "disagreement"].includes(dynamic) && agentCount < 2)
    throw new Error("This scenario needs at least two agents.");
  const targets =
    dynamic === "multi-address" || dynamic === "disagreement"
      ? FIXTURE_AGENTS.slice(0, 2).map(({ agentId }) => agentId)
      : dynamic === "direct" || dynamic === "handoff"
        ? [FIXTURE_AGENTS[0].agentId]
        : [];
  const gardenV1: Record<RoutingDynamic, string> = {
    direct: "Sol, could you suggest one way to make the fictional garden path safer after rain?",
    "multi-address": "Sol and Nova, what two different low-cost materials might suit the fictional garden path?",
    broadcast: "Everyone, please each offer one idea for the fictional community garden sign.",
    casual: "The fictional garden sign is getting easier to read as the layout settles.",
    handoff:
      "Sol, compare two options for the fictional garden sign, then ask Avery to choose if a preference is needed.",
    disagreement:
      "Sol, argue for a wooden fictional garden sign. Nova, argue for a metal one. Explain where the two choices differ.",
    "quoted-name":
      "The draft sign says “Sol, please water the garden” as a fictional example of instructions printed on a sign.",
  };
  const gardenChatV2: Record<RoutingDynamic, string> = {
    direct: "Sol, could you suggest one way to make our garden path safer after rain?",
    "multi-address":
      "Sol and Nova, what two low-cost materials might work for the garden path? Please give your own tradeoff.",
    broadcast: "Everyone, could you each offer one idea for the community garden sign?",
    casual: "The garden sign is getting easier to read now that the layout is settling.",
    handoff: "Sol, can you compare two options for the garden sign? Ask me to choose if you need a preference.",
    disagreement:
      "Sol, make the case for a wooden garden sign. Nova, make the case for metal. Where do your views differ?",
    "quoted-name":
      "The draft sign says “Sol, please water the garden” in its instructions. Will that wording confuse visitors?",
  };
  const everydayChatV3: Record<RoutingDynamic, string> = {
    direct:
      "Riley, I need to invite the team to a 20-minute check-in about next week's schedule. What one-sentence agenda should I put in the invite?",
    "multi-address":
      "Riley and Jordan, our shared notes could stay in one long document or move to separate pages by topic. Which would make updates easier, and what tradeoff matters most?",
    broadcast:
      "Everyone, I need a simple vegetarian dinner for four that can be ready in 30 minutes. What would you make? One idea each is plenty.",
    casual: "I got the laundry dry before the rain started. The clean towels are folded now.",
    handoff:
      "Riley, I can leave for the station at 8:10 or 8:25. The train is at 9:00 and the trip usually takes 25 minutes. Which departure would you choose?",
    disagreement:
      "Our planning meeting starts at 4. The quiet room closes at 4:30; a video call could run until 5 but the connection is spotty. Riley, which would you choose if focus matters most? Jordan, which would you choose if enough time matters most?",
    "quoted-name":
      "A notice on the door reads ‘Riley, check the lights before leaving.’ Would visitors mistake that for a request to them?",
  };
  const text =
    scenarioProfileId === "everyday-chat-v3"
      ? everydayChatV3
      : scenarioProfileId === "garden-chat-v2"
        ? gardenChatV2
        : gardenV1;
  return {
    scenarioId: `${dynamic}-${agentCount}-${energy}-${preflightMode}`,
    variant: classifierEnabled ? "jev-on" : "jev-off",
    dynamic,
    agentCount,
    energy,
    preflightMode,
    classifierEnabled,
    text: text[dynamic],
    ...(selection.scenarioProfileId ? { scenarioProfileId } : {}),
    expectedDirectAgents: targets,
    ...(dynamic === "disagreement" && agentCount >= 3
      ? {
          followup: {
            scenarioId: `resolution-${agentCount}-${energy}-${preflightMode}`,
            text:
              scenarioProfileId === "everyday-chat-v3"
                ? "Casey, for a planning meeting starting at 4, would you choose a quiet room that closes at 4:30 or a video call that can run until 5 but has a spotty connection? Please weigh the choice."
                : scenarioProfileId === "garden-chat-v2"
                  ? "Terra, given the wooden and metal sign ideas above, what compromise would work? What should I decide?"
                  : "Terra, given the fictional wooden and metal sign ideas above, describe a practical compromise and what Avery should decide.",
            expectedDirectAgents: [FIXTURE_AGENTS[2].agentId],
          },
        }
      : {}),
  };
}

/** Six matched Jev-on/off pairs; each entry still runs in a fresh isolated room. */
export const PILOT_BASE_CASES: readonly Omit<ScenarioSelection, "classifierEnabled">[] = [
  { dynamic: "direct", agentCount: 1, energy: "low", preflightMode: "enforce" },
  { dynamic: "direct", agentCount: 3, energy: "low", preflightMode: "enforce" },
  { dynamic: "broadcast", agentCount: 2, energy: "low", preflightMode: "enforce" },
  { dynamic: "casual", agentCount: 3, energy: "balanced", preflightMode: "enforce" },
  { dynamic: "handoff", agentCount: 2, energy: "low", preflightMode: "enforce" },
  { dynamic: "disagreement", agentCount: 3, energy: "lively", preflightMode: "enforce" },
];

export function pilotScenarios(): LiveScenario[] {
  return PILOT_BASE_CASES.flatMap((base) =>
    [true, false].map((classifierEnabled) => buildLiveScenario({ ...base, classifierEnabled })),
  );
}
