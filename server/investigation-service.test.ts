import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RoomStore } from "./room-store.js";
import { InvestigationStore } from "./investigation-store.js";
import { InvestigationService, type InvestigationExecutor, type InvestigationExecutorInput, type InvestigationExecutorResult } from "./investigation-service.js";

const roots: string[] = [];
const services: InvestigationService[] = [];
afterEach(async () => { const active = services.splice(0); for (const service of active) { await service.shutdown(); await eventually(() => service.activeCount() === 0); } await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 10 }))); });
class DeferredExecutor implements InvestigationExecutor {
  inputs: InvestigationExecutorInput[] = []; private pending: Array<{ resolve: (value: InvestigationExecutorResult) => void; reject: (error: unknown) => void }> = [];
  dispatch(input: InvestigationExecutorInput) { this.inputs.push(input); return new Promise<InvestigationExecutorResult>((resolve, reject) => { this.pending.push({ resolve, reject }); input.signal.addEventListener("abort", () => reject(new Error(String(input.signal.reason))), { once: true }); }); }
  resolve(value: Partial<InvestigationExecutorResult> = {}) { this.pending.shift()!.resolve({ providerSessionId: value.providerSessionId || "investigation-session", summary: value.summary || "Corroborated local finding.", evidenceRefs: value.evidenceRefs || [], unresolvedQuestions: value.unresolvedQuestions || [], usage: value.usage || { tokens: 10, toolCalls: 1 } }); }
}
async function fixture(executor: InvestigationExecutor = new DeferredExecutor(), options: { stopped?: () => boolean; maxConcurrentGlobal?: number; defaultTokenLimit?: number; now?: () => Date } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "amfaa-investigation-")); roots.push(root); const stateDirectory = path.join(root, "state"); const rooms = await RoomStore.open(root, path.join(root, "room")); const store = await InvestigationStore.open(stateDirectory); const service = new InvestigationService(store, rooms, executor, { configuredEnabled: false, emergencyStopped: options.stopped, maxConcurrentGlobal: options.maxConcurrentGlobal, defaultTokenLimit: options.defaultTokenLimit, now: options.now }); services.push(service); await service.initialize(); const policy = (await service.policy())!; await service.updatePolicy(policy.revision, true, "test-human"); const evidence = [{ kind: "room_message" as const, ref: rooms.snapshot().messages.at(-1)!.id }]; return { root, stateDirectory, rooms, store, service, executor, evidence };
}
async function eventually(check: () => boolean | Promise<boolean>) { for (let attempt = 0; attempt < 100; attempt += 1) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 5)); } throw new Error("condition not reached"); }

describe("independent investigation lane", () => {
  it("runs beside foreground activity with a distinct session and lands only in the inbox", async () => {
    const value = await fixture(); const executor = value.executor as DeferredExecutor; await value.rooms.setSession("codex-sol", "foreground-session", "read-only");
    const requested = await value.service.request({ owner: "codex-sol", objective: "Corroborate the anomaly", trigger: "Unexpected identity signal", signal: "AGENT_DECISION", evidenceRefs: value.evidence }); expect(requested.kind).toBe("ok");
    await eventually(() => executor.inputs.length === 1); expect(executor.inputs[0].forbiddenProviderSessionIds).toContain("foreground-session"); expect(executor.inputs[0].capabilities).toEqual(["READ_PROJECT", "READ_OBSERVABILITY", "RUN_READ_ONLY_TESTS"]); expect(executor.inputs[0].excludedCapabilities).toContain("EDIT");
    await value.rooms.addMessage("you", "The room moved on while this ran."); expect(executor.inputs[0].signal.aborted).toBe(false); executor.resolve({ providerSessionId: "background-session" }); await eventually(async () => (await value.service.list())[0]?.status === "COMPLETED");
    expect(value.rooms.snapshot().messages.at(-1)?.text).toBe("The room moved on while this ran."); expect(await value.service.inbox("codex-sol")).toMatchObject([{ status: "UNREAD", summary: "Corroborated local finding." }]); expect((await value.service.contextForAgent("codex-sol"))[0]?.summary).toContain("Corroborated");
  });
  it("requires trusted corroboratable initiation and enforces one lane per agent", async () => {
    const value = await fixture(); expect(await value.service.request({ owner: "codex-sol", objective: "Investigate", trigger: "raw packet", signal: "AGENT_DECISION" })).toMatchObject({ kind: "rejected" }); expect(await value.service.request({ owner: "codex-sol", objective: "Investigate", trigger: "forged", signal: "AGENT_DECISION", evidenceRefs: [{ kind: "room_message", ref: "forged" }] })).toMatchObject({ kind: "rejected" });
    expect((await value.service.request({ owner: "codex-sol", objective: "Investigate", trigger: "credible tip", signal: "AGENT_DECISION", evidenceRefs: value.evidence })).kind).toBe("ok"); expect(await value.service.request({ owner: "codex-sol", objective: "Duplicate", trigger: "same signal", signal: "AGENT_DECISION", evidenceRefs: value.evidence })).toMatchObject({ kind: "conflict" });
  });
  it("allows a bounded real-provider context budget while rejecting values above the hard ceiling", async () => {
    const value = await fixture();
    expect(await value.service.request({ owner: "codex-sol", objective: "Too large", trigger: "provider context", signal: "AUTHENTICATED_HUMAN", evidenceRefs: value.evidence, budget: { tokenLimit: 96_001 } })).toMatchObject({ kind: "rejected" });
    expect((await value.service.request({ owner: "codex-sol", objective: "Bounded real provider", trigger: "provider context", signal: "AUTHENTICATED_HUMAN", evidenceRefs: value.evidence, budget: { tokenLimit: 96_000 } })).kind).toBe("ok");
  });
  it("configures a bounded default token budget for autonomous requests", async () => {
    const value = await fixture(new DeferredExecutor(), { defaultTokenLimit: 96_000 });
    expect((await value.service.policy())?.defaultBudget.tokenLimit).toBe(96_000);
    const requested = await value.service.request({ owner: "codex-sol", objective: "Autonomous bounded run", trigger: "credible local evidence", signal: "AGENT_DECISION", evidenceRefs: value.evidence });
    expect(requested.kind === "ok" && requested.value.budget.tokenLimit).toBe(96_000);
  });
  it("bounds global provider concurrency while allowing one independent lane for another agent", async () => {
    const value = await fixture(new DeferredExecutor(), { maxConcurrentGlobal: 1 }); const executor = value.executor as DeferredExecutor; await value.service.request({ owner: "codex-sol", objective: "First", trigger: "signal one", signal: "AGENT_DECISION", evidenceRefs: value.evidence }); await value.service.request({ owner: "claude-sonnet", objective: "Second", trigger: "signal two", signal: "AGENT_DECISION", evidenceRefs: value.evidence }); await eventually(() => executor.inputs.length === 1); expect((await value.service.list()).filter((job) => job.status === "RUNNING")).toHaveLength(1); expect((await value.service.list()).filter((job) => job.status === "QUEUED")).toHaveLength(1); executor.resolve({ providerSessionId: "first-background" }); await eventually(() => executor.inputs.length === 2); expect(executor.inputs[1].owner).toBe("claude-sonnet");
  });
  it("fails closed on provider-session collision, budget exhaustion, emergency stop, and policy revision", async () => {
    const first = await fixture(); const firstExecutor = first.executor as DeferredExecutor; await first.rooms.setSession("codex-sol", "shared", "read-only"); await first.service.request({ owner: "codex-sol", objective: "Check", trigger: "signal", signal: "AGENT_DECISION", evidenceRefs: first.evidence }); await eventually(() => firstExecutor.inputs.length === 1); firstExecutor.resolve({ providerSessionId: "shared" }); await eventually(async () => (await first.service.list())[0]?.status === "FAILED"); expect(await first.service.inbox("codex-sol")).toEqual([]);
    const second = await fixture(); const secondExecutor = second.executor as DeferredExecutor; await second.service.request({ owner: "codex-sol", objective: "Check", trigger: "signal", signal: "AGENT_DECISION", evidenceRefs: second.evidence, budget: { tokenLimit: 1 } }); await eventually(() => secondExecutor.inputs.length === 1); secondExecutor.resolve({ usage: { tokens: 2, toolCalls: 0 } }); await eventually(async () => (await second.service.list())[0]?.status === "FAILED");
    let stopped = false; const third = await fixture(new DeferredExecutor(), { stopped: () => stopped }); const thirdExecutor = third.executor as DeferredExecutor; await third.service.request({ owner: "codex-sol", objective: "Check", trigger: "signal", signal: "AGENT_DECISION", evidenceRefs: third.evidence }); await eventually(() => thirdExecutor.inputs.length === 1); stopped = true; await third.service.cancelAll("Emergency stop is active."); expect((await third.service.list())[0]?.status).toBe("CANCELLED");
    const fourth = await fixture(); const fourthExecutor = fourth.executor as DeferredExecutor; await fourth.service.request({ owner: "codex-sol", objective: "Check", trigger: "signal", signal: "AGENT_DECISION", evidenceRefs: fourth.evidence }); await eventually(() => fourthExecutor.inputs.length === 1); const policy = (await fourth.service.policy())!; await fourth.service.updatePolicy(policy.revision, true, "new authority epoch"); expect((await fourth.service.list())[0]?.status).toBe("CANCELLED");
  });
  it("persists tool-boundary checkpoints and reconciles restart without claiming an orphan is running", async () => {
    const value = await fixture(); const executor = value.executor as DeferredExecutor; await value.service.request({ owner: "codex-sol", objective: "Check", trigger: "signal", signal: "AGENT_DECISION", evidenceRefs: value.evidence }); await eventually(() => executor.inputs.length === 1); await executor.inputs[0].progress("WAITING_TOOL", "Reading local tests", { summary: "Inspected parser", opaqueState: "next:test-file" }); expect((await value.service.list())[0]).toMatchObject({ status: "WAITING_TOOL", checkpoint: { summary: "Inspected parser" } });
    const reopenedStore = await InvestigationStore.open(value.stateDirectory); const restarted = new InvestigationService(reopenedStore, value.rooms, new DeferredExecutor()); services.push(restarted); await restarted.initialize(); expect((await restarted.list())[0]).toMatchObject({ status: "CHECKPOINTED", blocker: expect.stringContaining("Ready to resume") }); await restarted.resume((await restarted.list())[0].investigationId); await eventually(() => restarted.activeCount() === 1);
  });
  it("archives expired inbox results and clears the durable waiting disposition", async () => {
    let clock = new Date("2026-08-25T00:00:00.000Z"); const value = await fixture(new DeferredExecutor(), { now: () => clock }); const executor = value.executor as DeferredExecutor; await value.service.request({ owner: "codex-sol", objective: "Retention", trigger: "signal", signal: "AGENT_DECISION", evidenceRefs: value.evidence }); await eventually(() => executor.inputs.length === 1); executor.resolve(); await eventually(async () => (await value.service.list())[0]?.status === "COMPLETED"); clock = new Date("2026-09-02T00:00:00.000Z"); expect(await value.service.inbox("codex-sol")).toMatchObject([{ status: "ARCHIVED" }]); expect((await value.service.list())[0]).toMatchObject({ status: "ARCHIVED", resultWaiting: false });
  });
  it("rejects forged durable checkpoints and audit chains on reopen", async () => {
    const value = await fixture(); const executor = value.executor as DeferredExecutor; await value.service.request({ owner: "codex-sol", objective: "Check", trigger: "signal", signal: "AGENT_DECISION", evidenceRefs: value.evidence }); await eventually(() => executor.inputs.length === 1); await executor.inputs[0].progress("WAITING_TOOL", "tool", { summary: "checkpoint", opaqueState: "safe" }); const file = path.join(value.stateDirectory, "investigations.json"); const state = JSON.parse(await readFile(file, "utf8")); state.jobs[Object.keys(state.jobs)[0]].checkpoint.opaqueState = "forged"; await writeFile(file, JSON.stringify(state)); await expect(InvestigationStore.open(value.stateDirectory)).rejects.toThrow(/checkpoint|investigation/i);
  });
});
