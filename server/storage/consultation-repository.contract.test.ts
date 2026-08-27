import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ConsultationAffinity, ConsultationFinalArtifact, ConsultationProvenance } from "../../shared/consultation-domain.js";
import type { ConsultationRepository } from "./consultation-repository.js";
import { consultationRequestDigest } from "./consultation-repository.js";
import { JsonConsultationRepository } from "./json-consultation-repository.js";
import { SqliteConsultationRepository } from "./sqlite-consultation-repository.js";

type Fixture = { repository: ConsultationRepository; reopen(): Promise<ConsultationRepository>; close(): void };
const roots: string[] = [];
const factories: ReadonlyArray<readonly [string, (root: string) => Promise<Fixture>]> = [
  ["JSON", async (root) => { const file = path.join(root, "consultations.json"); let repository: ConsultationRepository = await JsonConsultationRepository.open(file); return { get repository() { return repository; }, async reopen() { repository = await JsonConsultationRepository.open(file); return repository; }, close() {} }; }],
  ["SQLite", async (root) => { const file = path.join(root, "consultations.sqlite"); let repository: ConsultationRepository = await SqliteConsultationRepository.open(file); return { get repository() { return repository; }, async reopen() { (repository as SqliteConsultationRepository).close(); repository = await SqliteConsultationRepository.open(file); return repository; }, close() { (repository as SqliteConsultationRepository).close(); } }; }],
];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));
const provenance = (at = "2026-08-27T12:00:00.000Z"): ConsultationProvenance => ({ kind: "human", actorId: "human-1", sourceId: "message-1", recordedAt: at });
const create = (roomId: string, consultationId: string, idempotencyKey = "idem-1", topic = "Review release strategy") => ({ roomId, consultationId, idempotencyKey, request: { topic, context: { priority: "safe", nested: { a: 1, b: 2 } } } as const, provenance: provenance(), now: "2026-08-27T12:00:00.000Z" });

describe.each(factories)("%s consultation repository contract", (_backend, makeFixture) => {
  it("replays exact requests and rejects conflicting idempotency reuse", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "amfaa-consult-")); roots.push(root); const fixture = await makeFixture(root);
    try {
      const first = await fixture.repository.createConsultation(create("room-a", "consult-a"));
      expect(first).toMatchObject({ kind: "created", consultation: { state: "queued", revision: 1, roomId: "room-a", requestDigest: consultationRequestDigest(create("room-a", "consult-a").request) } });
      expect(await fixture.repository.createConsultation(create("room-a", "consult-a"))).toEqual({ kind: "replayed", consultation: first.kind === "created" ? first.consultation : undefined });
      expect(await fixture.repository.createConsultation(create("room-a", "consult-b", "idem-1", "Different request"))).toEqual({ kind: "idempotency_conflict", roomId: "room-a", idempotencyKey: "idem-1" });
      expect(await fixture.repository.getConsultation({ roomId: "room-a", consultationId: "consult-a" })).toMatchObject({ request: { topic: "Review release strategy" }, idempotencyKey: "idem-1" });
    } finally { fixture.close(); }
  });

  it("preserves affinities, temporary duties, provenance, active and terminal projections across restart", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "amfaa-consult-")); roots.push(root); const fixture = await makeFixture(root);
    try {
      const affinity: ConsultationAffinity = { roomId: "room-a", participantId: "agent-sol", duties: ["challenger", "scribe"], provenance: provenance(), createdAt: "2026-08-27T11:00:00.000Z", updatedAt: "2026-08-27T11:00:00.000Z" };
      await fixture.repository.putConsultationAffinity(affinity);
      await fixture.repository.createConsultation(create("room-a", "active", "active-key"));
      await fixture.repository.createConsultation(create("room-a", "terminal", "terminal-key"));
      expect(await fixture.repository.applyConsultationChange({ roomId: "room-a", consultationId: "active" }, 1, { kind: "assign_duty", participantId: "agent-sol", duty: "facilitator", provenance: { kind: "system", actorId: "scheduler", sourceId: "affinity:agent-sol", recordedAt: "2026-08-27T12:01:00.000Z" } }, "scheduler", "2026-08-27T12:01:00.000Z")).toMatchObject({ kind: "accepted", consultation: { revision: 2 } });
      const discussing = await fixture.repository.applyConsultationChange({ roomId: "room-a", consultationId: "terminal" }, 1, { kind: "transition", to: "discussing", reason: "participants joined" }, "agent-sol", "2026-08-27T12:01:00.000Z");
      expect(discussing.kind).toBe("accepted");
      const artifact: ConsultationFinalArtifact = { schemaVersion: 1, synthesis: "Canary release", recommendations: ["Deploy to 5%"], evidence: [{ id: "test", uri: "ci:123", summary: "Contract suite passed" }], blockers: [], dissent: [{ participantId: "agent-luna", position: "Prefer 1%" }], provenance: [provenance()], completedAt: "2026-08-27T12:02:00.000Z", completedBy: "agent-sol" };
      expect(await fixture.repository.applyConsultationChange({ roomId: "room-a", consultationId: "terminal" }, 2, { kind: "transition", to: "complete", reason: "artifact recorded", finalArtifact: artifact }, "agent-sol", artifact.completedAt)).toMatchObject({ kind: "accepted", consultation: { state: "complete", finalArtifact: artifact } });
      const reopened = await fixture.reopen();
      expect(await reopened.getConsultation({ roomId: "room-a", consultationId: "active" })).toMatchObject({ roomId: "room-a", state: "queued", revision: 2, affinitySnapshot: [affinity], duties: [{ duty: "facilitator", provenance: { sourceId: "affinity:agent-sol" } }] });
      expect(await reopened.getConsultation({ roomId: "room-a", consultationId: "terminal" })).toMatchObject({ roomId: "room-a", state: "complete", revision: 3, finalArtifact: artifact });
      expect((await reopened.listConsultationEvents({ roomId: "room-a", consultationId: "terminal" })).map(({ revision }) => revision)).toEqual([1, 2, 3]);
      expect(await reopened.listConsultationAffinities("room-a")).toEqual([affinity]);
    } finally { fixture.close(); }
  });

  it("isolates identical IDs, idempotency keys, affinity indexes, lists, and event lookup by room", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "amfaa-consult-")); roots.push(root); const fixture = await makeFixture(root);
    try {
      await fixture.repository.putConsultationAffinity({ roomId: "room-a", participantId: "shared-agent", duties: ["scribe"], provenance: provenance(), createdAt: "2026-08-27T11:00:00.000Z", updatedAt: "2026-08-27T11:00:00.000Z" });
      await fixture.repository.putConsultationAffinity({ roomId: "room-b", participantId: "shared-agent", duties: ["challenger"], provenance: provenance(), createdAt: "2026-08-27T11:00:00.000Z", updatedAt: "2026-08-27T11:00:00.000Z" });
      await fixture.repository.createConsultation(create("room-a", "same-id", "same-key", "Room A request"));
      await fixture.repository.createConsultation(create("room-b", "same-id", "same-key", "Room B request"));
      await fixture.repository.applyConsultationChange({ roomId: "room-a", consultationId: "same-id" }, 1, { kind: "transition", to: "cancelled", reason: "room A cancelled" }, "human-1", "2026-08-27T12:01:00.000Z");
      expect(await fixture.repository.getConsultation({ roomId: "room-a", consultationId: "same-id" })).toMatchObject({ state: "cancelled", request: { topic: "Room A request" } });
      expect(await fixture.repository.getConsultation({ roomId: "room-b", consultationId: "same-id" })).toMatchObject({ state: "queued", request: { topic: "Room B request" } });
      expect((await fixture.repository.listConsultations({ roomId: "room-a" })).items).toHaveLength(1);
      expect((await fixture.repository.listConsultationEvents({ roomId: "room-b", consultationId: "same-id" })).map(({ revision }) => revision)).toEqual([1]);
      expect(await fixture.repository.listConsultationAffinities("room-a")).toMatchObject([{ roomId: "room-a", duties: ["scribe"] }]);
      expect(await fixture.repository.listConsultationAffinities("room-b")).toMatchObject([{ roomId: "room-b", duties: ["challenger"] }]);
      expect(await fixture.repository.getConsultation({ roomId: "room-c", consultationId: "same-id" })).toBeUndefined();
    } finally { fixture.close(); }
  });
});
