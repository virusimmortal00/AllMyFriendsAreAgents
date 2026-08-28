import express from "express";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DIAGNOSTIC_STREAM_FILES, LocalFileDiagnosticsQueryService, type DiagnosticQueryResult, type DiagnosticsQueryService } from "./diagnostics-query.js";
import { registerRoomDiagnosticsToolRoute, RoomDiagnosticsToolBroker, type RoomDiagnosticsCapabilityBinding, type RoomDiagnosticsLeaseEvent } from "./room-diagnostics-tool.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function emptyResult(): DiagnosticQueryResult {
  const result = { records: [], chunks: [], nextCursor: null, scannedBytes: 0, serializedBytes: 0, malformedRecords: 0, scanLimitReached: false };
  return { ...result, serializedBytes: Buffer.byteLength(JSON.stringify(result)) };
}

function fixture() {
  let now = Date.parse("2026-08-28T12:00:00.000Z");
  let binding: RoomDiagnosticsCapabilityBinding = {
    effective: true, participantId: "codex-sol", providerSessionId: "provider-session-one", roomId: "room-one", projectId: "project-one", manifestRevision: 7,
    caller: { principalId: "codex-sol", selfId: "codex-sol", roomIds: ["room-one"], projectIds: ["project-one"], operator: false },
    allowedScopes: ["self", "room", "project"],
  };
  const query = vi.fn<DiagnosticsQueryService["query"]>(async () => emptyResult());
  const events: RoomDiagnosticsLeaseEvent[] = [];
  const broker = new RoomDiagnosticsToolBroker({ query }, (participantId) => participantId === binding.participantId ? binding : undefined, () => now, (event) => events.push(event));
  const token = broker.issue("codex-sol")!;
  const input = { requestId: "diagnostic-request-01", query: { window: "last-hour", scope: "room", streams: ["generations"], severities: ["warn"], identity: { generationId: "generation-one" }, correlation: { correlationId: "correlation-one" }, limit: 12 } } as const;
  return { broker, token, input, query, events, setNow: (value: number) => { now = value; }, getNow: () => now, setBinding: (value: RoomDiagnosticsCapabilityBinding) => { binding = value; }, getBinding: () => binding };
}

describe("lease-bound room_diagnostics broker", () => {
  it("advertises and issues only under current effective server capability policy", () => {
    const api = fixture();
    api.setBinding({ ...api.getBinding(), effective: false });
    expect(api.broker.issue("codex-sol")).toBeUndefined();
    expect(api.broker.issue("claude-sonnet")).toBeUndefined();
    expect(api.events[0]).toMatchObject({ outcome: "issued", reason: "lease-issued", participantId: "codex-sol", manifestRevision: 7 });
    expect(JSON.stringify(api.events)).not.toContain("provider-session-one");
  });

  it("binds participant, provider session, room, project, and manifest and fails closed on substitution or staleness", async () => {
    const participant = fixture();
    expect(await participant.broker.execute(participant.token, { ...participant.input, participantId: "claude-sonnet" })).toBeUndefined();
    expect(participant.query).not.toHaveBeenCalled();

    const session = fixture();
    session.setBinding({ ...session.getBinding(), providerSessionId: "provider-session-two" });
    expect(await session.broker.execute(session.token, session.input)).toBeUndefined();
    expect(session.events.at(-1)).toMatchObject({ outcome: "revoked", reason: "provider-session-stale" });

    const manifest = fixture();
    manifest.setBinding({ ...manifest.getBinding(), manifestRevision: 8 });
    expect(await manifest.broker.execute(manifest.token, manifest.input)).toBeUndefined();
    expect(manifest.events.at(-1)).toMatchObject({ outcome: "revoked", reason: "manifest-stale" });

    const scope = fixture();
    scope.setBinding({ ...scope.getBinding(), roomId: "room-two" });
    expect(await scope.broker.execute(scope.token, scope.input)).toBeUndefined();
    expect(scope.events.at(-1)).toMatchObject({ outcome: "revoked", reason: "capability-revoked" });
  });

  it("expires and explicitly revokes leases before diagnostics are reachable", async () => {
    const expired = fixture();
    expired.setNow(expired.getNow() + 10 * 60_000);
    expect(await expired.broker.execute(expired.token, expired.input)).toBeUndefined();
    expect(expired.events.at(-1)).toMatchObject({ outcome: "expired", reason: "lease-expired" });
    expect(expired.query).not.toHaveBeenCalled();
    const revoked = fixture();
    expect(revoked.broker.revoke("codex-sol")).toBe(true);
    expect(await revoked.broker.execute(revoked.token, revoked.input)).toBeUndefined();
    expect(revoked.events.at(-1)).toMatchObject({ outcome: "revoked", reason: "explicit-revocation" });
  });

  it("replays an identical request idempotently and revokes request-id substitution abuse", async () => {
    const api = fixture();
    const first = await api.broker.execute(api.token, api.input);
    expect(await api.broker.execute(api.token, api.input)).toEqual(first);
    expect(api.query).toHaveBeenCalledTimes(1);
    expect(api.events.filter(({ reason }) => reason === "idempotent-replay")).toHaveLength(1);
    expect(await api.broker.execute(api.token, { ...api.input, query: { window: "last-day", scope: "project" } })).toBeUndefined();
    expect(api.events.at(-1)).toMatchObject({ outcome: "revoked", reason: "request-substitution" });
    expect(await api.broker.execute(api.token, { ...api.input, requestId: "diagnostic-request-02" })).toBeUndefined();
    expect(api.query).toHaveBeenCalledTimes(1);
  });

  it("enforces the bounded call count without treating exact replay as another call", async () => {
    const api = fixture();
    for (let index = 0; index < 8; index++) expect(await api.broker.execute(api.token, { ...api.input, requestId: `diagnostic-call-${String(index).padStart(2, "0")}` })).toBeDefined();
    expect(await api.broker.execute(api.token, { ...api.input, requestId: "diagnostic-call-08" })).toBeUndefined();
    expect(api.events.at(-1)).toMatchObject({ outcome: "rejected", reason: "bounded-call-limit" });
    expect(api.query).toHaveBeenCalledTimes(8);
  });

  it("preserves the original bounded time range across cursor calls", async () => {
    const api = fixture();
    api.query.mockResolvedValueOnce({ ...emptyResult(), nextCursor: "cursor-one" });
    await api.broker.execute(api.token, api.input);
    api.setNow(api.getNow() + 5_000);
    await api.broker.execute(api.token, {
      ...api.input,
      requestId: "diagnostic-request-02",
      query: { ...api.input.query, cursor: "cursor-one" },
    });
    expect(api.query).toHaveBeenCalledTimes(2);
    expect(api.query.mock.calls[1][1].from).toBe(api.query.mock.calls[0][1].from);
    expect(api.query.mock.calls[1][1].to).toBe(api.query.mock.calls[0][1].to);
  });

  it("distinguishes audit events from separate leases and absorbs operation-log failures", async () => {
    let now = Date.parse("2026-08-28T12:00:00.000Z");
    const binding: RoomDiagnosticsCapabilityBinding = {
      effective: true, participantId: "codex-sol", providerSessionId: "session", roomId: "room-one", projectId: "project-one", manifestRevision: 7,
      caller: { principalId: "codex-sol", selfId: "codex-sol", roomIds: ["room-one"], projectIds: ["project-one"], operator: false }, allowedScopes: ["room"],
    };
    const operationLog = vi.fn(async () => { throw new Error("audit sink unavailable"); });
    const broker = new RoomDiagnosticsToolBroker({ query: async () => emptyResult() }, () => binding, () => now, operationLog);
    const first = broker.issue("codex-sol")!;
    await broker.execute(first, { requestId: "diagnostic-request-01", query: { window: "last-hour", scope: "room" } });
    expect(broker.revoke("codex-sol")).toBe(true);
    now += 1;
    const second = broker.issue("codex-sol")!;
    await broker.execute(second, { requestId: "diagnostic-request-01", query: { window: "last-hour", scope: "room" } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const accepted = broker.audit().filter(({ outcome }) => outcome === "accepted");
    expect(accepted).toHaveLength(2);
    expect(new Set(accepted.map(({ id }) => id)).size).toBe(2);
    expect(operationLog).toHaveBeenCalled();
  });

  it("accepts only closed bounded selectors and never caller-selected paths, backends, credentials, text searches, identities, or times", async () => {
    const forbidden = [
      { path: "/private/log" }, { backend: "loki" }, { credential: "secret" }, { search: "unrestricted text" },
      { from: "1970-01-01T00:00:00Z", to: "2099-01-01T00:00:00Z" }, { roomId: "room-two" }, { projectId: "project-two" },
    ];
    for (const [index, field] of forbidden.entries()) {
      const api = fixture();
      expect(await api.broker.execute(api.token, { requestId: `invalid-query-${index}`, query: { window: "last-hour", scope: "room", ...field } })).toBeUndefined();
      expect(api.query).not.toHaveBeenCalled();
    }
    const api = fixture();
    await api.broker.execute(api.token, api.input);
    const [caller, query] = api.query.mock.calls[0];
    expect(caller).toEqual(api.getBinding().caller);
    expect(query).toMatchObject({ scope: "room", identity: { roomId: "room-one", generationId: "generation-one" }, limit: 12, maxScannedBytes: 2 * 1024 * 1024, maxSerializedBytes: 256 * 1024 });
    expect(Date.parse(query.to) - Date.parse(query.from)).toBe(60 * 60_000);
    expect(JSON.stringify(query)).not.toMatch(/path|backend|credential|search|provider-session/);
  });

  it("honors self/room/project/operator visibility through the bound diagnostics caller", async () => {
    const api = fixture();
    await api.broker.execute(api.token, { requestId: "self-scope-request", query: { window: "last-hour", scope: "self" } });
    expect(api.query.mock.calls[0][1]).toMatchObject({ scope: "self", identity: { selfId: "codex-sol" } });
    expect(await api.broker.execute(api.token, { requestId: "operator-scope-request", query: { window: "last-hour", scope: "operator" } })).toBeUndefined();
    expect(api.events.at(-1)).toMatchObject({ reason: "scope-forbidden" });
  });

  it("rejects an out-of-contract service response that exceeds result count or byte bounds", async () => {
    const count = fixture();
    count.query.mockResolvedValue({ ...emptyResult(), records: Array.from({ length: 51 }, (_, index) => ({ recordId: String(index) } as never)) });
    await expect(count.broker.execute(count.token, count.input)).rejects.toMatchObject({ code: "invalid-query" });
    const bytes = fixture();
    bytes.query.mockResolvedValue({ ...emptyResult(), serializedBytes: 256 * 1024 + 1 });
    await expect(bytes.broker.execute(bytes.token, bytes.input)).rejects.toMatchObject({ code: "invalid-query" });
  });

  it("returns only query-service evidence, redacts authentication secrets, and never mutates transcript state", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "amfaa-room-diagnostics-tool-")); roots.push(root);
    const directory = path.join(root, "logs", "authoritative-v1"); await mkdir(directory, { recursive: true });
    const record = { envelopeVersion: 1, recordId: "record-one", stream: "generations", timestamp: "2026-08-28T11:45:00.000Z", severity: "warn", event: "generation.evidence", projectId: "project-one", roomId: "room-one", agentId: "codex-sol", selfId: "codex-sol", visibility: "room", content: { evidence: "preserve diagnostic evidence", authorization: "Bearer top-secret", nested: { apiKey: "remove-me", note: "password=hunter2" } } };
    await writeFile(path.join(directory, `${DIAGNOSTIC_STREAM_FILES.generations}.jsonl`), `${JSON.stringify(record)}\n`);
    const binding: RoomDiagnosticsCapabilityBinding = { effective: true, participantId: "codex-sol", providerSessionId: "session", roomId: "room-one", projectId: "project-one", manifestRevision: 1, caller: { principalId: "codex-sol", selfId: "codex-sol", roomIds: ["room-one"], projectIds: ["project-one"], operator: false }, allowedScopes: ["self", "room", "project"] };
    const events: RoomDiagnosticsLeaseEvent[] = [];
    const broker = new RoomDiagnosticsToolBroker(new LocalFileDiagnosticsQueryService(root, "project-one"), () => binding, () => Date.parse("2026-08-28T12:00:00.000Z"), (event) => events.push(event));
    const token = broker.issue("codex-sol")!;
    const transcript = [{ speaker: "human", text: "existing room message" }];
    const before = structuredClone(transcript);
    const result = await broker.execute(token, { requestId: "redaction-request-01", query: { window: "last-hour", scope: "room", streams: ["generations"] } });
    expect(result?.records[0].content).toMatchObject({ evidence: "preserve diagnostic evidence", authorization: "[REDACTED]", nested: { apiKey: "[REDACTED]" } });
    expect(JSON.stringify(result)).not.toMatch(/top-secret|remove-me|hunter2/);
    expect(transcript).toEqual(before);
    expect(JSON.stringify(events)).not.toMatch(/diagnostic evidence|top-secret|remove-me|hunter2|correlation-one|generation-one/);
  });

  it("integrates through an opaque no-store transport and rejects participant/request substitution", async () => {
    const api = fixture(); const app = express(); app.use(express.json()); registerRoomDiagnosticsToolRoute(app, api.broker);
    const server = app.listen(0, "127.0.0.1"); await new Promise<void>((resolve) => server.once("listening", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/agent-tools/room-diagnostics`;
    try {
      expect((await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(404);
      const accepted = await fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${api.token}` }, body: JSON.stringify(api.input) });
      expect(accepted.status).toBe(200); expect(accepted.headers.get("cache-control")).toBe("no-store");
      const substituted = await fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${api.token}` }, body: JSON.stringify({ ...api.input, participantId: "claude-sonnet" }) });
      expect(substituted.status).toBe(404);
    } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  });
});
