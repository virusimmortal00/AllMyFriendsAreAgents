import type express from "express";
import type { AgentCapabilityStatus } from "../shared/capabilities.js";
import type { CapabilityAuditStore } from "./capability-audit.js";
import { ControlError, type ControlPlaneStore } from "./control-plane.js";

export function registerCapabilityDiagnosticsRoute(input: {
  app: express.Express;
  control: Pick<ControlPlaneStore, "require">;
  refresh: () => Promise<unknown>;
  statuses: () => Readonly<Record<string, AgentCapabilityStatus>>;
  audit: Pick<CapabilityAuditStore, "list">;
  operationLog: (level: "error", event: string, fields: Record<string, unknown>) => Promise<unknown> | unknown;
}) {
  input.app.get("/api/control/capabilities", async (request, response) => {
    try {
      const session = input.control.require(request);
      if (session.principal.role !== "OWNER") throw new ControlError(403, "Only the owner can inspect capability audit records.");
      await input.refresh();
      const limit = Math.max(1, Math.min(Number(request.query.limit) || 100, 200));
      return response.set("Cache-Control", "no-store").json({ policyRevision: 1, agents: input.statuses(), audit: input.audit.list(limit) });
    } catch (error) {
      if (error instanceof ControlError) return response.status(error.status).json({ error: error.message });
      try { void Promise.resolve(input.operationLog("error", "capability.diagnostics.failed", { error, outcome: "failed", reason: "unexpected-server-error" })).catch(() => undefined); } catch { /* Diagnostics logging is best effort. */ }
      return response.status(500).json({ error: "Capability diagnostics are temporarily unavailable." });
    }
  });
}
