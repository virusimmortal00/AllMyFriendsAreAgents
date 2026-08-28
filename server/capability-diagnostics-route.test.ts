import express from "express";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { ControlError } from "./control-plane.js";
import { registerCapabilityDiagnosticsRoute } from "./capability-diagnostics-route.js";

async function serve(control: { require: (request: express.Request) => unknown }, refresh = async () => undefined) {
  const app = express(); const operationLog = vi.fn();
  registerCapabilityDiagnosticsRoute({ app, control: control as never, refresh, statuses: () => ({}), audit: { list: () => [] }, operationLog });
  const server = app.listen(0, "127.0.0.1"); await new Promise<void>((resolve) => server.once("listening", resolve));
  return { operationLog, call: () => fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/control/capabilities`), close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

describe("owner capability diagnostics boundary", () => {
  it("preserves bounded ControlError responses", async () => {
    const api = await serve({ require: () => { throw new ControlError(401, "Owner sign-in required."); } });
    try { const response = await api.call(); expect(response.status).toBe(401); expect(await response.json()).toEqual({ error: "Owner sign-in required." }); expect(api.operationLog).not.toHaveBeenCalled(); } finally { await api.close(); }
  });

  it("logs unexpected failures and returns a generic 500 without details", async () => {
    const api = await serve({ require: () => ({ principal: { role: "OWNER" } }) }, async () => { throw new Error("database password=private"); });
    try { const response = await api.call(); expect(response.status).toBe(500); expect(await response.json()).toEqual({ error: "Capability diagnostics are temporarily unavailable." }); expect(api.operationLog).toHaveBeenCalledWith("error", "capability.diagnostics.failed", expect.objectContaining({ outcome: "failed", reason: "unexpected-server-error" })); } finally { await api.close(); }
  });
});
