import type { ConversationEnergy } from "../shared/conversation-energy.js";
import type { ActiveAgentId } from "../shared/participants.js";
import type { PreflightMode } from "../shared/preflight.js";
import type { StudyCaseMetadataV1 } from "./conversation-routing-live-study.js";

export type RoutingDynamic =
  | "direct"
  | "multi-address"
  | "broadcast"
  | "casual"
  | "handoff"
  | "disagreement"
  | "quoted-name";

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
  study?: StudyCaseMetadataV1;
}

export const FIXTURE_AGENTS = [
  { agentId: "codex-sol", name: "Sol" },
  { agentId: "claude-sonnet", name: "Nova" },
  { agentId: "claude-opus", name: "Terra" },
  { agentId: "cursor-grok", name: "Mira" },
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
}

/** Every example is fictional and independent of any real room transcript. */
export function buildLiveScenario(selection: ScenarioSelection): LiveScenario {
  const { dynamic, agentCount, energy, preflightMode, classifierEnabled } = selection;
  if (
    !ROUTING_DYNAMICS.includes(dynamic) ||
    !ROUTING_ENERGIES.includes(energy) ||
    !ROUTING_MODES.includes(preflightMode) ||
    ![1, 2, 3, 4].includes(agentCount) ||
    typeof classifierEnabled !== "boolean"
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
  const text: Record<RoutingDynamic, string> = {
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
  return {
    scenarioId: `${dynamic}-${agentCount}-${energy}-${preflightMode}`,
    variant: classifierEnabled ? "jev-on" : "jev-off",
    dynamic,
    agentCount,
    energy,
    preflightMode,
    classifierEnabled,
    text: text[dynamic],
    expectedDirectAgents: targets,
    ...(dynamic === "disagreement" && agentCount >= 3
      ? {
          followup: {
            scenarioId: `resolution-${agentCount}-${energy}-${preflightMode}`,
            text: "Terra, given the fictional wooden and metal sign ideas above, describe a practical compromise and what Avery should decide.",
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
