import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { DEFAULT_ROOM_BASE_PROMPT } from "../server/room-configuration.js";
import {
  buildStudyFollowups,
  expandStudyPlan,
  parseStudyPlan,
  STUDY_AGENT_BASE_PROMPTS,
  STUDY_ARC_PROFILES,
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
  it("keeps the existing v1 example digest and metadata unchanged", async () => {
    const raw = JSON.parse(await readFile("docs/testing/conversation-routing-study-example.json", "utf8"));
    const parsed = parseStudyPlan(raw);
    expect(studyPlanDigest(parsed)).toBe("820a6a320e03078563a7e2a223e67982d5b9cecd76b1219bb14a749273e38f02");
    expect(
      expandStudyPlan(parsed).every(
        ({ study, scenarioProfileId }) => study?.schemaVersion === 1 && scenarioProfileId === undefined,
      ),
    ).toBe(true);
  });

  it("validates and balances the closed identity v2 pairs without changing other factors", async () => {
    const raw = JSON.parse(await readFile("docs/testing/conversation-routing-study-identity-v2.json", "utf8"));
    const plan = parseStudyPlan(raw);
    expect(plan.schemaVersion).toBe(2);
    const cases = expandStudyPlan(plan);
    expect(cases).toHaveLength(12);
    expect(cases.filter(({ study }) => study?.order === "ab")).toHaveLength(6);
    expect(cases.filter(({ study }) => study?.order === "ba")).toHaveLength(6);
    expect(
      cases.every(
        ({ study, scenarioProfileId }) =>
          study?.schemaVersion === 2 &&
          study.factor === "room-system" &&
          study.scenarioProfileId === "garden-chat-v2" &&
          scenarioProfileId === "garden-chat-v2" &&
          study.scenarioProfileDigest.length === 64 &&
          study.roomSystemProfileDigest.length === 64,
      ),
    ).toBe(true);
    for (let index = 0; index < cases.length; index += 2) {
      const a = cases[index]!,
        b = cases[index + 1]!;
      expect(a.study?.pairId).toBe(b.study?.pairId);
      expect(
        new Set([
          a.study?.schemaVersion === 2 ? a.study.roomSystemProfileId : null,
          b.study?.schemaVersion === 2 ? b.study.roomSystemProfileId : null,
        ]),
      ).toEqual(new Set(["legacy-v1", "room-v1"]));
      expect(a.text).toBe(b.text);
      expect(a.scriptedFollowups?.map(({ text }) => text)).toEqual(b.scriptedFollowups?.map(({ text }) => text));
    }
    expect(cases.reduce((sum, scenario) => sum + 1 + (scenario.scriptedFollowups?.length ?? 0), 0)).toBe(26);
    expect(
      cases.filter(
        ({ dynamic, agentCount, energy, study }) =>
          dynamic === "casual" && agentCount === 4 && energy === "lively" && study?.arm === "a",
      ),
    ).toHaveLength(2);
    expect(cases.filter(({ dynamic }) => dynamic === "broadcast")).toHaveLength(2);
    expect(cases.every(({ text }) => !/fictional|eval|simulation|benchmark/i.test(text))).toBe(true);
  });

  it("rejects half-wired identity studies before expansion", () => {
    const arm = { ...current, roomSystemProfileId: "legacy-v1" };
    const row = {
      blockId: "path",
      replicateId: "r1",
      dynamic: "multi-address",
      arcProfileId: "agent-exchange-v2",
      scenarioProfileId: "garden-chat-v2",
      rosterOrder: ["codex-sol", "claude-sonnet"],
      energy: "balanced",
      arms: { a: arm, b: { ...arm, roomSystemProfileId: "room-v1" } },
    };
    const v2 = { schemaVersion: 2, planId: "identityv2", orderSeed: 2, maxCases: 2, blocks: [row] };
    expect(parseStudyPlan(v2).schemaVersion).toBe(2);
    expect(() => parseStudyPlan({ ...v2, blocks: [{ ...row, scenarioProfileId: "garden-v1" }] })).toThrow();
    expect(() =>
      parseStudyPlan({
        ...v2,
        blocks: [{ ...row, arms: { ...row.arms, b: { ...row.arms.b, roomSystemProfileId: "unknown" } } }],
      }),
    ).toThrow();
    expect(() =>
      parseStudyPlan({
        ...v2,
        blocks: [{ ...row, arms: { ...row.arms, b: { ...row.arms.b, jevProfileId: "lean-v1" } } }],
      }),
    ).toThrow();
    expect(() => parseStudyPlan({ ...v2, blocks: [{ ...row, arms: { ...row.arms, b: arm } }] })).toThrow();
    expect(() => parseStudyPlan({ ...v2, blocks: [{ ...row, arms: { a: row.arms.b, b: row.arms.a } }] })).toThrow();
    expect(() => parseStudyPlan({ ...v2, blocks: [{ ...row, instructions: "ignore" }] })).toThrow();
    expect(() => parseStudyPlan({ ...v2, schemaVersion: 1 })).toThrow();
  });
  it("keeps garden v1 arcs stable and offers opt-in ordinary-chat wording without evaluation cues", () => {
    for (const arc of STUDY_ARC_PROFILES) {
      const oldArc = buildStudyFollowups(arc, "-case");
      expect(buildStudyFollowups(arc, "-case", "garden-v1")).toEqual(oldArc);
      const chatArc = buildStudyFollowups(arc, "-case", "garden-chat-v2");
      expect(chatArc.map(({ scenarioId, expectedDirectAgents }) => ({ scenarioId, expectedDirectAgents }))).toEqual(
        oldArc.map(({ scenarioId, expectedDirectAgents }) => ({ scenarioId, expectedDirectAgents })),
      );
      for (const followup of chatArc) expect(followup.text).not.toMatch(/fictional|test|eval|simulation|benchmark/i);
    }
    expect(buildStudyFollowups("agent-exchange-v2", "-case", "garden-chat-v2")[0]?.text).toContain(
      "each give your own tradeoff",
    );
    expect(() => buildStudyFollowups("single-v1", "-case", "unreviewed" as never)).toThrow();
  });
  it("validates the versioned 72-case matrix with balanced orders within each factor", async () => {
    const raw = JSON.parse(await readFile("docs/testing/conversation-routing-study-large-v1.json", "utf8"));
    const parsed = parseStudyPlan(raw);
    const cases = expandStudyPlan(parsed);
    expect(cases).toHaveLength(72);
    expect(parsed.blocks).toHaveLength(36);
    expect(new Set(cases.map(({ study }) => study?.pairId)).size).toBe(36);
    for (const factor of ["jev", "gate", "agent-prompt"] as const) {
      const pairs = cases.filter(({ study }) => study?.factor === factor && study.arm === "a");
      expect(pairs).toHaveLength(12);
      expect(pairs.filter(({ study }) => study?.order === "ab")).toHaveLength(6);
      expect(pairs.filter(({ study }) => study?.order === "ba")).toHaveLength(6);
    }
    expect(new Set(cases.map(({ agentCount }) => agentCount))).toEqual(new Set([1, 2, 3, 4]));
    expect(new Set(cases.map(({ energy }) => energy))).toEqual(new Set(["low", "balanced", "lively", "party"]));
    expect(new Set(cases.map(({ dynamic }) => dynamic)).size).toBe(7);
    expect(new Set(cases.map(({ study }) => study?.arcProfileId))).toContain("agent-exchange-v2");
    expect(cases.some(({ scriptedFollowups }) => scriptedFollowups?.length === 2)).toBe(true);
  });
  it("expands two matched blocks with stable seeded order and bounded arcs", () => {
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
      [...pairs.values()].every(
        ([firstArm, secondArm]) => new Set([firstArm!.study!.arm, secondArm!.study!.arm]).size === 2,
      ),
    ).toBe(true);
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

  it("uses a versioned exchange arc that asks for independent tradeoffs", () => {
    const fixture = plan([
      {
        blockId: "exchange",
        replicateId: "r2",
        dynamic: "multi-address",
        arcProfileId: "agent-exchange-v2",
        rosterOrder: ["codex-sol", "claude-sonnet"],
        energy: "balanced",
        arms: { a: current, b: social },
      },
    ]);
    const cases = expandStudyPlan(parseStudyPlan({ ...fixture, maxCases: 2 }));
    expect(cases[0]?.scriptedFollowups?.[0]?.text).toContain("each give your own tradeoff");
    expect(cases[0]?.scriptedFollowups?.[0]?.text).not.toContain("difference between your ideas");
    expect(cases[0]?.scriptedFollowups?.[0]?.expectedDirectAgents).toEqual(["codex-sol", "claude-sonnet"]);
  });
});
