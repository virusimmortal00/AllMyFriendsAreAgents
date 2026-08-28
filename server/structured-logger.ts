import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import path from "node:path";
import type express from "express";
import { redactDiagnosticSecrets } from "../shared/diagnostic-redaction.js";

export type LogVisibility = "operator" | "project" | "room" | "self";
export interface LogContext {
  traceId: string;
  spanId: string;
  requestId?: string;
  operationId?: string;
  generationId?: string;
  projectId?: string;
  projectPath?: string;
  visibility?: LogVisibility;
  selfId?: string;
  roomId?: string;
  operatorId?: string;
  agentId?: string;
}
const storage = new AsyncLocalStorage<LogContext>();
const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-0[01]$/;
export function parseOrCreateTraceparent(value?: string) { const match = value?.toLowerCase().match(TRACEPARENT); const traceId = match?.[1] || randomBytes(16).toString("hex"); const parentSpanId = match?.[2]; const spanId = randomBytes(8).toString("hex"); return { traceId, spanId, ...(parentSpanId ? { parentSpanId } : {}), traceparent: `00-${traceId}-${spanId}-01` }; }

export function safeError(error: unknown, includeStack = false) { if (!(error instanceof Error)) return { name: "Error", message: redactDiagnosticSecrets(String(error)).slice(0, 500) }; return { name: error.name.slice(0, 100), message: redactDiagnosticSecrets(error.message).slice(0, 500), ...(includeStack && error.stack ? { stack: redactDiagnosticSecrets(error.stack).split("\n").slice(0, 12).join("\n") } : {}) }; }

const SECRET_FIELD = /(?:^|[-_])(?:authorization|proxy[-_]?authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|auth[-_]?token|token|secret|password|passwd|cookie|set[-_]?cookie|credential|private[-_]?key)(?:$|[-_])/i;
function isSecretField(key: string) {
  const compact = key.replace(/[-_\s]/g, "").toLowerCase();
  return SECRET_FIELD.test(key) || /(?:authorization|apikey|accesstoken|refreshtoken|authtoken|token|secret|password|passwd|cookie|setcookie|credential|privatekey)$/.test(compact)
    || /(?:provider|service|client|auth|access)key$/.test(compact);
}

/** Evidence-preserving serializer with recursive authentication-secret redaction. */
export function sanitizeLogValue(value: unknown, depth = 0, includeStack = false, seen = new WeakSet<object>()): unknown {
  if (depth > 12) return "[bounded-depth]";
  if (value instanceof Error) {
    const error = safeError(value, includeStack) as Record<string, unknown>;
    const cause = "cause" in value ? sanitizeLogValue(value.cause, depth + 1, includeStack, seen) : undefined;
    return cause === undefined ? error : { ...error, cause };
  }
  if (typeof value === "string") return redactDiagnosticSecrets(value).slice(0, 1_000_000);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "symbol" || typeof value === "function") return `[${typeof value}]`;
  if (Array.isArray(value)) {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    const result = value.slice(0, 10_000).map((item) => sanitizeLogValue(item, depth + 1, includeStack, seen));
    seen.delete(value);
    return result;
  }
  if (value && typeof value === "object") {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    const result: Record<string, unknown> = {};
    let keys: string[];
    try { keys = Object.keys(value as Record<string, unknown>).slice(0, 10_000); }
    catch (error) { seen.delete(value); return { serializationError: safeError(error) }; }
    for (const key of keys) {
      if (isSecretField(key)) { result[key] = "[REDACTED]"; continue; }
      try { result[key] = sanitizeLogValue((value as Record<string, unknown>)[key], depth + 1, includeStack, seen); }
      catch (error) { result[key] = { serializationError: safeError(error) }; }
    }
    seen.delete(value);
    return result;
  }
  return value;
}

export function currentLogContext() { return storage.getStore(); }

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
    const line = JSON.stringify({ ...fields, ...context, ...this.identity, timestamp: new Date(now).toISOString(), level, event });
    try { this.consoleSink(line); } catch {}
    if (!this.filePath) return;
    this.queue = this.queue.catch(() => undefined).then(async () => { await mkdir(path.dirname(this.filePath!), { recursive: true, mode: 0o700 }); await this.rotateIfNeeded(Buffer.byteLength(line) + 1); await appendFile(this.filePath!, `${line}\n`, { mode: 0o600 }); }).catch(() => undefined);
  }
  private async rotateIfNeeded(incoming: number) { let size = 0; try { size = (await stat(this.filePath!)).size; } catch {} if (size + incoming <= this.maxBytes) return; for (let index = this.rotations - 1; index >= 1; index--) await rename(`${this.filePath}.${index}`, `${this.filePath}.${index + 1}`).catch(() => undefined); await rename(this.filePath!, `${this.filePath}.1`).catch(() => undefined); }
}

export function traceMiddleware(logger: { log(level: "debug" | "info" | "warn" | "error", event: string, fields?: Record<string, unknown>): Promise<unknown> }): express.RequestHandler { return (request, response, next) => { const trace = parseOrCreateTraceparent(request.header("traceparent")); const context = { traceId: trace.traceId, spanId: trace.spanId, requestId: request.header("x-request-id")?.slice(0, 100) || crypto.randomUUID() }; response.set("traceparent", trace.traceparent); response.set("x-request-id", context.requestId); const started = Date.now(); storage.run(context, () => { response.once("finish", () => { void logger.log("info", "http.request.completed", { method: request.method, path: request.path, statusCode: response.statusCode, durationMs: Date.now() - started }); }); next(); }); }; }
export function withLogContext<T>(fields: Partial<LogContext>, callback: () => T) { return storage.run({ ...(storage.getStore() || { traceId: randomBytes(16).toString("hex"), spanId: randomBytes(8).toString("hex") }), ...fields }, callback); }
