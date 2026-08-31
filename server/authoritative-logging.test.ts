import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ApplicationLoggerFacade, AUTHORITATIVE_STREAMS, AuthoritativeLogging, DEFAULT_STREAM_ROTATION, migrateLegacyLogs, type AuthoritativeStream } from "./authoritative-logging.js";
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
      "server-service-lifecycle", "opencode-harness", "openrouter-provider",
      "generations", "capability-decisions", "security-audit",
    ]);
    expect(Object.keys(DEFAULT_STREAM_ROTATION)).toEqual(AUTHORITATIVE_STREAMS);
    for (const value of Object.values(DEFAULT_STREAM_ROTATION)) expect(value).toMatchObject({ maxBytes: expect.any(Number), frequencyMs: expect.any(Number), retention: expect.any(Number) });
    expect(new Set(Object.values(DEFAULT_STREAM_ROTATION).map(({ maxBytes, frequencyMs, retention }) => `${maxBytes}:${frequencyMs}:${retention}`)).size).toBe(6);
  });

  it("preserves diagnostic evidence with a scoped shared envelope while redacting authentication secrets and malformed values", async () => {
    const { destinations, logging } = await memoryFoundation();
    const cyclic: Record<string, unknown> = { retained: "surrounding evidence" }; cyclic.self = cyclic;
    Object.defineProperty(cyclic, "broken", { enumerable: true, get() { throw new Error("Bearer getter-secret"); } });
    await withLogContext({ traceId: "a".repeat(32), spanId: "b".repeat(16), requestId: "request-1", operationId: "operation-1", generationId: "generation-1", visibility: "room", selfId: "agent-1", roomId: "room-1", operatorId: "operator-1" }, () => {
      logging.log("generations", "info", "generation.completed", {
        outcome: "completed", reason: "provider-finished",
        prompt: "assembled prompt: ordinary model output mentioning chain of thought",
        rawResponse: "raw provider output", interpretedOutput: { text: "visible answer" },
        usage: { inputTokens: 10 }, cost: { usd: 0.001 }, routing: { provider: "example" },
        rateLimit: { remaining: 3 }, cooldown: { until: "later" }, authorization: "Bearer auth-secret",
        providerKey: "sk-1234567890abcdef", cyclic,
      });
    });
    await logging.flush();
    const [record] = records(destinations.get("generations")!);
    expect(record).toMatchObject({
      envelopeVersion: 1, severity: "info", event: "generation.completed", stream: "generations",
      projectId: "project-1", projectPath: "/projects/one", traceId: "a".repeat(32), spanId: "b".repeat(16),
      requestId: "request-1", operationId: "operation-1", generationId: "generation-1", correlationId: "operation-1", visibility: "room",
      agentId: "agent-1", selfId: "agent-1", roomId: "room-1", operatorId: "operator-1", outcome: "completed", reason: "provider-finished",
      prompt: expect.stringContaining("chain of thought"), rawResponse: "raw provider output",
      interpretedOutput: { text: "visible answer" }, usage: { inputTokens: 10 }, cost: { usd: 0.001 },
      routing: { provider: "example" }, rateLimit: { remaining: 3 }, cooldown: { until: "later" },
      authorization: "[REDACTED]", providerKey: "[REDACTED]",
      cyclic: { retained: "surrounding evidence", self: "[circular]", broken: { serializationError: expect.any(Object) } },
    });
    expect(record.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(JSON.stringify(record)).not.toMatch(/auth-secret|1234567890abcdef|getter-secret/);
  });

  it("preserves authorized evidence beyond every former serializer cap", async () => {
    const { destinations, logging } = await memoryFoundation({ maxBufferedBytes: 8 * 1024 * 1024, includeStacks: true });
    const prompt = "p".repeat(1_000_050);
    const providerError = new Error("e".repeat(700));
    providerError.stack = Array.from({ length: 20 }, (_, index) => `stack-line-${index}`).join("\n");
    const toolOutcomes = Array.from({ length: 10_050 }, (_, index) => ({ index }));
    const interpretedOutput = Object.fromEntries(Array.from({ length: 10_050 }, (_, index) => [`field-${index}`, index]));
    const nested: Record<string, unknown> = {};
    let cursor = nested;
    for (let depth = 0; depth < 20; depth++) { const child: Record<string, unknown> = {}; cursor.child = child; cursor = child; }
    cursor.evidence = "deep provider evidence";

    logging.log("generations", "error", "generation.full-evidence", {
      prompt,
      rawResponse: "raw output",
      interpretedOutput,
      toolOutcomes,
      providerError,
      nested,
      authorization: "Bearer must-not-leak",
    });
    await logging.flush();
    const [record] = records(destinations.get("generations")!);
    expect(record.prompt).toBe(prompt);
    expect(record.interpretedOutput["field-10049"]).toBe(10_049);
    expect(record.toolOutcomes).toHaveLength(10_050);
    expect(record.providerError.message).toBe("e".repeat(700));
    expect(record.providerError.stack.split("\n")).toHaveLength(20);
    let nestedRecord = record.nested;
    for (let depth = 0; depth < 20; depth++) nestedRecord = nestedRecord.child;
    expect(nestedRecord.evidence).toBe("deep provider evidence");
    expect(record.authorization).toBe("[REDACTED]");
    expect(JSON.stringify(record)).not.toContain("must-not-leak");
  });

  it("preserves a record above the default 256 KiB queue capacity", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "amfaa-authoritative-default-large-")); roots.push(root);
    const logging = await AuthoritativeLogging.open({ dataDirectory: root, projectId: "project-1", projectPath: "/projects/one" });
    const evidence = `begin:${"x".repeat(300 * 1024)}:end`;
    logging.log("generations", "info", "generation.default-large-evidence", { rawResponse: evidence });
    await logging.close();
    const names = (await readdir(path.join(root, "logs", "authoritative-v1"))).filter((name) => name.startsWith("generations.") && name.endsWith(".jsonl"));
    const persisted = (await Promise.all(names.map((name) => readFile(path.join(root, "logs", "authoritative-v1", name), "utf8")))).join("");
    expect(JSON.parse(persisted).rawResponse).toBe(evidence);
    expect(logging.metrics().generations).toMatchObject({ dropped: 0, written: 1 });
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
    for (const stream of ["generations", "openrouter-provider", "opencode-harness"] as const) {
      const streamRecords = records(destinations.get(stream)!);
      expect(streamRecords.length, stream).toBeGreaterThan(0);
      for (const record of streamRecords) expect(record).toMatchObject({ traceId: "c".repeat(32), requestId: "request-2", operationId: "operation-2", generationId: "generation-2" });
    }
    const generation = records(destinations.get("generations")!)[0];
    expect(generation).toMatchObject({ prompt: "full assembled prompt", rawResponse: "partial provider response", visibleMessages: ["interpreted output"] });
    expect(generation).not.toHaveProperty("providerUsage");
    const provider = records(destinations.get("openrouter-provider")!)[0];
    expect(provider).toMatchObject({ usage: { totalTokens: 12 }, costUsd: 0.02, errors: [{ message: "provider said no" }], routing: { route: "primary" }, rateLimit: { resetMs: 10 }, cooldown: { retryAt: 20 } });
    const harness = records(destinations.get("opencode-harness")!);
    expect(harness.find(({ event }) => event === "opencode.tool.outcome")).toMatchObject({ interpreted: { part: { state: { output: "tool evidence" } } } });
    expect(harness.find(({ event }) => event === "opencode.stdout")?.output).toContain("provider raw error");
    expect(harness.find(({ event }) => event === "opencode.stderr")?.output).toBe("OpenCode stderr evidence");
    expect(records(destinations.get("server-service-lifecycle")!)).toHaveLength(0);
    expect(records(destinations.get("capability-decisions")!)).toHaveLength(0);
    expect(records(destinations.get("security-audit")!)).toHaveLength(0);
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
      const correlated = [...records(destinations.get("server-service-lifecycle")!), ...records(destinations.get("generations")!), ...records(destinations.get("opencode-harness")!)];
      expect(correlated.length).toBeGreaterThanOrEqual(3);
      expect(correlated.every((record) => record.traceId === "e".repeat(32) && record.requestId === "http-request")).toBe(true);
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });

  it("exposes bounded-buffer drops, coalescing, and sink failures without recursive payload logs", async () => {
    let now = 1_000;
    const { destinations, logging } = await memoryFoundation({ maxBufferedBytes: 1024, maxIdentical: 1, identicalWindowMs: 100, now: () => now }, ["openrouter-provider"]);
    for (let index = 0; index < 10; index++) logging.log("opencode-harness", "info", `stdout.${index}`, { output: "x".repeat(700) });
    for (let index = 0; index < 4; index++) logging.application("warn", "same.event", { outcome: "same" });
    now += 100; logging.application("warn", "same.event", { outcome: "same" });
    logging.log("openrouter-provider", "error", "provider.failed", { raw: "payload must not recur" });
    await logging.flush();
    const metrics = logging.metrics();
    expect(metrics["opencode-harness"].dropped).toBeGreaterThan(0);
    expect(metrics["server-service-lifecycle"].coalesced).toBe(3);
    expect(metrics["openrouter-provider"].sinkFailures).toBeGreaterThan(0);
    expect(JSON.stringify(records(destinations.get("server-service-lifecycle")!))).not.toContain("payload must not recur");
  });

  it("bounds high-cardinality identical-signature state", async () => {
    const { destinations, logging } = await memoryFoundation({ maxIdentical: 1, maxIdenticalSignatures: 2, identicalWindowMs: 60_000 });
    logging.application("info", "signature.one", { value: 1 });
    logging.application("info", "signature.two", { value: 2 });
    logging.application("info", "signature.three", { value: 3 });
    logging.application("info", "signature.one", { value: 1 });
    await logging.flush();
    expect(records(destinations.get("server-service-lifecycle")!).map(({ event }) => event)).toEqual([
      "signature.one", "signature.two", "signature.three", "signature.one",
    ]);
  });

  it("rotates each real pino-roll stream independently and enforces directory and file permissions", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "amfaa-authoritative-real-")); roots.push(root);
    const rotation = Object.fromEntries(AUTHORITATIVE_STREAMS.map((stream, index) => [stream, { maxBytes: 900 + index * 137, frequencyMs: 60_000 + index * 1_000, retention: index + 1 }])) as Record<AuthoritativeStream, { maxBytes: number; frequencyMs: number; retention: number }>;
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

  it("reopens after restart without losing earlier authoritative records", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "amfaa-authoritative-reopen-")); roots.push(root);
    const options = { dataDirectory: root, projectId: "project-reopen", projectPath: root, maxBufferedBytes: 1024 * 1024 };
    const first = await AuthoritativeLogging.open(options);
    first.log("generations", "info", "generation.before-restart", { generationId: "before" });
    await first.close();
    const second = await AuthoritativeLogging.open(options);
    second.log("generations", "info", "generation.after-restart", { generationId: "after" });
    await second.close();

    const names = (await readdir(second.logDirectory)).filter((name) => name.startsWith("generations.") && name.endsWith(".jsonl"));
    const persisted = (await Promise.all(names.map((name) => readFile(path.join(second.logDirectory, name), "utf8")))).join("\n");
    expect(persisted).toContain('"event":"generation.before-restart"');
    expect(persisted).toContain('"event":"generation.after-restart"');
  });

  it("serializes concurrent producers without record loss or corruption", async () => {
    const { destinations, logging } = await memoryFoundation({ maxBufferedBytes: 4 * 1024 * 1024, maxIdentical: 500 });
    await Promise.all(Array.from({ length: 250 }, (_, producer) => Promise.resolve().then(() => {
      logging.log("opencode-harness", "info", "opencode.concurrent-output", { producer, output: `output-${producer}` });
    })));
    await logging.flush();
    const concurrent = records(destinations.get("opencode-harness")!);
    expect(concurrent).toHaveLength(250);
    expect(new Set(concurrent.map(({ producer }) => producer)).size).toBe(250);
    expect(logging.metrics()["opencode-harness"]).toMatchObject({ dropped: 0, sinkFailures: 0, written: 250 });
  });

  it("assigns application events to one subsystem owner and rotates on an independent time bound", async () => {
    const { destinations, logging } = await memoryFoundation({ roomId: "room" });
    const facade = new ApplicationLoggerFacade(logging);
    await facade.log("info", "server.startup.completed", { outcome: "ready" });
    await facade.log("info", "agent.tool-policy.snapshot", { outcome: "configured" });
    await facade.log("warn", "room-command-tool.lease", { outcome: "rejected", reason: "expired" });
    await facade.log("info", "room.roster.audit.changed", { roomId: "room", actorKind: "room-member", actorId: "member", previousRevision: 1, nextRevision: 2, visibility: "operator" });
    await facade.log("warn", "openrouter.provider.rate-limited", { outcome: "deferred" });
    await facade.log("info", "opencode.harness.started", { outcome: "started" });
    await logging.flush();
    expect(records(destinations.get("server-service-lifecycle")!).map(({ event }) => event)).toEqual(["server.startup.completed"]);
    expect(records(destinations.get("capability-decisions")!).map(({ event }) => event)).toEqual(["agent.tool-policy.snapshot"]);
    expect(records(destinations.get("security-audit")!).map(({ event }) => event)).toEqual(["room-command-tool.lease", "room.roster.audit.changed"]);
    expect(records(destinations.get("security-audit")!)[1]).toMatchObject({ roomId: "room", actorKind: "room-member", actorId: "member", previousRevision: 1, nextRevision: 2, visibility: "operator" });
    expect(records(destinations.get("openrouter-provider")!).map(({ event }) => event)).toEqual(["openrouter.provider.rate-limited"]);
    expect(records(destinations.get("opencode-harness")!).map(({ event }) => event)).toEqual(["opencode.harness.started"]);

    const root = await mkdtemp(path.join(os.tmpdir(), "amfaa-authoritative-time-")); roots.push(root);
    const rotation = Object.fromEntries(AUTHORITATIVE_STREAMS.map((stream, index) => [stream, { maxBytes: 10 * 1024 * 1024, frequencyMs: 40 + index, retention: 4 }])) as Record<AuthoritativeStream, { maxBytes: number; frequencyMs: number; retention: number }>;
    const real = await AuthoritativeLogging.open({ dataDirectory: root, projectId: "p", projectPath: root, rotation });
    for (const stream of AUTHORITATIVE_STREAMS) real.log(stream, "info", "before.time-bound");
    await real.flush();
    const beforeNames = await readdir(real.logDirectory);
    const before = Object.fromEntries(AUTHORITATIVE_STREAMS.map((stream) => [stream, Math.max(...beforeNames.filter((name) => name.startsWith(`${stream}.`)).map((name) => Number(name.match(/\.(\d+)\.jsonl$/)?.[1] || 0)))]));
    await new Promise((resolve) => setTimeout(resolve, 120));
    for (const stream of AUTHORITATIVE_STREAMS) real.log(stream, "info", "after.time-bound");
    await real.flush();
    const names = await readdir(real.logDirectory);
    for (const stream of AUTHORITATIVE_STREAMS) expect(Math.max(...names.filter((name) => name.startsWith(`${stream}.`)).map((name) => Number(name.match(/\.(\d+)\.jsonl$/)?.[1] || 0)))).toBeGreaterThan(Number(before[stream]));
    await real.close();
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
