import express from "express";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONTROL_SESSION_COOKIE, ControlPlaneStore } from "./control-plane.js";
import { DIAGNOSTIC_STREAM_FILES, LocalFileDiagnosticsQueryService, type DiagnosticQueryResult, type DiagnosticsQueryService } from "./diagnostics-query.js";
import { registerOwnerDiagnosticsRoutes } from "./owner-diagnostics-api.js";

const roots: string[] = [];
const servers: Array<ReturnType<express.Express["listen"]>> = [];
const bootstrapSecret = "local-bootstrap-secret-with-32-characters";
const password = "correct horse battery staple";
const emptyResult: DiagnosticQueryResult = { records: [], chunks: [], nextCursor: null, scannedBytes: 0, serializedBytes: 0, malformedRecords: 0, scanLimitReached: false };

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(service?: DiagnosticsQueryService, bind = "127.0.0.1") {
  const root = await mkdtemp(path.join(os.tmpdir(), "amfaa-owner-diagnostics-")); roots.push(root);
  const control = await ControlPlaneStore.open(root, bootstrapSecret);
  await control.bootstrap(bootstrapSecret, "owner", password);
  const authenticated = await control.authenticate("owner", password);
  if (!authenticated) throw new Error("owner authentication fixture failed");
  const app = express(); app.use(express.json());
  registerOwnerDiagnosticsRoutes({ app, control, service: service ?? new LocalFileDiagnosticsQueryService(root, "project-one") });
  const server = app.listen(0, bind); servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  const headers = { "content-type": "application/json", cookie: `${CONTROL_SESSION_COOKIE}=${authenticated.token}`, "x-amfaa-csrf": authenticated.csrfToken };
  return { root, port, headers, control, ownerToken: authenticated.token };
}

const query = { from: "2026-08-28T00:00:00.000Z", to: "2026-08-29T00:00:00.000Z", scope: "operator", streams: ["generations"], limit: 25, maxScannedBytes: 64_000, maxSerializedBytes: 16_000 };

describe("owner diagnostics HTTP route", () => {
  it("denies an unauthenticated request without returning or querying evidence", async () => {
    const service = { query: vi.fn(async () => emptyResult) };
    const api = await fixture(service);
    const response = await fetch(`http://127.0.0.1:${api.port}/api/control/diagnostics/query`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(query) });
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "Diagnostics are unavailable." });
    expect(service.query).not.toHaveBeenCalled();
  });

  it("uses the bounded contract to return other agents' self, room, and project evidence to a local OWNER", async () => {
    const api = await fixture();
    const directory = path.join(api.root, "logs", "authoritative-v1");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const base = { envelopeVersion: 1, stream: "generations", timestamp: "2026-08-28T12:00:00.000Z", severity: "info", event: "generation.evidence", projectId: "project-one", agentId: "agent-two" };
    const records = [
      { ...base, recordId: "self-evidence", selfId: "agent-two", visibility: "self", content: { prompt: "peer assembled prompt", rawOutput: "peer provider output", authorization: "Bearer secret" } },
      { ...base, recordId: "room-evidence", roomId: "room-two", visibility: "room", content: { stdout: "OpenCode stdout", stderr: "OpenCode stderr" } },
      { ...base, recordId: "project-evidence", visibility: "project", content: { toolOutcome: "completed", usage: 21, cost: 0.04, routing: "provider/model", rateLimit: "clear", cooldown: "none" } },
    ];
    await writeFile(path.join(directory, `${DIAGNOSTIC_STREAM_FILES.generations}.jsonl`), `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, { mode: 0o600 });
    const response = await fetch(`http://127.0.0.1:${api.port}/api/control/diagnostics/query`, { method: "POST", headers: api.headers, body: JSON.stringify(query) });
    expect(response.status).toBe(200);
    const result = await response.json() as DiagnosticQueryResult;
    expect(result.records.map((record) => record.recordId).sort()).toEqual(["project-evidence", "room-evidence", "self-evidence"]);
    expect(JSON.stringify(result)).toContain("peer assembled prompt");
    expect(JSON.stringify(result)).toContain("peer provider output");
    expect(JSON.stringify(result)).toContain("OpenCode stdout");
    expect(JSON.stringify(result)).not.toContain("Bearer secret");
    expect(result).toMatchObject({ nextCursor: null, scanLimitReached: false });
    expect(result.serializedBytes).toBeLessThanOrEqual(query.maxSerializedBytes);
  });

  it("denies a non-OWNER control-plane principal without querying evidence", async () => {
    const service = { query: vi.fn(async () => emptyResult) };
    const api = await fixture(service);
    const actor = api.control.require({ header: (name: string) => name.toLowerCase() === "cookie" ? `${CONTROL_SESSION_COOKIE}=${api.ownerToken}` : undefined } as express.Request).principal;
    await api.control.createPrincipal(actor, { username: "administrator", password: "administrator password", role: "ADMIN", capabilities: [] });
    const administrator = await api.control.authenticate("administrator", "administrator password");
    if (!administrator) throw new Error("administrator authentication fixture failed");
    const response = await fetch(`http://127.0.0.1:${api.port}/api/control/diagnostics/query`, { method: "POST", headers: { "content-type": "application/json", cookie: `${CONTROL_SESSION_COOKIE}=${administrator.token}`, "x-amfaa-csrf": administrator.csrfToken }, body: JSON.stringify(query) });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Diagnostics are unavailable." });
    expect(service.query).not.toHaveBeenCalled();
  });

  it("denies an authenticated non-loopback peer even when headers claim a loopback origin", async () => {
    const peer = Object.values(networkInterfaces()).flat().find((address) => address?.family === "IPv4" && !address.internal)?.address;
    if (!peer) throw new Error("A non-loopback interface is required for the route boundary test.");
    const service = { query: vi.fn(async () => emptyResult) };
    const api = await fixture(service, "0.0.0.0");
    const response = await fetch(`http://${peer}:${api.port}/api/control/diagnostics/query`, { method: "POST", headers: { ...api.headers, forwarded: "for=127.0.0.1;host=127.0.0.1", "x-forwarded-for": "127.0.0.1", "x-real-ip": "127.0.0.1", origin: `http://127.0.0.1:${api.port}` }, body: JSON.stringify(query) });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Diagnostics are unavailable." });
    expect(service.query).not.toHaveBeenCalled();
  });
});
