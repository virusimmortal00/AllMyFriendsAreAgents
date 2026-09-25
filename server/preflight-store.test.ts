import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { PreflightStore } from "./preflight-store.js";
import type { AgentRoutingDecision } from "./preflight-gate.js";
import { requiredAt } from "./test-invariants.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function store() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "amfaa-preflight-"));
  directories.push(directory);
  return PreflightStore.open(directory);
}

describe("pre-flight routing persistence and evidence", () => {
  it("retains historical low-score suppression reasons across reopen", async () => {
    const first = await store();
    await first.recordDecision({
      triggerMessageId: "legacy-low-score", mode: "shadow", energy: "balanced",
      decision: {
        qualifyingForStarvation: true,
        decisions: [{ agent: "claude-sonnet", outcome: "suppress", reason: "classified_irrelevant" }],
      },
    });
    const reopened = await PreflightStore.open(path.dirname(first.path));
    expect((await reopened.rawDecisions())[0]?.agents[0]).toMatchObject({
      agent: "claude-sonnet", outcome: "suppress", reason: "classified_irrelevant",
    });
  });

  it("persists starvation counters without fabricating generation identifiers", async () => {
    const first = await store();
    const record = await first.recordDecision({
      triggerMessageId: "message-1", mode: "enforce", energy: "balanced",
      decision: {
        qualifyingForStarvation: true,
        decisions: [
          { agent: "codex-sol", outcome: "invoke", reason: "ambient_selection" },
          { agent: "claude-sonnet", outcome: "suppress", reason: "no_routing_signal" },
        ],
      },
    });
    expect(record).not.toHaveProperty("generationId");
    expect(record.agents[1]).not.toHaveProperty("generationId");
    const reopened = await PreflightStore.open(path.dirname(first.path));
    expect(await reopened.routingState()).toMatchObject({ "codex-sol": { consecutiveQualifyingSuppressions: 0 }, "claude-sonnet": { consecutiveQualifyingSuppressions: 1 } });
    expect(JSON.parse(await readFile(first.path, "utf8"))).not.toHaveProperty("generationId");
  });

  it("counts ambiguous shadow speech conservatively as a false suppression", async () => {
    const routing = await store();
    const record = await routing.recordDecision({
      triggerMessageId: "message-1", mode: "shadow", energy: "low",
      at: "2026-08-20T12:00:00.000Z",
      decision: {
        qualifyingForStarvation: true,
        decisions: [{ agent: "claude-sonnet", outcome: "suppress", reason: "no_routing_signal" }],
      },
    });
    await routing.recordDisposition(record.decisionId, "claude-sonnet", { action: "speak", distinct: true });
    await routing.recordDecision({
      triggerMessageId: "message-2", mode: "shadow", energy: "low",
      at: "2026-08-27T12:00:01.000Z",
      decision: { qualifyingForStarvation: false, decisions: [{ agent: "claude-sonnet", outcome: "invoke", reason: "required_mention" }] },
    });
    expect(await routing.evidence(new Date("2026-08-27T12:00:01.000Z").getTime())).toMatchObject({
      evaluatedShadowSuppressions: 1,
      falseSuppressions: 1,
      falseSuppressionRate: 1,
    });
  });

  it("reports a null rate without evaluated shadow suppressions", async () => {
    const routing = await store();
    await routing.recordDecision({
      triggerMessageId: "message-1", mode: "shadow", energy: "low",
      at: "2026-08-20T12:00:00.000Z",
      decision: { qualifyingForStarvation: true, decisions: [{ agent: "claude-sonnet", outcome: "suppress", reason: "no_routing_signal" }] },
    });
    await routing.recordDecision({
      triggerMessageId: "message-2", mode: "shadow", energy: "low", at: "2026-08-27T12:00:01.000Z",
      decision: { qualifyingForStarvation: false, decisions: [{ agent: "claude-sonnet", outcome: "invoke", reason: "required_mention" }] },
    });
    expect(await routing.evidence(new Date("2026-08-27T12:00:01.000Z").getTime())).toMatchObject({
      evaluatedShadowSuppressions: 0,
      falseSuppressionRate: null,
    });
  });


  it("records the full shadow-decision window span in days", async () => {

    const routing = await store();
    const record = await routing.recordDecision({
      triggerMessageId: "message-1", mode: "shadow", energy: "low", at: "2026-08-20T12:00:00.000Z",
      decision: { qualifyingForStarvation: true, decisions: [{ agent: "claude-sonnet", outcome: "suppress", reason: "no_routing_signal" }] },
    });
    await routing.recordDisposition(record.decisionId, "claude-sonnet", { action: "yield" });
    await routing.recordDecision({
      triggerMessageId: "message-2", mode: "shadow", energy: "low", at: "2026-08-27T12:00:01.000Z",
      decision: { qualifyingForStarvation: false, decisions: [{ agent: "claude-sonnet", outcome: "invoke", reason: "required_mention" }] },
    });
    expect(await routing.evidence(new Date("2026-08-27T12:00:01.000Z").getTime())).toMatchObject({
      evaluatedShadowSuppressions: 1,
      falseSuppressionRate: 0,
      shadowDaysRecorded: 7.000011574074074,

    });
  });


  it("records zero shadow days for a single shadow observation", async () => {

    const routing = await store();
    const record = await routing.recordDecision({
      triggerMessageId: "message-1", mode: "shadow", energy: "low", at: "2026-08-20T12:00:00.000Z",
      decision: { qualifyingForStarvation: true, decisions: [{ agent: "claude-sonnet", outcome: "suppress", reason: "no_routing_signal" }] },
    });
    await routing.recordDisposition(record.decisionId, "claude-sonnet", { action: "yield" });
    expect(await routing.evidence(new Date("2026-08-27T12:00:01.000Z").getTime())).toMatchObject({
      shadowDaysRecorded: 0,
    });
  });


  it("counts 200 completed shadow suppressions within a single day", async () => {

    const routing = await store();
    for (let index = 0; index < 200; index += 1) {
      const record = await routing.recordDecision({
        triggerMessageId: `message-${index}`, mode: "shadow", energy: "low", at: "2026-08-27T12:00:00.000Z",
        decision: { qualifyingForStarvation: true, decisions: [{ agent: "claude-sonnet", outcome: "suppress", reason: "no_routing_signal" }] },
      });
      await routing.recordDisposition(record.decisionId, "claude-sonnet", { action: "yield" });
    }
    expect(await routing.evidence(new Date("2026-08-27T12:01:00.000Z").getTime())).toMatchObject({
      evaluatedShadowSuppressions: 200,
      falseSuppressionRate: 0,
    });
  });


  it("computes the false-suppression rate from evaluated dispositions", async () => {

    const routing = await store();
    for (let index = 0; index < 20; index += 1) {
      const record = await routing.recordDecision({
        triggerMessageId: `message-${index}`, mode: "shadow", energy: "low",
        at: index === 19 ? "2026-08-27T12:00:01.000Z" : "2026-08-20T12:00:00.000Z",
        decision: { qualifyingForStarvation: true, decisions: [{ agent: "claude-sonnet", outcome: "suppress", reason: "no_routing_signal" }] },
      });
      await routing.recordDisposition(record.decisionId, "claude-sonnet", index === 0 ? { action: "speak", distinct: true } : { action: "yield" });
    }
    expect(await routing.evidence(new Date("2026-08-27T12:00:01.000Z").getTime())).toMatchObject({
      evaluatedShadowSuppressions: 20,
      falseSuppressions: 1,
      falseSuppressionRate: 0.05,
    });
  });
});

describe("pre-flight classification persistence and evidence", () => {
  const baselineDecisions: AgentRoutingDecision[] = [
    { agent: "codex-sol", outcome: "invoke", reason: "fallback" },
    { agent: "claude-sonnet", outcome: "suppress", reason: "no_routing_signal" },
  ];
  const classification = {
    model: "jev-latest",
    latencyMs: 420,
    inputTokens: 1800,
    outputTokens: 96,
    costUsd: 0.0000756,
    wholeRoomProbability: 0.03,
    addressProbabilities: { "codex-sol": 0.91, "claude-sonnet": 0.02 },
    baseline: baselineDecisions.map((entry) => ({ ...entry })),
  };

  it("persists a classification consult and its baseline across reopen", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "amfaa-preflight-"));
    directories.push(directory);
    const first = await PreflightStore.open(directory);
    await first.recordDecision({
      triggerMessageId: "message-1", mode: "shadow", energy: "balanced",
      decision: { qualifyingForStarvation: true, decisions: baselineDecisions.map((entry) => ({ ...entry })) },
      classification: { ...classification, providerResolvedModelId: "typesafe/jev-1.13", optionalWorthProbabilities: { "codex-sol": 0.15, "claude-sonnet": 0.8 } },
    });

    const reopened = await PreflightStore.open(directory);
    const decisions = await reopened.rawDecisions();
    expect(requiredAt(decisions,0,"reopened preflight decision").classification).toEqual({
      ...classification, providerResolvedModelId: "typesafe/jev-1.13", optionalWorthProbabilities: { "codex-sol": 0.15, "claude-sonnet": 0.8 },
    });
  });

  it("migrates an earlier classification record with no optional-worth predictions", async () => {
    const first = await store();
    await first.recordDecision({
      triggerMessageId: "legacy-classification", mode: "shadow", energy: "balanced",
      decision: { qualifyingForStarvation: true, decisions: baselineDecisions.map((entry) => ({ ...entry })) },
      classification,
    });
    const reopened = await PreflightStore.open(path.dirname(first.path));
    expect((await reopened.rawDecisions())[0]?.classification).toEqual(classification);
  });

  it("drops a malformed classification while keeping the routing decision", async () => {
    const routing = await store();
    await routing.recordDecision({
      triggerMessageId: "message-1", mode: "shadow", energy: "balanced",
      decision: { qualifyingForStarvation: true, decisions: baselineDecisions.map((entry) => ({ ...entry })) },
      classification: { ...classification, wholeRoomProbability: 7 },
    });

    const decisions = await routing.rawDecisions();
    const decision=requiredAt(decisions,0,"sanitized preflight decision");
    expect(decision.classification).toBeUndefined();
    expect(decision.agents).toHaveLength(2);
  });

  it("aggregates counterfactual savings only from turns that ran with metrics", async () => {
    const routing = await store();
    const record = await routing.recordDecision({
      triggerMessageId: "message-1", mode: "shadow", energy: "balanced",
      decision: {
        qualifyingForStarvation: true,
        decisions: [
          { agent: "codex-sol", outcome: "invoke", reason: "classified_addressed" },
          { agent: "claude-sonnet", outcome: "suppress", reason: "classified_irrelevant" },
        ],
      },
      classification: {
        ...classification,
        baseline: [
          { agent: "codex-sol" as const, outcome: "invoke" as const, reason: "fallback" },
          { agent: "claude-sonnet" as const, outcome: "invoke" as const, reason: "ambient_selection" },
        ],
      },
    });
    await routing.recordDisposition(record.decisionId, "claude-sonnet", { action: "yield", costUsd: 0.021, durationMs: 18_400 });
    const evidence = await routing.evidence();
    expect(evidence.classification).toEqual({
      calls: 1,
      model: "jev-latest",
      totalInputTokens: 1800,
      totalOutputTokens: 96,
      totalCostUsd: 0.0000756,
      averageLatencyMs: 420,
      additionalSuppressions: 1,
      additionalInvocations: 0,
      suppressedSpoke: 0,
      suppressedYield: 1,
      rescuedSpoke: 0,
      counterfactualSavedCostUsd: 0.021,
      counterfactualSavedDurationMs: 18_400,
    });
  });

  it("counts a shadow-suppressed turn that spoke as a false suppression and kept cost", async () => {
    const routing = await store();
    const record = await routing.recordDecision({
      triggerMessageId: "message-1", mode: "shadow", energy: "balanced",
      decision: {
        qualifyingForStarvation: true,
        decisions: [{ agent: "claude-sonnet", outcome: "suppress", reason: "classified_irrelevant" }],
      },
      classification: {
        ...classification,
        baseline: [{ agent: "claude-sonnet" as const, outcome: "invoke" as const, reason: "ambient_selection" }],
      },
    });
    await routing.recordDisposition(record.decisionId, "claude-sonnet", { action: "speak", distinct: true, costUsd: 0.05, durationMs: 30_000 });
    const evidence = await routing.evidence();
    expect(evidence.falseSuppressions).toBe(1);
    expect(evidence.classification).toMatchObject({
      suppressedSpoke: 1,
      counterfactualSavedCostUsd: 0.05,
      counterfactualSavedDurationMs: 30_000,
    });
  });

  it("counts a rescued invocation that spoke, without crediting savings", async () => {
    const routing = await store();
    const record = await routing.recordDecision({
      triggerMessageId: "message-1", mode: "shadow", energy: "balanced",
      decision: {
        qualifyingForStarvation: true,
        decisions: [{ agent: "codex-sol", outcome: "invoke", reason: "classified_addressed" }],
      },
      classification: {
        ...classification,
        baseline: [{ agent: "codex-sol" as const, outcome: "suppress" as const, reason: "no_routing_signal" }],
      },
    });
    await routing.recordDisposition(record.decisionId, "codex-sol", { action: "speak", distinct: true, costUsd: 0.02, durationMs: 9_000 });
    expect(await routing.evidence()).toMatchObject({
      classification: {
        additionalInvocations: 1,
        rescuedSpoke: 1,
        additionalSuppressions: 0,
        counterfactualSavedCostUsd: 0,
      },
    });
  });

  it("marks aggregate evidence as mixed when decisions use different models", async () => {
    const routing = await store();
    for (const [index, model] of ["jev-v1", "jev-v2"].entries()) {
      await routing.recordDecision({
        triggerMessageId: `message-${index}`, mode: "shadow", energy: "balanced",
        decision: { qualifyingForStarvation: true, decisions: baselineDecisions.map((entry) => ({ ...entry })) },
        classification: { ...classification, model },
      });
    }
    expect((await routing.evidence()).classification).toMatchObject({ calls: 2, model: "mixed" });
  });

  it("omits classification evidence when no classified decisions exist", async () => {
    const routing = await store();
    await routing.recordDecision({
      triggerMessageId: "message-1", mode: "shadow", energy: "balanced",
      decision: { qualifyingForStarvation: true, decisions: [{ agent: "codex-sol", outcome: "invoke", reason: "fallback" }] },
    });
    expect(await routing.evidence()).not.toHaveProperty("classification");
  });
});
