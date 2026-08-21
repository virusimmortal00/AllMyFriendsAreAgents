import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { DEFERRED_WORKSPACE_FEATURE_IDS, seedDeferredWorkspaceFeatures, seedWaveOneImprovements, WAVE_ONE_IMPROVEMENT_IDS } from "./improvement-ledger.js";
import { runSqliteMigrations } from "./sqlite-migrations.js";

const ROOM_ID = "room-ledger-test";

async function databaseWithRoom() {
  const database = new DatabaseSync(":memory:", { enableForeignKeyConstraints: true });
  await runSqliteMigrations(database);
  database.prepare(`
    INSERT INTO rooms(
      id, slug, name, topic, writable_agent, conversation_energy, project_path,
      participant_styles_json, status, created_at, updated_at
    ) VALUES (?, 'ledger', 'Ledger', 'Improvements', 'nobody', 'balanced', '/tmp', '{}', 'idle', ?, ?)
  `).run(ROOM_ID, "2026-08-21T00:00:00.000Z", "2026-08-21T00:00:00.000Z");
  return database;
}

function rows(database: DatabaseSync, table: string) {
  return database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
}

describe("Wave 1 Improvements ledger seed", () => {
  it("seeds exactly the three agreed items with immutable history and qualified evidence", async () => {
    const database = await databaseWithRoom();
    try {
      expect(seedWaveOneImprovements(database, ROOM_ID)).toEqual({
        created: WAVE_ONE_IMPROVEMENT_IDS,
        skipped: [],
      });
      const items = database.prepare(`
        SELECT id, revision, state, status_contract_json
        FROM canonical_improvements WHERE room_id = ? ORDER BY id
      `).all(ROOM_ID) as Array<{ id: string; revision: number; state: string; status_contract_json: string }>;
      expect(items.map(({ id }) => id)).toEqual([...WAVE_ONE_IMPROVEMENT_IDS].sort());
      expect(items.every(({ revision, state }) => revision === 1 && state === "PROPOSED")).toBe(true);
      for (const item of items) {
        const status = JSON.parse(item.status_contract_json);
        expect(Object.keys(status).sort()).toEqual([
          "deployment", "developerTeamEvidence", "implementation", "independentAcceptance",
          "nextAction", "schemaVersion", "upstreamPublication",
        ].sort());
        expect(status.developerTeamEvidence).toMatchObject({ state: "AVAILABLE" });
        expect(status.developerTeamEvidence.evidence).toHaveLength(2);
        expect(status.independentAcceptance).toEqual({ state: "PENDING" });
        expect(status.upstreamPublication).toEqual({ state: "UNPUBLISHED" });
      }
      expect(rows(database, "canonical_improvement_revisions")).toHaveLength(3);
      expect(rows(database, "canonical_improvement_audit_history")).toHaveLength(3);
      expect(rows(database, "canonical_improvement_milestones")).toHaveLength(3);
      const evidence = rows(database, "canonical_improvement_evidence") as Array<Record<string, unknown>>;
      expect(evidence).toHaveLength(6);
      expect(evidence.every(({ qualification }) => qualification === "DEVELOPER_TEAM")).toBe(true);
      expect(evidence.filter(({ evidence_kind }) => evidence_kind === "TEST_SUITE")).toHaveLength(3);
      expect(evidence.filter(({ evidence_kind }) => evidence_kind === "BUILD")).toHaveLength(3);

      expect(() => database.prepare(`
        UPDATE canonical_improvement_revisions SET lifecycle_state = 'COMPLETED'
      `).run()).toThrow(/immutable/);
      expect(() => database.prepare(`
        DELETE FROM canonical_improvement_audit_history
      `).run()).toThrow(/append-only/);
    } finally {
      database.close();
    }
  });

  it("is a semantic no-op on a second identical run", async () => {
    const database = await databaseWithRoom();
    try {
      seedWaveOneImprovements(database, ROOM_ID);
      const before = {
        items: rows(database, "canonical_improvements"),
        revisions: rows(database, "canonical_improvement_revisions"),
        evidence: rows(database, "canonical_improvement_evidence"),
        milestones: rows(database, "canonical_improvement_milestones"),
        audit: rows(database, "canonical_improvement_audit_history"),
      };
      expect(seedWaveOneImprovements(database, ROOM_ID)).toEqual({
        created: [],
        skipped: WAVE_ONE_IMPROVEMENT_IDS,
      });
      expect({
        items: rows(database, "canonical_improvements"),
        revisions: rows(database, "canonical_improvement_revisions"),
        evidence: rows(database, "canonical_improvement_evidence"),
        milestones: rows(database, "canonical_improvement_milestones"),
        audit: rows(database, "canonical_improvement_audit_history"),
      }).toEqual(before);
    } finally {
      database.close();
    }
  });

  it("does not overwrite an item containing a later user-authored revision", async () => {
    const database = await databaseWithRoom();
    try {
      seedWaveOneImprovements(database, ROOM_ID);
      const original = database.prepare(`
        SELECT projection_json FROM canonical_improvements WHERE room_id = ? AND id = ?
      `).get(ROOM_ID, "reconnect-ux") as { projection_json: string };
      const revision = { ...JSON.parse(original.projection_json), revision: 2, state: "IN_REVIEW", updatedAt: "2026-08-21T01:00:00.000Z" };
      const snapshotJson = JSON.stringify(revision);
      const statusJson = JSON.stringify(revision.statusContract);
      database.prepare(`
        INSERT INTO canonical_improvement_revisions(
          room_id, improvement_id, revision, lifecycle_state, status_contract_json, snapshot_json, created_at
        ) VALUES (?, 'reconnect-ux', 2, 'IN_REVIEW', ?, ?, '2026-08-21T01:00:00.000Z')
      `).run(ROOM_ID, statusJson, snapshotJson);
      database.prepare(`
        INSERT INTO canonical_improvement_audit_history(
          room_id, improvement_id, event_id, revision, event_kind, actor_id, occurred_at, details_json
        ) VALUES (?, 'reconnect-ux', 'user-review', 2, 'REVISED', 'user', '2026-08-21T01:00:00.000Z', '{}')
      `).run(ROOM_ID);
      database.prepare(`
        INSERT INTO canonical_improvement_evidence(
          room_id, improvement_id, evidence_id, introduced_revision, qualification,
          evidence_kind, uri, summary, recorded_at
        ) VALUES (?, 'reconnect-ux', 'user-evidence', 2, 'INDEPENDENT_ACCEPTANCE',
          'REVIEW', 'user://review', 'User-authored review', '2026-08-21T01:00:00.000Z')
      `).run(ROOM_ID);
      database.prepare(`
        INSERT INTO canonical_improvement_milestones(
          room_id, improvement_id, milestone_id, introduced_revision, state, summary, recorded_at
        ) VALUES (?, 'reconnect-ux', 'user-milestone', 2, 'PENDING', 'User milestone', '2026-08-21T01:00:00.000Z')
      `).run(ROOM_ID);
      database.prepare(`
        UPDATE canonical_improvements
        SET revision = 2, state = 'IN_REVIEW', updated_at = '2026-08-21T01:00:00.000Z',
            projection_json = ?, status_contract_json = ?
        WHERE room_id = ? AND id = 'reconnect-ux'
      `).run(snapshotJson, statusJson, ROOM_ID);

      const before = {
        item: database.prepare("SELECT * FROM canonical_improvements WHERE room_id = ? AND id = 'reconnect-ux'").get(ROOM_ID),
        revisions: rows(database, "canonical_improvement_revisions"),
        evidence: rows(database, "canonical_improvement_evidence"),
        milestones: rows(database, "canonical_improvement_milestones"),
        audit: rows(database, "canonical_improvement_audit_history"),
      };
      seedWaveOneImprovements(database, ROOM_ID);
      expect({
        item: database.prepare("SELECT * FROM canonical_improvements WHERE room_id = ? AND id = 'reconnect-ux'").get(ROOM_ID),
        revisions: rows(database, "canonical_improvement_revisions"),
        evidence: rows(database, "canonical_improvement_evidence"),
        milestones: rows(database, "canonical_improvement_milestones"),
        audit: rows(database, "canonical_improvement_audit_history"),
      }).toEqual(before);
    } finally {
      database.close();
    }
  });
});

describe("Deferred workspace feature ledger seed", () => {
  it("records three distinct deferred items outside Wave 1 and is idempotent", async () => {
    const database = await databaseWithRoom();
    try {
      expect(seedDeferredWorkspaceFeatures(database, ROOM_ID)).toEqual({ created: DEFERRED_WORKSPACE_FEATURE_IDS, skipped: [] });
      const items = database.prepare("SELECT id, revision, projection_json, status_contract_json FROM canonical_improvements WHERE room_id = ? ORDER BY id").all(ROOM_ID) as Array<{ id: string; revision: number; projection_json: string; status_contract_json: string }>;
      expect(items.map((item) => item.id)).toEqual([...DEFERRED_WORKSPACE_FEATURE_IDS].sort());
      expect(items.every((item) => item.revision === 1 && JSON.parse(item.projection_json).claims[0].statement.includes("outside Wave 1"))).toBe(true);
      expect(items.every((item) => JSON.parse(item.status_contract_json).nextAction.blocker === "Deferred and explicitly outside Wave 1.")).toBe(true);
      const before = { items: rows(database, "canonical_improvements"), revisions: rows(database, "canonical_improvement_revisions"), audit: rows(database, "canonical_improvement_audit_history") };
      expect(seedDeferredWorkspaceFeatures(database, ROOM_ID)).toEqual({ created: [], skipped: DEFERRED_WORKSPACE_FEATURE_IDS });
      expect({ items: rows(database, "canonical_improvements"), revisions: rows(database, "canonical_improvement_revisions"), audit: rows(database, "canonical_improvement_audit_history") }).toEqual(before);
    } finally { database.close(); }
  });
});
