import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { AUTHORITATIVE_STREAMS, AuthoritativeLogging, DEFAULT_STREAM_ROTATION, migrateLegacyLogs, type AuthoritativeStream } from "./authoritative-logging.js";
import { GenerationJournal } from "./generation-journal.js";
import { traceMiddleware, withLogContext } from "./structured-logger.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

class MemoryDestination extends EventEmitter {
  lines: string[] = [];
  constructor(private readonly failure = false) { super(); }
  write(line: string) { if (this.failure) throw new Error("sink unavailable"); this.lines.push(line); return true; }
  flush(callback?: (error?: Error) => void) { callback?.(); }
  end() {}
}

async function memoryFoundation(options: Partial<Parameters<typeof AuthoritativeLogging.open>[0]> = {}, failures: AuthoritativeStream[] = []) {
  const root = await mkdtemp(path.join(os.tmpdir(), "amfaa-authoritative-memory-")); roots.push(root);
  const destinations = new Map<AuthoritativeStream, MemoryDestination>();
  const logging = await AuthoritativeLogging.open({
    dataDirectory: root, projectId: "project-1", projectPath: "/projects/one",
    ...options,
    sinkFactory: async (stream) => { const destination = new MemoryDestination(failures.includes(stream)); destinations.set(stream, destination); return destination; },
  });
  return { root, destinations, logging };
}

function records(destination: MemoryDestination) { return destination.lines.map((line) => JSON.parse(line)); }

describe("authoritative logging foundation", () => {
  it("defines exactly six independently configured Pino/pino-roll streams", () => {
    expect(AUTHORITATIVE_STREAMS).toEqual([
      "application-events", "generation-provider-exchanges", "tool-outcomes",
      "provider-errors", "opencode-stdout", "opencode-stderr",
    ]);
    expect(Object.keys(DEFAULT_STREAM_ROTATION)).toEqual(AUTHORITATIVE_STREAMS);
    for (const value of Object.values(DEFAULT_STREAM_ROTATION)) expect(value).toMatchObject({ maxBytes: expect.any(Number), retention: expect.any(Number) });
    expect(new Set(Object.values(DEFAULT_STREAM_ROTATION).map(({ maxBytes, retention }) => `${maxBytes}:${retention}`)).size).toBe(6);
  });

  it("preserves diagnostic evidence with a scoped shared envelope while redacting authentication secrets and malformed values", async () => {
    const { destinations, logging } = await memoryFoundation();
    const cyclic: Record<string, unknown> = { retained: "surrounding evidence" }; cyclic.self = cyclic;
    Object.defineProperty(cyclic, "broken", { enumerable: true, get() { throw new Error("Bearer getter-secret"); } });
    await withLogContext({ traceId: "a".repeat(32), spanId: "b".repeat(16), requestId: "request-1", operationId: "operation-1", generationId: "generation-1", visibility: "room", selfId: "agent-1", roomId: "room-1", operatorId: "operator-1" }, () => {
      logging.log("generation-provider-exchanges", "info", "generation.completed", {
        prompt: "assembled prompt: ordinary model output mentioning chain of thought",
        rawResponse: "raw provider output", interpretedOutput: { text: "visible answer" },
        usage: { inputTokens: 10 }, cost: { usd: 0.001 }, routing: { provider: "example" },
        rateLimit: { remaining: 3 }, cooldown: { until: "later" }, authorization: "Bearer auth-secret",
        providerKey: "sk-1234567890abcdef", cyclic,
      });
    });
    await logging.flush();
    const [record] = records(destinations.get("generation-provider-exchanges")!);
    expect(record).toMatchObject({
      envelopeVersion: 1, severity: "info", event: "generation.completed", stream: "generation-provider-exchanges",
      projectId: "project-1", projectPath: "/projects/one", traceId: "a".repeat(32), spanId: "b".repeat(16),
      requestId: "request-1", operationId: "operation-1", generationId: "generation-1", visibility: "room",
      selfId: "agent-1", roomId: "room-1", operatorId: "operator-1",
      prompt: expect.stringContaining("chain of thought"), rawResponse: "raw provider output",
      interpretedOutput: { text: "visible answer" }, usage: { inputTokens: 10 }, cost: { usd: 0.001 },
      routing: { provider: "example" }, rateLimit: { remaining: 3 }, cooldown: { until: "later" },
      authorization: "[REDACTED]", providerKey: "[REDACTED]",
      cyclic: { retained: "surrounding evidence", self: "[circular]", broken: { serializationError: expect.any(Object) } },
    });
    expect(record.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(JSON.stringify(record)).not.toMatch(/auth-secret|1234567890abcdef|getter-secret/);
  });

  it("routes generation, provider, tool, stdout, and stderr evidence with usable cross-stream correlation", async () => {
    const { destinations, logging } = await memoryFoundation();
    const journal = await GenerationJournal.open("/projects/one", undefined, undefined, logging);
    await withLogContext({ traceId: "c".repeat(32), spanId: "d".repeat(16), requestId: "request-2", operationId: "operation-2", visibility: "self", selfId: "agent-a" }, () => journal.append({
      type: "generation.failed", generationId: "generation-2", agent: "codex-sol",
      prompt: "full assembled prompt", rawResponse: "partial provider response", visibleMessages: ["interpreted output"],
      providerUsage: { totalTokens: 12 }, providerCostUsd: 0.02, routing: { route: "primary" }, rateLimit: { resetMs: 10 }, cooldown: { retryAt: 20 },
      providerErrors: [{ message: "provider said no" }], error: "request failed",
      cliStdout: `${JSON.stringify({ type: "tool_use", part: { type: "tool", tool: "read", state: { status: "completed", output: "tool evidence" } } })}\n${JSON.stringify({ type: "error", error: { message: "provider raw error" } })}`,
      cliStderr: "OpenCode stderr evidence",
    }));
    await logging.flush();
    for (const stream of AUTHORITATIVE_STREAMS.slice(1)) {
      const streamRecords = records(destinations.get(stream)!);
      expect(streamRecords.length, stream).toBeGreaterThan(0);
      for (const record of streamRecords) expect(record).toMatchObject({ traceId: "c".repeat(32), requestId: "request-2", operationId: "operation-2", generationId: "generation-2" });
    }
    const generation = records(destinations.get("generation-provider-exchanges")!)[0];
    expect(generation).toMatchObject({ prompt: "full assembled prompt", rawResponse: "partial provider response", visibleMessages: ["interpreted output"], providerUsage: { totalTokens: 12 }, providerCostUsd: 0.02 });
    expect(records(destinations.get("tool-outcomes")!)[0]).toMatchObject({ interpreted: { part: { state: { output: "tool evidence" } } } });
    expect(records(destinations.get("opencode-stdout")!)[0].output).toContain("provider raw error");
    expect(records(destinations.get("opencode-stderr")!)[0].output).toBe("OpenCode stderr evidence");
  });

  it("propagates HTTP traceparent and request context into downstream generation streams", async () => {
    const { destinations, logging } = await memoryFoundation();
    const journal = await GenerationJournal.open("/projects/one", undefined, undefined, logging);
    const facade = { log: (level: "debug" | "info" | "warn" | "error", event: string, fields?: Record<string, unknown>) => { logging.application(level, event, fields); return Promise.resolve(); } };
    const app = express(); app.use(traceMiddleware(facade)); app.get("/generate", async (_request, response) => { await journal.append({ type: "generation.completed", generationId: "http-generation", agent: "codex-sol", cliStdout: "output" }); response.json({ ok: true }); });
    const server = app.listen(0); await new Promise<void>((resolve) => server.once("listening", resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/generate`, { headers: { traceparent: `00-${"e".repeat(32)}-${"f".repeat(16)}-01`, "x-request-id": "http-request" } });
      expect(response.headers.get("traceparent")).toMatch(new RegExp(`^00-${"e".repeat(32)}-[0-9a-f]{16}-01$`));
      await new Promise((resolve) => setTimeout(resolve, 0)); await logging.flush();
      const correlated = [...records(destinations.get("application-events")!), ...records(destinations.get("generation-provider-exchanges")!), ...records(destinations.get("opencode-stdout")!)];
      expect(correlated.length).toBeGreaterThanOrEqual(3);
      expect(correlated.every((record) => record.traceId === "e".repeat(32) && record.requestId === "http-request")).toBe(true);
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });

  it("exposes bounded-buffer drops, coalescing, and sink failures without recursive payload logs", async () => {
    let now = 1_000;
    const { destinations, logging } = await memoryFoundation({ maxBufferedBytes: 1024, maxIdentical: 1, identicalWindowMs: 100, now: () => now }, ["provider-errors"]);
    for (let index = 0; index < 10; index++) logging.log("opencode-stdout", "info", `stdout.${index}`, { output: "x".repeat(700) });
    for (let index = 0; index < 4; index++) logging.application("warn", "same.event", { outcome: "same" });
    now += 100; logging.application("warn", "same.event", { outcome: "same" });
    logging.log("provider-errors", "error", "provider.failed", { raw: "payload must not recur" });
    await logging.flush();
    const metrics = logging.metrics();
    expect(metrics["opencode-stdout"].dropped).toBeGreaterThan(0);
    expect(metrics["application-events"].coalesced).toBe(3);
    expect(metrics["provider-errors"].sinkFailures).toBeGreaterThan(0);
    expect(JSON.stringify(records(destinations.get("application-events")!))).not.toContain("payload must not recur");
  });

  it("rotates each real pino-roll stream independently and enforces directory and file permissions", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "amfaa-authoritative-real-")); roots.push(root);
    const rotation = Object.fromEntries(AUTHORITATIVE_STREAMS.map((stream, index) => [stream, { maxBytes: 900 + index * 137, retention: index + 1 }])) as Record<AuthoritativeStream, { maxBytes: number; retention: number }>;
    const logging = await AuthoritativeLogging.open({ dataDirectory: root, projectId: "p", projectPath: root, rotation, maxBufferedBytes: 1024 * 1024 });
    for (const stream of AUTHORITATIVE_STREAMS) for (let index = 0; index < 40; index++) logging.log(stream, "info", `${stream}.${index}`, { evidence: "x".repeat(300) });
    await logging.flush(); await new Promise((resolve) => setTimeout(resolve, 100)); await logging.flush();
    expect((await stat(logging.logDirectory)).mode & 0o777).toBe(0o700);
    const files = await readdir(logging.logDirectory);
    for (const stream of AUTHORITATIVE_STREAMS) {
      const matching = files.filter((name) => name.startsWith(`${stream}.`) && name.endsWith(".jsonl"));
      expect(matching.length, stream).toBeGreaterThan(0);
      expect(matching.length, stream).toBeLessThanOrEqual(rotation[stream].retention + 1);
      expect(Math.max(...matching.map((name) => Number(name.match(/\.(\d+)\.jsonl$/)?.[1] || 0))), `${stream} rotated`).toBeGreaterThan(0);
      for (const name of matching) expect((await stat(path.join(logging.logDirectory, name))).mode & 0o777).toBe(0o600);
    }
    await logging.close();
  });

  it("deterministically retires former sinks without leaving competing authoritative paths", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "amfaa-legacy-")); roots.push(root); await chmod(root, 0o755);
    for (const name of ["server.jsonl", "server.jsonl.1", "generations.jsonl", "live-dev.log"]) await writeFile(path.join(root, name), name);
    const first = await migrateLegacyLogs(root);
    expect(first.retired.map(({ source }) => source)).toEqual(["generations.jsonl", "live-dev.log", "server.jsonl", "server.jsonl.1"]);
    for (const name of ["server.jsonl", "server.jsonl.1", "generations.jsonl", "live-dev.log"]) await expect(stat(path.join(root, name))).rejects.toThrow();
    await writeFile(path.join(root, "server.jsonl"), "new legacy collision");
    const second = await migrateLegacyLogs(root);
    expect(second.retired.at(-1)?.destination).toBe("logs/legacy-v1/server.jsonl.retired-1");
    expect(await readFile(path.join(root, "logs", "legacy-v1", "server.jsonl"), "utf8")).toBe("server.jsonl");
    expect((await stat(path.join(root, "logs", "legacy-v1", "server.jsonl.retired-1"))).mode & 0o777).toBe(0o600);
  });
});
