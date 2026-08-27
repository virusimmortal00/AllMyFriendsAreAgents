import { describe, expect, it } from "vitest";
import { createConsultation } from "../../shared/consultation-domain.js";
import { normalizeJsonConsultationState, normalizeStoredConsultation, validateAffinity } from "./consultation-storage.js";

const provenance = { kind: "human" as const, actorId: "human-1", recordedAt: "2026-08-27T00:00:00.000Z" };
const consultation = () => createConsultation({
  roomId: "room-a", consultationId: "consult-a", idempotencyKey: "key", idempotencyScope: "human-1",
  requestDigest: `sha256:${"a".repeat(64)}`, request: { topic: "Validate stored data" }, provenance, now: provenance.recordedAt,
});

describe("consultation storage validation", () => {
  it("rejects unknown storage and consultation schema versions", () => {
    expect(() => normalizeJsonConsultationState({ schemaVersion: 2, consultations: {}, events: [], affinities: {} })).toThrow(/Unsupported consultation storage schema version 2/);
    expect(() => normalizeStoredConsultation({ ...consultation(), schemaVersion: 2 } as never)).toThrow(/Unsupported stored consultation schema version 2/);
  });

  it("rejects unknown affinity duties and empty persisted execution participants", () => {
    expect(() => validateAffinity({ roomId: "room-a", participantId: "agent-a", duties: ["oracle"], provenance, createdAt: provenance.recordedAt, updatedAt: provenance.recordedAt } as never)).toThrow(/unknown duty/);
    expect(() => normalizeStoredConsultation({ ...consultation(), execution: { dialogueEnabled: true, limits: { participantLimit: 1, turnLimit: 1, roundLimit: 1, concurrencyLimit: 1, timeLimitMs: 1 }, participantIds: [""], turns: [], inputs: [], blockingQuestion: null, synthesisKey: "key", synthesisStarted: false, providerOperations: [] } })).toThrow(/empty participant ID/);
  });

  it("rejects malformed stored collections with domain errors", () => {
    expect(() => normalizeStoredConsultation({ ...consultation(), affinitySnapshot: null } as never)).toThrow(/required collections/);
    expect(() => normalizeStoredConsultation({ ...consultation(), duties: {} } as never)).toThrow(/required collections/);
    expect(() => normalizeStoredConsultation({ ...consultation(), provenance: "invalid" } as never)).toThrow(/required collections/);
    expect(() => normalizeStoredConsultation({ ...consultation(), affinitySnapshot: [{ roomId: "room-a", participantId: "agent-a", duties: null, provenance, createdAt: provenance.recordedAt, updatedAt: provenance.recordedAt }] } as never)).toThrow(/affinity duties/);
    expect(() => normalizeStoredConsultation({ ...consultation(), execution: { dialogueEnabled: true, limits: { participantLimit: 1, turnLimit: 1, roundLimit: 1, concurrencyLimit: 1, timeLimitMs: 1 }, participantIds: null, turns: [], inputs: [], blockingQuestion: null, synthesisKey: "key", synthesisStarted: false, providerOperations: [] } } as never)).toThrow(/execution is missing required collections/);
    expect(() => normalizeStoredConsultation({ ...consultation(), execution: { dialogueEnabled: true, limits: { participantLimit: 1, turnLimit: 1, roundLimit: 1, concurrencyLimit: 1, timeLimitMs: 1 }, participantIds: ["agent-a"], turns: null, inputs: [], blockingQuestion: null, synthesisKey: "key", synthesisStarted: false, providerOperations: [] } } as never)).toThrow(/execution is missing required collections/);
  });
});
