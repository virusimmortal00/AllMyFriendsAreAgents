import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuthoritativeLogging } from "./authoritative-logging.js";
import {
  DIAGNOSTICS_QUERY_LIMITS,
  DIAGNOSTIC_STREAM_FILES,
  DiagnosticsQueryError,
  LocalFileDiagnosticsQueryService,
  type DiagnosticCaller,
  type DiagnosticQuery,
  type DiagnosticRecord,
  type DiagnosticsQueryService,
} from "./diagnostics-query.js";

const roots: string[] = [];
const projectId = "project-one";
const range = { from: "2026-08-28T00:00:00.000Z", to: "2026-08-29T00:00:00.000Z" };
const projectCaller: DiagnosticCaller = { principalId: "human-one", selfId: "agent-one", roomIds: ["room-one"], projectIds: [projectId], operator: false };
const baseQuery: DiagnosticQuery = { ...range, scope: "project" };

function record(overrides: Partial<DiagnosticRecord> = {}): DiagnosticRecord {
  return {
    schemaVersion: 1, recordId: "record-one", stream: "generations", timestamp: "2026-08-28T12:00:00.000Z",
    severity: "info", event: "generation.completed", projectId, roomId: "room-one", agentId: "agent-one",
    selfId: "agent-one", generationId: "generation-one", correlationId: "correlation-one", traceId: "a".repeat(32),
    requestId: "request-one", visibility: "project", content: { prompt: "preserve this prompt", output: "preserve this output" }, ...overrides,
  };
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "amfaa-diagnostics-query-"));
  roots.push(root);
  const service: DiagnosticsQueryService = new LocalFileDiagnosticsQueryService(root, projectId);
  const logDirectory = path.join(root, "logs", "authoritative-v1");
  await mkdir(logDirectory, { recursive: true, mode: 0o700 });
  const write = async (stream: keyof typeof DIAGNOSTIC_STREAM_FILES, records: readonly unknown[], suffix = "") => {
    await writeFile(path.join(logDirectory, `${DIAGNOSTIC_STREAM_FILES[stream]}${suffix}.jsonl`), records.map((item) => typeof item === "string" ? item : JSON.stringify(item)).join("\n") + "\n", { mode: 0o600 });
  };
  return { root, logDirectory, service, write };
}

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

/** Reusable behavioral suite; every backend implements DiagnosticsQueryService. */
function diagnosticsQueryContract(name: string, make: typeof fixture) {
  describe(name, () => {
    it("queries all six fixed streams with deterministic selectors and ordering", async () => {
      const { service, write } = await make();
      const streams = Object.keys(DIAGNOSTIC_STREAM_FILES) as Array<keyof typeof DIAGNOSTIC_STREAM_FILES>;
      await Promise.all(streams.map((stream, index) => write(stream, [record({ recordId: `record-${index}`, stream, timestamp: `2026-08-28T12:00:0${index}.000Z`, severity: index % 2 ? "warn" : "info", event: index % 2 ? "selected.warn" : "selected.info" })])));
      const result = await service.query(projectCaller, { ...baseQuery, severities: ["warn"], events: ["selected.warn"] });
      expect(result.records.map(({ recordId }) => recordId)).toEqual(["record-5", "record-3", "record-1"]);
      expect(result.records.map(({ stream }) => stream)).toEqual(["security-audit", "generations", "opencode-harness"]);
    });

    it("enforces self, room, project, and operator scopes before returning content", async () => {
      const { service, write } = await make();
      await write("generations", [
        record({ recordId: "self-own", visibility: "self" }),
        record({ recordId: "self-peer", visibility: "self", agentId: "agent-two", selfId: "agent-two" }),
        record({ recordId: "room-own", visibility: "room" }),
        record({ recordId: "room-other", visibility: "room", roomId: "room-two" }),
        record({ recordId: "project", visibility: "project" }),
        record({ recordId: "operator", visibility: "operator" }),
      ]);
      expect((await service.query(projectCaller, { ...range, scope: "self" })).records.map(({ recordId }) => recordId)).toEqual(["self-own"]);
      expect((await service.query(projectCaller, { ...range, scope: "room", identity: { roomId: "room-one" } })).records.map(({ recordId }) => recordId).sort()).toEqual(["room-own", "self-own"]);
      expect((await service.query(projectCaller, baseQuery)).records.map(({ recordId }) => recordId).sort()).toEqual(["project", "room-own", "self-own"]);
      await expect(service.query(projectCaller, { ...range, scope: "room", identity: { roomId: "room-two" } })).rejects.toMatchObject({ code: "forbidden" });
      await expect(service.query(projectCaller, { ...range, scope: "operator" })).rejects.toMatchObject({ code: "forbidden" });
      const operator = { ...projectCaller, operator: true, operatorId: "operator-one" };
      expect((await service.query(operator, { ...range, scope: "self" })).records.map(({ recordId }) => recordId).sort()).toEqual(["self-own", "self-peer"]);
      expect((await service.query(operator, { ...range, scope: "room" })).records.map(({ recordId }) => recordId).sort()).toEqual(["room-other", "room-own", "self-own", "self-peer"]);
      expect((await service.query(operator, { ...range, scope: "project" })).records.map(({ recordId }) => recordId).sort()).toEqual(["project", "room-other", "room-own", "self-own", "self-peer"]);
      expect((await service.query(operator, { ...range, scope: "operator" })).records).toHaveLength(6);
    });

    it("rejects project, identity, selector, cursor, path, backend, and window escapes", async () => {
      const { service } = await make();
      const outside = { ...projectCaller, projectIds: ["project-two"] };
      await expect(service.query(outside, baseQuery)).rejects.toMatchObject({ code: "forbidden" });
      await expect(service.query(projectCaller, { ...range, scope: "self", identity: { selfId: "agent-two" } })).rejects.toMatchObject({ code: "forbidden" });
      await expect(service.query({ ...projectCaller, selfId: undefined }, { ...range, scope: "self" })).rejects.toMatchObject({ code: "forbidden" });
      await expect(service.query({ ...projectCaller, roomIds: [] }, { ...range, scope: "room", identity: { roomId: "room-one" } })).rejects.toMatchObject({ code: "forbidden" });
      await expect(service.query({ ...projectCaller, projectIds: [] }, baseQuery)).rejects.toMatchObject({ code: "forbidden" });
      await expect(service.query(projectCaller, { ...baseQuery, streams: ["unknown" as never] })).rejects.toMatchObject({ code: "invalid-query" });
      await expect(service.query(projectCaller, { ...baseQuery, cursor: "not-a-cursor" })).rejects.toMatchObject({ code: "invalid-cursor" });
      await expect(service.query(projectCaller, { ...baseQuery, repository: "other/repository" } as DiagnosticQuery)).rejects.toMatchObject({ code: "invalid-query" });
      await expect(service.query(projectCaller, { ...baseQuery, path: "/private/data" } as DiagnosticQuery)).rejects.toMatchObject({ code: "invalid-query" });
      await expect(service.query(projectCaller, { ...baseQuery, backend: "loki" } as DiagnosticQuery)).rejects.toMatchObject({ code: "invalid-query" });
      await expect(service.query(projectCaller, { from: range.from, to: "2026-09-30T00:00:00.000Z", scope: "project" })).rejects.toMatchObject({ code: "invalid-query" });
      expect(() => new LocalFileDiagnosticsQueryService("relative/path", projectId)).toThrow(DiagnosticsQueryError);
    });

    it("enforces result, scanned, serialized, time, and selector bounds", async () => {
      const { service, write } = await make();
      await write("generations", Array.from({ length: 205 }, (_, index) => record({ recordId: `bounded-${String(index).padStart(3, "0")}`, content: { text: "x".repeat(80) } })));
      await expect(service.query(projectCaller, { ...baseQuery, limit: DIAGNOSTICS_QUERY_LIMITS.maxResults + 1 })).rejects.toMatchObject({ code: "invalid-query" });
      await expect(service.query(projectCaller, { ...baseQuery, maxScannedBytes: DIAGNOSTICS_QUERY_LIMITS.maxScannedBytes + 1 })).rejects.toMatchObject({ code: "invalid-query" });
      await expect(service.query(projectCaller, { ...baseQuery, maxSerializedBytes: DIAGNOSTICS_QUERY_LIMITS.maxSerializedBytes + 1 })).rejects.toMatchObject({ code: "invalid-query" });
      await expect(service.query(projectCaller, { ...baseQuery, events: Array.from({ length: 21 }, (_, index) => `event-${index}`) })).rejects.toMatchObject({ code: "invalid-query" });
      expect((await service.query(projectCaller, { ...baseQuery, limit: 7 })).records).toHaveLength(7);
      const scanned = await service.query(projectCaller, { ...baseQuery, maxScannedBytes: 1024 });
      expect(scanned.scannedBytes).toBeLessThanOrEqual(1024);
      expect(scanned.scanLimitReached).toBe(true);
      const serialized = await service.query(projectCaller, { ...baseQuery, maxSerializedBytes: 6_000 });
      expect(serialized.serializedBytes).toBeLessThanOrEqual(6_000);
      expect(serialized.serializedBytes).toBe(Buffer.byteLength(JSON.stringify(serialized)));
      expect(serialized.records.length).toBeLessThan(50);
    });

    it("filters identities and exact correlation envelopes", async () => {
      const { service, write } = await make();
      await write("openrouter-provider", [record({ recordId: "correlated", stream: "openrouter-provider" }), record({ recordId: "other", stream: "openrouter-provider", correlationId: "other", generationId: "other" })]);
      const result = await service.query(projectCaller, { ...baseQuery, identity: { roomId: "room-one", agentId: "agent-one", generationId: "generation-one" }, correlation: { correlationId: "correlation-one", traceId: "a".repeat(32), requestId: "request-one" } });
      expect(result.records.map(({ recordId }) => recordId)).toEqual(["correlated"]);
    });

    it("preserves authorized evidence while recursively redacting only authentication material", async () => {
      const { service, write } = await make();
      const deep: Record<string, unknown> = {};
      let leaf = deep;
      for (let index = 0; index < 30; index++) { leaf.next = {}; leaf = leaf.next as Record<string, unknown>; }
      leaf.evidence = "preserve deep evidence";
      await write("generations", [record({ content: { prompt: "preserve assembled prompt", rawOutput: "preserve provider output", reasoning: "preserve disclosed reasoning", authorization: "Bearer top-secret", nested: { apiKey: "key-value", note: "password=hunter2" }, deep } })]);
      const [result] = (await service.query(projectCaller, baseQuery)).records;
      expect(result?.content).toMatchObject({ prompt: "preserve assembled prompt", rawOutput: "preserve provider output", reasoning: "preserve disclosed reasoning", authorization: "[REDACTED]", nested: { apiKey: "[REDACTED]" } });
      expect(JSON.stringify(result)).not.toContain("hunter2");
      expect(JSON.stringify(result)).toContain("preserve deep evidence");
    });

    it("reads the finalized authoritative logging envelope and never projects its filesystem identity", async () => {
      const { root, service } = await make();
      const logging = await AuthoritativeLogging.open({ dataDirectory: root, projectId, projectPath: "/sensitive/project/path" });
      logging.log("generations", "info", "generation.real-envelope", { prompt: "full prompt", rawOutput: "full output", authorization: "Bearer unsafe-value" }, { visibility: "project", roomId: "room-one", agentId: "agent-one", selfId: "agent-one", generationId: "generation-real" });
      await logging.flush();
      const result = await service.query(projectCaller, { ...baseQuery, events: ["generation.real-envelope"] });
      expect(result.records).toHaveLength(1);
      expect(result.records[0]).toMatchObject({ stream: "generations", schemaVersion: 1, selfId: "agent-one", content: { prompt: "full prompt", rawOutput: "full output", authorization: "[REDACTED]" } });
      expect(JSON.stringify(result)).not.toContain("/sensitive/project/path");
      await logging.close();
    });

    it("continues a real record above 1 MiB losslessly within bounded responses", async () => {
      const { root, service } = await make();
      const evidence = `begin:${"x".repeat(1_200_000)}:end`;
      const logging = await AuthoritativeLogging.open({
        dataDirectory: root, projectId, projectPath: root, maxBufferedBytes: 3 * 1024 * 1024,
        rotation: { generations: { maxBytes: 4 * 1024 * 1024, frequencyMs: 60_000, retention: 3 } },
      });
      logging.log("generations", "info", "generation.oversized", { rawOutput: evidence, authorization: "Bearer remove-me" }, { visibility: "project", roomId: "room-one", selfId: "agent-one" });
      await logging.flush();
      const fragments: Buffer[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 40; page++) {
        const result = await service.query(projectCaller, { ...baseQuery, events: ["generation.oversized"], maxScannedBytes: 4 * 1024 * 1024, maxSerializedBytes: 64 * 1024, ...(cursor ? { cursor } : {}) });
        expect(result.serializedBytes).toBeLessThanOrEqual(64 * 1024);
        for (const chunk of result.chunks) fragments.push(Buffer.from(chunk.data, "base64"));
        cursor = result.nextCursor || undefined;
        if (!cursor) break;
      }
      const assembled = JSON.parse(Buffer.concat(fragments).toString("utf8")) as DiagnosticRecord;
      expect(assembled.content).toMatchObject({ rawOutput: evidence, authorization: "[REDACTED]" });
      expect(fragments.length).toBeGreaterThan(10);
      await logging.close();
    });

    it("continues scanning older evidence after chunking an oversized newest record", async () => {
      const { service, write } = await make();
      const target = record({ recordId: "older-target", timestamp: "2026-08-28T10:00:00.000Z", event: "generation.target", content: { marker: "must-reach" } });
      const filler = Array.from({ length: 8 }, (_, index) => record({
        recordId: `older-filler-${index}`,
        timestamp: `2026-08-28T11:00:0${index}.000Z`,
        event: "generation.filler",
        content: { evidence: "f".repeat(24 * 1024) },
      }));
      const newest = record({ recordId: "oversized-newest", timestamp: "2026-08-28T12:00:00.000Z", event: "generation.oversized", content: { evidence: "x".repeat(600 * 1024) } });
      await write("generations", [target, ...filler, newest]);

      const found: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 40; page++) {
        const result = await service.query(projectCaller, {
          ...baseQuery,
          streams: ["generations"],
          maxScannedBytes: 640 * 1024,
          maxSerializedBytes: 64 * 1024,
          ...(cursor ? { cursor } : {}),
        });
        found.push(...result.records.map(({ recordId }) => recordId));
        cursor = result.nextCursor || undefined;
        if (!cursor) break;
      }
      expect(found).toContain("older-target");
    });

    it("returns a scan cursor when a bounded page contains no matching records", async () => {
      const { service, write } = await make();
      const target = record({ recordId: "older-match", timestamp: "2026-08-28T10:00:00.000Z", event: "generation.target" });
      const unrelated = Array.from({ length: 30 }, (_, index) => record({
        recordId: `newer-unrelated-${index}`,
        timestamp: `2026-08-28T11:00:${String(index).padStart(2, "0")}.000Z`,
        event: "generation.unrelated",
        content: { evidence: "x".repeat(512) },
      }));
      await write("generations", [target, ...unrelated]);

      const found: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 40; page++) {
        const result = await service.query(projectCaller, {
          ...baseQuery,
          streams: ["generations"],
          events: ["generation.target"],
          maxScannedBytes: 2_048,
          ...(cursor ? { cursor } : {}),
        });
        if (page === 0) {
          expect(result.records).toHaveLength(0);
          expect(result.scanLimitReached).toBe(true);
          expect(result.nextCursor).toBeTruthy();
        }
        found.push(...result.records.map(({ recordId }) => recordId));
        cursor = result.nextCursor || undefined;
        if (!cursor) break;
      }
      expect(found).toContain("older-match");
    });

    it("deduplicates rotation overlap and keeps cursor pagination stable during rotation", async () => {
      const { service, write } = await make();
      const records = [4, 3, 2, 1].map((index) => record({ recordId: `page-${index}`, timestamp: `2026-08-28T12:00:0${index}.000Z` }));
      await write("generations", records.slice(0, 3));
      await write("generations", records.slice(2), ".1");
      const first = await service.query(projectCaller, { ...baseQuery, limit: 2 });
      expect(first.records.map(({ recordId }) => recordId)).toEqual(["page-4", "page-3"]);
      expect(first.nextCursor).toBeTruthy();
      await write("generations", [record({ recordId: "new-after-page", timestamp: "2026-08-28T12:00:09.000Z" }), ...records.slice(0, 2)]);
      await write("generations", records.slice(1), ".1");
      const second = await service.query(projectCaller, { ...baseQuery, limit: 2, cursor: first.nextCursor! });
      expect(second.records.map(({ recordId }) => recordId)).toEqual(["page-2", "page-1"]);
      expect(second.nextCursor).toBeNull();
    });

    it("handles missing files, malformed and legacy records, partial lines, and fixed rotation limits without path disclosure", async () => {
      const { root, service, write } = await make();
      expect(await service.query(projectCaller, baseQuery)).toMatchObject({ records: [], scannedBytes: 0 });
      const legacy = { timestamp: "2026-08-28T11:00:00.000Z", level: 40, event: "legacy.warning", projectId, visibility: "operator", safe: "legacy content" };
      const legacyDirectory = path.join(root, "logs", "legacy-v1");
      await mkdir(legacyDirectory, { recursive: true, mode: 0o700 });
      await writeFile(path.join(legacyDirectory, "server.jsonl"), `${JSON.stringify(legacy)}\nnot-json\n${JSON.stringify(record({ recordId: "partial" }))}`, { mode: 0o600 });
      const operator = { ...projectCaller, operator: true, operatorId: "operator-one" };
      const result = await service.query(operator, { ...range, scope: "operator", streams: ["server-service-lifecycle"] });
      expect(result.records).toHaveLength(1);
      expect(result.records[0]).toMatchObject({ schemaVersion: 0, event: "legacy.warning", severity: "warn", content: { safe: "legacy content" } });
      expect(result.malformedRecords).toBe(1);
      expect(JSON.stringify(result)).not.toContain(root);
      for (let rotation = 17; rotation <= 30; rotation++) await write("security-audit", [record({ recordId: `retained-${rotation}`, stream: "security-audit", visibility: "operator", timestamp: `2026-08-28T12:${rotation}:00.000Z` })], `.${rotation}`);
      await write("security-audit", [record({ recordId: "old-0", stream: "security-audit", visibility: "operator", timestamp: "2026-08-28T12:00:00.000Z" })], ".0");
      const retained = await service.query(operator, { ...range, scope: "operator", streams: ["security-audit"] });
      for (let rotation = 17; rotation <= 30; rotation++) expect(retained.records.map(({ recordId }) => recordId)).toContain(`retained-${rotation}`);
      const newest = await service.query(operator, { ...range, scope: "operator", streams: ["security-audit"], maxScannedBytes: 1_024 });
      expect(newest.records.map(({ recordId }) => recordId)).toContain("retained-30");
    });
  });
}

diagnosticsQueryContract("local-file diagnostics query contract", fixture);
