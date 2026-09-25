import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PreflightAuditRecord } from "../server/preflight-store.js";
import { collectLiveScenarioEvidence, readRoutingEvents } from "./conversation-routing-live-evidence.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function fixture() {
  const triggerMessageId = "trigger_12345678",
    jobId = "job_12345678",
    runId = "run_12345678",
    generationId = "gen_12345678";
  const records: Record<string, unknown>[] = [
    { event: "conversation.trigger.stage", triggerMessageId, jobId, stage: "consumed", queueDelayMs: 12 },
    {
      event: "conversation.trigger.stage",
      triggerMessageId,
      jobId,
      stage: "classifier",
      outcome: "completed",
      durationMs: 73,
    },
    {
      event: "conversation.trigger.stage",
      triggerMessageId,
      jobId,
      stage: "preflight-completed",
      outcome: "routed",
      classifier: "completed",
    },
    { event: "conversation.trigger.stage", triggerMessageId, jobId, stage: "first-visible", timeToFirstVisibleMs: 805 },
    {
      event: "conversation.trigger.stage",
      triggerMessageId,
      jobId,
      stage: "generation-completed",
      generationId,
      attemptOrdinal: 1,
    },
    {
      event: "conversation.trigger.stage",
      triggerMessageId,
      jobId,
      stage: "terminal",
      reason: "no-explicit-unresolved-state",
    },
    { event: "conversation.run.started", jobId, runId, runEventSequence: 1 },
    {
      event: "conversation.turn.finished",
      jobId,
      runId,
      runEventSequence: 2,
      turnId: "turn_12345678",
      generationId,
      outcome: "responded",
    },
    {
      event: "conversation.run.completed",
      jobId,
      runId,
      runEventSequence: 3,
      attemptedEventCount: 3,
      outcome: "completed",
      reason: "no-explicit-unresolved-state",
      summary: { counts: { attemptedTurns: 1, respondedTurns: 1, yieldedTurns: 0, confirmedDeliveredBursts: 1 } },
    },
    { event: "generation.started", jobId, runId, turnId: "turn_12345678", generationId },
    { event: "generation.completed", jobId, runId, turnId: "turn_12345678", generationId },
    {
      event: "generation.delivery",
      jobId,
      runId,
      turnId: "turn_12345678",
      generationId,
      confirmedDeliveredBurstCount: 1,
    },
    {
      event: "provider.exchange.observed",
      jobId,
      runId,
      turnId: "turn_12345678",
      generationId,
      usage: {
        inputTokens: 2,
        outputTokens: 29,
        totalTokens: 131,
        openCodeObservedInputTokens: 2,
        openCodeObservedOutputTokens: 29,
        openCodeObservedReasoningTokens: 0,
        openCodeObservedCacheReadTokens: 100,
        openCodeObservedCacheWriteTokens: 0,
        openCodeObservedTotalTokens: 131,
      },
      costUsd: 0.009,
      openCodeEstimatedCostUsd: 0.009,
    },
  ];
  const preflight: PreflightAuditRecord[] = [
    {
      decisionId: "decision_12345678",
      triggerMessageId,
      at: "2026-09-25T00:00:00.000Z",
      mode: "enforce",
      energy: "low",
      qualifyingForStarvation: false,
      classification: {
        model: "fixture-jev",
        latencyMs: 73,
        inputTokens: 2,
        outputTokens: 1,
        costUsd: 0.001,
        wholeRoomProbability: 0,
        addressProbabilities: {},
        baseline: [],
      },
      agents: [
        { agent: "codex-sol", outcome: "invoke", reason: "required_plain_address" },
        { agent: "claude-sonnet", outcome: "suppress", reason: "no_routing_signal" },
      ],
    },
  ];
  return { triggerMessageId, records, preflight };
}

describe("live routing scalar extraction", () => {
  it("joins one trigger, run, generation, provider report and required address without copying text", () => {
    const input = fixture();
    input.records.push({ event: "opencode.stdout", runId: "run_12345678", output: "private-output" });
    const result = collectLiveScenarioEvidence({
      scenarioId: "direct-2-low-enforce",
      variant: "jev-on",
      preflightMode: "enforce",
      records: input.records,
      preflightDecisions: input.preflight,
      triggerMessageId: input.triggerMessageId,
    });
    expect(result).toMatchObject({
      scenarioId: "direct-2-low-enforce",
      variant: "jev-on",
      runId: "run_12345678",
      requiredAddressAgents: ["codex-sol"],
      classifier: { outcome: "completed", durationMs: 73 },
      queueDelayMs: 12,
      firstVisibleMs: 805,
      attemptedTurns: 1,
      respondedTurns: 1,
      generationStarts: 1,
      generationCompletions: 1,
      openCodeUsageProvenance: "step-fields-v1",
      openCodeObservedInputTokens: 2,
      openCodeObservedOutputTokens: 29,
      openCodeObservedReasoningTokens: 0,
      openCodeObservedCacheReadTokens: 100,
      openCodeObservedCacheWriteTokens: 0,
      openCodeObservedTotalTokens: 131,
      openCodeEstimatedCostUsd: 0.009,
      openCodeUsageCoverage: "reported",
      openCodeTotalCoverage: "reported",
    });
    expect(JSON.stringify(result)).not.toContain("private-output");
  });

  it("keeps missing and incomplete usage unknown, including a started generation without completion", () => {
    const input = fixture();
    input.records = input.records.filter((record) => record.event !== "provider.exchange.observed");
    const base = {
      scenarioId: "direct-2-low-enforce",
      variant: "jev-off" as const,
      preflightMode: "enforce" as const,
      records: input.records,
      preflightDecisions: input.preflight,
      triggerMessageId: input.triggerMessageId,
    };
    expect(collectLiveScenarioEvidence(base)).toMatchObject({
      openCodeObservedInputTokens: null,
      openCodeEstimatedCostUsd: null,
      openCodeUsageCoverage: "missing",
    });
    input.records.push({
      event: "provider.exchange.observed",
      runId: "run_12345678",
      generationId: "gen_12345678",
      usage: { openCodeObservedInputTokens: 2, openCodeObservedOutputTokens: 29, openCodeObservedTotalTokens: 131 },
      costUsd: 0.009,
      openCodeEstimatedCostUsd: 0.009,
    });
    input.records.push({ event: "generation.started", runId: "run_12345678", generationId: "gen_failed" });
    expect(collectLiveScenarioEvidence(base)).toMatchObject({
      openCodeUsageCoverage: "partial",
      openCodeTotalCoverage: "partial",
      openCodeObservedTotalTokens: null,
    });
  });

  it("does not infer OpenCode field presence from normalized token or cost fallback", () => {
    const input = fixture();
    const provider = input.records.find((record) => record.event === "provider.exchange.observed")!;
    provider.usage = { inputTokens: 2, outputTokens: 29, totalTokens: 31 };
    delete provider.openCodeEstimatedCostUsd;
    const legacy = collectLiveScenarioEvidence({
      scenarioId: "direct-2-low-enforce",
      variant: "jev-on",
      preflightMode: "enforce",
      records: input.records,
      preflightDecisions: input.preflight,
      triggerMessageId: input.triggerMessageId,
    });
    expect(legacy).toMatchObject({
      openCodeUsageCoverage: "missing",
      openCodeEstimatedCostUsd: null,
      openCodeTotalCoverage: "missing",
      openCodeObservedTotalTokens: null,
    });
    provider.usage = { openCodeObservedInputTokens: 2, openCodeObservedOutputTokens: 29, totalTokens: 31 };
    provider.openCodeEstimatedCostUsd = 0.009;
    const result = collectLiveScenarioEvidence({
      scenarioId: "direct-2-low-enforce",
      variant: "jev-on",
      preflightMode: "enforce",
      records: input.records,
      preflightDecisions: input.preflight,
      triggerMessageId: input.triggerMessageId,
    });
    expect(result).toMatchObject({
      openCodeUsageCoverage: "reported",
      openCodeEstimatedCostUsd: 0.009,
      openCodeTotalCoverage: "missing",
      openCodeObservedTotalTokens: null,
      openCodeObservedCacheReadTokens: null,
      openCodeObservedCacheWriteTokens: null,
      openCodeObservedReasoningTokens: null,
    });
  });

  it("rejects ambiguous or missing terminal and run sequence evidence", () => {
    const input = fixture();
    const base = {
      scenarioId: "direct-2-low-enforce",
      variant: "jev-on" as const,
      preflightMode: "enforce" as const,
      records: input.records,
      preflightDecisions: input.preflight,
      triggerMessageId: input.triggerMessageId,
    };
    expect(() =>
      collectLiveScenarioEvidence({ ...base, records: input.records.filter((record) => record.stage !== "terminal") }),
    ).toThrow();
    expect(() =>
      collectLiveScenarioEvidence({
        ...base,
        records: input.records.filter((record) => record.runEventSequence !== 2),
      }),
    ).toThrow();
    expect(() => collectLiveScenarioEvidence({ ...base, preflightDecisions: [] })).toThrow();
    const { classification: _classification, ...withoutClassification } = input.preflight[0]!;
    expect(() => collectLiveScenarioEvidence({ ...base, preflightDecisions: [withoutClassification] })).toThrow(
      "Jev completion proof",
    );
    expect(() =>
      collectLiveScenarioEvidence({
        ...base,
        records: input.records.filter((record) => record.stage !== "preflight-completed"),
      }),
    ).toThrow("Jev completion proof");
  });

  it("accepts literal off mode only without a persisted decision", () => {
    const input = fixture();
    const result = collectLiveScenarioEvidence({
      scenarioId: "direct-2-low-off",
      variant: "jev-off",
      preflightMode: "off",
      records: input.records,
      preflightDecisions: [],
      triggerMessageId: input.triggerMessageId,
    });
    expect(result.requiredAddressAgents).toEqual([]);
  });
});

describe("rotated structured streams", () => {
  it("reads base and rotated generation/provider files and discards a partial trailing line", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "amfaa-routing-log-test-"));
    directories.push(root);
    await mkdir(path.join(root, "authoritative-v1"));
    const logs = path.join(root, "authoritative-v1");
    await writeFile(path.join(logs, "generations.1.jsonl"), '{"event":"generation.started"}\n');
    await writeFile(path.join(logs, "generations.jsonl"), '{"event":"conversation.run.completed"}\n{"event":"partial"');
    await writeFile(path.join(logs, "openrouter-provider.jsonl"), '{"event":"provider.exchange.observed"}\n');
    await writeFile(path.join(logs, "opencode-harness.jsonl"), '{"event":"opencode.stdout","output":"secret"}\n');
    const records = await readRoutingEvents(logs);
    expect(records.map(({ event }) => event)).toEqual([
      "generation.started",
      "conversation.run.completed",
      "provider.exchange.observed",
    ]);
    expect(JSON.stringify(records)).not.toContain("secret");
  });
});
