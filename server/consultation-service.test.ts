import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConsultationProvenance } from "../shared/consultation-domain.js";
import { ConsultationRunner, sanitizeConsultationContext, type ConsultationDialogueExecutor, type ConsultationSynthesisOutput, type ConsultationSynthesisService } from "./consultation-service.js";
import { JsonConsultationRepository } from "./storage/json-consultation-repository.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); vi.restoreAllMocks(); });
const provenance: ConsultationProvenance = { kind: "human", actorId: "human-1", sourceId: "message-1", recordedAt: "2026-08-27T12:00:00.000Z" };
const eventually = async (check: () => boolean | Promise<boolean>) => { for (let index = 0; index < 200; index += 1) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 5)); } throw new Error("condition not reached"); };
async function repository() { const directory = await mkdtemp(path.join(os.tmpdir(), "consultation-service-")); directories.push(directory); return { directory, repository: await JsonConsultationRepository.open(path.join(directory, "consultations.json")) }; }
function settled(synthesis = "Use a canary release."): ConsultationSynthesisService { return { synthesize: vi.fn(async (): Promise<ConsultationSynthesisOutput> => ({ kind: "settled", synthesis, recommendations: ["Start at 5%."] })) }; }

describe("ConsultationRunner", () => {
  it("durably returns a queued ID before default asynchronous synthesis and starts no dialogue", async () => {
    const fixture = await repository(); let resolve!: (value: ConsultationSynthesisOutput) => void;
    const synthesis: ConsultationSynthesisService = { synthesize: vi.fn(() => new Promise<ConsultationSynthesisOutput>((done) => { resolve = done; })) };
    const dialogue: ConsultationDialogueExecutor = { performTurn: vi.fn() };
    const runner = new ConsultationRunner(fixture.repository, synthesis, dialogue);
    const started = await runner.start({ roomId: "room-a", consultationId: "consult-a", idempotencyKey: "start-a", request: { topic: "Choose a safe release strategy" }, provenance });
    expect(started).toMatchObject({ kind: "created", consultation: { consultationId: "consult-a", state: "queued", execution: { dialogueEnabled: false } } });
    expect(dialogue.performTurn).not.toHaveBeenCalled();
    await eventually(() => vi.mocked(synthesis.synthesize).mock.calls.length === 1);
    expect((await fixture.repository.getConsultation({ roomId: "room-a", consultationId: "consult-a" }))?.state).toBe("discussing");
    resolve({ kind: "settled", synthesis: "Canary first.", dissent: [{ participantId: "agent-b", position: "Prefer a smaller cohort." }], provenance: [provenance] });
    await eventually(async () => (await runner.get({ roomId: "room-a", consultationId: "consult-a" }))?.state === "complete");
    expect(await runner.get({ roomId: "room-a", consultationId: "consult-a" })).toMatchObject({ finalArtifact: { synthesis: "Canary first.", dissent: [{ participantId: "agent-b", position: "Prefer a smaller cohort." }], provenance: [provenance] } });
  });

  it("bounds opted-in dialogue and dispatches only request-derived, credential-free context", async () => {
    const fixture = await repository(); let active = 0; let maximumActive = 0;
    const dialogue: ConsultationDialogueExecutor = { performTurn: vi.fn(async (input) => { active += 1; maximumActive = Math.max(maximumActive, active); await new Promise((resolve) => setTimeout(resolve, 2)); active -= 1; expect(JSON.stringify(input.context)).not.toMatch(/secret-value|private\/repo/); expect(input.prompt).toContain(input.duty); return { response: `${input.participantId} position`, dissent: input.duty === "challenger", evidence: [{ id: input.turnId, uri: "test:dialogue", summary: "bounded" }] }; }) };
    const synthesis = settled(); const runner = new ConsultationRunner(fixture.repository, synthesis, dialogue);
    await runner.start({ roomId: "room-a", consultationId: "bounded", idempotencyKey: "bounded", request: { topic: "Select the release sequence", requestedParticipantIds: ["agent-a", "agent-b", "agent-c"], context: { apiToken: "secret-value", repository_path: "/private/repo", safe: "Bearer abc.def", constraint: "No downtime" } }, provenance, dialogue: { enabled: true, participantLimit: 2, turnLimit: 3, roundLimit: 2, concurrencyLimit: 2, timeLimitMs: 10_000 } });
    await eventually(async () => (await runner.get({ roomId: "room-a", consultationId: "bounded" }))?.state === "complete");
    const final = await runner.get({ roomId: "room-a", consultationId: "bounded" });
    expect(final?.execution?.participantIds).toEqual(["agent-a", "agent-b"]);
    expect(final?.execution?.turns).toHaveLength(3);
    expect(Math.max(...final!.execution!.turns.map(({ round }) => round))).toBeLessThanOrEqual(2);
    expect(maximumActive).toBeLessThanOrEqual(2);
    expect(final?.request.context).toEqual({ safe: "[REDACTED CREDENTIAL]", constraint: "No downtime" });
    expect(final?.finalArtifact?.evidence).toHaveLength(3);
  });

  it("blocks, rejects stale and cross-room input, resumes, and sanitizes questions", async () => {
    const fixture = await repository();
    const synthesis: ConsultationSynthesisService = { synthesize: vi.fn(async (input): Promise<ConsultationSynthesisOutput> => input.inputs.length ? { kind: "settled", synthesis: `Window: ${input.inputs[0].value}` } : { kind: "input_required", question: "Provide window; authorization: Bearer should-not-leak" }) };
    const runner = new ConsultationRunner(fixture.repository, synthesis);
    await runner.start({ roomId: "room-a", consultationId: "blocked", idempotencyKey: "blocked", request: { topic: "Choose the deployment window" }, provenance });
    await eventually(async () => (await runner.get({ roomId: "room-a", consultationId: "blocked" }))?.state === "input_required");
    const blocked = (await runner.get({ roomId: "room-a", consultationId: "blocked" }))!;
    expect(blocked.execution?.blockingQuestion).not.toContain("should-not-leak");
    expect(await runner.submitInput({ roomId: "room-b", consultationId: "blocked" }, blocked.revision, "Friday", "human-1")).toMatchObject({ kind: "not_found" });
    expect(await runner.submitInput({ roomId: "room-a", consultationId: "blocked" }, blocked.revision - 1, "Friday", "human-1")).toMatchObject({ kind: "conflict" });
    expect(await runner.submitInput({ roomId: "room-a", consultationId: "blocked" }, blocked.revision, "Friday after 18:00", "human-1", "input-1")).toMatchObject({ kind: "ok", consultation: { state: "discussing" } });
    await eventually(async () => (await runner.get({ roomId: "room-a", consultationId: "blocked" }))?.state === "complete");
    expect((await runner.get({ roomId: "room-a", consultationId: "blocked" }))?.finalArtifact?.synthesis).toContain("Friday after 18:00");
  });

  it("recovers safe work and refuses duplicate provider dispatch after an uncertain crash", async () => {
    const fixture = await repository();
    const queuedFirst = new ConsultationRunner(fixture.repository, settled("Should not run before restart."));
    await queuedFirst.start({ roomId: "room-a", consultationId: "queued-restart", idempotencyKey: "queued-restart", request: { topic: "Recover a queued consultation safely" }, provenance }); queuedFirst.close(); await new Promise((resolve) => setTimeout(resolve, 10));
    expect((await fixture.repository.getConsultation({ roomId: "room-a", consultationId: "queued-restart" }))?.state).toBe("queued");
    const queuedSynthesis = settled("Recovered from queued."); const queuedSecond = new ConsultationRunner(await JsonConsultationRepository.open(path.join(fixture.directory, "consultations.json")), queuedSynthesis);
    await queuedSecond.reconcile("room-a"); await eventually(async () => (await queuedSecond.get({ roomId: "room-a", consultationId: "queued-restart" }))?.state === "complete");
    expect(queuedSynthesis.synthesize).toHaveBeenCalledTimes(1);
    queuedSecond.close(); await new Promise((resolve) => setTimeout(resolve, 10));

    const dialogue: ConsultationDialogueExecutor = { performTurn: vi.fn(async (input) => ({ response: `turn ${input.turnId}` })) };
    let rejectFirst!: (error: Error) => void;
    const firstSynthesis: ConsultationSynthesisService = { synthesize: vi.fn((_input) => new Promise<ConsultationSynthesisOutput>((_resolve, reject) => { rejectFirst = reject; })) };
    const first = new ConsultationRunner(fixture.repository, firstSynthesis, dialogue);
    await first.start({ roomId: "room-a", consultationId: "restart", idempotencyKey: "restart", request: { topic: "Recover this consultation safely", requestedParticipantIds: ["agent-a"] }, provenance, dialogue: { enabled: true, participantLimit: 1, turnLimit: 1, roundLimit: 1, concurrencyLimit: 1 } });
    await eventually(async () => (await first.get({ roomId: "room-a", consultationId: "restart" }))?.execution?.turns.length === 1 && vi.mocked(firstSynthesis.synthesize).mock.calls.length === 1);
    const originalKey = vi.mocked(firstSynthesis.synthesize).mock.calls[0][0].idempotencyKey;
    first.close(); rejectFirst(new Error("shutdown")); await new Promise((resolve) => setTimeout(resolve, 10));
    const secondSynthesis = settled("Recovered once."); const second = new ConsultationRunner(await JsonConsultationRepository.open(path.join(fixture.directory, "consultations.json")), secondSynthesis, dialogue);
    await second.reconcile("room-a");
    await eventually(async () => (await second.get({ roomId: "room-a", consultationId: "restart" }))?.state === "failed");
    expect(dialogue.performTurn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(secondSynthesis.synthesize).mock.calls.filter(([input]) => input.consultationId === "restart")).toHaveLength(0);
    expect((await second.get({ roomId: "room-a", consultationId: "restart" }))?.execution?.providerOperations).toContainEqual(expect.objectContaining({ operationKey: originalKey, kind: "synthesis", status: "started" }));
    second.close(); await new Promise((resolve) => setTimeout(resolve, 10));

    const waitingSynthesis: ConsultationSynthesisService = { synthesize: vi.fn(async (): Promise<ConsultationSynthesisOutput> => ({ kind: "input_required", question: "Which region?" })) };
    const waiting = new ConsultationRunner(await JsonConsultationRepository.open(path.join(fixture.directory, "consultations.json")), waitingSynthesis);
    await waiting.start({ roomId: "room-a", consultationId: "waiting", idempotencyKey: "waiting", request: { topic: "Choose the primary deployment region" }, provenance });
    await eventually(async () => (await waiting.get({ roomId: "room-a", consultationId: "waiting" }))?.state === "input_required"); waiting.close(); await new Promise((resolve) => setTimeout(resolve, 10));
    const afterWaiting = settled(); const recovered = new ConsultationRunner(await JsonConsultationRepository.open(path.join(fixture.directory, "consultations.json")), afterWaiting);
    await recovered.reconcile("room-a"); await new Promise((resolve) => setTimeout(resolve, 20));
    expect(afterWaiting.synthesize).not.toHaveBeenCalled();
  });

  it("recovers persisted dialogue configuration and duties when creation precedes execution initialization", async () => {
    const fixture = await repository();
    await fixture.repository.createConsultation({
      roomId: "room-a", consultationId: "creation-crash", idempotencyKey: "creation-crash", idempotencyScope: provenance.actorId,
      request: { topic: "Recover requested dialogue", requestedParticipantIds: ["agent-a"], dialogue: { enabled: true, participantLimit: 1, turnLimit: 1, roundLimit: 1, concurrencyLimit: 1, timeLimitMs: 10_000 } },
      provenance, now: provenance.recordedAt,
    });
    const dialogue: ConsultationDialogueExecutor = { performTurn: vi.fn(async () => ({ response: "Recovered turn" })) };
    const runner = new ConsultationRunner(fixture.repository, settled(), dialogue);
    await runner.reconcile("room-a");
    await eventually(async () => (await runner.get({ roomId: "room-a", consultationId: "creation-crash" }))?.state === "complete");
    expect(await runner.get({ roomId: "room-a", consultationId: "creation-crash" })).toMatchObject({
      request: { dialogue: { enabled: true, turnLimit: 1 } },
      execution: { dialogueEnabled: true, limits: { turnLimit: 1 }, participantIds: ["agent-a"], turns: [{ participantId: "agent-a" }] },
      duties: [{ participantId: "agent-a", duty: "facilitator" }],
    });
  });

  it("persists turn dispatch before provider invocation and never repeats an uncertain turn", async () => {
    const fixture = await repository();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const firstDialogue: ConsultationDialogueExecutor = { performTurn: vi.fn(async () => { markStarted(); return new Promise<never>(() => undefined); }) };
    const first = new ConsultationRunner(fixture.repository, settled(), firstDialogue);
    await first.start({ roomId: "room-a", consultationId: "turn-crash", idempotencyKey: "turn-crash", request: { topic: "Do not repeat", requestedParticipantIds: ["agent-a"] }, provenance, dialogue: { enabled: true, participantLimit: 1, turnLimit: 1, roundLimit: 1, concurrencyLimit: 1 } });
    await started;
    first.close();
    const secondDialogue: ConsultationDialogueExecutor = { performTurn: vi.fn() };
    const second = new ConsultationRunner(await JsonConsultationRepository.open(path.join(fixture.directory, "consultations.json")), settled(), secondDialogue);
    await second.reconcile("room-a");
    await eventually(async () => (await second.get({ roomId: "room-a", consultationId: "turn-crash" }))?.state === "failed");
    expect(firstDialogue.performTurn).toHaveBeenCalledTimes(1);
    expect(secondDialogue.performTurn).not.toHaveBeenCalled();
  });

  it("fails closed when the shared generation ceiling cannot reserve dialogue capacity", async () => {
    const fixture = await repository();
    const dialogue: ConsultationDialogueExecutor = { performTurn: vi.fn() };
    const runner = new ConsultationRunner(fixture.repository, settled(), dialogue, undefined, undefined, { reserve: () => undefined });
    await runner.start({ roomId: "room-a", consultationId: "capacity", idempotencyKey: "capacity", request: { topic: "Respect shared ceiling", requestedParticipantIds: ["agent-a"] }, provenance, dialogue: { enabled: true, participantLimit: 1, turnLimit: 1, roundLimit: 1, concurrencyLimit: 1 } });
    await eventually(async () => (await runner.get({ roomId: "room-a", consultationId: "capacity" }))?.state === "failed");
    expect(dialogue.performTurn).not.toHaveBeenCalled();
  });

  it("persists one winner when cancellation races completion and makes cancellation idempotent", async () => {
    const fixture = await repository(); let resolve!: (value: ConsultationSynthesisOutput) => void;
    const synthesis: ConsultationSynthesisService = { synthesize: () => new Promise((done) => { resolve = done; }) };
    const runner = new ConsultationRunner(fixture.repository, synthesis);
    await runner.start({ roomId: "room-a", consultationId: "race", idempotencyKey: "race", request: { topic: "Race cancellation against completion" }, provenance });
    await eventually(async () => (await runner.get({ roomId: "room-a", consultationId: "race" }))?.state === "discussing");
    const racing = (await runner.get({ roomId: "room-a", consultationId: "race" }))!;
    const cancel = runner.cancel(racing, racing.revision, "human-1"); resolve({ kind: "settled", synthesis: "Late synthesis" });
    expect(await cancel).toMatchObject({ kind: "ok", consultation: { state: "cancelled" } });
    await new Promise((done) => setTimeout(done, 20));
    const terminal = (await runner.get(racing))!; expect(terminal.state).toBe("cancelled"); expect(terminal.finalArtifact).toBeNull();
    expect(await runner.cancel(racing, terminal.revision, "human-1")).toMatchObject({ kind: "ok", consultation: { state: "cancelled" } });
    expect((await fixture.repository.listConsultationEvents(racing)).filter(({ snapshot }) => ["complete", "cancelled", "failed"].includes(snapshot.state))).toHaveLength(1);
  });
});

describe("sanitizeConsultationContext", () => {
  it("recursively strips private repository and credential fields", () => {
    expect(sanitizeConsultationContext({ safe: "ok", nested: { password: "never", projectPath: "/private", note: "api_key=also-never" } })).toEqual({ safe: "ok", nested: { note: "api_key=[REDACTED]" } });
  });
});
