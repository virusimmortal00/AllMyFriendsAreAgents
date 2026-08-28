import type express from "express";
import { ControlError, type ControlPlaneStore } from "./control-plane.js";
import { DiagnosticsQueryError, type DiagnosticQuery, type DiagnosticsQueryService } from "./diagnostics-query.js";

const UNAVAILABLE = { error: "Diagnostics are unavailable." } as const;
const FAILED = { error: "Diagnostics query could not be completed." } as const;

/** Only the transport peer is authoritative; proxy and origin headers are ignored. */
export function isLocalDiagnosticsRequest(request: express.Request) {
  const address = request.socket.remoteAddress?.toLowerCase();
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

export function registerOwnerDiagnosticsRoutes(input: { app: express.Express; control: ControlPlaneStore; service: DiagnosticsQueryService }) {
  input.app.post("/api/control/diagnostics/query", async (request, response) => {
    response.set("Cache-Control", "no-store");
    if (!isLocalDiagnosticsRequest(request)) return response.status(404).json(UNAVAILABLE);

    try {
      const session = input.control.require(request, undefined, true);
      if (session.principal.role !== "OWNER") throw new ControlError(403, "Owner authorization is required.");
      if (!request.body || typeof request.body !== "object" || Array.isArray(request.body)) throw new DiagnosticsQueryError("invalid-query");
      const caller = {
        principalId: session.principal.id,
        operatorId: session.principal.id,
        roomIds: [],
        projectIds: [],
        operator: true,
      } as const;
      return response.json(await input.service.query(caller, request.body as DiagnosticQuery));
    } catch (error) {
      if (error instanceof ControlError) return response.status(error.status).json(UNAVAILABLE);
      if (error instanceof DiagnosticsQueryError) return response.status(error.code === "forbidden" ? 403 : 400).json(FAILED);
      return response.status(500).json(FAILED);
    }
  });
}
