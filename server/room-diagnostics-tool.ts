import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type express from "express";
import {
  DIAGNOSTIC_STREAMS,
  DiagnosticsQueryError,
  type DiagnosticCaller,
  type DiagnosticQuery,
  type DiagnosticQueryResult,
  type DiagnosticSeverity,
  type DiagnosticStream,
  type DiagnosticsQueryService,
  type DiagnosticVisibility,
} from "./diagnostics-query.js";

const LEASE_LIFETIME_MS = 10 * 60_000;
const CALL_LIMIT = 8;
const RESULT_LIMIT = 50;
const SCANNED_BYTE_LIMIT = 2 * 1024 * 1024;
const SERIALIZED_BYTE_LIMIT = 256 * 1024;
const REQUEST_ID = /^[a-zA-Z0-9_-]{8,100}$/;
const WINDOWS = { "last-15-minutes": 15 * 60_000, "last-hour": 60 * 60_000, "last-day": 24 * 60 * 60_000 } as const;
const SCOPES = ["self", "room", "project", "operator"] as const;
const SEVERITIES = ["debug", "info", "warn", "error"] as const;

export type RoomDiagnosticsWindow = keyof typeof WINDOWS;
export interface RoomDiagnosticsSelector {
  readonly window: RoomDiagnosticsWindow;
  readonly scope: DiagnosticVisibility;
  readonly streams?: readonly DiagnosticStream[];
  readonly severities?: readonly DiagnosticSeverity[];
  readonly identity?: Readonly<{ agentId?: string; generationId?: string }>;
  readonly correlation?: Readonly<{ correlationId?: string; traceId?: string; requestId?: string }>;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface RoomDiagnosticsCapabilityBinding {
  readonly effective: boolean;
  readonly participantId: string;
  readonly providerSessionId: string | null;
  readonly roomId: string;
  readonly projectId: string;
  readonly manifestRevision: number;
  readonly caller: DiagnosticCaller;
  readonly allowedScopes: readonly DiagnosticVisibility[];
}

interface DiagnosticsLease extends RoomDiagnosticsCapabilityBinding {
  readonly digest: Buffer;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly requests: Map<string, { readonly fingerprint: string; readonly result: Promise<DiagnosticQueryResult> }>;
  readonly cursorRanges: Map<string, { readonly from: string; readonly to: string }>;
}

export type RoomDiagnosticsLeaseOutcome = "issued" | "refreshed" | "accepted" | "replayed" | "rejected" | "expired" | "revoked";
export type RoomDiagnosticsLeaseReason = "lease-issued" | "lease-refreshed" | "tool-call-accepted" | "idempotent-replay" | "invalid-request" | "request-substitution" | "bounded-call-limit" | "scope-forbidden" | "query-rejected" | "lease-expired" | "provider-session-stale" | "manifest-stale" | "capability-revoked" | "explicit-revocation";
export interface RoomDiagnosticsLeaseEvent {
  readonly id: string;
  readonly at: string;
  readonly participantId: string;
  readonly outcome: RoomDiagnosticsLeaseOutcome;
  readonly reason: RoomDiagnosticsLeaseReason;
  readonly requestIdDigest: string | null;
  readonly scope: DiagnosticVisibility | null;
  readonly window: RoomDiagnosticsWindow | null;
  readonly resultCount: number | null;
  readonly resultBytes: number | null;
  readonly manifestRevision: number;
}

function digest(value: string) { return createHash("sha256").update(value).digest(); }
function fingerprint(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function requestDigest(value: string) { return value ? digest(value).toString("hex").slice(0, 24) : null; }
function isObject(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
function hasOnly(value: Record<string, unknown>, allowed: readonly string[]) { return Object.keys(value).every((key) => allowed.includes(key)); }
function boundedString(value: unknown) { return typeof value === "string" && value.length > 0 && value.length <= 200 ? value : undefined; }

function parseSelector(value: unknown): RoomDiagnosticsSelector | undefined {
  if (!isObject(value) || !hasOnly(value, ["window", "scope", "streams", "severities", "identity", "correlation", "limit", "cursor"])) return undefined;
  if (typeof value.window !== "string" || !(value.window in WINDOWS) || !SCOPES.includes(value.scope as DiagnosticVisibility)) return undefined;
  const streams = value.streams === undefined ? undefined : Array.isArray(value.streams) && value.streams.length > 0 && value.streams.length <= DIAGNOSTIC_STREAMS.length && value.streams.every((item) => DIAGNOSTIC_STREAMS.includes(item)) ? [...new Set(value.streams)] as DiagnosticStream[] : undefined;
  if (value.streams !== undefined && !streams) return undefined;
  const severities = value.severities === undefined ? undefined : Array.isArray(value.severities) && value.severities.length > 0 && value.severities.length <= SEVERITIES.length && value.severities.every((item) => SEVERITIES.includes(item)) ? [...new Set(value.severities)] as DiagnosticSeverity[] : undefined;
  if (value.severities !== undefined && !severities) return undefined;
  const identity = parseExactSelector(value.identity, ["agentId", "generationId"]);
  const correlation = parseExactSelector(value.correlation, ["correlationId", "traceId", "requestId"]);
  if (value.identity !== undefined && !identity || value.correlation !== undefined && !correlation) return undefined;
  const limit = value.limit === undefined ? undefined : Number.isSafeInteger(value.limit) && (value.limit as number) >= 1 && (value.limit as number) <= RESULT_LIMIT ? value.limit as number : undefined;
  if (value.limit !== undefined && limit === undefined) return undefined;
  const cursor = value.cursor === undefined ? undefined : typeof value.cursor === "string" && value.cursor.length > 0 && value.cursor.length <= 2_000 ? value.cursor : undefined;
  if (value.cursor !== undefined && !cursor) return undefined;
  return { window: value.window as RoomDiagnosticsWindow, scope: value.scope as DiagnosticVisibility, ...(streams ? { streams } : {}), ...(severities ? { severities } : {}), ...(identity ? { identity } : {}), ...(correlation ? { correlation } : {}), ...(limit ? { limit } : {}), ...(cursor ? { cursor } : {}) };
}

function parseExactSelector(value: unknown, keys: readonly string[]) {
  if (value === undefined) return undefined;
  if (!isObject(value) || !hasOnly(value, keys)) return undefined;
  const output: Record<string, string> = {};
  for (const key of keys) {
    if (value[key] === undefined) continue;
    const item = boundedString(value[key]);
    if (!item) return undefined;
    output[key] = item;
  }
  return Object.keys(output).length ? output : undefined;
}

export class RoomDiagnosticsToolBroker {
  private readonly leases = new Map<string, DiagnosticsLease>();
  private readonly events: RoomDiagnosticsLeaseEvent[] = [];
  private readonly recorded = new Set<string>();

  constructor(
    private readonly service: DiagnosticsQueryService,
    private readonly currentBinding: (participantId: string) => RoomDiagnosticsCapabilityBinding | undefined,
    private readonly now: () => number = Date.now,
    private readonly operationLog?: (event: RoomDiagnosticsLeaseEvent) => Promise<unknown> | unknown,
  ) {}

  issue(participantId: string): string | undefined {
    this.prune();
    const binding = this.currentBinding(participantId);
    if (!binding?.effective || binding.participantId !== participantId || !validBinding(binding)) return undefined;
    const existing = [...this.leases.entries()].find(([, lease]) => lease.participantId === participantId);
    if (existing) this.leases.delete(existing[0]);
    const token = `${randomUUID()}${randomUUID()}`;
    const issuedAt = this.now();
    const lease: DiagnosticsLease = { ...binding, digest: digest(token), issuedAt, expiresAt: issuedAt + LEASE_LIFETIME_MS, requests: new Map(), cursorRanges: new Map() };
    this.leases.set(digest(token).toString("hex"), lease);
    this.record(lease, existing ? "refreshed" : "issued", existing ? "lease-refreshed" : "lease-issued", null, null, null, null, null, `${binding.manifestRevision}:issue`);
    return token;
  }

  revoke(participantId: string) {
    const located = [...this.leases.entries()].find(([, lease]) => lease.participantId === participantId);
    if (!located) return false;
    this.leases.delete(located[0]);
    this.record(located[1], "revoked", "explicit-revocation", null, null, null, null, null, `${located[1].manifestRevision}:explicit-revocation`);
    return true;
  }

  async execute(token: string, input: unknown): Promise<DiagnosticQueryResult | undefined> {
    this.prune();
    const supplied = digest(token);
    const key = supplied.toString("hex");
    const lease = this.leases.get(key);
    if (!lease || lease.digest.length !== supplied.length || !timingSafeEqual(lease.digest, supplied)) return undefined;
    const current = this.currentBinding(lease.participantId);
    const staleReason = bindingRejection(lease, current);
    if (staleReason) { this.leases.delete(key); this.record(lease, "revoked", staleReason, null, null, null, null, null, `${lease.manifestRevision}:revoked:${staleReason}`); return undefined; }
    if (!isObject(input) || !hasOnly(input, ["requestId", "query"]) || typeof input.requestId !== "string" || !REQUEST_ID.test(input.requestId)) {
      this.record(lease, "rejected", "invalid-request", typeof input === "object" && input && "requestId" in input && typeof input.requestId === "string" ? input.requestId : "", null, null, null, null, `${lease.manifestRevision}:invalid:${fingerprint(input)}`);
      return undefined;
    }
    const requestId = input.requestId;
    const selector = parseSelector(input.query);
    if (!selector) { this.record(lease, "rejected", "invalid-request", requestId, null, null, null, null, `${lease.manifestRevision}:invalid:${requestId}`); return undefined; }
    if (!lease.allowedScopes.includes(selector.scope)) { this.record(lease, "rejected", "scope-forbidden", requestId, selector.scope, selector.window, null, null, `${lease.manifestRevision}:scope:${requestId}`); return undefined; }
    const requestFingerprint = fingerprint(input);
    const replay = lease.requests.get(requestId);
    if (replay) {
      if (replay.fingerprint !== requestFingerprint) { this.leases.delete(key); this.record(lease, "revoked", "request-substitution", requestId, selector.scope, selector.window, null, null, `${lease.manifestRevision}:substitution:${requestId}`); return undefined; }
      this.record(lease, "replayed", "idempotent-replay", requestId, selector.scope, selector.window, null, null, `${lease.manifestRevision}:replay:${requestId}`);
      return replay.result;
    }
    if (lease.requests.size >= CALL_LIMIT) { this.record(lease, "rejected", "bounded-call-limit", requestId, selector.scope, selector.window, null, null, `${lease.manifestRevision}:limit:${requestId}`); return undefined; }
    const operation = this.query(lease, selector).then((result) => {
      if (result.records.length > RESULT_LIMIT || result.serializedBytes > SERIALIZED_BYTE_LIMIT || Buffer.byteLength(JSON.stringify(result)) > SERIALIZED_BYTE_LIMIT) throw new DiagnosticsQueryError("invalid-query");
      this.record(lease, "accepted", "tool-call-accepted", requestId, selector.scope, selector.window, result.records.length + result.chunks.length, result.serializedBytes, `${lease.manifestRevision}:accepted:${requestId}`);
      return result;
    }).catch((error) => {
      this.record(lease, "rejected", "query-rejected", requestId, selector.scope, selector.window, null, null, `${lease.manifestRevision}:query-rejected:${requestId}`);
      throw error;
    });
    lease.requests.set(requestId, { fingerprint: requestFingerprint, result: operation });
    return operation;
  }

  audit(limit = 100) { return this.events.slice(-Math.max(1, Math.min(limit, 200))); }

  private async query(lease: DiagnosticsLease, selector: RoomDiagnosticsSelector) {
    const inheritedRange = selector.cursor ? lease.cursorRanges.get(selector.cursor) : undefined;
    if (selector.cursor && !inheritedRange) throw new DiagnosticsQueryError("invalid-cursor");
    const to = inheritedRange?.to ?? new Date(this.now()).toISOString();
    const from = inheritedRange?.from ?? new Date(Date.parse(to) - WINDOWS[selector.window]).toISOString();
    const identity = { ...selector.identity, ...(selector.scope === "room" ? { roomId: lease.roomId } : {}), ...(selector.scope === "self" ? { selfId: lease.caller.selfId || lease.participantId } : {}) };
    const query: DiagnosticQuery = {
      from, to, scope: selector.scope,
      ...(selector.streams ? { streams: selector.streams } : {}), ...(selector.severities ? { severities: selector.severities } : {}),
      ...(Object.keys(identity).length ? { identity } : {}), ...(selector.correlation ? { correlation: selector.correlation } : {}),
      limit: selector.limit || RESULT_LIMIT, maxScannedBytes: SCANNED_BYTE_LIMIT, maxSerializedBytes: SERIALIZED_BYTE_LIMIT,
      ...(selector.cursor ? { cursor: selector.cursor } : {}),
    };
    const result = await this.service.query(lease.caller, query);
    if (result.nextCursor) {
      lease.cursorRanges.set(result.nextCursor, { from, to });
      if (lease.cursorRanges.size > CALL_LIMIT) lease.cursorRanges.delete(lease.cursorRanges.keys().next().value!);
    }
    return result;
  }

  private prune() {
    const now = this.now();
    for (const [key, lease] of this.leases) if (lease.expiresAt <= now) { this.leases.delete(key); this.record(lease, "expired", "lease-expired", null, null, null, null, null, `${lease.manifestRevision}:expired:${lease.expiresAt}`); }
  }

  private record(binding: Pick<RoomDiagnosticsCapabilityBinding, "participantId" | "manifestRevision"> & Partial<Pick<DiagnosticsLease, "issuedAt">>, outcome: RoomDiagnosticsLeaseOutcome, reason: RoomDiagnosticsLeaseReason, requestId: string | null, scope: DiagnosticVisibility | null, window: RoomDiagnosticsWindow | null, resultCount: number | null, resultBytes: number | null, dedupe: string) {
    const id = fingerprint(`${binding.participantId}:${binding.issuedAt ?? "unissued"}:${dedupe}`);
    if (this.recorded.has(id)) return;
    this.recorded.add(id); if (this.recorded.size > 1_000) this.recorded.delete(this.recorded.values().next().value!);
    const event = { id: id.slice(0, 24), at: new Date(this.now()).toISOString(), participantId: binding.participantId, outcome, reason, requestIdDigest: requestId === null ? null : requestDigest(requestId), scope, window, resultCount, resultBytes, manifestRevision: binding.manifestRevision } satisfies RoomDiagnosticsLeaseEvent;
    this.events.push(event); if (this.events.length > 500) this.events.splice(0, this.events.length - 500);
    try {
      const logged = this.operationLog?.(event);
      if (logged && typeof (logged as PromiseLike<unknown>).then === "function") {
        void Promise.resolve(logged).catch(() => undefined);
      }
    } catch {
      // Diagnostics audit logging must never disrupt lease issuance or use.
    }
  }
}

function validBinding(binding: RoomDiagnosticsCapabilityBinding) {
  return Boolean(binding.participantId && binding.roomId && binding.projectId && Number.isSafeInteger(binding.manifestRevision) && binding.manifestRevision > 0 && binding.caller.principalId === binding.participantId && binding.caller.roomIds.includes(binding.roomId) && binding.caller.projectIds.includes(binding.projectId) && binding.allowedScopes.length && binding.allowedScopes.every((scope) => SCOPES.includes(scope)));
}

function bindingRejection(lease: DiagnosticsLease, current: RoomDiagnosticsCapabilityBinding | undefined): RoomDiagnosticsLeaseReason | undefined {
  if (!current?.effective || current.participantId !== lease.participantId) return "capability-revoked";
  if (current.providerSessionId !== lease.providerSessionId) return "provider-session-stale";
  if (current.manifestRevision !== lease.manifestRevision) return "manifest-stale";
  if (current.roomId !== lease.roomId || current.projectId !== lease.projectId || current.caller.principalId !== lease.caller.principalId) return "capability-revoked";
  return undefined;
}

export function registerRoomDiagnosticsToolRoute(app: express.Express, broker: RoomDiagnosticsToolBroker) {
  app.post("/api/agent-tools/room-diagnostics", async (request, response) => {
    const authorization = request.header("authorization") || "";
    const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!token) return response.status(404).json({ error: "Not found." });
    try {
      const result = await broker.execute(token, request.body);
      if (!result) return response.status(404).json({ error: "Not found." });
      return response.set("Cache-Control", "no-store").json(result);
    } catch (error) {
      if (error instanceof DiagnosticsQueryError) return response.status(error.code === "forbidden" ? 403 : 400).set("Cache-Control", "no-store").json({ error: error.code });
      throw error;
    }
  });
}
