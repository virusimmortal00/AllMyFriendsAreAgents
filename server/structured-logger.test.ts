import express from "express";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import {
  currentLogContext,
  parseOrCreateTraceparent,
  safeError,
  sanitizeLogValue,
  traceMiddleware,
  withLogContext,
} from "./structured-logger.js";

describe("structured logging helpers", () => {
  it("propagates a valid W3C trace id and creates a fresh span", () => {
    const parsed = parseOrCreateTraceparent("00-0123456789abcdef0123456789abcdef-0123456789abcdef-01");
    expect(parsed.traceId).toBe("0123456789abcdef0123456789abcdef");
    expect(parsed.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(parseOrCreateTraceparent("invalid").traceId).toMatch(/^[0-9a-f]{32}$/);
  });

  it("preserves diagnostic evidence while redacting authentication secrets", () => {
    const cyclic: Record<string, unknown> = {
      arbitrary: "diagnostic",
      prompt: "private prompt",
      rawResponse: "private response",
      authorization: "Bearer private-auth",
      providerErrors: [{ message: "provider detail" }],
    };
    cyclic.self = cyclic;
    expect(sanitizeLogValue(cyclic)).toEqual({
      arbitrary: "diagnostic",
      prompt: "private prompt",
      rawResponse: "private response",
      authorization: "[REDACTED]",
      providerErrors: [{ message: "provider detail" }],
      self: "[circular]",
    });
    expect(safeError(new Error("token=abcdef1234567890")).message).not.toContain("abcdef1234567890");
    const prefixedCookies = sanitizeLogValue("request headers: Cookie: first=secret-one; second=secret-two") as string;
    expect(prefixedCookies).toBe("request headers: Cookie: [REDACTED]");
    expect(prefixedCookies).not.toMatch(/secret-one|secret-two/);
    expect(safeError(new Error("local failure"))).not.toHaveProperty("stack");
    expect(safeError(new Error("local failure"), true)).toHaveProperty("stack");
  });

  it("merges correlation context across nested operation boundaries", () => {
    withLogContext({ traceId: "a".repeat(32), spanId: "b".repeat(16), requestId: "request-1" }, () => {
      withLogContext({ correlationId: "correlation-1", operationId: "operation-1", agentId: "agent-1" }, () => {
        expect(currentLogContext()).toMatchObject({
          traceId: "a".repeat(32), spanId: "b".repeat(16), requestId: "request-1",
          correlationId: "correlation-1", operationId: "operation-1", agentId: "agent-1",
        });
      });
    });
  });

  it("adds request correlation headers and exposes context to the authoritative logger", async () => {
    const events: Array<Record<string, unknown>> = [];
    const logger = {
      async log(level: "debug" | "info" | "warn" | "error", event: string, fields: Record<string, unknown> = {}) {
        events.push({ level, event, fields, context: currentLogContext() });
      },
    };
    const app = express();
    app.use(traceMiddleware(logger));
    app.get("/ok", (_request, response) => response.json({ ok: true }));
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/ok`, {
        headers: {
          traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
          "x-request-id": "request-1",
        },
      });
      expect(response.headers.get("traceparent")).toMatch(/^00-0123456789abcdef0123456789abcdef-[0-9a-f]{16}-01$/);
      expect(response.headers.get("x-request-id")).toBe("request-1");
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(events).toContainEqual(expect.objectContaining({
        level: "info",
        event: "http.request.completed",
        context: expect.objectContaining({ traceId: "0123456789abcdef0123456789abcdef", requestId: "request-1" }),
      }));
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("absorbs asynchronous completion-log failures", async () => {
    const logger = { log: vi.fn(async () => { throw new Error("sink unavailable"); }) };
    const app = express(); app.use(traceMiddleware(logger)); app.get("/ok", (_request, response) => response.json({ ok: true }));
    const server = app.listen(0); await new Promise<void>((resolve) => server.once("listening", resolve));
    try {
      expect((await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/ok`)).ok).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(logger.log).toHaveBeenCalledWith("info", "http.request.completed", expect.objectContaining({ statusCode: 200 }));
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
});
