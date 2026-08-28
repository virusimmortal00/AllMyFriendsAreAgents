import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, opendir } from "node:fs/promises";
import path from "node:path";
import { AUTHORITATIVE_STREAMS, DEFAULT_STREAM_ROTATION, type AuthoritativeStream } from "./authoritative-logging.js";
import { sanitizeLogValue } from "./structured-logger.js";

export const DIAGNOSTIC_STREAMS = AUTHORITATIVE_STREAMS;
export type DiagnosticStream = AuthoritativeStream;
export type DiagnosticSeverity = "debug" | "info" | "warn" | "error";
export type DiagnosticVisibility = "self" | "room" | "project" | "operator";

export const DIAGNOSTICS_QUERY_LIMITS = Object.freeze({
  defaultResults: 50,
  maxResults: 200,
  maxScannedBytes: 8 * 1024 * 1024,
  maxSerializedBytes: 1024 * 1024,
  minSerializedBytes: 4 * 1024,
  maxWindowMs: 7 * 24 * 60 * 60 * 1000,
  maxSelectorValues: 20,
  maxDirectoryEntries: 256,
});

/** The fixed filenames are part of the local backend, never query input. */
export const DIAGNOSTIC_STREAM_FILES: Readonly<Record<DiagnosticStream, string>> = Object.freeze({
  "server-service-lifecycle": "server-service-lifecycle",
  "opencode-harness": "opencode-harness",
  "openrouter-provider": "openrouter-provider",
  generations: "generations",
  "capability-decisions": "capability-decisions",
  "security-audit": "security-audit",
});

export interface DiagnosticCaller {
  readonly principalId: string;
  readonly selfId?: string;
  readonly operatorId?: string;
  readonly roomIds: readonly string[];
  readonly projectIds: readonly string[];
  readonly operator: boolean;
}

export interface DiagnosticQuery {
  readonly from: string;
  readonly to: string;
  readonly scope: DiagnosticVisibility;
  readonly streams?: readonly DiagnosticStream[];
  readonly severities?: readonly DiagnosticSeverity[];
  readonly events?: readonly string[];
  readonly identity?: Readonly<{ roomId?: string; agentId?: string; generationId?: string; selfId?: string; operatorId?: string }>;
  readonly correlation?: Readonly<{ correlationId?: string; traceId?: string; requestId?: string }>;
  readonly limit?: number;
  readonly maxScannedBytes?: number;
  readonly maxSerializedBytes?: number;
  readonly cursor?: string;
}

export interface DiagnosticRecord {
  readonly schemaVersion: number;
  readonly recordId: string;
  readonly stream: DiagnosticStream;
  readonly timestamp: string;
  readonly severity: DiagnosticSeverity;
  readonly event: string;
  readonly projectId: string;
  readonly roomId?: string;
  readonly agentId?: string;
  readonly selfId?: string;
  readonly operatorId?: string;
  readonly generationId?: string;
  readonly correlationId?: string;
  readonly traceId?: string;
  readonly requestId?: string;
  readonly visibility: DiagnosticVisibility;
  readonly content: Readonly<Record<string, unknown>>;
}

export interface DiagnosticQueryResult {
  readonly records: readonly DiagnosticRecord[];
  readonly chunks: readonly DiagnosticRecordChunk[];
  readonly nextCursor: string | null;
  readonly scannedBytes: number;
  readonly serializedBytes: number;
  readonly malformedRecords: number;
  readonly scanLimitReached: boolean;
}

/** A lossless fragment of one redacted DiagnosticRecord JSON document. */
export interface DiagnosticRecordChunk {
  readonly kind: "record-chunk";
  readonly recordId: string;
  readonly stream: DiagnosticStream;
  readonly offset: number;
  readonly totalBytes: number;
  readonly encoding: "base64-json-utf8";
  readonly data: string;
  readonly final: boolean;
}

export interface DiagnosticsQueryService {
  query(caller: DiagnosticCaller, query: DiagnosticQuery): Promise<DiagnosticQueryResult>;
}

export class DiagnosticsQueryError extends Error {
  constructor(readonly code: "invalid-query" | "forbidden" | "invalid-cursor" | "record-too-large") {
    super(`Diagnostics query rejected: ${code}.`);
    this.name = "DiagnosticsQueryError";
  }
}

interface NormalizedQuery extends Omit<DiagnosticQuery, "streams" | "severities" | "events" | "limit" | "maxScannedBytes" | "maxSerializedBytes" | "cursor"> {
  streams: readonly DiagnosticStream[];
  severities: readonly DiagnosticSeverity[];
  events: readonly string[];
  limit: number;
  maxScannedBytes: number;
  maxSerializedBytes: number;
  after: OrderKey | null;
  chunkOffset: number;
  fingerprint: string;
}
interface OrderKey { timestamp: string; stream: DiagnosticStream; recordId: string }
interface CursorEnvelope { v: 1; fingerprint: string; after: OrderKey; chunkOffset?: number }
interface Candidate { record: DiagnosticRecord }

const SEVERITIES = ["debug", "info", "warn", "error"] as const;
const VISIBILITIES = ["self", "room", "project", "operator"] as const;

export class LocalFileDiagnosticsQueryService implements DiagnosticsQueryService {
  private readonly directory: string;
  constructor(dataDirectory: string, private readonly projectId: string) {
    if (!path.isAbsolute(dataDirectory) || !projectId.trim()) throw new DiagnosticsQueryError("invalid-query");
    this.directory = path.join(path.resolve(dataDirectory), "logs", "authoritative-v1");
  }

  async query(caller: DiagnosticCaller, input: DiagnosticQuery): Promise<DiagnosticQueryResult> {
    const query = normalizeQuery(input);
    authorizeScope(caller, query, this.projectId);
    const candidates: Candidate[] = [];
    const dedupe = new Set<string>();
    const scannedFiles = new Set<string>();
    let scannedBytes = 0;
    let malformedRecords = 0;
    let scanLimitReached = false;

    // A bounded second listing closes the rename/create window of concurrent rotation.
    for (let pass = 0; pass < 2 && scannedBytes < query.maxScannedBytes; pass++) {
      for (const file of await this.resolveFiles(query.streams)) {
        if (scannedBytes >= query.maxScannedBytes) { scanLimitReached = true; break; }
        const allowance = query.maxScannedBytes - scannedBytes;
        const result = await readBoundedLines(file.filePath, allowance, scannedFiles);
        scannedBytes += result.scannedBytes;
        if (result.truncated) scanLimitReached = true;
        for (const line of result.lines) {
          let value: unknown;
          try { value = JSON.parse(line); } catch { malformedRecords++; continue; }
          const record = normalizeRecord(value, file.stream, this.projectId);
          if (!record) { malformedRecords++; continue; }
          if (!matches(record, query) || !recordVisibleTo(record, caller, query.scope, this.projectId)) continue;
          const dedupeKey = stableRecordKey(record);
          if (dedupe.has(dedupeKey)) continue;
          dedupe.add(dedupeKey);
          candidates.push({ record });
        }
      }
    }

    candidates.sort((left, right) => compareRecords(left.record, right.record));
    const eligible = query.after ? candidates.filter(({ record }) => {
      const comparison = compareKey(keyOf(record), query.after!);
      return comparison > 0 || (query.chunkOffset > 0 && comparison === 0);
    }) : candidates;
    const records: DiagnosticRecord[] = [];
    const chunks: DiagnosticRecordChunk[] = [];
    let completed = 0;
    let lastCompleted: OrderKey | null = null;
    let continuation: { key: OrderKey; offset: number } | null = null;
    const fullRecordBudget = query.maxSerializedBytes - 1_600;
    for (const { record } of eligible) {
      if (records.length + chunks.length >= query.limit) break;
      const safe = redactRecord(record);
      const bytes = Buffer.from(JSON.stringify(safe));
      const key = keyOf(record);
      const chunkOffset = query.after && compareKey(key, query.after) === 0 ? query.chunkOffset : 0;
      if (chunkOffset > bytes.length) throw new DiagnosticsQueryError("invalid-cursor");
      if (chunkOffset > 0 || bytes.length > fullRecordBudget) {
        if (records.length || chunks.length) break;
        const rawBudget = Math.max(1, Math.floor((query.maxSerializedBytes - 2_000) / 2));
        const end = Math.min(bytes.length, chunkOffset + rawBudget);
        chunks.push({ kind: "record-chunk", recordId: record.recordId, stream: record.stream, offset: chunkOffset, totalBytes: bytes.length, encoding: "base64-json-utf8", data: bytes.subarray(chunkOffset, end).toString("base64"), final: end === bytes.length });
        if (end < bytes.length) continuation = { key, offset: end };
        else { lastCompleted = key; completed++; }
        break;
      }
      const projected = Buffer.byteLength(JSON.stringify({ records: [...records, safe], chunks, nextCursor: "x".repeat(700), scannedBytes, serializedBytes: 0, malformedRecords, scanLimitReached }));
      if (projected > query.maxSerializedBytes) break;
      records.push(safe);
      lastCompleted = key;
      completed++;
    }
    const hasMore = continuation !== null || completed < eligible.length || scanLimitReached;
    const cursorKey = continuation?.key || lastCompleted;
    const nextCursor = hasMore && cursorKey ? encodeCursor({ v: 1, fingerprint: query.fingerprint, after: cursorKey, ...(continuation ? { chunkOffset: continuation.offset } : {}) }) : null;
    const result = { records, chunks, nextCursor, scannedBytes, serializedBytes: 0, malformedRecords, scanLimitReached };
    for (let index = 0; index < 4; index++) {
      const measured = Buffer.byteLength(JSON.stringify(result));
      if (measured === result.serializedBytes) break;
      result.serializedBytes = measured;
    }
    if (result.serializedBytes > query.maxSerializedBytes) throw new DiagnosticsQueryError("record-too-large");
    return result;
  }

  private async resolveFiles(streams: readonly DiagnosticStream[]) {
    let names: string[] = [];
    names = await listBoundedNames(this.directory);
    const files: Array<{ stream: DiagnosticStream; filePath: string; rotation: number; rank: number }> = [];
    for (const stream of streams) {
      const base = DIAGNOSTIC_STREAM_FILES[stream];
      const pattern = new RegExp(`^${escapeRegex(base)}(?:\\.(\\d+))?\\.jsonl$`);
      const retained: Array<{ stream: DiagnosticStream; filePath: string; rotation: number }> = [];
      for (const name of names) {
        const match = name.match(pattern);
        if (!match) continue;
        const rotation = match[1] ? Number(match[1]) : 0;
        if (!Number.isSafeInteger(rotation)) continue;
        retained.push({ stream, filePath: path.join(this.directory, name), rotation });
      }
      retained.sort((a, b) => b.rotation - a.rotation);
      files.push(...retained.slice(0, DEFAULT_STREAM_ROTATION[stream].retention + 1).map((file, rank) => ({ ...file, rank })));
    }
    const legacyDirectory = path.join(path.dirname(this.directory), "legacy-v1");
    const legacyNames = await listBoundedNames(legacyDirectory);
    for (const name of legacyNames) {
      const match = name.match(/^(server|generations)\.jsonl(?:\.(\d+)|\.retired-(\d+))?$/);
      if (!match) continue;
      const stream: DiagnosticStream = match[1] === "server" ? "server-service-lifecycle" : "generations";
      const rotation = match[2] || match[3] ? Number(match[2] || match[3]) : 0;
      if (streams.includes(stream) && Number.isSafeInteger(rotation)) files.push({ stream, filePath: path.join(legacyDirectory, name), rotation: -1 - rotation, rank: 1_000 + rotation });
    }
    return files.sort((a, b) => a.rank - b.rank || DIAGNOSTIC_STREAMS.indexOf(a.stream) - DIAGNOSTIC_STREAMS.indexOf(b.stream));
  }
}

function normalizeQuery(input: DiagnosticQuery): NormalizedQuery {
  if (!isPlainObject(input) || hasUnknownKeys(input, ["from", "to", "scope", "streams", "severities", "events", "identity", "correlation", "limit", "maxScannedBytes", "maxSerializedBytes", "cursor"])) throw new DiagnosticsQueryError("invalid-query");
  if (!VISIBILITIES.includes(input.scope) || typeof input.from !== "string" || typeof input.to !== "string") throw new DiagnosticsQueryError("invalid-query");
  const fromMs = Date.parse(input.from), toMs = Date.parse(input.to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs > toMs || toMs - fromMs > DIAGNOSTICS_QUERY_LIMITS.maxWindowMs) throw new DiagnosticsQueryError("invalid-query");
  const streams = uniqueEnum(input.streams ?? DIAGNOSTIC_STREAMS, DIAGNOSTIC_STREAMS);
  const severities = uniqueEnum(input.severities ?? SEVERITIES, SEVERITIES);
  const events = uniqueStrings(input.events ?? []);
  const identity = normalizeSelector(input.identity, ["roomId", "agentId", "generationId", "selfId", "operatorId"]);
  const correlation = normalizeSelector(input.correlation, ["correlationId", "traceId", "requestId"]);
  const limit = boundedInteger(input.limit, DIAGNOSTICS_QUERY_LIMITS.defaultResults, 1, DIAGNOSTICS_QUERY_LIMITS.maxResults);
  const maxScannedBytes = boundedInteger(input.maxScannedBytes, DIAGNOSTICS_QUERY_LIMITS.maxScannedBytes, 1, DIAGNOSTICS_QUERY_LIMITS.maxScannedBytes);
  const maxSerializedBytes = boundedInteger(input.maxSerializedBytes, DIAGNOSTICS_QUERY_LIMITS.maxSerializedBytes, DIAGNOSTICS_QUERY_LIMITS.minSerializedBytes, DIAGNOSTICS_QUERY_LIMITS.maxSerializedBytes);
  const basis = { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString(), scope: input.scope, streams, severities, events, identity, correlation, limit, maxScannedBytes, maxSerializedBytes };
  const fingerprint = digest(basis);
  let after: OrderKey | null = null;
  let chunkOffset = 0;
  if (input.cursor !== undefined) {
    const cursor = decodeCursor(input.cursor);
    if (cursor.fingerprint !== fingerprint) throw new DiagnosticsQueryError("invalid-cursor");
    after = cursor.after;
    chunkOffset = cursor.chunkOffset || 0;
  }
  return { ...basis, after, chunkOffset, fingerprint };
}

function authorizeScope(caller: DiagnosticCaller, query: NormalizedQuery, projectId: string) {
  if (!validCaller(caller)) throw new DiagnosticsQueryError("forbidden");
  if (caller.operator) {
    if (query.identity?.operatorId && query.identity.operatorId !== caller.operatorId) throw new DiagnosticsQueryError("forbidden");
    return;
  }
  if (query.scope === "self" && !caller.selfId) throw new DiagnosticsQueryError("forbidden");
  if (query.scope === "room" && (!query.identity?.roomId || !caller.roomIds.includes(query.identity.roomId))) throw new DiagnosticsQueryError("forbidden");
  if (query.scope === "project" && !caller.projectIds.includes(projectId)) throw new DiagnosticsQueryError("forbidden");
  if (query.scope === "operator" && !caller.operator) throw new DiagnosticsQueryError("forbidden");
  if (query.identity?.roomId && !caller.operator && !caller.roomIds.includes(query.identity.roomId)) throw new DiagnosticsQueryError("forbidden");
  if (query.identity?.selfId && query.scope === "self" && query.identity.selfId !== caller.selfId) throw new DiagnosticsQueryError("forbidden");
  if (query.identity?.operatorId && (!caller.operator || query.identity.operatorId !== caller.operatorId)) throw new DiagnosticsQueryError("forbidden");
}

function recordVisibleTo(record: DiagnosticRecord, caller: DiagnosticCaller, requested: DiagnosticVisibility, projectId: string) {
  if (record.projectId !== projectId) return false;
  if (VISIBILITIES.indexOf(record.visibility) > VISIBILITIES.indexOf(requested)) return false;
  // A server-local operator may inspect collaborative evidence at any lower
  // visibility without pretending to be each agent or joining every room.
  if (caller.operator) return true;
  if (record.visibility === "self") return Boolean(record.selfId && record.selfId === caller.selfId);
  if (record.visibility === "room") return Boolean(record.roomId && caller.roomIds.includes(record.roomId));
  if (record.visibility === "project") return caller.projectIds.includes(projectId);
  return caller.operator;
}

function matches(record: DiagnosticRecord, query: NormalizedQuery) {
  if (record.timestamp < query.from || record.timestamp > query.to || !query.streams.includes(record.stream) || !query.severities.includes(record.severity)) return false;
  if (query.events.length && !query.events.includes(record.event)) return false;
  for (const [key, value] of Object.entries(query.identity ?? {})) if (record[key as keyof DiagnosticRecord] !== value) return false;
  for (const [key, value] of Object.entries(query.correlation ?? {})) if (record[key as keyof DiagnosticRecord] !== value) return false;
  return true;
}

function normalizeRecord(value: unknown, stream: DiagnosticStream, projectId: string): DiagnosticRecord | null {
  if (!isPlainObject(value)) return null;
  const declaredStream = string(value.stream);
  if (declaredStream && declaredStream !== stream) return null;
  const timestampValue = string(value.timestamp) || string(value.time);
  const time = timestampValue ? Date.parse(timestampValue) : NaN;
  const event = string(value.event) || string(value.type);
  const severity = normalizeSeverity(value.severity ?? value.level);
  if (!Number.isFinite(time) || !event || !severity) return null;
  const timestamp = new Date(time).toISOString();
  const declaredProject = string(value.projectId) || string(value.project);
  if (declaredProject && declaredProject !== projectId) return null;
  const content = isPlainObject(value.content) ? value.content : Object.fromEntries(Object.entries(value).filter(([key]) => !ENVELOPE_KEYS.has(key)));
  const recordId = string(value.recordId) || string(value.id) || digest({ stream, timestamp, event, value });
  return {
    schemaVersion: positiveInteger(value.envelopeVersion) || positiveInteger(value.schemaVersion) || 0,
    recordId: recordId.slice(0, 200), stream, timestamp, severity, event: event.slice(0, 200), projectId,
    ...optional("roomId", value.roomId), ...optional("agentId", value.agentId ?? value.agent),
    ...optional("selfId", value.selfId), ...optional("operatorId", value.operatorId), ...optional("generationId", value.generationId),
    ...optional("correlationId", value.correlationId), ...optional("traceId", value.traceId), ...optional("requestId", value.requestId),
    visibility: VISIBILITIES.includes(value.visibility as DiagnosticVisibility) ? value.visibility as DiagnosticVisibility : "operator",
    content,
  };
}

const ENVELOPE_KEYS = new Set(["envelopeVersion", "schemaVersion", "recordId", "id", "stream", "timestamp", "time", "severity", "level", "event", "type", "projectId", "project", "projectPath", "roomId", "agentId", "agent", "selfId", "operatorId", "generationId", "correlationId", "traceId", "spanId", "requestId", "visibility", "service", "serviceVersion", "instanceId", "deploymentCommit", "deploymentEpoch", "environment", "content"]);

async function readBoundedLines(filePath: string, allowance: number, seen: Set<string>) {
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat();
    if (!before.isFile()) return { lines: [] as string[], scannedBytes: 0, truncated: false };
    const identity = `${before.dev}:${before.ino}:${before.size}:${before.mtimeMs}`;
    if (seen.has(identity)) return { lines: [] as string[], scannedBytes: 0, truncated: false };
    seen.add(identity);
    const bytes = Math.min(before.size, allowance);
    const start = Math.max(0, before.size - bytes);
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, start);
    let text = buffer.subarray(0, bytesRead).toString("utf8");
    if (start > 0) { const boundary = text.indexOf("\n"); text = boundary < 0 ? "" : text.slice(boundary + 1); }
    if (before.size === 0 || buffer[bytesRead - 1] !== 0x0a) { const boundary = text.lastIndexOf("\n"); text = boundary < 0 ? "" : text.slice(0, boundary); }
    return { lines: text.split("\n").filter(Boolean), scannedBytes: bytesRead, truncated: before.size > bytesRead };
  } catch { return { lines: [] as string[], scannedBytes: 0, truncated: false }; }
  finally { await handle?.close().catch(() => undefined); }
}

function redactRecord(record: DiagnosticRecord): DiagnosticRecord {
  return sanitizeLogValue(record) as DiagnosticRecord;
}

function compareRecords(left: DiagnosticRecord, right: DiagnosticRecord) { return compareKey(keyOf(left), keyOf(right)); }
function compareKey(left: OrderKey, right: OrderKey) { return right.timestamp.localeCompare(left.timestamp) || DIAGNOSTIC_STREAMS.indexOf(left.stream) - DIAGNOSTIC_STREAMS.indexOf(right.stream) || left.recordId.localeCompare(right.recordId); }
function keyOf(record: DiagnosticRecord): OrderKey { return { timestamp: record.timestamp, stream: record.stream, recordId: record.recordId }; }
function stableRecordKey(record: DiagnosticRecord) { return `${record.stream}\0${record.recordId}`; }
function digest(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function encodeCursor(value: CursorEnvelope) { return Buffer.from(JSON.stringify(value)).toString("base64url"); }
function decodeCursor(value: string): CursorEnvelope {
  try {
    if (value.length > 2_000) throw new Error();
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as CursorEnvelope;
    if (parsed.v !== 1 || typeof parsed.fingerprint !== "string" || !parsed.after || typeof parsed.after.timestamp !== "string" || !DIAGNOSTIC_STREAMS.includes(parsed.after.stream) || typeof parsed.after.recordId !== "string" || (parsed.chunkOffset !== undefined && (!Number.isSafeInteger(parsed.chunkOffset) || parsed.chunkOffset <= 0 || parsed.chunkOffset > DIAGNOSTICS_QUERY_LIMITS.maxScannedBytes))) throw new Error();
    return parsed;
  } catch { throw new DiagnosticsQueryError("invalid-cursor"); }
}
function uniqueEnum<T extends string>(input: readonly T[], allowed: readonly T[]) {
  if (!Array.isArray(input) || !input.length || input.length > DIAGNOSTICS_QUERY_LIMITS.maxSelectorValues || input.some((item) => !allowed.includes(item))) throw new DiagnosticsQueryError("invalid-query");
  return [...new Set(input)];
}
function uniqueStrings(input: readonly string[]) {
  if (!Array.isArray(input) || input.length > DIAGNOSTICS_QUERY_LIMITS.maxSelectorValues || input.some((item) => typeof item !== "string" || !item || item.length > 200)) throw new DiagnosticsQueryError("invalid-query");
  return [...new Set(input)];
}
function normalizeSelector<T extends string>(value: unknown, keys: readonly T[]): Readonly<Partial<Record<T, string>>> | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value) || hasUnknownKeys(value, keys)) throw new DiagnosticsQueryError("invalid-query");
  const output: Partial<Record<T, string>> = {};
  for (const key of keys) { const item = value[key]; if (item !== undefined) { if (typeof item !== "string" || !item || item.length > 200) throw new DiagnosticsQueryError("invalid-query"); output[key] = item; } }
  return output;
}
function boundedInteger(value: unknown, fallback: number, min: number, max: number) { if (value === undefined) return fallback; if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new DiagnosticsQueryError("invalid-query"); return value as number; }
function normalizeSeverity(value: unknown): DiagnosticSeverity | null { if (SEVERITIES.includes(value as DiagnosticSeverity)) return value as DiagnosticSeverity; if (typeof value === "number") return value >= 50 ? "error" : value >= 40 ? "warn" : value >= 30 ? "info" : "debug"; return null; }
function optional<K extends string>(key: K, value: unknown): Partial<Record<K, string>> { const output = string(value); return output ? { [key]: output.slice(0, 200) } as Partial<Record<K, string>> : {}; }
function string(value: unknown) { return typeof value === "string" && value ? value : null; }
function positiveInteger(value: unknown) { return Number.isSafeInteger(value) && (value as number) > 0 ? value as number : null; }
function isPlainObject(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
function hasUnknownKeys(value: Record<string, unknown>, keys: readonly string[]) { return Object.keys(value).some((key) => !keys.includes(key)); }
function validCaller(caller: DiagnosticCaller) { return isPlainObject(caller) && typeof caller.principalId === "string" && caller.principalId.length > 0 && Array.isArray(caller.roomIds) && caller.roomIds.length <= 1_000 && caller.roomIds.every((item) => typeof item === "string") && Array.isArray(caller.projectIds) && caller.projectIds.length <= 1_000 && caller.projectIds.every((item) => typeof item === "string") && typeof caller.operator === "boolean"; }
function escapeRegex(value: string) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
async function listBoundedNames(directory: string) {
  const names: string[] = [];
  let handle;
  try {
    handle = await opendir(directory);
    for await (const entry of handle) {
      if (names.length >= DIAGNOSTICS_QUERY_LIMITS.maxDirectoryEntries) break;
      names.push(entry.name);
    }
  } catch {}
  finally { await handle?.close().catch(() => undefined); }
  return names;
}
