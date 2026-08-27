import type { AddressInfo } from "node:net";
import express from "express";
import { describe, expect, it, vi } from "vitest";
import { registerAssignmentRoutes } from "./assignment-api.js";
import type { AssignmentLifecycleService } from "./assignment-lifecycle.js";
import type { DeveloperTeamRegistry } from "./developer-team.js";

async function withApi(service: Partial<AssignmentLifecycleService>, run: (baseUrl: string) => Promise<void>, options: { authenticated?: boolean; onChanged?: () => void | Promise<void> } = {}) {
  const app = express(); app.use(express.json());
  registerAssignmentRoutes({
    app,
    service: service as AssignmentLifecycleService,
    developers: { authenticate: () => options.authenticated ? ({ member: {} }) : null } as unknown as DeveloperTeamRegistry,
    onChanged: options.onChanged,
  });
  const server = app.listen(0); await new Promise<void>((resolve) => server.once("listening", resolve));
  try { await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`); }
  finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

describe("assignment lifecycle API", () => {
  it("passes exact revisioned cancellation and disposal requests", async () => {
    const cancel = vi.fn().mockResolvedValue({ kind: "ok", value: { lifecycleStatus: "CANCELLED" } });
    const dispose = vi.fn().mockResolvedValue({ kind: "ok", value: { lifecycleStatus: "DISPOSED" } });
    await withApi({ metadata: {} as AssignmentLifecycleService["metadata"], cancel, dispose } as Partial<AssignmentLifecycleService>, async (base) => {
      const headers = { "Content-Type": "application/json", Authorization: "Bearer developer" };
      expect((await fetch(`${base}/api/developer/assignments/a-1/cancel`, { method: "POST", headers, body: JSON.stringify({ expectedRevision: 2, idempotencyKey: "cancel-1" }) })).status).toBe(200);
      expect((await fetch(`${base}/api/developer/assignments/a-1/dispose`, { method: "POST", headers, body: JSON.stringify({ expectedRevision: 3, idempotencyKey: "dispose-1", confirmDisposable: true }) })).status).toBe(200);
      expect(cancel).toHaveBeenCalledWith("Bearer developer", { assignmentId: "a-1", expectedRevision: 2, idempotencyKey: "cancel-1" });
      expect(dispose).toHaveBeenCalledWith("Bearer developer", { assignmentId: "a-1", expectedRevision: 3, idempotencyKey: "dispose-1", confirmDisposable: true });
    });
  });

  it("uses assignment-specific missing and conflict responses", async () => {
    await withApi({ metadata: {} as AssignmentLifecycleService["metadata"], cancel: vi.fn().mockResolvedValue({ kind: "not_found" }), dispose: vi.fn().mockResolvedValue({ kind: "conflict", reason: "stale" }) } as Partial<AssignmentLifecycleService>, async (base) => {
      const headers = { "Content-Type": "application/json" };
      const missing = await fetch(`${base}/api/developer/assignments/missing/cancel`, { method: "POST", headers, body: "{}" });
      expect(missing.status).toBe(404); expect(await missing.json()).toEqual({ error: "Assignment not found." });
      expect((await fetch(`${base}/api/developer/assignments/a/dispose`, { method: "POST", headers, body: "{}" })).status).toBe(409);
    });
  });

  it("refreshes public implementation status after lifecycle cleanup", async () => {
    const cleanup = vi.fn().mockResolvedValue([{ assignmentId: "a-1", lifecycleStatus: "MISSING" }]);
    const onChanged = vi.fn(async () => undefined);
    await withApi({ metadata: {} as AssignmentLifecycleService["metadata"], cleanup }, async (base) => {
      const response = await fetch(`${base}/api/developer/assignments/cleanup`, { method: "POST" });
      expect(response.status).toBe(200);
      expect(onChanged).toHaveBeenCalledOnce();
      expect(cleanup).toHaveBeenCalledOnce();
    }, { authenticated: true, onChanged });
  });
});
