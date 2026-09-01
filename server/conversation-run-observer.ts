import { randomUUID } from "node:crypto";
import type { ConversationConfiguration, ConversationFact, ConversationObserver, ConversationRunSummary } from "../shared/conversation-observability.js";
import { CONVERSATION_EVENT_MAX_BYTES, CONVERSATION_EVIDENCE_ID_MAX_LENGTH } from "../shared/conversation-observability.js";
import type { AuthoritativeLogging } from "./authoritative-logging.js";
import { observeSafely } from "./nonblocking-observer.js";
import { currentLogContext } from "./structured-logger.js";

/** Bounds only the new structured metadata, never existing raw evidence. */
export function boundedConversationRecord(input: Record<string, unknown>) {
  let omittedDetailCount = 0;
  const project = (value: unknown, key: string): unknown => {
    if (typeof value === "string" && /Ids?$/.test(key)) {
      if (!value) return null;
      if (Buffer.byteLength(JSON.stringify(value)) > CONVERSATION_EVIDENCE_ID_MAX_LENGTH) { omittedDetailCount++; return null; }
    }
    if (Array.isArray(value)) {
      omittedDetailCount += Math.max(0, value.length - 32);
      return value.slice(0, 32).map((item) => project(item, key));
    }
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, project(child, childKey)]));
    return value;
  };
  const record = project(input, "") as Record<string, unknown>;
  const configuration = record.configuration as { candidateIds?: unknown[] } | null;
  // Reserve room for the existing envelope and scalar run/decision fields.
  while (Buffer.byteLength(JSON.stringify(record)) > CONVERSATION_EVENT_MAX_BYTES - 3_000 && configuration?.candidateIds?.length) {
    configuration.candidateIds.pop(); omittedDetailCount++;
  }
  return { ...record, omittedDetailCount };
}

/** The orchestration boundary owns the sole start/completion emission attempts. */
export async function observeConversationRun<T>(
  logging: Pick<AuthoritativeLogging, "log">,
  engine: "energy" | "legacy",
  execute: (observer: ConversationObserver) => Promise<T>,
): Promise<T> {
  const runId = currentLogContext()?.runId || randomUUID();
  const startedAt = Date.now();
  let sequence = 0;
  let started = false;
  let summary: ConversationRunSummary | null = null;
  let failed = false;
  const emit = (event: string, level: "info" | "warn" | "error", fields: Record<string, unknown>, terminal = false) => {
    sequence += 1;
    observeSafely(() => logging.log("generations", level, event, boundedConversationRecord({
      eventVersion: 1, runId, runEventSequence: sequence, ...fields,
      ...(terminal ? { attemptedEventCount: sequence } : {}),
    }), { visibility: "operator", correlationId: runId }), undefined);
  };
  const start = (configuration: ConversationConfiguration | null) => {
    if (started) return;
    started = true;
    emit("conversation.run.started", "info", { engine, startedAt: new Date(startedAt).toISOString(), configuration });
  };
  const observer: ConversationObserver = (fact: ConversationFact) => {
    if (fact.kind === "configuration") { start(fact.configuration); return; }
    if (fact.kind === "summary") { summary = fact.summary; return; }
    start(null);
    const { kind, ...fields } = fact;
    if (kind === "decision") emit("conversation.turn.decision", "info", fields);
    else {
      const finished = fact as Extract<ConversationFact, { kind: "turn-finished" }>;
      emit("conversation.turn.finished", finished.outcome === "failed" ? "error" : finished.reason === "malformed-disposition" ? "warn" : "info", fields);
    }
  };
  try {
    return await execute(observer);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    // Setup can throw before either runner supplies its policy. Do not invent it.
    start(null);
    const terminal = summary as ConversationRunSummary | null;
    const outcome = failed ? "failed" : terminal ? "completed" : "unknown";
    const reason = failed ? "run-failed" : terminal?.reason || "summary-unavailable";
    const level = failed ? "error" : terminal?.engineSettled === false && (terminal.policy.messageCeilingReached || terminal.policy.turnCeilingReached) ? "warn" : "info";
    emit("conversation.run.completed", level, {
      engine, outcome, reason, summary: terminal, durationMs: Math.max(0, Date.now() - startedAt),
      errorCategory: failed ? terminal ? "orchestration-error" : "preparation-error" : null,
    }, true);
  }
}
