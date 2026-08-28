import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import type express from "express";
import { redactDiagnosticSecrets } from "../shared/diagnostic-redaction.js";

export type LogVisibility = "operator" | "project" | "room" | "self";
export interface LogContext {
  traceId: string;
  spanId: string;
  requestId?: string;
  correlationId?: string;
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

export function traceMiddleware(logger: { log(level: "debug" | "info" | "warn" | "error", event: string, fields?: Record<string, unknown>): Promise<unknown> }): express.RequestHandler { return (request, response, next) => { const trace = parseOrCreateTraceparent(request.header("traceparent")); const context = { traceId: trace.traceId, spanId: trace.spanId, requestId: request.header("x-request-id")?.slice(0, 100) || crypto.randomUUID() }; response.set("traceparent", trace.traceparent); response.set("x-request-id", context.requestId); const started = Date.now(); storage.run(context, () => { response.once("finish", () => { void logger.log("info", "http.request.completed", { method: request.method, path: request.path, statusCode: response.statusCode, durationMs: Date.now() - started }); }); next(); }); }; }
export function withLogContext<T>(fields: Partial<LogContext>, callback: () => T) { return storage.run({ ...(storage.getStore() || { traceId: randomBytes(16).toString("hex"), spanId: randomBytes(8).toString("hex") }), ...fields }, callback); }
