import type { AddressInfo } from "node:net";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthenticatedDeveloper, DeveloperCapability } from "./developer-team.js";
import { DeveloperTeamRegistry, hashToken } from "./developer-team.js";
import { DurableConsultationMcpService } from "./consultation-mcp.js";
import {
  ConsultationRunner,
  type ConsultationDialogueExecutor,
  type ConsultationSynthesisInput,
  type ConsultationSynthesisOutput,
  type ConsultationSynthesisService,
} from "./consultation-service.js";
import { registerRoomMcpRoutes, type RoomMcpBridge, type RoomMcpIdempotency } from "./room-mcp.js";
import { JsonConsultationRepository } from "./storage/json-consultation-repository.js";

const TOKEN = "consultation-e2e-token-with-at-least-thirty-two-characters";
const ROOM_A = "00000000-0000-4000-8000-0000000000a1";
const ROOM_B = "00000000-0000-4000-8000-0000000000b2";
const ALL_CAPABILITIES: readonly DeveloperCapability[] = [
  "ROOM_READ", "ROOM_CHAT", "CONSULTATION_READ", "CONSULTATION_WRITE", "CONSULTATION_CANCEL",
];
const CLIENT_PACKAGES = [
  { name: "Codex", manifest: ".mcp.json" },
  { name: "Claude Code", manifest: "adapters/claude-code/.mcp.json" },
  { name: "Cursor", manifest: "cursor.mcp.json" },
  { name: "OpenCode", manifest: "adapters/opencode/opencode.json" },
] as const;
const pluginRoot = path.resolve("plugins/all-my-friends-are-agents");
const directories: string[] = [];
const runners: ConsultationRunner[] = [];

afterEach(async () => {
  for (const runner of runners.splice(0)) runner.close();
  await new Promise((resolve) => setTimeout(resolve, 20));
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function registry() {
  return new DeveloperTeamRegistry([{
    memberId: "e2e-consultant",
    revision: 1,
    displayName: "E2E Consultant",
    roles: ["AUTHOR"],
    capabilities: ALL_CAPABILITIES,
    tokenHash: hashToken(TOKEN),
    createdAt: "2026-08-27T00:00:00.000Z",
  }]);
}

function multiRoomBridge(): RoomMcpBridge & { readonly messages: Map<string, Array<{ id: string; text: string }>> } {
  const messages = new Map([
    [ROOM_A, [{ id: "a-1", text: "alpha only" }, { id: "a-2", text: "alpha latest" }]],
    [ROOM_B, [{ id: "b-1", text: "beta only" }]],
  ]);
  const allowed = (roomId: string) => messages.has(roomId);
  return {
    messages,
    listRooms: () => [
      { roomId: ROOM_B, name: "Beta", topic: "Second room", status: "active", busy: false },
      { roomId: ROOM_A, name: "Alpha", topic: "First room", status: "active", busy: false },
    ],
    authorizeRoom: (roomId: string) => allowed(roomId),
    readRoom: (roomId: string, limit: number, afterMessageId?: string | null) => {
      const roomMessages = messages.get(roomId);
      if (!roomMessages) return { kind: "stale_cursor" };
      const start = afterMessageId == null ? 0 : roomMessages.findIndex(({ id }) => id === afterMessageId) + 1;
      if (afterMessageId != null && start === 0) return { kind: "stale_cursor" };
      const visible = roomMessages.slice(start, start + limit);
      return {
        kind: "ok",
        value: { messages: visible },
        continuationMessageId: visible.at(-1)?.id ?? afterMessageId ?? null,
      };
    },
    sendMessage: async (roomId: string, _developer: AuthenticatedDeveloper, text: string, _idempotency: RoomMcpIdempotency) => {
      const roomMessages = messages.get(roomId);
      if (!roomMessages) return { kind: "not_found" };
      const message = { id: `${roomId === ROOM_A ? "a" : "b"}-${roomMessages.length + 1}`, text };
      roomMessages.push(message);
      return { kind: "ok", value: { accepted: true, messageId: message.id } };
    },
  };
}

async function repositoryFile(prefix = "consultation-e2e-") {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  directories.push(directory);
  return path.join(directory, "consultations.json");
}

async function withServer(
  runner: ConsultationRunner,
  repository: JsonConsultationRepository,
  bridge: RoomMcpBridge,
  run: (url: string) => Promise<void>,
) {
  const app = express();
  const registration = registerRoomMcpRoutes({
    app,
    developers: registry(),
    bridge,
    consultationService: new DurableConsultationMcpService(runner, repository),
  });
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`);
  } finally {
    await registration.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function withClient(
  url: string,
  name: string,
  enhanced: boolean,
  input: string,
  run: (client: Client) => Promise<void>,
) {
  const client = new Client({ name, version: "e2e" }, {
    versionNegotiation: { mode: "auto" },
    capabilities: enhanced ? { tasks: { list: {}, cancel: {} }, elicitation: { form: {} } } : {},
  });
  if (enhanced) client.setRequestHandler("elicitation/create", async () => ({ action: "accept", content: { response: input } }));
  await client.connect(new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
  }));
  try { await run(client); } finally { await client.close(); }
}

async function waitFor(client: Client, roomId: string, consultationId: string, state: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const result = await client.callTool({
      name: "get_room_consultation",
      arguments: { room_id: roomId, consultation_id: consultationId, event_limit: 50 },
    });
    if ((result.structuredContent as { state?: string }).state === state) return result;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Consultation ${consultationId} did not reach ${state}`);
}

async function eventually(check: () => boolean | Promise<boolean>) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("E2E condition was not reached");
}

function errorCode(result: { structuredContent?: unknown }) {
  return (result.structuredContent as { error?: { code?: string } })?.error?.code;
}

describe("consultation end-to-end compatibility", () => {
  it("runs every client package through explicit fallback and negotiated Tasks/input_required without room leakage", async () => {
    for (const clientPackage of CLIENT_PACKAGES) {
      expect(JSON.parse(await readFile(path.join(pluginRoot, clientPackage.manifest), "utf8"))).toBeTypeOf("object");
    }

    const file = await repositoryFile();
    const repository = await JsonConsultationRepository.open(file);
    const dialogue: ConsultationDialogueExecutor = { performTurn: vi.fn() };
    const synthesis: ConsultationSynthesisService = {
      synthesize: vi.fn(async (input): Promise<ConsultationSynthesisOutput> => input.inputs.length === 0
        ? { kind: "input_required", question: "Choose a window; authorization: Bearer do-not-leak" }
        : {
          kind: "settled",
          synthesis: `${input.roomId}: deploy ${input.inputs[0].value}`,
          recommendations: ["Use a canary."],
          dissent: [{ participantId: "challenger", position: "Keep rollback automatic." }],
          completedBy: "e2e-synthesizer",
        }),
    };
    const runner = new ConsultationRunner(repository, synthesis, dialogue);
    runners.push(runner);
    const bridge = multiRoomBridge();

    await withServer(runner, repository, bridge, async (url) => {
      for (const clientPackage of CLIENT_PACKAGES) {
        for (const enhanced of [false, true]) {
          const mode = enhanced ? "enhanced" : "fallback";
          const responseText = `${clientPackage.name} ${mode} Friday 18:00`;
          await withClient(url, `${clientPackage.name}-${mode}`, enhanced, responseText, async (client) => {
            const listed = await client.callTool({ name: "list_rooms", arguments: {} });
            expect((listed.structuredContent as { rooms: Array<{ roomId: string }> }).rooms.map(({ roomId }) => roomId)).toEqual([ROOM_A, ROOM_B]);

            const firstPage = await client.callTool({ name: "read_room", arguments: { room_id: ROOM_A, limit: 1 } });
            expect(firstPage.structuredContent).toMatchObject({ roomId: ROOM_A, messages: [{ text: "alpha only" }] });
            const cursor = (firstPage.structuredContent as { cursor: string }).cursor;
            const secondPage = await client.callTool({ name: "read_room", arguments: { room_id: ROOM_A, cursor } });
            expect(secondPage.structuredContent).toMatchObject({ roomId: ROOM_A, messages: [{ text: "alpha latest" }] });
            expect(errorCode(await client.callTool({ name: "read_room", arguments: { room_id: ROOM_B, cursor } }))).toBe("CURSOR_REFRESH_REQUIRED");

            const messageKey = `message-${clientPackage.name.replaceAll(" ", "-")}-${mode}`;
            const messageInput = { room_id: ROOM_B, text: `hello from ${clientPackage.name} ${mode}`, idempotency_key: messageKey };
            const sent = await client.callTool({ name: "send_room_message", arguments: messageInput });
            expect((await client.callTool({ name: "send_room_message", arguments: messageInput })).structuredContent).toEqual(sent.structuredContent);
            expect(errorCode(await client.callTool({ name: "send_room_message", arguments: { ...messageInput, text: "conflicting message" } }))).toBe("IDEMPOTENCY_CONFLICT");
            expect(bridge.messages.get(ROOM_A)?.some(({ text }) => text.includes(clientPackage.name))).toBe(false);

            const startInput = {
              room_id: ROOM_A,
              topic: `Profile ${clientPackage.name} ${mode}`,
              idempotency_key: `start-${clientPackage.name.replaceAll(" ", "-")}-${mode}`,
            };
            const started = await client.callTool({ name: "start_room_consultation", arguments: startInput });
            expect(started.structuredContent).toMatchObject({
              room_id: ROOM_A,
              state: "queued",
              transport: { mode: enhanced ? "mcp_task" : "polling", task_id: enhanced ? expect.any(String) : null },
            });
            expect((await client.callTool({ name: "start_room_consultation", arguments: startInput })).structuredContent).toEqual(started.structuredContent);
            expect(errorCode(await client.callTool({ name: "start_room_consultation", arguments: { ...startInput, topic: "conflicting topic" } }))).toBe("IDEMPOTENCY_CONFLICT");
            const consultationId = (started.structuredContent as { consultation_id: string }).consultation_id;

            const blocked = await waitFor(client, ROOM_A, consultationId, "input_required");
            expect(blocked.structuredContent).toMatchObject({ room_id: ROOM_A, consultation_id: consultationId });
            expect((blocked.structuredContent as { blocking_question: string }).blocking_question).not.toContain("do-not-leak");
            expect(errorCode(await client.callTool({ name: "get_room_consultation", arguments: { room_id: ROOM_B, consultation_id: consultationId } }))).toBe("ROOM_NOT_FOUND");
            const revision = (blocked.structuredContent as { revision: number }).revision;
            const staleResponse = await client.callTool({
              name: "respond_to_room_consultation",
              arguments: { room_id: ROOM_A, consultation_id: consultationId, expected_revision: revision - 1, response: responseText, idempotency_key: `stale-${mode}-${clientPackage.name.replaceAll(" ", "-")}` },
            });
            if (!staleResponse.structuredContent) throw new Error(`Missing stale response content: ${JSON.stringify(staleResponse)}`);
            expect(staleResponse.structuredContent).toMatchObject({ error: { code: "STALE_REVISION" } });
            expect(errorCode(await client.callTool({
              name: "respond_to_room_consultation",
              arguments: { room_id: ROOM_B, consultation_id: consultationId, expected_revision: revision, response: responseText, idempotency_key: `cross-room-${mode}-${clientPackage.name.replaceAll(" ", "-")}` },
            }))).toBe("ROOM_NOT_FOUND");

            const responseInput = {
              room_id: ROOM_A,
              consultation_id: consultationId,
              expected_revision: revision,
              ...(enhanced ? {} : { response: responseText }),
              idempotency_key: `resume-${clientPackage.name.replaceAll(" ", "-")}-${mode}`,
            };
            const resumed = await client.callTool({ name: "respond_to_room_consultation", arguments: responseInput });
            expect(resumed.structuredContent).toMatchObject({ room_id: ROOM_A, consultation_id: consultationId, state: "discussing" });
            const complete = await waitFor(client, ROOM_A, consultationId, "complete");
            expect(complete.structuredContent).toMatchObject({
              room_id: ROOM_A,
              consultation_id: consultationId,
              final_artifact: {
                synthesis: `${ROOM_A}: deploy ${responseText}`,
                recommendations: ["Use a canary."],
                dissent: [{ participantId: "challenger", position: "Keep rollback automatic." }],
              },
            });
            expect(errorCode(await client.callTool({ name: "respond_to_room_consultation", arguments: responseInput }))).toBeUndefined();
          });
        }
      }
    });

    expect(dialogue.performTurn).not.toHaveBeenCalled();
  }, 30_000);

  it("preserves dialogue settings and refuses duplicate provider execution after restart", async () => {
    const file = await repositoryFile("consultation-restart-e2e-");
    const firstRepository = await JsonConsultationRepository.open(file);
    const dialogue: ConsultationDialogueExecutor = {
      performTurn: vi.fn(async (input) => ({
        response: `${input.participantId} recommends a canary`,
        dissent: input.duty === "challenger",
      })),
    };
    let synthesisStarted!: () => void;
    const startedSynthesis = new Promise<void>((resolve) => { synthesisStarted = resolve; });
    const firstSynthesis: ConsultationSynthesisService = {
      synthesize: vi.fn(async () => {
        synthesisStarted();
        return new Promise<ConsultationSynthesisOutput>(() => undefined);
      }),
    };
    const firstRunner = new ConsultationRunner(firstRepository, firstSynthesis, dialogue);
    runners.push(firstRunner);
    const bridge = multiRoomBridge();
    let consultationId = "";

    await withServer(firstRunner, firstRepository, bridge, async (url) => withClient(url, "restart-before", false, "unused", async (client) => {
      const startInput = {
        room_id: ROOM_B,
        topic: "Restart a bounded dialogue",
        requested_participant_ids: ["facilitator", "challenger"],
        dialogue: { enabled: true, participantLimit: 2, turnLimit: 2, roundLimit: 1, concurrencyLimit: 1, timeLimitMs: 10_000 },
        idempotency_key: "restart-bounded-start",
      };
      const started = await client.callTool({ name: "start_room_consultation", arguments: startInput });
      consultationId = (started.structuredContent as { consultation_id: string }).consultation_id;
      expect(started.structuredContent).toMatchObject({ room_id: ROOM_B, consultation_id: consultationId, state: "queued" });
      await startedSynthesis;
      await eventually(async () => (await firstRepository.getConsultation({ roomId: ROOM_B, consultationId }))?.execution?.turns.length === 2);
      const discussing = await waitFor(client, ROOM_B, consultationId, "discussing");
      expect((discussing.structuredContent as { progress: { events: unknown[] } }).progress.events.length).toBeGreaterThan(0);
    }));

    firstRunner.close();
    const beforeRestart = await firstRepository.getConsultation({ roomId: ROOM_B, consultationId });
    expect(beforeRestart?.execution).toMatchObject({
      dialogueEnabled: true,
      limits: { participantLimit: 2, turnLimit: 2, roundLimit: 1, concurrencyLimit: 1 },
      turns: [{ participantId: "facilitator", round: 1 }, { participantId: "challenger", round: 1 }],
    });
    const synthesisKey = beforeRestart?.execution?.synthesisKey;

    const reopened = await JsonConsultationRepository.open(file);
    const recoveredSynthesis: ConsultationSynthesisService = {
      synthesize: vi.fn(async (input: ConsultationSynthesisInput): Promise<ConsultationSynthesisOutput> => ({
        kind: "settled",
        synthesis: `Recovered ${input.turns.length} bounded turns in ${input.roomId}`,
        dissent: input.turns.filter(({ dissent }) => dissent).map(({ participantId, response }) => ({ participantId, position: response })),
      })),
    };
    const recoveredRunner = new ConsultationRunner(reopened, recoveredSynthesis, dialogue);
    runners.push(recoveredRunner);
    await recoveredRunner.reconcile(ROOM_A);
    expect(recoveredSynthesis.synthesize).not.toHaveBeenCalled();
    await recoveredRunner.reconcile(ROOM_B);

    await withServer(recoveredRunner, reopened, bridge, async (url) => withClient(url, "restart-after", true, "unused", async (client) => {
      const replay = await client.callTool({ name: "start_room_consultation", arguments: {
        room_id: ROOM_B,
        topic: "Restart a bounded dialogue",
        requested_participant_ids: ["facilitator", "challenger"],
        dialogue: { enabled: true, participantLimit: 2, turnLimit: 2, roundLimit: 1, concurrencyLimit: 1, timeLimitMs: 10_000 },
        idempotency_key: "restart-bounded-start",
      } });
      expect(replay.structuredContent).toMatchObject({ room_id: ROOM_B, consultation_id: consultationId });
      const failed = await waitFor(client, ROOM_B, consultationId, "failed");
      expect(failed.structuredContent).toMatchObject({
        room_id: ROOM_B,
        consultation_id: consultationId,
        final_artifact: null,
      });
      const revision = (failed.structuredContent as { revision: number }).revision;
      const delta = await client.callTool({ name: "get_room_consultation", arguments: { room_id: ROOM_B, consultation_id: consultationId, after_revision: revision - 1 } });
      expect((delta.structuredContent as { progress: { events: Array<{ state: string }> } }).progress.events).toEqual([expect.objectContaining({ state: "failed" })]);
    }));

    const terminal = await reopened.getConsultation({ roomId: ROOM_B, consultationId });
    expect(terminal?.execution?.turns).toHaveLength(2);
    expect(terminal?.execution?.synthesisKey).toBe(synthesisKey);
    expect(dialogue.performTurn).toHaveBeenCalledTimes(2);
    expect(recoveredSynthesis.synthesize).not.toHaveBeenCalled();
    expect((await reopened.listConsultationEvents({ roomId: ROOM_B, consultationId })).filter(({ snapshot }) => snapshot.state === "failed")).toHaveLength(1);
  }, 20_000);

  it("makes cancellation exact-replay safe, rejects conflicting reuse, and persists one completion-race winner", async () => {
    const file = await repositoryFile("consultation-cancel-e2e-");
    const repository = await JsonConsultationRepository.open(file);
    let resolveSynthesis!: (output: ConsultationSynthesisOutput) => void;
    const synthesis: ConsultationSynthesisService = {
      synthesize: vi.fn(() => new Promise<ConsultationSynthesisOutput>((resolve) => { resolveSynthesis = resolve; })),
    };
    const runner = new ConsultationRunner(repository, synthesis);
    runners.push(runner);

    await withServer(runner, repository, multiRoomBridge(), async (url) => withClient(url, "cancel-race", false, "unused", async (client) => {
      const started = await client.callTool({ name: "start_room_consultation", arguments: { room_id: ROOM_A, topic: "Race cancellation", idempotency_key: "cancel-race-start" } });
      const consultationId = (started.structuredContent as { consultation_id: string }).consultation_id;
      await eventually(() => vi.mocked(synthesis.synthesize).mock.calls.length === 1);
      const discussing = await waitFor(client, ROOM_A, consultationId, "discussing");
      const cancelInput = {
        room_id: ROOM_A,
        consultation_id: consultationId,
        expected_revision: (discussing.structuredContent as { revision: number }).revision,
        reason: "No longer needed",
        idempotency_key: "cancel-race-key",
      };
      const cancellation = client.callTool({ name: "cancel_room_consultation", arguments: cancelInput });
      await new Promise((resolve) => setTimeout(resolve, 5));
      resolveSynthesis({ kind: "settled", synthesis: "A completion that raced cancellation" });
      const cancelled = await cancellation;
      expect(cancelled.structuredContent).toMatchObject({ room_id: ROOM_A, consultation_id: consultationId, state: "cancelled", final_artifact: null });
      expect((await client.callTool({ name: "cancel_room_consultation", arguments: cancelInput })).structuredContent).toEqual(cancelled.structuredContent);
      expect(errorCode(await client.callTool({ name: "cancel_room_consultation", arguments: { ...cancelInput, reason: "different reason" } }))).toBe("IDEMPOTENCY_CONFLICT");
      await new Promise((resolve) => setTimeout(resolve, 20));
      const events = await repository.listConsultationEvents({ roomId: ROOM_A, consultationId });
      expect(events.filter(({ snapshot }) => ["complete", "cancelled", "failed"].includes(snapshot.state))).toHaveLength(1);
    }));
  });
});
