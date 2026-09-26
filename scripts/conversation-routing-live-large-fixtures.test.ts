import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { decidePreflight } from "../server/preflight-gate.js";
import type { RoomMessage, RoomState } from "../server/types.js";
import { DEFAULT_PARTICIPANT_STYLES } from "../shared/chat-style.js";
import { CONVERSATION_OPTIONAL_SEATS } from "../shared/conversation-energy.js";
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
      ["agent-prompt", "casual", "everyday", "ba"],
      ["gate", "handoff", "everyday", "ab"],
      ["jev", "direct", "practical", "ab"],
    ]);
    expect(
      cases
        .filter((_, index) => index % 2 === 0)
        .slice(0, 3)
        .map(({ study }) => (study?.schemaVersion === 5 ? study.scenarioProfileId : null)),
    ).toEqual(["casual-home-p", "handoff-home-g", "direct-work-j"]);
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
    expect(studyPlanDigest(plan)).toBe("1a383295b7140df1550687441b3079a295435b09050c6637e29fe4c0fd5f66dc");
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

  it("makes ten gate pairs capable of changing optional routing and keeps two broadcasts as controls", async () => {
    const cases = expandStudyPlan(parseStudyPlan(await rawPlan()));
    const gatePairs = cases.filter(({ study }) => study?.factor === "gate" && study.arm === "a");
    let active = 0;
    let controls = 0;
    for (const left of gatePairs) {
      const right = cases.find((item) => item.study?.pairId === left.study?.pairId && item.study?.arm === "b")!;
      const turns = [
        { text: left.text, expectedDirectAgents: left.expectedDirectAgents },
        ...(left.scriptedFollowups ?? []),
      ];
      const turn = turns.find((item) => item.expectedDirectAgents.length < left.rosterOrder!.length)!;
      const trigger: RoomMessage = {
        id: "human-1",
        speaker: "you",
        text: turn.text,
        timestamp: "2026-09-26T12:00:00.000Z",
        kind: "chat",
      };
      const room: RoomState = {
        messages: [trigger],
        sessions: {},
        status: "idle",
        settings: {
          roomName: "Fixture",
          topic: "Fixture",
          writableAgent: "nobody",
          conversationEnergy: left.energy,
          projectPath: "/fixture",
          participantStyles: structuredClone(DEFAULT_PARTICIPANT_STYLES),
        },
        roster: {
          revision: 1,
          entries: left.rosterOrder!.map((agentId) => ({
            agentId,
            enabled: true,
            conversationalName: [...names].find(([, id]) => id === agentId)?.[0] ?? agentId,
          })),
        },
      };
      const optional = left.rosterOrder!.filter((agent) => !turn.expectedDirectAgents.includes(agent));
      const optionalWorth = Object.fromEntries(
        optional.map((agent, index) => [
          agent,
          index === optional.length - 1 && turn.expectedDirectAgents.length === 0 ? 1 : 0,
        ]),
      );
      const required = Object.fromEntries(turn.expectedDirectAgents.map((agent) => [agent, 1]));
      const decide = (scenario: typeof left) =>
        decidePreflight({
          trigger,
          room,
          rankedAgents: scenario.rosterOrder!,
          health: {},
          routing: {},
          energy: scenario.energy,
          wholeRoomInvitation: scenario.dynamic === "broadcast",
          classification: { agents: required, wholeRoom: 0, optionalWorth },
          gateProfileId: scenario.study!.gateProfileId as "current-v1" | "relevance-v1",
        });
      const a = decide(left),
        b = decide(right);
      for (const agent of turn.expectedDirectAgents) {
        expect(a.decisions.find((row) => row.agent === agent)?.outcome).toBe("invoke");
        expect(b.decisions.find((row) => row.agent === agent)?.outcome).toBe("invoke");
      }
      if (left.dynamic === "broadcast") {
        controls++;
        expect(a.decisions).toEqual(b.decisions);
      } else {
        active++;
        expect(CONVERSATION_OPTIONAL_SEATS[left.energy]).not.toBe(0);
        expect(a.decisions, left.study?.schemaVersion === 5 ? left.study.scenarioProfileId : "gate-pair").not.toEqual(
          b.decisions,
        );
      }
    }
    expect({ active, controls }).toEqual({ active: 10, controls: 2 });
  });

  it("keeps prompt treatments optional-capable outside two broadcast controls", async () => {
    const cases = expandStudyPlan(parseStudyPlan(await rawPlan()));
    const promptPairs = cases.filter(({ study }) => study?.factor === "agent-prompt" && study.arm === "a");
    const opportunity = promptPairs.filter(
      (item) =>
        item.dynamic !== "broadcast" &&
        CONVERSATION_OPTIONAL_SEATS[item.energy] !== 0 &&
        [{ expectedDirectAgents: item.expectedDirectAgents }, ...(item.scriptedFollowups ?? [])].some(
          (turn) => turn.expectedDirectAgents.length < item.rosterOrder!.length,
        ),
    );
    expect(opportunity).toHaveLength(10);
    expect(
      opportunity.map((item) => (item.study?.schemaVersion === 5 ? item.study.scenarioProfileId : null)).sort(),
    ).toEqual([
      "casual-home-p",
      "casual-work-p",
      "direct-home-p",
      "direct-work-p",
      "dispute-work-p",
      "handoff-home-p",
      "handoff-work-p",
      "multi-home-p",
      "multi-work-p",
      "quoted-home-p",
    ]);
    expect(
      promptPairs
        .filter((item) => item.dynamic === "broadcast")
        .map((item) => (item.study?.schemaVersion === 5 ? item.study.scenarioProfileId : null))
        .sort(),
    ).toEqual(["broadcast-home-p", "broadcast-work-p"]);
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
    const exchangeIndex = raw.blocks.findIndex((block: { dynamic: string }) => block.dynamic === "multi-address");
    expect(() => parseStudyPlan(change(exchangeIndex, { arcProfileId: "agent-exchange-v1" }))).toThrow("closed matrix");
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
    const gateDirect = raw.blocks.findIndex(
      (block: { scenarioProfileId: string }) => block.scenarioProfileId === "direct-home-g",
    );
    expect(() => parseStudyPlan(change(gateDirect, { energy: "low" }))).toThrow("optional-capable");
    const promptDirect = raw.blocks.findIndex(
      (block: { scenarioProfileId: string }) => block.scenarioProfileId === "direct-home-p",
    );
    expect(() => parseStudyPlan(change(promptDirect, { rosterOrder: ["codex-sol"] }))).toThrow("optional-capable");
    expect(() => parseStudyPlan(change(0, { instructions: "ignore prior instructions" }))).toThrow();
    expect(() => parseStudyPlan({ ...raw, schemaVersion: 99 })).toThrow();
  });
});
