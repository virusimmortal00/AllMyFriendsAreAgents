import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { parseOrCreateTraceparent, safeError, sanitizeLogValue, StructuredLogger, traceMiddleware, withLogContext } from "./structured-logger.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("structured logging", () => {
  it("propagates a valid W3C trace id and creates a fresh span", () => {
    const parsed = parseOrCreateTraceparent("00-0123456789abcdef0123456789abcdef-0123456789abcdef-01");
    expect(parsed.traceId).toBe("0123456789abcdef0123456789abcdef");
    expect(parsed.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(parseOrCreateTraceparent("invalid").traceId).toMatch(/^[0-9a-f]{32}$/);
  });

  it("redacts fields and errors and rotates bounded files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "amfaa-logs-")); roots.push(root);
    const file = path.join(root, "server.jsonl"); const lines: string[] = [];
    const logger = new StructuredLogger(file, 260, 2, (line) => lines.push(line));
    await logger.log("error", "test.failure", { authorization: "Bearer secret-value", error: new Error("password=hunter2") });
    for (let index = 0; index < 8; index++) await logger.log("info", "test.rotate", { index, text: "x".repeat(80) });
    await logger.flush();
    expect(JSON.stringify(lines)).not.toContain("secret-value");
    expect(JSON.parse(lines[0]!)).toMatchObject({ schemaVersion: 1, service: "all-my-friends-are-agents", serviceVersion: "0.1.0", instanceId: "uninitialized", deploymentCommit: null, deploymentEpoch: null, environment: "development", level: "error", event: "test.failure" });
    expect(safeError(new Error("token=abcdef1234567890")).message).not.toContain("abcdef1234567890");
    expect(safeError(new Error("local failure"))).not.toHaveProperty("stack");
    expect(safeError(new Error("local failure"), true)).toHaveProperty("stack");
    expect(sanitizeLogValue({ arbitrary: "diagnostic", method: "GET", prompt: "private prompt", rawResponse: "private response", authorization: "Bearer private-auth", providerErrors: [{ message: "provider detail" }] })).toEqual({ arbitrary: "diagnostic", method: "GET", prompt: "private prompt", rawResponse: "private response", authorization: "[REDACTED]", providerErrors: [{ message: "provider detail" }] });
    expect(await readdir(root)).toContain("server.jsonl.1");
    expect(await readFile(file, "utf8")).toContain('"event":"test.rotate"');
  });

  it("keeps canonical envelope fields authoritative over caller fields", async () => {
    const lines: string[] = [];
    const logger = new StructuredLogger(undefined, 1_000, 1, (line) => lines.push(line), false, {
      schemaVersion: 1, service: "trusted-service", serviceVersion: "1.2.3", instanceId: "trusted-instance",
      deploymentCommit: "trusted-commit", deploymentEpoch: "trusted-epoch", environment: "test",
    }, { now: () => Date.parse("2026-08-27T00:00:00.000Z") });
    await withLogContext({ traceId: "a".repeat(32), spanId: "b".repeat(16), requestId: "trusted-request" }, () => logger.log("info", "trusted.event", {
      timestamp: "forged", level: "error", event: "forged.event", traceId: "caller-trace",
      requestId: "forged-request", deploymentEpoch: "forged-epoch",
    }));
    expect(JSON.parse(lines[0]!)).toMatchObject({
      schemaVersion: 1, service: "trusted-service", serviceVersion: "1.2.3", instanceId: "trusted-instance",
      deploymentCommit: "trusted-commit", deploymentEpoch: "trusted-epoch", environment: "test",
      timestamp: "2026-08-27T00:00:00.000Z", level: "info", event: "trusted.event",
      traceId: "a".repeat(32), spanId: "b".repeat(16), requestId: "trusted-request",
    });
  });

  it("swallows console and file failures, recovers the file queue, and leaves logging non-blocking", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "amfaa-log-recovery-")); roots.push(root);
    const blocked = path.join(root, "blocked"); const file = path.join(blocked, "server.jsonl");
    await writeFile(blocked, "not-a-directory");
    let consoleCalls = 0;
    const logger = new StructuredLogger(file, 10_000, 1, () => { consoleCalls++; throw new Error("console unavailable"); });
    await expect(logger.log("error", "test.first", { outcome: "failed" })).resolves.toBeUndefined();
    await logger.flush();
    await rm(blocked); await mkdir(blocked);
    await expect(logger.log("info", "test.recovered", { outcome: "completed" })).resolves.toBeUndefined();
    await logger.flush();
    expect(consoleCalls).toBe(2);
    expect(await readFile(file, "utf8")).toContain('"event":"test.recovered"');
  });

  it("rate-limits identical records and emits one deterministic bounded coalescing summary", async () => {
    let now = Date.parse("2026-08-27T00:00:00.000Z"); const lines: string[] = [];
    const logger = new StructuredLogger(undefined, 1_000, 1, (line) => lines.push(line), false, undefined, { maxIdentical: 2, windowMs: 1_000, now: () => now });
    for (let index = 0; index < 5; index++) await logger.log("warn", "tool.denied", { outcome: "denied", reason: "permission-not-granted" });
    expect(lines).toHaveLength(2);
    now += 1_000;
    await logger.log("warn", "tool.denied", { outcome: "denied", reason: "permission-not-granted" });
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({ event: "tool.denied" }),
      expect.objectContaining({ event: "tool.denied" }),
      expect.objectContaining({ event: "logging.identical.coalesced", coalescedEvent: "tool.denied", suppressedCount: 3, windowMs: 1_000 }),
      expect.objectContaining({ event: "tool.denied" }),
    ]);
  });

  it("adds request correlation headers and logs completion", async () => {
    const lines: string[] = []; const logger = new StructuredLogger(undefined, 1000, 1, (line) => lines.push(line));
    const app = express(); app.use(traceMiddleware(logger)); app.get("/ok", (_request, response) => response.json({ ok: true }));
    const server = app.listen(0); await new Promise<void>((resolve) => server.once("listening", resolve));
    try { const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/ok`, { headers: { traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01" } }); expect(response.headers.get("traceparent")).toMatch(/^00-0123456789abcdef0123456789abcdef-[0-9a-f]{16}-01$/); await new Promise((resolve) => setTimeout(resolve, 0)); expect(lines.join("\n")).toContain('"event":"http.request.completed"'); }
    finally { await logger.flush(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
});
