import type { DatabaseSync } from "node:sqlite";
import type { Improvement } from "../../shared/improvement-domain.js";
import type { ImprovementStatusContract } from "../../shared/improvement-status.js";

export const WAVE_ONE_IMPROVEMENT_IDS = [
  "autonomous-improvement-foundation",
  "reconnect-ux",
  "source-control-adapter",
] as const;

export const DEFERRED_WORKSPACE_FEATURE_IDS = [
  "interleaved-roster-badges",
  "transcript-badge-choice",
  "private-shared-workspaces",
] as const;

export type WaveOneImprovementId = (typeof WAVE_ONE_IMPROVEMENT_IDS)[number];
export type DeferredWorkspaceFeatureId = (typeof DEFERRED_WORKSPACE_FEATURE_IDS)[number];

const SEED_ACTOR = "developer-team";
const SEED_AT = "2026-08-21T00:00:00.000Z";

interface WaveOneSeed {
  readonly id: WaveOneImprovementId;
  readonly claim: string;
  readonly milestone: string;
  readonly nextAction: string;
}

interface DeferredSeed {
  readonly id: DeferredWorkspaceFeatureId;
  readonly claim: string;
}

const WAVE_ONE_SEEDS: readonly WaveOneSeed[] = [
  {
    id: "autonomous-improvement-foundation",
    claim: "Establish the revision-preserving autonomous Improvements foundation.",
    milestone: "Revision-preserving Improvements ledger is independently accepted.",
    nextAction: "Obtain independent acceptance of the Improvements foundation.",
  },
  {
    id: "reconnect-ux",
    claim: "Preserve the room experience through service interruption and reconnect.",
    milestone: "Reconnect behavior receives independent acceptance.",
    nextAction: "Run independent reconnect acceptance.",
  },
  {
    id: "source-control-adapter",
    claim: "Add a bounded source-control adapter for autonomous improvement work.",
    milestone: "Source-control adapter is implemented and independently accepted.",
    nextAction: "Implement and independently accept the source-control adapter.",
  },
];

const DEFERRED_SEEDS: readonly DeferredSeed[] = [
  { id: "interleaved-roster-badges", claim: "Deferred interleaved roster badges; explicitly outside Wave 1." },
  { id: "transcript-badge-choice", claim: "Deferred transcript-badge choice; explicitly outside Wave 1." },
  { id: "private-shared-workspaces", claim: "Deferred private/shared workspaces; explicitly outside Wave 1." },
];

const REPORTED_EVIDENCE = [
  {
    id: "developer-team-reported-suite-208-of-208",
    kind: "TEST_SUITE",
    uri: "developer-team://verification/test-suite-208-of-208",
    summary: "Developer Team reported the complete 208/208 test suite passing.",
  },
  {
    id: "developer-team-reported-build",
    kind: "BUILD",
    uri: "developer-team://verification/build",
    summary: "Developer Team reported the production build passing.",
  },
] as const;

function seedStatus(nextAction: string): ImprovementStatusContract {
  return {
    schemaVersion: 1,
    implementation: { state: "UNKNOWN" },
    deployment: { state: "UNKNOWN" },
    developerTeamEvidence: {
      state: "AVAILABLE",
      evidence: REPORTED_EVIDENCE.map(({ id, uri }) => ({ id, uri })),
    },
    independentAcceptance: { state: "PENDING" },
    upstreamPublication: { state: "UNPUBLISHED" },
    nextAction: { state: "ACTION_REQUIRED", action: nextAction },
  };
}

function seedProjection(seed: WaveOneSeed): Improvement {
  const statusContract = seedStatus(seed.nextAction);
  return {
    id: seed.id,
    revision: 1,
    state: "PROPOSED",
    risk: "LOW",
    authorId: SEED_ACTOR,
    technicalConsensus: { status: "PENDING", reviews: [] },
    actionAuthority: {
      status: "PENDING",
      grantedBy: null,
      grantedByHuman: false,
      improvementRevision: null,
      allowedActions: [],
    },
    claims: [{ id: `${seed.id}-scope`, statement: seed.claim }],
    workClaim: {
      fencingToken: 0,
      holderMemberId: null,
      leaseExpiresAt: null,
      status: "UNCLAIMED",
      manifests: [],
      history: [],
    },
    evidence: REPORTED_EVIDENCE.map((evidence) => ({
      id: evidence.id,
      uri: evidence.uri,
      description: evidence.summary,
      addedBy: SEED_ACTOR,
      addedAt: SEED_AT,
    })),
    attribution: [{ actorId: SEED_ACTOR, at: SEED_AT, change: "SEED_WAVE_1", revision: 1 }],
    statusContract,
    createdAt: SEED_AT,
    updatedAt: SEED_AT,
  };
}

function deferredProjection(seed: DeferredSeed): Improvement {
  const statusContract: ImprovementStatusContract = {
    schemaVersion: 1,
    implementation: { state: "UNKNOWN" },
    deployment: { state: "UNKNOWN" },
    developerTeamEvidence: { state: "UNKNOWN" },
    independentAcceptance: { state: "PENDING" },
    upstreamPublication: { state: "UNPUBLISHED" },
    nextAction: { state: "BLOCKED", blocker: "Deferred and explicitly outside Wave 1." },
  };
  return {
    id: seed.id, revision: 1, state: "CANCELED", risk: "LOW", authorId: SEED_ACTOR,
    technicalConsensus: { status: "PENDING", reviews: [] },
    actionAuthority: { status: "PENDING", grantedBy: null, grantedByHuman: false, improvementRevision: null, allowedActions: [] },
    claims: [{ id: `${seed.id}-scope`, statement: seed.claim }],
    workClaim: { fencingToken: 0, holderMemberId: null, leaseExpiresAt: null, status: "UNCLAIMED", manifests: [], history: [] },
    evidence: [],
    attribution: [{ actorId: SEED_ACTOR, at: SEED_AT, change: "DEFERRED_OUTSIDE_WAVE_1", revision: 1 }],
    statusContract, createdAt: SEED_AT, updatedAt: SEED_AT,
  };
}

/**
 * Adds only absent Wave 1 items. An existing canonical ID is left wholly
 * untouched, including all later revisions and user-authored child records.
 */
export function seedWaveOneImprovements(database: DatabaseSync, roomId: string) {
  const created: WaveOneImprovementId[] = [];
  const skipped: WaveOneImprovementId[] = [];
  database.exec("BEGIN IMMEDIATE");
  try {
    for (const seed of WAVE_ONE_SEEDS) {
      const exists = database.prepare(
        "SELECT 1 FROM canonical_improvements WHERE room_id = ? AND id = ?",
      ).get(roomId, seed.id);
      if (exists) {
        skipped.push(seed.id);
        continue;
      }

      const projection = seedProjection(seed);
      const projectionJson = JSON.stringify(projection);
      const statusJson = JSON.stringify(projection.statusContract);
      database.prepare(`
        INSERT INTO canonical_improvements(
          room_id, id, revision, state, risk, author_id, created_at, updated_at,
          projection_json, status_contract_json
        ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        roomId, projection.id, projection.state, projection.risk, projection.authorId,
        projection.createdAt, projection.updatedAt, projectionJson, statusJson,
      );
      database.prepare(`
        INSERT INTO canonical_improvement_events(
          room_id, improvement_id, revision, actor_id, occurred_at, change_json, snapshot_json
        ) VALUES (?, ?, 1, ?, ?, ?, ?)
      `).run(roomId, projection.id, SEED_ACTOR, SEED_AT, JSON.stringify("SEED_WAVE_1"), projectionJson);
      database.prepare(`
        INSERT INTO canonical_improvement_revisions(
          room_id, improvement_id, revision, lifecycle_state, status_contract_json, snapshot_json, created_at
        ) VALUES (?, ?, 1, ?, ?, ?, ?)
      `).run(roomId, projection.id, projection.state, statusJson, projectionJson, SEED_AT);
      database.prepare(`
        INSERT INTO canonical_improvement_audit_history(
          room_id, improvement_id, event_id, revision, event_kind, actor_id, occurred_at, details_json
        ) VALUES (?, ?, 'seed-wave-1', 1, 'SEEDED', ?, ?, ?)
      `).run(roomId, projection.id, SEED_ACTOR, SEED_AT, JSON.stringify({ source: "wave-1" }));

      for (const evidence of REPORTED_EVIDENCE) {
        database.prepare(`
          INSERT INTO canonical_improvement_evidence(
            room_id, improvement_id, evidence_id, introduced_revision, qualification,
            evidence_kind, uri, summary, recorded_at
          ) VALUES (?, ?, ?, 1, 'DEVELOPER_TEAM', ?, ?, ?, ?)
        `).run(roomId, projection.id, evidence.id, evidence.kind, evidence.uri, evidence.summary, SEED_AT);
      }
      database.prepare(`
        INSERT INTO canonical_improvement_milestones(
          room_id, improvement_id, milestone_id, introduced_revision, state, summary, recorded_at
        ) VALUES (?, ?, 'wave-1-acceptance', 1, 'PENDING', ?, ?)
      `).run(roomId, projection.id, seed.milestone, SEED_AT);
      database.prepare(`
        INSERT INTO canonical_improvement_milestone_records(
          room_id, improvement_id, milestone_id, introduced_revision, state, summary, recorded_at
        ) VALUES (?, ?, 'wave-1-acceptance', 1, 'PENDING', ?, ?)
      `).run(roomId, projection.id, seed.milestone, SEED_AT);
      created.push(seed.id);
    }
    database.exec("COMMIT");
    return { created, skipped } as const;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

/** Adds only absent, explicitly deferred features; existing history is untouched. */
export function seedDeferredWorkspaceFeatures(database: DatabaseSync, roomId: string) {
  const created: DeferredWorkspaceFeatureId[] = [];
  const skipped: DeferredWorkspaceFeatureId[] = [];
  database.exec("BEGIN IMMEDIATE");
  try {
    for (const seed of DEFERRED_SEEDS) {
      if (database.prepare("SELECT 1 FROM canonical_improvements WHERE room_id = ? AND id = ?").get(roomId, seed.id)) {
        skipped.push(seed.id);
        continue;
      }
      const projection = deferredProjection(seed);
      const projectionJson = JSON.stringify(projection);
      const statusJson = JSON.stringify(projection.statusContract);
      database.prepare(`INSERT INTO canonical_improvements(room_id, id, revision, state, risk, author_id, created_at, updated_at, projection_json, status_contract_json) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`).run(roomId, projection.id, projection.state, projection.risk, projection.authorId, SEED_AT, SEED_AT, projectionJson, statusJson);
      database.prepare(`INSERT INTO canonical_improvement_events(room_id, improvement_id, revision, actor_id, occurred_at, change_json, snapshot_json) VALUES (?, ?, 1, ?, ?, ?, ?)`).run(roomId, seed.id, SEED_ACTOR, SEED_AT, JSON.stringify("DEFERRED_OUTSIDE_WAVE_1"), projectionJson);
      database.prepare(`INSERT INTO canonical_improvement_revisions(room_id, improvement_id, revision, lifecycle_state, status_contract_json, snapshot_json, created_at) VALUES (?, ?, 1, ?, ?, ?, ?)`).run(roomId, seed.id, projection.state, statusJson, projectionJson, SEED_AT);
      database.prepare(`INSERT INTO canonical_improvement_audit_history(room_id, improvement_id, event_id, revision, event_kind, actor_id, occurred_at, details_json) VALUES (?, ?, 'deferred-wave-1', 1, 'DEFERRED', ?, ?, ?)`).run(roomId, seed.id, SEED_ACTOR, SEED_AT, JSON.stringify({ source: "wave-1", deferred: true }));
      created.push(seed.id);
    }
    database.exec("COMMIT");
    return { created, skipped } as const;
  } catch (error) { database.exec("ROLLBACK"); throw error; }
}
