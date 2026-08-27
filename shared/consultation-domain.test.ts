import { describe, expect, it } from "vitest";
import { applyConsultationChange, createConsultation, type ConsultationFinalArtifact } from "./consultation-domain.js";

const provenance = { kind: "human" as const, actorId: "human-1", recordedAt: "2026-08-27T10:00:00.000Z" };
const initial = () => createConsultation({ roomId: "room:opaque/a", consultationId: "consult:opaque/a", idempotencyKey: "request-1", requestDigest: `sha256:${"a".repeat(64)}`, request: { topic: "Choose a release strategy" }, provenance, now: provenance.recordedAt });

describe("consultation lifecycle", () => {
  it("requires bounded idempotency and participant inputs", () => {
    expect(() => createConsultation({ roomId: "room", consultationId: "consult", idempotencyKey: "x".repeat(129), requestDigest: `sha256:${"a".repeat(64)}`, request: { topic: "Topic" }, provenance, now: provenance.recordedAt })).toThrow(/128 bytes/);
    expect(() => createConsultation({ roomId: "room", consultationId: "consult", idempotencyKey: "key", requestDigest: `sha256:${"a".repeat(64)}`, request: { topic: "Topic", requestedParticipantIds: Array.from({ length: 33 }, (_, index) => `agent-${index}`) }, provenance, now: provenance.recordedAt })).toThrow(/at most 32/);
  });

  it("accepts the complete lifecycle and records revisioned timestamps and reasons", () => {
    let consultation = initial();
    const discussing = applyConsultationChange(consultation, 1, { kind: "transition", to: "discussing", reason: "panel assembled" }, "facilitator", "2026-08-27T10:01:00.000Z");
    expect(discussing.kind).toBe("accepted"); if (discussing.kind !== "accepted") return; consultation = discussing.consultation;
    const input = applyConsultationChange(consultation, 2, { kind: "transition", to: "input_required", reason: "need deployment window" }, "facilitator", "2026-08-27T10:02:00.000Z");
    expect(input.kind).toBe("accepted"); if (input.kind !== "accepted") return; consultation = input.consultation;
    const resumed = applyConsultationChange(consultation, 3, { kind: "transition", to: "discussing", reason: "window supplied" }, "human-1", "2026-08-27T10:03:00.000Z");
    expect(resumed.kind).toBe("accepted"); if (resumed.kind !== "accepted") return; consultation = resumed.consultation;
    const artifact: ConsultationFinalArtifact = { schemaVersion: 1, synthesis: "Ship gradually.", recommendations: ["Canary first"], evidence: [{ id: "ev-1", uri: "commit:abc", summary: "Canary coverage" }], blockers: [], dissent: [{ participantId: "challenger", position: "Delay one day" }], provenance: [provenance], completedAt: "2026-08-27T10:04:00.000Z", completedBy: "scribe" };
    const complete = applyConsultationChange(consultation, 4, { kind: "transition", to: "complete", reason: "synthesis approved", finalArtifact: artifact }, "scribe", artifact.completedAt);
    expect(complete).toMatchObject({ kind: "accepted", consultation: { revision: 5, state: "complete", finalArtifact: artifact } });
    if (complete.kind === "accepted") expect(complete.consultation.transitions).toEqual([
      expect.objectContaining({ revision: 1, from: null, to: "queued", reason: "created" }),
      expect.objectContaining({ revision: 2, from: "queued", to: "discussing", at: "2026-08-27T10:01:00.000Z", reason: "panel assembled" }),
      expect.objectContaining({ revision: 3, from: "discussing", to: "input_required", reason: "need deployment window" }),
      expect.objectContaining({ revision: 4, from: "input_required", to: "discussing", reason: "window supplied" }),
      expect.objectContaining({ revision: 5, from: "discussing", to: "complete", reason: "synthesis approved" }),
    ]);
  });

  it("rejects invalid, stale, incomplete, and terminal transitions", () => {
    const consultation = initial();
    expect(applyConsultationChange(consultation, 1, { kind: "transition", to: "complete", reason: "too soon" }, "actor", "now")).toMatchObject({ kind: "rejected" });
    expect(applyConsultationChange(consultation, 0, { kind: "transition", to: "discussing", reason: "stale" }, "actor", "now")).toEqual({ kind: "conflict", expectedRevision: 0, actualRevision: 1 });
    const failed = applyConsultationChange(consultation, 1, { kind: "transition", to: "failed", reason: "provider unavailable" }, "actor", "2026-08-27T10:01:00.000Z");
    expect(failed.kind).toBe("accepted");
    if (failed.kind === "accepted") expect(applyConsultationChange(failed.consultation, 2, { kind: "transition", to: "cancelled", reason: "late" }, "actor", "later")).toMatchObject({ kind: "rejected" });
  });

  it("tracks temporary duties and their provenance without replacing history", () => {
    let consultation = initial();
    for (const [index, duty] of (["facilitator", "contributor", "challenger", "scribe"] as const).entries()) {
      const assigned = applyConsultationChange(consultation, consultation.revision, { kind: "assign_duty", participantId: `agent-${duty}`, duty, provenance: { kind: "system", actorId: "scheduler", sourceId: `policy:${index + 1}`, recordedAt: `2026-08-27T10:0${index + 1}:00.000Z` } }, "scheduler", `2026-08-27T10:0${index + 1}:00.000Z`);
      expect(assigned.kind).toBe("accepted"); if (assigned.kind !== "accepted") return; consultation = assigned.consultation;
    }
    expect(consultation.duties).toMatchObject([
      { duty: "facilitator", releasedAt: null }, { duty: "contributor", releasedAt: null },
      { participantId: "agent-challenger", duty: "challenger", provenance: { sourceId: "policy:3" } }, { duty: "scribe", releasedAt: null },
    ]);
    const released = applyConsultationChange(consultation, 5, { kind: "release_duty", participantId: "agent-challenger", duty: "challenger", reason: "challenge recorded" }, "facilitator", "2026-08-27T10:05:00.000Z");
    expect(released.kind).toBe("accepted");
    if (released.kind === "accepted") expect(released.consultation.duties.find(({ duty }) => duty === "challenger")).toMatchObject({ releasedAt: "2026-08-27T10:05:00.000Z", releaseReason: "challenge recorded" });
  });
});
