import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import pino, { type Logger as PinoLogger } from "pino";
import buildRoll from "pino-roll";
import { currentLogContext, sanitizeLogValue, type LogContext, type LogVisibility, type StructuredLogIdentity } from "./structured-logger.js";

export const AUTHORITATIVE_STREAMS = [
  "server-service-lifecycle",
  "opencode-harness",
  "openrouter-provider",
  "generations",
  "capability-decisions",
  "security-audit",
] as const;
export type AuthoritativeStream = typeof AUTHORITATIVE_STREAMS[number];
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface StreamRotation { maxBytes: number; frequencyMs: number; retention: number }
export type StreamRotationConfiguration = Record<AuthoritativeStream, StreamRotation>;
export interface LoggingMetrics { dropped: number; coalesced: number; sinkFailures: number; written: number }
export type LoggingMetricsSnapshot = Record<AuthoritativeStream, LoggingMetrics>;

export const DEFAULT_STREAM_ROTATION: StreamRotationConfiguration = {
  "server-service-lifecycle": { maxBytes: 5 * 1024 * 1024, frequencyMs: 24 * 60 * 60 * 1000, retention: 7 },
  "opencode-harness": { maxBytes: 24 * 1024 * 1024, frequencyMs: 6 * 60 * 60 * 1000, retention: 8 },
  "openrouter-provider": { maxBytes: 12 * 1024 * 1024, frequencyMs: 60 * 60 * 1000, retention: 24 },
  "generations": { maxBytes: 16 * 1024 * 1024, frequencyMs: 12 * 60 * 60 * 1000, retention: 14 },
  "capability-decisions": { maxBytes: 8 * 1024 * 1024, frequencyMs: 24 * 60 * 60 * 1000, retention: 14 },
  "security-audit": { maxBytes: 8 * 1024 * 1024, frequencyMs: 24 * 60 * 60 * 1000, retention: 30 },
};

interface Destination {
  write(chunk: string): boolean;
  flush?(callback?: (error?: Error) => void): void;
  end?(): void;
  destroy?(): void;
  on?(event: string, listener: (...args: unknown[]) => void): unknown;
  once?(event: string, listener: (...args: unknown[]) => void): unknown;
}

export interface AuthoritativeLoggingOptions {
  dataDirectory: string;
  projectId: string;
  projectPath: string;
  roomId?: string;
  identity?: StructuredLogIdentity;
  rotation?: Partial<StreamRotationConfiguration>;
  maxBufferedBytes?: number;
  maxIdentical?: number;
  maxIdenticalSignatures?: number;
  identicalWindowMs?: number;
  includeStacks?: boolean;
  now?: () => number;
  sinkFactory?: (stream: AuthoritativeStream, file: string, rotation: StreamRotation) => Promise<Destination>;
}

interface StreamState {
  destination: Destination;
  logger: PinoLogger;
  queue: string[];
  queuedBytes: number;
  draining: boolean;
  metrics: LoggingMetrics;
  identical: Map<string, { since: number; emitted: number; suppressed: number }>;
}

const legacyPattern = /^(?:server\.jsonl(?:\.\d+)?|generations\.jsonl(?:\.\d+)?|live-dev\.log(?:\.\d+)?)$/;

/** Retires former authoritative sinks before any Wave 1 destination is opened. */
export async function migrateLegacyLogs(dataDirectory: string) {
  const legacyDirectory = path.join(dataDirectory, "logs", "legacy-v1");
  const manifestPath = path.join(legacyDirectory, "migration.json");
  await mkdir(legacyDirectory, { recursive: true, mode: 0o700 });
  await chmod(legacyDirectory, 0o700);
  const previous = await readFile(manifestPath, "utf8").then((value) => JSON.parse(value) as { retired?: Array<{ source: string; destination: string }> }).catch(() => ({ retired: [] }));
  const names = (await readdir(dataDirectory).catch(() => [])).filter((name) => legacyPattern.test(name)).sort();
  const migrated: Array<{ source: string; destination: string }> = [];
  for (const name of names) {
    let destination = path.join(legacyDirectory, name);
    for (let index = 1; await stat(destination).then(() => true, () => false); index++) destination = path.join(legacyDirectory, `${name}.retired-${index}`);
    await rename(path.join(dataDirectory, name), destination);
    await chmod(destination, 0o600);
    migrated.push({ source: name, destination: path.relative(dataDirectory, destination) });
  }
  const manifest = { schemaVersion: 1, migration: "authoritative-logging-wave-1", retired: [...(previous.retired || []), ...migrated] };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  await chmod(manifestPath, 0o600);
  return manifest;
}

function freshCorrelation() { return { traceId: randomBytes(16).toString("hex"), spanId: randomBytes(8).toString("hex") }; }
function cloneMetrics(metrics: LoggingMetrics): LoggingMetrics { return { ...metrics }; }

export class AuthoritativeLogging {
  readonly logDirectory: string;
  private readonly states = new Map<AuthoritativeStream, StreamState>();
  private readonly now: () => number;
  private readonly maxBufferedBytes: number;
  private readonly maxIdentical: number;
  private readonly maxIdenticalSignatures: number;
  private readonly identicalWindowMs: number;
  private readonly includeStacks: boolean;
  private readonly identity: StructuredLogIdentity;
  private projectId: string;
  private projectPath: string;
  private constructor(private readonly options: AuthoritativeLoggingOptions) {
    this.logDirectory = path.join(options.dataDirectory, "logs", "authoritative-v1");
    this.now = options.now || Date.now;
    this.maxBufferedBytes = Math.max(1024, options.maxBufferedBytes ?? 256 * 1024);
    this.maxIdentical = Math.max(1, options.maxIdentical ?? 20);
    this.maxIdenticalSignatures = Math.max(1, options.maxIdenticalSignatures ?? 500);
    this.identicalWindowMs = Math.max(100, options.identicalWindowMs ?? 10_000);
    this.includeStacks = Boolean(options.includeStacks);
    this.projectId = options.projectId;
    this.projectPath = options.projectPath;
    this.identity = options.identity || { schemaVersion: 1, service: "all-my-friends-are-agents", serviceVersion: "0.1.0", instanceId: "uninitialized", deploymentCommit: null, deploymentEpoch: null, environment: "development" };
  }

  static async open(options: AuthoritativeLoggingOptions) {
    const logging = new AuthoritativeLogging(options);
    await mkdir(options.dataDirectory, { recursive: true, mode: 0o700 });
    await chmod(options.dataDirectory, 0o700);
    await migrateLegacyLogs(options.dataDirectory);
    await mkdir(logging.logDirectory, { recursive: true, mode: 0o700 });
    await chmod(logging.logDirectory, 0o700);
    for (const stream of AUTHORITATIVE_STREAMS) {
      const rotation = { ...DEFAULT_STREAM_ROTATION[stream], ...options.rotation?.[stream] };
      const file = path.join(logging.logDirectory, `${stream}.jsonl`);
      const destination = options.sinkFactory
        ? await options.sinkFactory(stream, file, rotation)
        : await buildRoll({ file, size: `${rotation.maxBytes}b`, frequency: rotation.frequencyMs, extension: ".jsonl", mode: 0o600, minLength: 0, limit: { count: rotation.retention, removeOtherLogFiles: true } });
      const metrics: LoggingMetrics = { dropped: 0, coalesced: 0, sinkFailures: 0, written: 0 };
      const state: StreamState = { destination, queue: [], queuedBytes: 0, draining: false, metrics, identical: new Map(), logger: undefined as unknown as PinoLogger };
      destination.on?.("error", () => { metrics.sinkFailures = Math.min(metrics.sinkFailures + 1, Number.MAX_SAFE_INTEGER); });
      const safeDestination = { write: (line: string) => { logging.enqueue(state, line); } };
      state.logger = pino({ base: null, timestamp: false, formatters: { level: (label) => ({ severity: label }) } }, safeDestination);
      logging.states.set(stream, state);
    }
    return logging;
  }

  setDeployment(deploymentCommit: string | null, deploymentEpoch: string | null) {
    this.identity.deploymentCommit = deploymentCommit;
    this.identity.deploymentEpoch = deploymentEpoch;
  }

  setProject(projectId: string, projectPath: string) { this.projectId = projectId; this.projectPath = projectPath; }

  log(stream: AuthoritativeStream, level: LogLevel, event: string, fields: Record<string, unknown> = {}, contextOverrides: Partial<LogContext> = {}) {
    const state = this.states.get(stream);
    if (!state) return;
    const context = { ...freshCorrelation(), ...currentLogContext(), ...contextOverrides };
    const safeFields = sanitizeLogValue(fields, 0, this.includeStacks) as Record<string, unknown>;
    const timestamp = new Date(this.now()).toISOString();
    const boundedEvent = String(event).slice(0, 160);
    const requestedVisibility = context.visibility || safeFields.visibility;
    const visibility: LogVisibility = requestedVisibility === "self" || requestedVisibility === "room" || requestedVisibility === "project" || requestedVisibility === "operator" ? requestedVisibility : "operator";
    const correlation = {
      traceId: context.traceId,
      spanId: context.spanId,
      requestId: context.requestId || null,
      operationId: context.operationId || (typeof safeFields.operationId === "string" ? safeFields.operationId : null),
      generationId: context.generationId || (typeof safeFields.generationId === "string" ? safeFields.generationId : null),
    };
    const correlationId = context.correlationId
      || (typeof safeFields.correlationId === "string" ? safeFields.correlationId : null)
      || correlation.operationId || correlation.requestId || correlation.generationId || correlation.traceId;
    const agentId = context.agentId || context.selfId
      || (typeof safeFields.agentId === "string" ? safeFields.agentId : null)
      || (typeof safeFields.agent === "string" ? safeFields.agent : null);
    const outcome = typeof safeFields.outcome === "string" ? safeFields.outcome.slice(0, 120) : null;
    const reason = typeof safeFields.reason === "string" ? safeFields.reason.slice(0, 500) : null;
    const envelope = {
      envelopeVersion: 1,
      timestamp,
      event: boundedEvent,
      stream,
      projectId: context.projectId || this.projectId,
      projectPath: context.projectPath || this.projectPath,
      ...correlation,
      correlationId,
      visibility,
      agentId,
      selfId: context.selfId || agentId,
      roomId: context.roomId || this.options.roomId || null,
      operatorId: context.operatorId || null,
      outcome,
      reason,
      ...this.identity,
    };
    for (const key of ["timestamp", "event", "stream", "projectId", "projectPath", "traceId", "spanId", "requestId", "operationId", "generationId", "correlationId", "visibility", "agentId", "selfId", "roomId", "operatorId", "outcome", "reason", "severity", "envelopeVersion"]) delete safeFields[key];
    const signature = createHash("sha256").update(JSON.stringify({ level, event: boundedEvent, scope: { projectId: envelope.projectId, visibility, selfId: envelope.selfId, roomId: envelope.roomId, operatorId: envelope.operatorId }, fields: safeFields })).digest("hex");
    const now = this.now();
    for (const [key, candidate] of state.identical) {
      if (key === signature || now - candidate.since < this.identicalWindowMs) continue;
      state.metrics.coalesced += candidate.suppressed;
      state.identical.delete(key);
    }
    let identical = state.identical.get(signature);
    if (identical && now - identical.since >= this.identicalWindowMs) {
      if (identical.suppressed) {
        state.metrics.coalesced += identical.suppressed;
        this.write(state, "info", { ...envelope, timestamp, event: "logging.identical.coalesced", coalescedEvent: boundedEvent, suppressedCount: identical.suppressed, windowMs: this.identicalWindowMs });
      }
      state.identical.delete(signature);
      identical = undefined;
    }
    if (!identical) {
      if (state.identical.size >= this.maxIdenticalSignatures) {
        const oldestKey = state.identical.keys().next().value!;
        state.metrics.coalesced += state.identical.get(oldestKey)?.suppressed ?? 0;
        state.identical.delete(oldestKey);
      }
      identical = { since: now, emitted: 0, suppressed: 0 };
      state.identical.set(signature, identical);
    }
    if (identical.emitted >= this.maxIdentical) { identical.suppressed++; return; }
    identical.emitted++;
    this.write(state, level, { ...safeFields, ...envelope });
  }

  application(level: LogLevel, event: string, fields: Record<string, unknown> = {}) { this.log("server-service-lifecycle", level, event, fields); }
  metrics(): LoggingMetricsSnapshot { return Object.fromEntries(AUTHORITATIVE_STREAMS.map((stream) => [stream, cloneMetrics(this.states.get(stream)!.metrics)])) as LoggingMetricsSnapshot; }

  async flush() {
    await Promise.all([...this.states.values()].map(async (state) => {
      await this.drain(state);
      await new Promise<void>((resolve) => state.destination.flush ? state.destination.flush(() => resolve()) : resolve());
    }));
  }

  async close() { await this.flush(); for (const state of this.states.values()) state.destination.end?.(); }

  private write(state: StreamState, level: LogLevel, record: Record<string, unknown>) {
    try { state.logger[level](record); }
    catch { state.metrics.sinkFailures++; }
  }

  private enqueue(state: StreamState, line: string) {
    const bytes = Buffer.byteLength(line);
    // Queue capacity bounds concurrent backlog, not the size of one complete
    // evidence record. One oversized record may occupy an otherwise-empty
    // queue so the logger never truncates or discards it solely due to size.
    if (state.queue.length && state.queuedBytes + bytes > this.maxBufferedBytes) { state.metrics.dropped++; return; }
    state.queue.push(line); state.queuedBytes += bytes;
    if (!state.draining) { state.draining = true; queueMicrotask(() => void this.drain(state)); }
  }

  private async drain(state: StreamState) {
    if (!state.draining && !state.queue.length) return;
    state.draining = true;
    while (state.queue.length) {
      const line = state.queue.shift()!; state.queuedBytes -= Buffer.byteLength(line);
      try {
        const writable = state.destination.write(line);
        state.metrics.written++;
        // Do not build an unbounded destination backlog. SonicBoom signals
        // drain after it has accepted and persisted the complete logical line.
        if (!writable && state.destination.once) await new Promise<void>((resolve) => state.destination.once!("drain", () => resolve()));
      }
      catch { state.metrics.sinkFailures++; }
    }
    state.draining = false;
  }
}

export class ApplicationLoggerFacade {
  constructor(readonly foundation: AuthoritativeLogging) {}
  log(level: LogLevel, event: string, fields: Record<string, unknown> = {}) {
    const stream: AuthoritativeStream = /(?:^|[.-])(?:capability|tool-policy)(?:[.-]|$)/.test(event)
      ? "capability-decisions"
      : /(?:^|[.-])(?:security|audit|auth|lease|manifest|control-plane|room-command-tool|github)(?:[.-]|$)/.test(event)
        ? "security-audit"
        : /(?:^|[.-])(?:openrouter|provider)(?:[.-]|$)/.test(event)
          ? "openrouter-provider"
          : /(?:^|[.-])opencode(?:[.-]|$)/.test(event)
            ? "opencode-harness"
            : "server-service-lifecycle";
    this.foundation.log(stream, level, event, fields);
    return Promise.resolve();
  }
  setDeployment(commit: string | null, epoch: string | null) { this.foundation.setDeployment(commit, epoch); }
  setProject(projectId: string, projectPath: string) { this.foundation.setProject(projectId, projectPath); }
  flush() { return this.foundation.flush(); }
}
