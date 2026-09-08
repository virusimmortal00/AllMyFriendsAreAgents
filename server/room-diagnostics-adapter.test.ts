import { afterEach, expect, it, vi } from "vitest";
import adapter from "./agent-tools/tools/room_diagnostics.js";
import type { ToolDefinition } from "@opencode-ai/plugin";
import { RoomDiagnosticsToolBroker } from "./room-diagnostics-tool.js";
import type { DiagnosticsQueryService } from "./diagnostics-query.js";
const diagnostics = adapter as unknown as ToolDefinition;

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
it("explains invalid-cursor recovery without exposing arbitrary server error content", async () => {
  vi.stubEnv("AMFAA_ROOM_DIAGNOSTICS_URL", "http://127.0.0.1:1234/tool");
  vi.stubEnv("AMFAA_ROOM_DIAGNOSTICS_TOKEN", "fixture-token");
  const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ error: "invalid-cursor", detail: "private-detail" }), { status: 400 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ error: "private-detail" }), { status: 400 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ records: [], nextCursor: null })));
  vi.stubGlobal("fetch", fetch);
  const context = {} as Parameters<typeof diagnostics.execute>[1];
  await expect(diagnostics.execute({ window: "last-hour", scope: "self", cursor: "invented" }, context)).rejects.toThrow("Start a new query without cursor");
  await expect(diagnostics.execute({ window: "last-hour", scope: "self" }, context)).rejects.toThrow(/^Room diagnostics returned 400\.$/);
  expect(JSON.parse(await diagnostics.execute({ window: "last-hour", scope: "self", cursor: null, identity: { generationId: null }, correlation: null, streams: null, severities: null, limit: null }, context) as string)).toEqual({ records: [], nextCursor: null });
  const bodies = fetch.mock.calls.map(([, init]) => JSON.parse(init.body));
  expect(new Set(bodies.map((body) => body.requestId)).size).toBe(3);
  expect(bodies[2].query).toEqual({ window: "last-hour", scope: "self" });
});

it("delivers null-only and non-empty selectors through the real diagnostics broker", async () => {
  const query = vi.fn<DiagnosticsQueryService["query"]>(async () => ({ records: [], chunks: [], nextCursor: null, scannedBytes: 0, serializedBytes: 200, malformedRecords: 0, scanLimitReached: false }));
  const broker = new RoomDiagnosticsToolBroker({ query }, () => ({ effective: true, participantId: "codex-sol", roomId: "fixture-room", projectId: "fixture-project", manifestRevision: 1,
    caller: { principalId: "codex-sol", selfId: "codex-sol", roomIds: ["fixture-room"], projectIds: ["fixture-project"], operator: false }, allowedScopes: ["self"] }));
  const token = broker.issue("codex-sol", { agentId: "codex-sol", generationId: "fixture-generation", attemptOrdinal: 1, isActive: () => true })!;
  vi.stubEnv("AMFAA_ROOM_DIAGNOSTICS_URL", "http://127.0.0.1:1234/tool");
  vi.stubEnv("AMFAA_ROOM_DIAGNOSTICS_TOKEN", token);
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    const result = await broker.execute(token, JSON.parse(init.body));
    return new Response(JSON.stringify(result || { error: "Not found." }), { status: result ? 200 : 404 });
  }));
  const context = {} as Parameters<typeof diagnostics.execute>[1];
  await diagnostics.execute({ window: "last-hour", scope: "self", identity: { agentId: null, generationId: null }, correlation: { requestId: null, traceId: null, correlationId: null } }, context);
  expect(query.mock.calls[0]?.[1]).toMatchObject({ identity: { selfId: "codex-sol" } });
  expect(query.mock.calls[0]?.[1]).not.toHaveProperty("correlation");
  await diagnostics.execute({ window: "last-hour", scope: "self", identity: { generationId: "fixture-generation", agentId: null }, correlation: { requestId: "fixture-request", traceId: null } }, context);
  expect(query.mock.calls[1]?.[1]).toMatchObject({ identity: { selfId: "codex-sol", generationId: "fixture-generation" }, correlation: { requestId: "fixture-request" } });
});
