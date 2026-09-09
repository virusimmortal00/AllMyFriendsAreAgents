import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RoomStore } from "./room-store.js";
import { SqliteRoomRepository } from "./storage/sqlite-room-repository.js";
import { makeInvestigationEvent } from "./investigation-record.js";
import { projectInvestigation } from "./investigation-api.js";
import { InvestigationStore } from "./investigation-store.js";
import { InvestigationService, type InvestigationExecutorInput, type InvestigationExecutorResult } from "./investigation-service.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function executor() {
  const inputs: InvestigationExecutorInput[] = [];
  let finish: (result: InvestigationExecutorResult) => void = () => { throw new Error("No dispatch"); };
  return {
    inputs,
    dispatch(input: InvestigationExecutorInput) {
      inputs.push(input);
      return new Promise<InvestigationExecutorResult>((resolve, reject) => {
        finish = resolve;
        input.signal.addEventListener("abort", () => reject(new Error("Stopped")), { once: true });
      });
    },
    finish() { finish({ providerSessionId: randomUUID(), summary: "Checked the bounded evidence.", usage: { tokens: 1, toolCalls: 1 } }); },
  };
}
async function fixture(backend: "json" | "sqlite") {
  const root = await mkdtemp(path.join(os.tmpdir(), "amfaa-investigation-recovery-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const openRooms = (name: string) => backend === "json" ? RoomStore.open(root, path.join(root, name)) : SqliteRoomRepository.open(root, path.join(root, `${name}.sqlite`));
  const open = async (name = "room") => {
    const rooms = await openRooms(name);
    const work = await InvestigationStore.open(path.join(root, "work"));
    const worker = executor();
    const service = new InvestigationService(work, rooms, worker, { configuredEnabled: true });
    let stopped = false;
    const stop = async () => {
      if (stopped) return;
      stopped = true;
      await service.shutdown();
      await expect.poll(() => service.activeCount()).toBe(0);
      if (rooms instanceof SqliteRoomRepository) rooms.close();
    };
    cleanups.push(stop);
    await service.initialize();
    return { rooms, work, worker, service, stop };
  };
  return { root, open };
}

describe.each(["json", "sqlite"] as const)("investigation durable recovery (%s)", (backend) => {
  it("reopens both repositories, resumes a checkpoint once, and delivers one inbox result", async () => {
    const f = await fixture(backend);
    const first = await f.open();
    const requested = await first.service.request({ owner: "codex-sol", objective: "Review local evidence", trigger: "Explicit review", signal: "AUTHENTICATED_HUMAN" });
    expect(requested.kind).toBe("ok");
    if (requested.kind === "ok") expect(projectInvestigation(requested.value)).not.toHaveProperty("admission");
    await expect.poll(() => first.worker.inputs.length).toBe(1);
    const input = first.worker.inputs[0];
    expect(await input.progress("WAITING_TOOL", "Reading", { summary: "Partial evidence", opaqueState: "next:fixture" })).toBe(true);
    await first.stop();
    const second = await f.open();
    const checkpoint = (await second.service.list())[0];
    expect(checkpoint).toMatchObject({ status: "CHECKPOINTED", checkpoint: { summary: "Partial evidence" } });
    expect(second.worker.inputs).toHaveLength(0);
    const results = await Promise.all([second.service.resume(checkpoint.investigationId), second.service.resume(checkpoint.investigationId)]);
    expect(results.filter((result) => result.kind === "ok")).toHaveLength(1);
    await expect.poll(() => second.worker.inputs.length).toBe(1);
    expect(second.worker.inputs[0]).toMatchObject({ attempt: 2, checkpoint: { summary: "Partial evidence" } });
    expect(await input.progress("RUNNING")).toBe(false);
    second.worker.finish();
    await expect.poll(async () => (await second.service.list())[0].status).toBe("COMPLETED");
    await second.stop();
    const third = await f.open();
    expect(await third.service.inbox("codex-sol")).toHaveLength(1);
    expect(third.worker.inputs).toHaveLength(0);
  });
  it.each(["room", "policy", "legacy"] as const)("retains evidence but refuses recovery after %s authority changes", async (change) => {
    const f = await fixture(backend);
    const first = await f.open();
    await first.service.request({ owner: "codex-sol", objective: "Review", trigger: "Explicit review", signal: "AUTHENTICATED_HUMAN" });
    await expect.poll(() => first.worker.inputs.length).toBe(1);
    await first.worker.inputs[0].progress("WAITING_TOOL", "Reading", { summary: "Retained checkpoint", opaqueState: "next:fixture" });
    await first.stop();
    const record = (await first.work.list())[0];
    if (change === "policy") {
      const policy = (await first.work.policy())!;
      await first.work.setPolicy(policy.revision, { ...policy, revision: policy.revision + 1 });
    }
    if (change === "legacy") {
      const { admission: _admission, ...legacy } = record;
      const next = { ...legacy, revision: record.revision + 1 };
      const event = makeInvestigationEvent(next, (await first.work.audit(record.investigationId)).at(-1), "LEGACY_FIXTURE", record.status, "Legacy record without admission", randomUUID());
      expect(await first.work.compareAndSet(record.revision, next, event)).toBe(true);
    }
    const second = await f.open(change === "room" ? "another-room" : "room");
    const recovered = (await second.service.list())[0];
    expect(recovered).toMatchObject({ status: "CANCELLED", checkpoint: { summary: "Retained checkpoint" } });
    expect(recovered.blocker).toContain(change === "room" ? "room-scope-changed" : change === "legacy" ? "admission-missing" : "authority epoch changed");
    expect((await second.service.resume(record.investigationId)).kind).not.toBe("ok");
    expect(second.worker.inputs).toHaveLength(0);
  });

  it("does not treat a current-boot grant as permission to ignore a durable reconciliation denial", async () => {
    const f = await fixture(backend);
    const first = await f.open();
    const requested = await first.service.request({ owner: "codex-sol", objective: "Review", trigger: "Explicit review", signal: "AUTHENTICATED_HUMAN" });
    expect(requested.kind).toBe("ok");
    await expect.poll(() => first.worker.inputs.length).toBe(1);
    await first.worker.inputs[0].progress("WAITING_TOOL", "Reading", { summary: "Checkpoint", opaqueState: "next:fixture" });
    if (first.rooms instanceof SqliteRoomRepository) {
      const scope = (await first.rooms.getStorageScope(first.rooms.roomId))!;
      const now = new Date().toISOString();
      await first.rooms.putSourceWorkBinding({ schemaVersion: 1, kind: "investigation", workId: first.worker.inputs[0].investigationId,
        roomId: scope.roomId, projectId: scope.projectId, repositoryReferenceId: null, repositoryReferenceRevision: null,
        originTaskId: null, originTaskRevision: null, implementationJobId: null, implementationWorkerId: null,
        state: "needs-reconciliation", reasonCode: "operator-review-required", evidence: {}, revision: 1, createdAt: now, updatedAt: now });
      expect(await first.worker.inputs[0].progress("RUNNING")).toBe(false);
      expect((await first.service.list())[0].blocker).toContain("operator-review-required");
    } else {
      // A room path change invalidates a read-only admission even if legacy boot
      // authority was granted for the same work identity.
      first.rooms.authorizeSourceWorkForCurrentBoot("investigation", first.worker.inputs[0].investigationId);
      await first.rooms.updateSettings({ projectPath: path.join(f.root, "changed-project") });
      expect(await first.worker.inputs[0].progress("RUNNING")).toBe(false);
      expect((await first.service.list())[0].status).toBe("CANCELLED");
    }
  });

});
