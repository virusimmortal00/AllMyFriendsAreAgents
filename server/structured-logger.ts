import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import path from "node:path";
import type express from "express";
import { redactDiagnosticSecrets } from "../shared/diagnostic-redaction.js";

export interface LogContext { traceId: string; spanId: string; requestId?: string; agentId?: string; operationId?: string }
const storage = new AsyncLocalStorage<LogContext>();
const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-0[01]$/;
export function parseOrCreateTraceparent(value?: string) { const match = value?.toLowerCase().match(TRACEPARENT); const traceId = match?.[1] || randomBytes(16).toString("hex"); const parentSpanId = match?.[2]; const spanId = randomBytes(8).toString("hex"); return { traceId, spanId, ...(parentSpanId ? { parentSpanId } : {}), traceparent: `00-${traceId}-${spanId}-01` }; }

export function safeError(error: unknown, includeStack = false) { if (!(error instanceof Error)) return { name: "Error", message: redactDiagnosticSecrets(String(error)).slice(0, 500) }; return { name: error.name.slice(0, 100), message: redactDiagnosticSecrets(error.message).slice(0, 500), ...(includeStack && error.stack ? { stack: redactDiagnosticSecrets(error.stack).split("\n").slice(0, 12).join("\n") } : {}) }; }

const ALLOWED_LOG_FIELDS = new Set([
  "type", "timestamp", "level", "event", "traceId", "spanId", "requestId", "operationId", "correlationId",
  "method", "path", "statusCode", "durationMs", "host", "port", "signal", "error", "name", "message", "stack",
  "generationId", "agent", "agentId", "permission", "modelId", "provider", "providerId", "variant", "resumedSession",
  "reason", "outcome", "includeDiff", "deploymentEpoch", "storedSessionEpoch", "promptCharacters", "responseCharacters",
  "toolCalls", "toolFailures", "providerSteps", "providerFinishReason", "providerUsage", "providerCostUsd", "exitCode",
  "inputTokens", "outputTokens", "reasoningTokens", "cacheReadTokens", "cacheWriteTokens", "totalTokens", "retryable",
  "visibleMessageCount", "visibleCharacters", "removedOrProtocolCharacters", "noResponse", "deliveredMessageCount", "totalVisibleMessages",
  "members", "agents", "assignments", "activeAssignments", "configured", "available", "effective", "policyRevision", "capability",
  "backend", "migration", "phase", "result", "kind", "revision", "manifestRevision", "fencingToken", "leaseStatus", "manifestStatus",
  "toolPolicy", "githubReadConfigured", "githubContributionConfigured", "readStoreConfigured", "contributionStoreConfigured", "count",
  "at", "issuedAt", "expiresAt", "present", "status", "providerSessionFresh", "effectiveCommands",
  "command", "selectorFamily", "family", "cache", "queueDelayMs", "rateLimited", "truncated", "failureKind", "statusClass",
  "coalescedEvent", "suppressedCount", "windowMs",
]);

/** Default-deny serializer: unknown keys and all content payload fields are omitted. */
export function sanitizeLogValue(value: unknown, depth = 0, includeStack = false): unknown {
  if (depth > 4) return "[bounded]";
  if (value instanceof Error) return safeError(value, includeStack);
  if (typeof value === "string") return redactDiagnosticSecrets(value).slice(0, 4_000);
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitizeLogValue(item, depth + 1, includeStack));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 100).flatMap(([key, item]) => {
    if (!ALLOWED_LOG_FIELDS.has(key) || /token|secret|password|authorization|cookie|prompt|rawResponse|stdout|stderr|instruction/i.test(key)) return [];
    return [[key, sanitizeLogValue(item, depth + 1, includeStack)]];
  }));
  return value;
}

export interface StructuredLogIdentity { schemaVersion: 1; service: string; serviceVersion: string; instanceId: string; deploymentCommit: string | null; deploymentEpoch: string | null; environment: string }
export interface StructuredLogRateLimit { maxIdentical?: number; windowMs?: number; now?: () => number }

export class StructuredLogger {
  private queue = Promise.resolve();
  private readonly identical = new Map<string, { startedAt: number; emitted: number; suppressed: number; event: string }>();
  private readonly maxIdentical: number;
  private readonly rateWindowMs: number;
  private readonly now: () => number;
  constructor(readonly filePath?: string, readonly maxBytes = 5 * 1024 * 1024, readonly rotations = 3, private readonly consoleSink: (line: string) => void = (line) => process.stdout.write(`${line}\n`), private readonly includeStacks = false, private identity: StructuredLogIdentity = { schemaVersion: 1, service: "all-my-friends-are-agents", serviceVersion: "0.1.0", instanceId: "uninitialized", deploymentCommit: null, deploymentEpoch: null, environment: "development" }, rateLimit: StructuredLogRateLimit = {}) {
    this.maxIdentical = Math.max(1, Math.min(rateLimit.maxIdentical ?? 20, 1_000));
    this.rateWindowMs = Math.max(100, Math.min(rateLimit.windowMs ?? 10_000, 60_000));
    this.now = rateLimit.now || Date.now;
  }
  setDeployment(deploymentCommit: string | null, deploymentEpoch: string | null) { this.identity = { ...this.identity, deploymentCommit, deploymentEpoch }; }
  async log(level: "debug" | "info" | "warn" | "error", event: string, fields: Record<string, unknown> = {}) {
    const context = sanitizeLogValue(storage.getStore() || {}, 0, this.includeStacks) as Record<string, unknown>;
    const safeFields = sanitizeLogValue(fields, 0, this.includeStacks) as Record<string, unknown>;
    const boundedEvent = event.slice(0, 120);
    const now = this.now();
    const signature = JSON.stringify({ level, event: boundedEvent, context, fields: safeFields });
    let state = this.identical.get(signature);
    if (state && now - state.startedAt >= this.rateWindowMs) {
      if (state.suppressed) this.emit("info", "logging.identical.coalesced", {}, { outcome: "completed", reason: "identical-event-rate-limit", coalescedEvent: state.event, suppressedCount: state.suppressed, windowMs: this.rateWindowMs }, now);
      state = undefined;
    }
    if (!state) {
      state = { startedAt: now, emitted: 0, suppressed: 0, event: boundedEvent };
      this.identical.set(signature, state);
      if (this.identical.size > 500) this.identical.delete(this.identical.keys().next().value!);
    }
    if (state.emitted >= this.maxIdentical) { state.suppressed = Math.min(state.suppressed + 1, 1_000_000); return; }
    state.emitted++;
    this.emit(level, boundedEvent, context, safeFields, now);
  }
  async flush() { await this.queue.catch(() => undefined); }
  private emit(level: "debug" | "info" | "warn" | "error", event: string, context: Record<string, unknown>, fields: Record<string, unknown>, now: number) {
    const line = JSON.stringify({ ...this.identity, timestamp: new Date(now).toISOString(), level, event, ...context, ...fields });
    try { this.consoleSink(line); } catch {}
    if (!this.filePath) return;
    this.queue = this.queue.catch(() => undefined).then(async () => { await mkdir(path.dirname(this.filePath!), { recursive: true, mode: 0o700 }); await this.rotateIfNeeded(Buffer.byteLength(line) + 1); await appendFile(this.filePath!, `${line}\n`, { mode: 0o600 }); }).catch(() => undefined);
  }
  private async rotateIfNeeded(incoming: number) { let size = 0; try { size = (await stat(this.filePath!)).size; } catch {} if (size + incoming <= this.maxBytes) return; for (let index = this.rotations - 1; index >= 1; index--) await rename(`${this.filePath}.${index}`, `${this.filePath}.${index + 1}`).catch(() => undefined); await rename(this.filePath!, `${this.filePath}.1`).catch(() => undefined); }
}

export function traceMiddleware(logger: StructuredLogger): express.RequestHandler { return (request, response, next) => { const trace = parseOrCreateTraceparent(request.header("traceparent")); const context = { traceId: trace.traceId, spanId: trace.spanId, requestId: request.header("x-request-id")?.slice(0, 100) || crypto.randomUUID() }; response.set("traceparent", trace.traceparent); response.set("x-request-id", context.requestId); const started = Date.now(); storage.run(context, () => { response.once("finish", () => { void logger.log("info", "http.request.completed", { method: request.method, path: request.path, statusCode: response.statusCode, durationMs: Date.now() - started }); }); next(); }); }; }
export function withLogContext<T>(fields: Partial<LogContext>, callback: () => T) { return storage.run({ ...(storage.getStore() || { traceId: randomBytes(16).toString("hex"), spanId: randomBytes(8).toString("hex") }), ...fields }, callback); }
