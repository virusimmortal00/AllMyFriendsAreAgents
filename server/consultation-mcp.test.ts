import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import { Client, InsufficientScopeError, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConsultationRunner, type ConsultationSynthesisOutput, type ConsultationSynthesisService } from "./consultation-service.js";
import { DurableConsultationMcpService } from "./consultation-mcp.js";
import { DeveloperTeamRegistry, hashToken, type DeveloperCapability } from "./developer-team.js";
import { registerRoomMcpRoutes, singleRoomMcpBridge } from "./room-mcp.js";
import { JsonConsultationRepository } from "./storage/json-consultation-repository.js";

const TOKEN = "consultation-mcp-test-token-with-at-least-thirty-two-characters";
const ROOM_ID = "00000000-0000-4000-8000-000000000001";
const directories: string[] = [];
const runners: ConsultationRunner[] = [];
afterEach(async () => {
  for (const runner of runners.splice(0)) runner.close();
  await new Promise((resolve) => setTimeout(resolve, 20));
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function registry(capabilities: readonly DeveloperCapability[]) {
  return new DeveloperTeamRegistry([{ memberId: "consultant", revision: 1, displayName: "Consultant", roles: ["AUTHOR"], capabilities, tokenHash: hashToken(TOKEN), createdAt: "2026-08-27T00:00:00.000Z" }]);
}

async function fixture(synthesis?: ConsultationSynthesisService) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "consultation-mcp-")); directories.push(directory);
  const file = path.join(directory, "consultations.json");
  const repository = await JsonConsultationRepository.open(file);
  const effective = synthesis ?? { synthesize: vi.fn(async (input): Promise<ConsultationSynthesisOutput> => input.inputs.length
    ? { kind: "settled", synthesis: `Accepted: ${input.inputs[0].value}` }
    : { kind: "input_required", question: "Which release window should be used?" }) };
  const runner = new ConsultationRunner(repository, effective);
  runners.push(runner);
  return { file, repository, runner, service: new DurableConsultationMcpService(runner, repository), synthesis: effective };
}

async function withServer(
  capabilities: readonly DeveloperCapability[],
  service: DurableConsultationMcpService,
  run: (url: string) => Promise<void>,
) {
  const app = express();
  const developers = registry(capabilities);
  const registration = registerRoomMcpRoutes({
    app, developers, consultationService: service,
    bridge: singleRoomMcpBridge({
      roomId: ROOM_ID,
      describe: () => ({ roomId: ROOM_ID, name: "Room", topic: "Consult", status: "active", busy: false }),
      read: () => ({ kind: "ok", value: { messages: [] }, continuationMessageId: null }),
      send: async () => ({ kind: "ok", value: { accepted: true } }),
    }),
  });
  const server = app.listen(0); await new Promise<void>((resolve) => server.once("listening", resolve));
  try { await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`); }
  finally { await registration.close(); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

async function withClient(url: string, capabilities: Record<string, unknown>, run: (client: Client) => Promise<void>) {
  const client = new Client({ name: "consultation-test", version: "1" }, { versionNegotiation: { mode: "auto" }, capabilities });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }));
  try { await run(client); } finally { await client.close(); }
}

async function waitFor(client: Client, consultationId: string, state: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await client.callTool({ name: "get_room_consultation", arguments: { room_id: ROOM_ID, consultation_id: consultationId } });
    if ((result.structuredContent as { state?: string }).state === state) return result;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Consultation did not reach ${state}`);
}

describe("consultation MCP contract", () => {
  it("publishes four deterministic explicit-room schemas and least-privilege annotations", async () => {
    const state = await fixture();
    await withServer(["CONSULTATION_READ", "CONSULTATION_WRITE", "CONSULTATION_CANCEL"], state.service, async (url) => withClient(url, {}, async (client) => {
      const tools = (await client.listTools()).tools;
      expect(tools.map(({ name }) => name)).toEqual([
        "list_rooms", "read_room", "send_room_message", "start_room_consultation", "get_room_consultation", "respond_to_room_consultation", "cancel_room_consultation",
      ]);
      for (const name of ["start_room_consultation", "get_room_consultation", "respond_to_room_consultation", "cancel_room_consultation"]) {
        const tool = tools.find((candidate) => candidate.name === name)!;
        expect(tool.inputSchema.required).toContain("room_id");
        expect(tool.outputSchema).toBeDefined();
      }
      expect(tools.find(({ name }) => name === "start_room_consultation")).toMatchObject({
        _meta: { "io.modelcontextprotocol/tasks": { taskSupport: "optional" } },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      });
      expect(tools.find(({ name }) => name === "get_room_consultation")?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
      expect(tools.find(({ name }) => name === "cancel_room_consultation")?.annotations).toMatchObject({ destructiveHint: true, idempotentHint: true });
    }));
    state.runner.close();
  });

  it("supports explicit fallback start, bounded polling, response replay/conflict, and cancellation replay", async () => {
    let releaseCancel!: (value: ConsultationSynthesisOutput) => void;
    const synthesis: ConsultationSynthesisService = { synthesize: vi.fn((input): Promise<ConsultationSynthesisOutput> => input.topic === "Keep running"
      ? new Promise<ConsultationSynthesisOutput>((resolve) => { releaseCancel = resolve; })
      : Promise.resolve(input.inputs.length ? { kind: "settled", synthesis: `Accepted: ${input.inputs[0].value}` } : { kind: "input_required", question: "Which release window?" })) };
    const state = await fixture(synthesis);
    await withServer(["CONSULTATION_READ", "CONSULTATION_WRITE", "CONSULTATION_CANCEL"], state.service, async (url) => withClient(url, {}, async (client) => {
      const startInput = { room_id: ROOM_ID, topic: "Choose a window", idempotency_key: "start-window-1" };
      const started = await client.callTool({ name: "start_room_consultation", arguments: startInput });
      const replay = await client.callTool({ name: "start_room_consultation", arguments: startInput });
      expect(replay.structuredContent).toEqual(started.structuredContent);
      expect(started.structuredContent).toMatchObject({ room_id: ROOM_ID, state: "queued", transport: { mode: "polling", task_id: null } });
      const consultationId = (started.structuredContent as { consultation_id: string }).consultation_id;
      const blocked = await waitFor(client, consultationId, "input_required");
      expect(blocked.structuredContent).toMatchObject({ blocking_question: "Which release window?", progress: { events: expect.any(Array) } });
      const revision = (blocked.structuredContent as { revision: number }).revision;
      const responseInput = { room_id: ROOM_ID, consultation_id: consultationId, expected_revision: revision, response: "Friday at 18:00", idempotency_key: "respond-window-1" };
      const response = await client.callTool({ name: "respond_to_room_consultation", arguments: responseInput });
      const responseReplay = await client.callTool({ name: "respond_to_room_consultation", arguments: responseInput });
      expect(responseReplay.structuredContent).toEqual(response.structuredContent);
      const conflict = await client.callTool({ name: "respond_to_room_consultation", arguments: { ...responseInput, response: "Saturday" } });
      expect(conflict.structuredContent).toMatchObject({ error: { code: "IDEMPOTENCY_CONFLICT" } });
      const complete = await waitFor(client, consultationId, "complete");
      expect(complete.structuredContent).toMatchObject({ final_artifact: { synthesis: "Accepted: Friday at 18:00" } });

      const cancelling = await client.callTool({ name: "start_room_consultation", arguments: { room_id: ROOM_ID, topic: "Keep running", idempotency_key: "start-cancel-1" } });
      const cancellingId = (cancelling.structuredContent as { consultation_id: string }).consultation_id;
      const discussing = await waitFor(client, cancellingId, "discussing");
      const cancelInput = { room_id: ROOM_ID, consultation_id: cancellingId, expected_revision: (discussing.structuredContent as { revision: number }).revision, idempotency_key: "cancel-1" };
      const cancelled = await client.callTool({ name: "cancel_room_consultation", arguments: cancelInput });
      const cancelReplay = await client.callTool({ name: "cancel_room_consultation", arguments: cancelInput });
      expect(cancelReplay.structuredContent).toEqual(cancelled.structuredContent);
      releaseCancel({ kind: "settled", synthesis: "Too late" });
    }));
    state.runner.close();
  });

  it("enforces scope step-up and room membership before lookup", async () => {
    const state = await fixture();
    await withServer(["CONSULTATION_READ"], state.service, async (url) => withClient(url, {}, async (client) => {
      await expect(client.callTool({ name: "start_room_consultation", arguments: { room_id: ROOM_ID, topic: "Denied", idempotency_key: "denied-start" } })).rejects.toBeInstanceOf(InsufficientScopeError);
      const hidden = await client.callTool({ name: "get_room_consultation", arguments: { room_id: "another-room", consultation_id: "secret" } });
      expect(hidden.structuredContent).toMatchObject({ error: { code: "ROOM_NOT_FOUND" } });
    }));
    state.runner.close();
  });

  it("activates negotiated task projection and signed multi-round-trip input while preserving explicit response", async () => {
    const state = await fixture();
    await withServer(["CONSULTATION_READ", "CONSULTATION_WRITE", "CONSULTATION_CANCEL"], state.service, async (url) => {
      const client = new Client({ name: "enhanced-consultation-test", version: "1" }, {
        versionNegotiation: { mode: "auto" },
        capabilities: { tasks: { list: {}, cancel: {} }, elicitation: { form: {} } },
      });
      client.setRequestHandler("elicitation/create", async () => ({ action: "accept", content: { response: "Sunday at noon" } }));
      await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }));
      try {
        const started = await client.callTool({ name: "start_room_consultation", arguments: { room_id: ROOM_ID, topic: "Choose enhanced window", idempotency_key: "enhanced-start" } });
        expect(started.structuredContent).toMatchObject({ transport: { mode: "mcp_task", task_id: expect.any(String) } });
        const id = (started.structuredContent as { consultation_id: string }).consultation_id;
        const blocked = await waitFor(client, id, "input_required");
        const resumed = await client.callTool({ name: "respond_to_room_consultation", arguments: { room_id: ROOM_ID, consultation_id: id, expected_revision: (blocked.structuredContent as { revision: number }).revision, idempotency_key: "enhanced-response" } });
        expect(resumed.structuredContent).toMatchObject({ room_id: ROOM_ID, consultation_id: id });
        expect((await waitFor(client, id, "complete")).structuredContent).toMatchObject({ final_artifact: { synthesis: "Accepted: Sunday at noon" } });
      } finally { await client.close(); }
    });
    state.runner.close();
  });

  it("polls the same room-attributed consultation after repository restart", async () => {
    const first = await fixture({ synthesize: () => new Promise(() => undefined) });
    const developer = registry(["CONSULTATION_READ", "CONSULTATION_WRITE"]).authenticate(`Bearer ${TOKEN}`, "CONSULTATION_WRITE")!;
    const started = await first.service.start({ room_id: ROOM_ID, topic: "Restart safely", idempotency_key: "restart-start" }, developer);
    expect(started).toMatchObject({ kind: "ok", consultation: { roomId: ROOM_ID } });
    first.runner.close(); await new Promise((resolve) => setTimeout(resolve, 10));
    const reopened = await JsonConsultationRepository.open(first.file);
    const secondRunner = new ConsultationRunner(reopened, { synthesize: async () => ({ kind: "settled", synthesis: "Recovered process" }) });
    runners.push(secondRunner);
    await secondRunner.reconcile(ROOM_ID);
    const secondService = new DurableConsultationMcpService(secondRunner, reopened);
    await withServer(["CONSULTATION_READ", "CONSULTATION_WRITE"], secondService, async (url) => withClient(url, {}, async (client) => {
      const id = started.kind === "ok" ? started.consultation.consultationId : "";
      const complete = await waitFor(client, id, "complete");
      expect(complete.structuredContent).toMatchObject({ room_id: ROOM_ID, consultation_id: id, final_artifact: { synthesis: "Recovered process" } });
    }));
    secondRunner.close();
  });
});
