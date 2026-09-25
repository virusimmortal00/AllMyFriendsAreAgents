import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DEFAULT_ROOM_BASE_PROMPT } from "../server/room-configuration.js";
import {
  expandStudyPlan,
  parseStudyPlan,
  STUDY_AGENT_BASE_PROMPTS,
  studyPlanDigest,
} from "./conversation-routing-live-study.js";

const current = { jevProfileId: "current-v1", gateProfileId: "current-v1", agentPromptProfileId: "current-v1" };
const social = { ...current, agentPromptProfileId: "social-v1" };

function plan(
  blocks = [
    {
      blockId: "garden",
      replicateId: "r1",
      dynamic: "casual",
      arcProfileId: "casual-thread-v1",
      rosterOrder: ["claude-opus", "codex-sol", "claude-sonnet"],
      energy: "balanced",
      arms: { a: current, b: social },
    },
    {
      blockId: "sign",
      replicateId: "r1",
      dynamic: "disagreement",
      arcProfileId: "dispute-resolution-v1",
      rosterOrder: ["codex-sol", "claude-sonnet", "claude-opus"],
      energy: "lively",
      arms: { a: current, b: { ...current, jevProfileId: "lean-v1" } },
    },
  ],
) {
  return { schemaVersion: 1, planId: "fixture", orderSeed: 427, maxCases: 4, blocks };
}

describe("closed live study plan", () => {
  it("expands two matched blocks with stable seeded AB/BA order and bounded arcs", () => {
    const parsed = parseStudyPlan(plan());
    const first = expandStudyPlan(parsed);
    expect(expandStudyPlan(parsed)).toEqual(first);
    expect(first).toHaveLength(4);
    const pairs = new Map<string, typeof first>();
    for (const scenario of first) {
      const pairId = scenario.study!.pairId;
      pairs.set(pairId, [...(pairs.get(pairId) ?? []), scenario]);
      expect(scenario.study?.planSha256).toBe(studyPlanDigest(parsed));
      expect(scenario.rosterOrder).toEqual(scenario.study?.rosterOrder);
      expect(scenario.followup).toBeUndefined();
      expect(scenario.scenarioId.length).toBeLessThanOrEqual(100);
    }
    expect(
      [...pairs.values()].map(([firstArm, secondArm]) => `${firstArm!.study!.arm}${secondArm!.study!.arm}`).sort(),
    ).toEqual(["ab", "ba"]);
    const casual = first.find(({ dynamic }) => dynamic === "casual")!;
    expect(casual.scriptedFollowups).toHaveLength(1);
    expect(casual.scriptedFollowups?.[0]?.text).not.toMatch(/^Avery:/);
    expect(STUDY_AGENT_BASE_PROMPTS["social-v1"].startsWith(DEFAULT_ROOM_BASE_PROMPT)).toBe(true);
    const socialCase = first.find(({ study }) => study?.agentPromptProfileId === "social-v1")!;
    expect(socialCase.study?.agentPromptProfileDigest).toBe(
      createHash("sha256").update(STUDY_AGENT_BASE_PROMPTS["social-v1"]).digest("hex"),
    );
    const dispute = first.find(({ dynamic }) => dynamic === "disagreement")!;
    expect(dispute.scriptedFollowups).toHaveLength(2);
    expect(dispute.scriptedFollowups?.[0]?.expectedDirectAgents).toEqual(["claude-opus"]);
  });

  it("rejects arbitrary prompt text, repeated or malformed identities, and multiple changed factors", () => {
    expect(() => parseStudyPlan({ ...plan(), privatePrompt: "unreviewed text" })).toThrow();
    const duplicate = plan();
    duplicate.blocks[1]!.blockId = "garden";
    expect(() => parseStudyPlan(duplicate)).toThrow();
    const badRoster = plan();
    badRoster.blocks[0]!.rosterOrder = ["codex-sol", "codex-sol", "claude-sonnet"];
    expect(() => parseStudyPlan(badRoster)).toThrow();
    const twoFactors = plan();
    twoFactors.blocks[0]!.arms.b = { ...social, gateProfileId: "relevance-v1", jevProfileId: "relevance-v1" };
    expect(() => parseStudyPlan(twoFactors)).toThrow();
    const tooMany = plan();
    tooMany.maxCases = 2;
    expect(() => parseStudyPlan(tooMany)).toThrow();
  });

  it("allows a gate-only comparison only with its optional-worth Jev question profile", () => {
    const gate = plan([
      {
        blockId: "gate",
        replicateId: "r2",
        dynamic: "casual",
        arcProfileId: "casual-thread-v1",
        rosterOrder: ["codex-sol", "claude-sonnet", "claude-opus"],
        energy: "balanced",
        arms: {
          a: { ...current, jevProfileId: "relevance-v1" },
          b: { ...current, jevProfileId: "relevance-v1", gateProfileId: "relevance-v1" },
        },
      },
    ]);
    expect(expandStudyPlan(parseStudyPlan({ ...gate, maxCases: 2 })).map(({ study }) => study?.factor)).toEqual([
      "gate",
      "gate",
    ]);
    gate.blocks[0]!.arms.a.jevProfileId = "current-v1";
    expect(() => parseStudyPlan({ ...gate, maxCases: 2 })).toThrow();
  });
});
