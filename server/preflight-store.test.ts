import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { PreflightStore } from "./preflight-store.js";

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
      promotionEligible: false,
      promotionEligibilityReasons: ["false_suppression_rate_too_high"],
    });
  });

  it("requires a non-empty completed denominator even after seven days", async () => {
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
      promotionEligible: false,
      promotionEligibilityReasons: ["no_evaluable_suppressions"],
    });
  });

  it("becomes eligible after seven days with a non-empty sub-five-percent sample", async () => {
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
      promotionEligible: true,
      promotionEligibilityReasons: [],
    });
  });

  it("does not treat a quiet week after one shadow observation as seven days of traffic", async () => {
    const routing = await store();
    const record = await routing.recordDecision({
      triggerMessageId: "message-1", mode: "shadow", energy: "low", at: "2026-08-20T12:00:00.000Z",
      decision: { qualifyingForStarvation: true, decisions: [{ agent: "claude-sonnet", outcome: "suppress", reason: "no_routing_signal" }] },
    });
    await routing.recordDisposition(record.decisionId, "claude-sonnet", { action: "yield" });
    expect(await routing.evidence(new Date("2026-08-27T12:00:01.000Z").getTime())).toMatchObject({
      shadowDaysRecorded: 0,
      promotionEligible: false,
      promotionEligibilityReasons: ["minimum_shadow_window_not_reached"],
    });
  });

  it("becomes eligible after 200 completed shadow suppressions before seven days", async () => {
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
      promotionEligible: true,
    });
  });

  it("requires a rate strictly below five percent", async () => {
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
      promotionEligible: false,
      promotionEligibilityReasons: ["false_suppression_rate_too_high"],
    });
  });
});
