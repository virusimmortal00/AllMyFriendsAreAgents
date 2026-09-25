import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { PREFLIGHT_REASONS } from "../server/preflight-gate.js";
import type { PreflightAuditRecord } from "../server/preflight-store.js";
import { isActiveAgentId } from "../shared/participants.js";

type RecordValue = Record<string, unknown>;
const STREAM_FILE = /^(?:generations|openrouter-provider)(?:\.[A-Za-z0-9_-]+)?\.jsonl$/;
const MAX_STREAM_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES = 96 * 1024 * 1024;
const ADDRESS_REASONS = new Set(["required_mention", "required_plain_address", "classified_addressed"]);
const ROUTING_REASONS = new Set<string>(PREFLIGHT_REASONS);
const CLASSIFIER_REASONS = new Set([
  "no-candidates",
  "room-disabled",
  "disabled",
  "cooldown",
  "empty_input",
  "no_credential",
  "timeout",
  "authentication",
  "http",
  "transport",
  "schema",
]);
const TERMINAL_REASONS = new Set([
  "cancelled",
  "no-visible-output",
  "broadcast-settled-response",
  "conversation-floor-completed",
  "no-explicit-unresolved-state",
  "no-material-disagreement",
  "open-without-second-responder",
  "safety-ceiling",
  "synthesis-no-response",
  "synthesis-settled",
  "blocked-input",
  "no-material-objection",
  "reconciliation-no-response",
  "reconciliation-settled",
  "unresolved-reconciliation",
  "queue-exhausted",
  "follow-up-limit",
  "attempt-ceiling",
  "run-failed",
]);
const EVIDENCE_ID = /^[A-Za-z0-9_-]{1,100}$/;

export interface LiveScenarioResult {
  schemaVersion: 1;
  openCodeUsageProvenance: "step-fields-v1";
  scenarioId: string;
  variant: "jev-on" | "jev-off";
  runId: string | null;
  preflightMode: "off" | "shadow" | "enforce";
  requiredAddressAgents: string[];
  routing: Array<{ agentId: string; outcome: "invoke" | "suppress" | "unavailable"; reason: string }>;
  classifier: {
    outcome: "completed" | "failed" | "skipped" | "not-consulted";
    reason: string | null;
    resolvedModelId: string | null;
    durationMs: number | null;
    reportedInputTokens: number | null;
    reportedOutputTokens: number | null;
    reportedCostUsd: number | null;
  };
  queueDelayMs: number | null;
  firstVisibleMs: number | null;
  terminalReason: string;
  attemptedTurns: number;
  respondedTurns: number;
  yieldedTurns: number;
  confirmedDeliveredBursts: number;
  generationStarts: number;
  generationCompletions: number;
  generationFailures: number;
  openCodeObservedInputTokens: number | null;
  openCodeObservedOutputTokens: number | null;
  openCodeObservedReasoningTokens: number | null;
  openCodeObservedCacheReadTokens: number | null;
  openCodeObservedCacheWriteTokens: number | null;
  openCodeObservedTotalTokens: number | null;
  openCodeEstimatedCostUsd: number | null;
  openCodeUsageCoverage: "reported" | "partial" | "missing";
  openCodeTotalCoverage: "reported" | "partial" | "missing";
}

function object(value: unknown): RecordValue | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as RecordValue) : null;
}
function string(value: unknown): string | null {
  return typeof value === "string" && EVIDENCE_ID.test(value) ? value : null;
}
function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function nonnegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
function event(record: RecordValue, name: string) {
  return record.event === name;
}

/** Reads only the two required streams, including rotated filenames. Raw records never leave the isolated process. */
export async function readRoutingEvents(directory: string): Promise<RecordValue[]> {
  const names = (await readdir(directory)).filter((name) => STREAM_FILE.test(name)).sort();
  if (!names.some((name) => /^generations(?:\.|\.jsonl)/.test(name)))
    throw new Error("Generation evidence stream is missing.");
  let totalBytes = 0;
  const records: RecordValue[] = [];
  for (const name of names) {
    const filename = path.join(directory, name);
    const size = (await stat(filename)).size;
    totalBytes += size;
    if (size > MAX_STREAM_BYTES || totalBytes > MAX_TOTAL_BYTES)
      throw new Error("Routing evidence exceeds the bounded stream limit.");
    const content = await readFile(filename, "utf8");
    // A writer may be appending the final line while the harness polls. Only complete lines are evidence.
    const complete = content.endsWith("\n") ? content : content.slice(0, content.lastIndexOf("\n") + 1);
    for (const line of complete.split("\n")) {
      if (!line) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new Error("Structured routing evidence is malformed.");
      }
      const value = object(parsed);
      if (!value || typeof value.event !== "string") throw new Error("Structured routing evidence is malformed.");
      records.push(value);
    }
  }
  return records;
}

/** Extracts a closed scalar projection. Throws when a run cannot be attributed to this trigger. */
export function collectLiveScenarioEvidence(input: {
  scenarioId: string;
  variant: "jev-on" | "jev-off";
  triggerMessageId: string;
  preflightMode: "off" | "shadow" | "enforce";
  records: readonly RecordValue[];
  preflightDecisions: readonly PreflightAuditRecord[];
}): LiveScenarioResult {
  const { scenarioId, variant, triggerMessageId, preflightMode, records } = input;
  if (!/^[a-z0-9-]{1,80}$/.test(scenarioId) || !EVIDENCE_ID.test(triggerMessageId))
    throw new Error("Scenario identity is invalid.");
  const stages = records.filter(
    (record) => event(record, "conversation.trigger.stage") && record.triggerMessageId === triggerMessageId,
  );
  const stage = (name: string) => stages.filter((record) => record.stage === name);
  const consumed = stage("consumed");
  const terminal = stage("terminal");
  if (consumed.length !== 1 || terminal.length !== 1)
    throw new Error("Trigger consumption or terminal evidence is incomplete.");
  const jobId = string(consumed[0]?.jobId);
  if (!jobId || terminal[0]?.jobId !== jobId) throw new Error("Trigger job correlation is incomplete.");
  const completedRuns = records.filter(
    (record) => event(record, "conversation.run.completed") && record.jobId === jobId,
  );
  if (completedRuns.length !== 1) throw new Error("Exactly one completed conversation run is required.");
  const completion = completedRuns[0]!;
  const runId = string(completion.runId);
  const start = records.filter(
    (record) => event(record, "conversation.run.started") && record.runId === runId && record.jobId === jobId,
  );
  if (!runId || start.length !== 1 || completion.outcome !== "completed")
    throw new Error("Conversation run evidence is incomplete.");
  const runRecords = records.filter((record) => record.runId === runId && typeof record.runEventSequence === "number");
  const sequences = runRecords.map((record) => count(record.runEventSequence));
  const expectedEvents = count(completion.attemptedEventCount);
  if (
    expectedEvents === null ||
    runRecords.length !== expectedEvents ||
    new Set(sequences).size !== expectedEvents ||
    sequences.some((sequence) => sequence === null || sequence < 1 || sequence > expectedEvents)
  ) {
    throw new Error("Conversation run event sequence is incomplete.");
  }
  const summary = object(completion.summary);
  const counts = object(summary?.counts);
  const attemptedTurns = count(counts?.attemptedTurns);
  const respondedTurns = count(counts?.respondedTurns);
  const yieldedTurns = count(counts?.yieldedTurns);
  const confirmedDeliveredBursts = count(counts?.confirmedDeliveredBursts);
  if (
    attemptedTurns === null ||
    respondedTurns === null ||
    yieldedTurns === null ||
    confirmedDeliveredBursts === null ||
    typeof completion.reason !== "string" ||
    !TERMINAL_REASONS.has(completion.reason) ||
    terminal[0]?.reason !== completion.reason
  )
    throw new Error("Conversation summary disagrees with trigger terminal evidence.");
  const decision = input.preflightDecisions.filter((record) => record.triggerMessageId === triggerMessageId);
  if (preflightMode === "off" ? decision.length !== 0 : decision.length !== 1 || decision[0]?.mode !== preflightMode) {
    throw new Error("Preflight decision evidence does not match the configured mode.");
  }
  const routing = (decision[0]?.agents ?? []).map(({ agent, outcome, reason }) => {
    if (
      !isActiveAgentId(agent) ||
      !["invoke", "suppress", "unavailable"].includes(outcome) ||
      !ROUTING_REASONS.has(reason)
    ) {
      throw new Error("Routing decision contains unsupported scalar evidence.");
    }
    return { agentId: agent, outcome, reason };
  });
  const requiredAddressAgents = routing
    .filter(({ outcome, reason }) => outcome === "invoke" && ADDRESS_REASONS.has(reason))
    .map(({ agentId }) => agentId);
  const classifierStages = stage("classifier");
  if (classifierStages.length > 1) throw new Error("Classifier evidence is ambiguous.");
  const classifierStage = classifierStages[0];
  const outcome = classifierStage?.outcome;
  if (classifierStage && outcome !== "completed" && outcome !== "failed" && outcome !== "skipped")
    throw new Error("Classifier outcome is unsupported.");
  const classifierReason = string(classifierStage?.reason) ?? string(classifierStage?.failureCategory);
  if (classifierReason && !CLASSIFIER_REASONS.has(classifierReason))
    throw new Error("Classifier reason is unsupported.");
  const classifierOutcome: LiveScenarioResult["classifier"]["outcome"] =
    outcome === "completed" || outcome === "failed" || outcome === "skipped" ? outcome : "not-consulted";
  const classification = decision[0]?.classification as
    | (NonNullable<(typeof decision)[number]["classification"]> & { providerResolvedModelId?: unknown })
    | undefined;
  // classification.model may fall back to the requested ID; only this exact optional
  // provider field can support a resolved-model claim.
  const resolvedModelId =
    classifierOutcome === "completed" &&
    typeof classification?.providerResolvedModelId === "string" &&
    /^(?=.{3,160}$)~?[a-zA-Z0-9._-]+\/[a-zA-Z0-9._/-]+$/.test(classification.providerResolvedModelId)
      ? classification.providerResolvedModelId
      : null;
  const classifier = {
    outcome: classifierOutcome,
    reason: classifierReason,
    resolvedModelId,
    durationMs: nonnegative(classifierStage?.durationMs),
    reportedInputTokens: count(classifierStage?.reportedInputTokens),
    reportedOutputTokens: count(classifierStage?.reportedOutputTokens),
    reportedCostUsd: nonnegative(classifierStage?.reportedCostUsd),
  };
  if (variant === "jev-on") {
    const routed = stage("preflight-completed");
    if (
      classifier.outcome !== "completed" ||
      routed.length !== 1 ||
      routed[0]?.jobId !== jobId ||
      routed[0]?.classifier !== "completed" ||
      routed[0]?.outcome !== "routed" ||
      !decision[0]?.classification
    )
      throw new Error("Jev completion proof is incomplete.");
  }
  const generationRecords = records.filter(
    (record) => record.runId === runId && typeof record.generationId === "string",
  );
  const starts = generationRecords.filter((record) => event(record, "generation.started"));
  const completions = generationRecords.filter((record) => event(record, "generation.completed"));
  const failures = generationRecords.filter((record) => event(record, "generation.failed"));
  const retries = generationRecords.filter((record) => event(record, "generation.retry"));
  const startedIds = new Set(starts.map((record) => record.generationId));
  if (
    startedIds.size !== starts.length ||
    completions.some((record) => !startedIds.has(record.generationId)) ||
    new Set(completions.map((record) => record.generationId)).size !== completions.length
  )
    throw new Error("Generation event correlation is inconsistent.");
  const completedIds = completions.map((record) => record.generationId);
  const turns = runRecords.filter((record) => event(record, "conversation.turn.finished"));
  for (const completionRecord of completions) {
    const turnId = string(completionRecord.turnId);
    if (
      !turnId ||
      !turns.some((turn) => turn.turnId === turnId && turn.generationId === completionRecord.generationId)
    ) {
      throw new Error("Generation-to-turn correlation is incomplete.");
    }
  }
  const generationStages = stage("generation-completed");
  for (const completionRecord of completions) {
    if (
      !generationStages.some(
        (record) =>
          record.generationId === completionRecord.generationId &&
          (record.attemptOrdinal === undefined || count(record.attemptOrdinal) !== null),
      )
    ) {
      throw new Error("Generation attempt stage is incomplete.");
    }
  }
  const usage = completedIds.map((generationId) => {
    const matches = records.filter(
      (record) =>
        event(record, "provider.exchange.observed") && record.generationId === generationId && record.runId === runId,
    );
    if (matches.length > 1) throw new Error("Provider usage evidence is ambiguous.");
    const observed = matches[0];
    const values = object(observed?.usage);
    return {
      input: count(values?.openCodeObservedInputTokens),
      output: count(values?.openCodeObservedOutputTokens),
      reasoning: count(values?.openCodeObservedReasoningTokens),
      cacheRead: count(values?.openCodeObservedCacheReadTokens),
      cacheWrite: count(values?.openCodeObservedCacheWriteTokens),
      total: count(values?.openCodeObservedTotalTokens),
      // costUsd is normalized and may contain a zero fallback; this is OpenCode's explicit estimate.
      cost: nonnegative(observed?.openCodeEstimatedCostUsd),
    };
  });
  const allGenerationsCompleted =
    usage.length > 0 && starts.length === completions.length && retries.length === 0 && failures.length === 0;
  const completeUsage =
    allGenerationsCompleted &&
    usage.every(({ input, output, cost }) => input !== null && output !== null && cost !== null);
  const anyUsage = usage.some(({ input, output, cost }) => input !== null || output !== null || cost !== null);
  const reported = (key: "input" | "output" | "cost") =>
    completeUsage ? usage.reduce((sum, entry) => sum + (entry[key] ?? 0), 0) : null;
  const completeTotal = allGenerationsCompleted && usage.every(({ total }) => total !== null);
  const anyTotal = usage.some(({ total }) => total !== null);
  const reportedBreakdown = (key: "reasoning" | "cacheRead" | "cacheWrite" | "total") =>
    allGenerationsCompleted && usage.every((entry) => entry[key] !== null)
      ? usage.reduce((sum, entry) => sum + (entry[key] ?? 0), 0)
      : null;
  const firstVisible = stage("first-visible");
  if (firstVisible.length > 1) throw new Error("First-visible timing evidence is ambiguous.");
  return {
    schemaVersion: 1,
    openCodeUsageProvenance: "step-fields-v1",
    scenarioId,
    variant,
    runId,
    preflightMode,
    requiredAddressAgents,
    routing,
    classifier,
    queueDelayMs: nonnegative(consumed[0]?.queueDelayMs),
    firstVisibleMs: nonnegative(firstVisible[0]?.timeToFirstVisibleMs),
    terminalReason: completion.reason,
    attemptedTurns,
    respondedTurns,
    yieldedTurns,
    confirmedDeliveredBursts,
    generationStarts: starts.length,
    generationCompletions: completions.length,
    generationFailures: failures.length,
    openCodeObservedInputTokens: reported("input"),
    openCodeObservedOutputTokens: reported("output"),
    openCodeObservedReasoningTokens: reportedBreakdown("reasoning"),
    openCodeObservedCacheReadTokens: reportedBreakdown("cacheRead"),
    openCodeObservedCacheWriteTokens: reportedBreakdown("cacheWrite"),
    openCodeObservedTotalTokens: reportedBreakdown("total"),
    openCodeEstimatedCostUsd: reported("cost"),
    openCodeUsageCoverage: completeUsage ? "reported" : anyUsage ? "partial" : "missing",
    openCodeTotalCoverage: completeTotal ? "reported" : anyTotal ? "partial" : "missing",
  };
}
