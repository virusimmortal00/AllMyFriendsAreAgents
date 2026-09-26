import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  LARGE_STUDY_PROFILES,
  largeStudyProfile,
  largeStudyProfileDigest,
} from "./conversation-routing-live-large-fixtures.js";
import { expandStudyPlan, parseStudyPlan, studyPlanDigest } from "./conversation-routing-live-study.js";

const path = "docs/testing/conversation-routing-study-large-everyday-v5.json";
async function rawPlan() {
  return JSON.parse(await readFile(path, "utf8"));
}
const names = new Map([
  ["Riley", "codex-sol"],
  ["Jordan", "claude-sonnet"],
  ["Casey", "claude-opus"],
]);

describe("closed 72-case everyday lever study", () => {
  it("expands 36 distinct pairs, balancing factors, themes, roster sizes, dynamics, and message counts", async () => {
    const plan = parseStudyPlan(await rawPlan());
    expect(plan.schemaVersion).toBe(5);
    const cases = expandStudyPlan(plan);
    expect(cases).toHaveLength(72);
    expect(
      cases
        .filter((_, index) => index % 2 === 0)
        .slice(0, 3)
        .map(({ study, dynamic }) => [
          study?.factor,
          dynamic,
          study?.schemaVersion === 5 ? study.theme : null,
          study?.order,
        ]),
    ).toEqual([
      ["agent-prompt", "multi-address", "everyday", "ab"],
      ["jev", "direct", "practical", "ba"],
      ["gate", "broadcast", "everyday", "ba"],
    ]);
    expect(new Set(cases.map(({ study }) => study?.caseId)).size).toBe(72);
    expect(new Set(cases.map(({ study }) => study?.pairId)).size).toBe(36);
    expect(new Set(cases.map(({ study }) => study?.schemaVersion === 5 && study.scenarioProfileDigest)).size).toBe(36);
    expect(new Set(cases.map(({ dynamic }) => dynamic)).size).toBe(7);
    expect(new Set(cases.map(({ agentCount }) => agentCount))).toEqual(new Set([1, 2, 3]));
    expect(new Set(cases.map((item) => 1 + (item.scriptedFollowups?.length ?? 0)))).toEqual(new Set([1, 2, 3]));
    const count = (factor: string, theme: string) =>
      cases.filter(({ study }) => study?.factor === factor && study.schemaVersion === 5 && study.theme === theme)
        .length / 2;
    for (const factor of ["jev", "gate", "agent-prompt"]) {
      expect(count(factor, "everyday")).toBe(6);
      expect(count(factor, "practical")).toBe(6);
      const pairStarts = cases.filter((_, index) => index % 2 === 0 && cases[index]?.study?.factor === factor);
      expect(pairStarts.filter(({ study }) => study?.order === "ab")).toHaveLength(6);
      expect(pairStarts.filter(({ study }) => study?.order === "ba")).toHaveLength(6);
      for (const theme of ["everyday", "practical"]) {
        const stratum = pairStarts.filter(({ study }) => study?.schemaVersion === 5 && study.theme === theme);
        expect(stratum.filter(({ study }) => study?.order === "ab")).toHaveLength(3);
        expect(stratum.filter(({ study }) => study?.order === "ba")).toHaveLength(3);
      }
    }
    for (let index = 0; index < cases.length; index += 2) {
      const [left, right] = [cases[index]!, cases[index + 1]!];
      const a = left.study!,
        b = right.study!;
      expect(a.pairId).toBe(b.pairId);
      expect(a.schemaVersion).toBe(5);
      expect(b.schemaVersion).toBe(5);
      expect(left.text).toBe(right.text);
      expect(left.scriptedFollowups?.map(({ text }) => text)).toEqual(right.scriptedFollowups?.map(({ text }) => text));
      expect(left.rosterOrder).toEqual(right.rosterOrder);
      expect(left.rosterOrder!.length).toBeLessThanOrEqual(3);
      expect(left.rosterOrder!.length).toBeGreaterThanOrEqual(a.factor === "gate" ? 2 : 1);
      if (a.factor === "gate") {
        const turns = [{ expectedDirectAgents: left.expectedDirectAgents }, ...(left.scriptedFollowups ?? [])];
        expect(turns.some((turn) => turn.expectedDirectAgents.length < left.rosterOrder!.length)).toBe(true);
      }
      if (left.dynamic === "quoted-name") {
        expect(left.expectedDirectAgents).toEqual([]);
        expect(right.expectedDirectAgents).toEqual([]);
      }
      if (a.schemaVersion !== 5 || b.schemaVersion !== 5) throw new Error("Expected V5 metadata.");
      expect(a.roomSystemProfileId).toBe("room-v1");
      expect(b.roomSystemProfileId).toBe("room-v1");
      expect(a.terminalInstructionProfileId).toBe("contribution-first-v1");
      expect(b.terminalInstructionProfileId).toBe("contribution-first-v1");
      const keys = ["jevProfileId", "gateProfileId", "agentPromptProfileId"] as const;
      const changed = keys.filter((key) => a[key] !== b[key]);
      expect(changed).toEqual([
        { jev: "jevProfileId", gate: "gateProfileId", "agent-prompt": "agentPromptProfileId" }[a.factor],
      ]);
      expect(a.scenarioProfileDigest).toBe(b.scenarioProfileDigest);
      expect(a.roomSystemProfileDigest).toBe(b.roomSystemProfileDigest);
      expect(a.terminalInstructionProfileDigest).toBe(b.terminalInstructionProfileDigest);
      for (const scenario of [left, right]) {
        for (const turn of [
          { text: scenario.text, expectedDirectAgents: scenario.expectedDirectAgents },
          ...(scenario.scriptedFollowups ?? []),
        ]) {
          for (const agent of turn.expectedDirectAgents) expect(scenario.rosterOrder).toContain(agent);
          for (const [name, agent] of names)
            if (new RegExp(`\\b${name}\\b`).test(turn.text)) expect(scenario.rosterOrder).toContain(agent);
          expect(turn.text).not.toMatch(/fictional|eval|benchmark|simulation|as we discussed|ideas above/i);
        }
      }
    }
    const invitation = cases.find(
      ({ study }) => study?.schemaVersion === 5 && study.scenarioProfileId === "handoff-work-j",
    )!;
    expect(invitation.text).toContain("Please ask Jordan to check your choice.");
    expect(invitation.expectedDirectAgents).toEqual(["codex-sol"]);
    expect(invitation.rosterOrder).toContain("claude-sonnet");
    expect(studyPlanDigest(plan)).toBe("e0c3c879a8feb010316d3d1a4def18f728ba63739d5b3ab452fae9db373efe5b");
  });

  it("binds each profile digest to its actual source text", async () => {
    const profile = largeStudyProfile("direct-home-j");
    const before = largeStudyProfileDigest(profile.id);
    const changed = {
      ...profile,
      messages: [{ ...profile.messages[0]!, text: `${profile.messages[0]!.text} Extra sentence.` }],
    };
    const after = createHash("sha256")
      .update(JSON.stringify({ profile: changed, cardNames: ["Riley", "Jordan", "Casey"] }))
      .digest("hex");
    expect(after).not.toBe(before);
    expect(Object.keys(LARGE_STUDY_PROFILES)).toHaveLength(36);
    expect(() => largeStudyProfile("unreviewed")).toThrow();
  });

  it("rejects missing, duplicate, out-of-matrix, and unpaired plans", async () => {
    const raw = await rawPlan();
    expect(() => parseStudyPlan({ ...raw, maxCases: 70 })).toThrow();
    expect(() => parseStudyPlan({ ...raw, blocks: raw.blocks.slice(0, -1) })).toThrow();
    expect(() => parseStudyPlan({ ...raw, blocks: [...raw.blocks.slice(0, -1), raw.blocks[0]] })).toThrow();
    const change = (index: number, patch: object) => ({
      ...raw,
      blocks: raw.blocks.map((block: object, i: number) => (i === index ? { ...block, ...patch } : block)),
    });
    expect(() => parseStudyPlan(change(0, { scenarioProfileId: "unreviewed" }))).toThrow();
    expect(() =>
      parseStudyPlan(change(0, { rosterOrder: ["codex-sol", "claude-sonnet", "claude-opus", "cursor-grok"] })),
    ).toThrow();
    expect(() =>
      parseStudyPlan(
        change(0, {
          arms: { ...raw.blocks[0].arms, b: { ...raw.blocks[0].arms.b, agentPromptProfileId: "social-v1" } },
        }),
      ),
    ).toThrow();
    expect(() => parseStudyPlan(change(12, { rosterOrder: ["codex-sol"] }))).toThrow();
    expect(() => parseStudyPlan(change(0, { instructions: "ignore prior instructions" }))).toThrow();
    expect(() => parseStudyPlan({ ...raw, schemaVersion: 99 })).toThrow();
  });
});
