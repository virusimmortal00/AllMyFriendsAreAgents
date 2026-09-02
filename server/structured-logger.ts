import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import type express from "express";
import { redactDiagnosticSecrets } from "../shared/diagnostic-redaction.js";

export type LogVisibility = "operator" | "project" | "room" | "self";
export interface LogContext {
  traceId: string;
  spanId: string;
  requestId?: string;
  jobId?: string;
  runId?: string;
  turnId?: string;
  attemptOrdinal?: number;
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

export function safeError(error: unknown, includeStack = false) {
  if (!(error instanceof Error)) {
    try { return { name: "Error", message: redactDiagnosticSecrets(String(error)) }; }
    catch { return { name: "Error", message: "[unprintable diagnostic error]" }; }
  }
  const read = (key: "name" | "message" | "stack") => {
    try { return redactDiagnosticSecrets(String(error[key] || "")); }
    catch { return `[unreadable error ${key}]`; }
  };
  const name = read("name");
  const message = read("message");
  const stack = includeStack ? read("stack") : "";
  return { name, message, ...(stack ? { stack } : {}) };
}

const SECRET_FIELD = /(?:^|[-_])(?:authorization|proxy[-_]?authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|auth[-_]?token|token|secret|password|passwd|cookie|set[-_]?cookie|credential|private[-_]?key)(?:$|[-_])/i;
function isSecretField(key: string) {
  const compact = key.replace(/[-_\s]/g, "").toLowerCase();
  return SECRET_FIELD.test(key) || /(?:authorization|apikey|accesstoken|refreshtoken|authtoken|token|secret|password|passwd|cookie|setcookie|credential|privatekey)$/.test(compact)
    || /(?:provider|service|client|auth|access)key$/.test(compact);
}

/** Evidence-preserving serializer with authentication-only redaction and iterative cycle handling. */
export function sanitizeLogValue(value: unknown, _depth = 0, includeStack = false, _seen = new WeakSet<object>()): unknown {
  const root: { value?: unknown } = {};
  type Task =
    | { type: "visit"; value: unknown; parent: Record<string, unknown> | unknown[] | { value?: unknown }; key: string | number }
    | { type: "property"; source: Record<string | number, unknown>; parent: Record<string, unknown> | unknown[]; key: string | number }
    | { type: "exit"; value: object };
  const active = new WeakSet<object>();
  const tasks: Task[] = [{ type: "visit", value, parent: root, key: "value" }];
  const assign = (parent: Record<string, unknown> | unknown[] | { value?: unknown }, key: string | number, next: unknown) => {
    (parent as Record<string | number, unknown>)[key] = next;
  };

  while (tasks.length) {
    const task = tasks.pop()!;
    if (task.type === "exit") { active.delete(task.value); continue; }
    if (task.type === "property") {
      if (typeof task.key === "string" && isSecretField(task.key)) { assign(task.parent, task.key, "[REDACTED]"); continue; }
      try { tasks.push({ type: "visit", value: task.source[task.key], parent: task.parent, key: task.key }); }
      catch (error) { assign(task.parent, task.key, { serializationError: safeError(error) }); }
      continue;
    }

    const current = task.value;
    if (typeof current === "string") { assign(task.parent, task.key, redactDiagnosticSecrets(current)); continue; }
    if (typeof current === "bigint") { assign(task.parent, task.key, current.toString()); continue; }
    if (typeof current === "symbol" || typeof current === "function") { assign(task.parent, task.key, `[${typeof current}]`); continue; }
    if (!current || typeof current !== "object") { assign(task.parent, task.key, current); continue; }
    if (active.has(current)) { assign(task.parent, task.key, "[circular]"); continue; }

    active.add(current);
    tasks.push({ type: "exit", value: current });
    if (current instanceof Error) {
      const result = safeError(current, includeStack) as Record<string, unknown>;
      assign(task.parent, task.key, result);
      if ("cause" in current) tasks.push({ type: "property", source: current as unknown as Record<string, unknown>, parent: result, key: "cause" });
      continue;
    }
    if (Array.isArray(current)) {
      const result = new Array<unknown>(current.length);
      assign(task.parent, task.key, result);
      for (let index = current.length - 1; index >= 0; index--) tasks.push({ type: "property", source: current as unknown as Record<number, unknown>, parent: result, key: index });
      continue;
    }

    const result: Record<string, unknown> = {};
    assign(task.parent, task.key, result);
    let keys: string[];
    try { keys = Object.keys(current); }
    catch (error) { assign(task.parent, task.key, { serializationError: safeError(error) }); continue; }
    for (let index = keys.length - 1; index >= 0; index--) tasks.push({ type: "property", source: current as Record<string, unknown>, parent: result, key: keys[index]! });
  }
  return root.value;
}

export function currentLogContext() { return storage.getStore(); }

/** Domain identities remain payload fields so identical-log coalescing respects them. */
export function conversationLogFields(context: Partial<LogContext> | undefined = currentLogContext()) {
  return {
    ...(context?.jobId ? { jobId: context.jobId } : {}),
    ...(context?.runId ? { runId: context.runId } : {}),
    ...(context?.turnId ? { turnId: context.turnId } : {}),
    ...(context?.attemptOrdinal !== undefined ? { attemptOrdinal: context.attemptOrdinal } : {}),
  };
}

export interface StructuredLogIdentity { schemaVersion: 1; service: string; serviceVersion: string; instanceId: string; deploymentCommit: string | null; deploymentEpoch: string | null; environment: string }

export function traceMiddleware(logger: { log(level: "debug" | "info" | "warn" | "error", event: string, fields?: Record<string, unknown>): Promise<unknown> }): express.RequestHandler { return (request, response, next) => { const trace = parseOrCreateTraceparent(request.header("traceparent")); const context = { traceId: trace.traceId, spanId: trace.spanId, requestId: request.header("x-request-id")?.slice(0, 100) || crypto.randomUUID() }; response.set("traceparent", trace.traceparent); response.set("x-request-id", context.requestId); const started = Date.now(); storage.run(context, () => { response.once("finish", () => { void logger.log("info", "http.request.completed", { method: request.method, path: request.path, statusCode: response.statusCode, durationMs: Date.now() - started }).catch(() => undefined); }); next(); }); }; }
export function withLogContext<T>(fields: Partial<LogContext>, callback: () => T) { return storage.run({ ...(storage.getStore() || { traceId: randomBytes(16).toString("hex"), spanId: randomBytes(8).toString("hex") }), ...fields }, callback); }
