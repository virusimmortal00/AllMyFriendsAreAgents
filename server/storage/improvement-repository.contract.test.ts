import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createImprovement,
  type DomainActor,
  type Improvement,
} from "../../shared/improvement-domain.js";
import { RoomStore } from "../room-store.js";
import type { RoomRepository } from "./room-repository.js";
import { SqliteRoomRepository } from "./sqlite-room-repository.js";

const author: DomainActor = { id: "author", role: "AUTHOR", human: true };
const reviewer: DomainActor = { id: "reviewer", role: "REVIEWER", human: true };
const operator: DomainActor = { id: "operator", role: "OPERATOR", human: true };
const temporaryDirectories: string[] = [];

interface RepositoryFixture {
  repository: RoomRepository;
  reopen(): Promise<RoomRepository>;
  close(): void;
  roomArtifact(): Promise<string | number>;
}

type FixtureFactory = (root: string) => Promise<RepositoryFixture>;

const factories: ReadonlyArray<readonly [string, FixtureFactory]> = [
  ["JSON", async (root) => {
    const stateDirectory = path.join(root, "isolated-json-state");
    let repository = await RoomStore.open(root, stateDirectory);
    return {
      get repository() { return repository; },
      async reopen() { repository = await RoomStore.open(root, stateDirectory); return repository; },
      close() {},
      async roomArtifact() { return readFile(path.join(stateDirectory, "room.json"), "utf8"); },
    };
  }],
  ["SQLite", async (root) => {
    const databasePath = path.join(root, "isolated-sqlite-state", "room.sqlite");
    let repository = await SqliteRoomRepository.open(root, databasePath);
    return {
      get repository() { return repository; },
      async reopen() {
        (repository as SqliteRoomRepository).close();
        repository = await SqliteRoomRepository.open(root, databasePath);
        return repository;
      },
      close() { (repository as SqliteRoomRepository).close(); },
      async roomArtifact() { return repository.snapshot().messages.length; },
    };
  }],
];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function initial(id: string, at = "2026-08-21T12:00:00.000Z"): Improvement {
  return createImprovement({
    id,
    risk: "LOW",
    author,
    claims: [{ id: `${id}-claim`, statement: `claim for ${id}` }],
    now: at,
  });
}

describe.each(factories)("%s canonical improvement repository contract", (_backend, makeFixture) => {
  it("creates, gets, filters, and paginates canonical projections", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "amfaa-improvement-contract-"));
    temporaryDirectories.push(root);
    const fixture = await makeFixture(root);
    try {
      expect(await fixture.repository.listImprovements()).toEqual({ items: [], nextCursor: null });
      expect((await fixture.repository.createImprovement(initial("imp-1"))).kind).toBe("created");
      expect((await fixture.repository.createImprovement(initial("imp-2", "2026-08-21T13:00:00.000Z"))).kind).toBe("created");
      expect(await fixture.repository.createImprovement(initial("imp-1"))).toEqual({ kind: "conflict", id: "imp-1" });
      expect((await fixture.repository.getImprovement("imp-1"))?.revision).toBe(1);

      const firstPage = await fixture.repository.listImprovements({ states: ["DRAFT"], risks: ["LOW"], limit: 1 });
      expect(firstPage.items.map(({ id }) => id)).toEqual(["imp-2"]);
      expect(firstPage.nextCursor).toBe("1");
      expect((await fixture.repository.listImprovements({ cursor: firstPage.nextCursor!, limit: 1 })).items.map(({ id }) => id))
        .toEqual(["imp-1"]);
      expect((await fixture.repository.listImprovements({ claimId: "imp-1-claim" })).items.map(({ id }) => id))
        .toEqual(["imp-1"]);
    } finally {
      fixture.close();
    }
  });

  it("atomically records transitions, claims, evidence, and attribution as immutable revisions", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "amfaa-improvement-contract-"));
    temporaryDirectories.push(root);
    const fixture = await makeFixture(root);
    try {
      await fixture.repository.createImprovement(initial("imp-history"));
      const proposed = await fixture.repository.applyImprovementChange(
        "imp-history", 1, { kind: "TRANSITION", to: "PROPOSED" }, author, "2026-08-21T12:01:00.000Z",
      );
      expect(proposed.kind).toBe("accepted");
      const withClaim = await fixture.repository.applyImprovementChange(
        "imp-history", 2, { kind: "ADD_CLAIM", claim: { id: "new-claim", statement: "measurable" } }, author,
        "2026-08-21T12:02:00.000Z",
      );
      expect(withClaim.kind).toBe("accepted");
      const withEvidence = await fixture.repository.applyImprovementChange(
        "imp-history", 3,
        { kind: "ADD_EVIDENCE", evidence: { id: "evidence-1", uri: "test://result", description: "verified" } },
        reviewer, "2026-08-21T12:03:00.000Z",
      );
      expect(withEvidence.kind).toBe("accepted");

      const current = await fixture.repository.getImprovement("imp-history");
      expect(current).toMatchObject({ revision: 4, state: "PROPOSED" });
      expect(current?.claims.map(({ id }) => id)).toEqual(["imp-history-claim", "new-claim"]);
      expect(current?.evidence).toEqual([expect.objectContaining({ id: "evidence-1", addedBy: "reviewer" })]);
      expect(current?.attribution.map(({ revision, actorId }) => ({ revision, actorId }))).toEqual([
        { revision: 1, actorId: "author" },
        { revision: 2, actorId: "author" },
        { revision: 3, actorId: "author" },
        { revision: 4, actorId: "reviewer" },
      ]);
      const history = await fixture.repository.listImprovementEvents("imp-history", { limit: 2 });
      expect(history.map(({ revision }) => revision)).toEqual([1, 2]);
      expect((await fixture.repository.listImprovementEvents("imp-history", { afterRevision: 2, limit: 10 }))
        .map(({ revision }) => revision)).toEqual([3, 4]);
      expect(history[0]?.snapshot).toMatchObject({ revision: 1, state: "DRAFT" });
    } finally {
      fixture.close();
    }
  });

  it("allows exactly one concurrent update at an expected revision", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "amfaa-improvement-contract-"));
    temporaryDirectories.push(root);
    const fixture = await makeFixture(root);
    try {
      await fixture.repository.createImprovement(initial("imp-race"));
      const results = await Promise.all([
        fixture.repository.applyImprovementChange(
          "imp-race", 1, { kind: "ADD_CLAIM", claim: { id: "winner-a", statement: "A" } }, author,
          "2026-08-21T12:01:00.000Z",
        ),
        fixture.repository.applyImprovementChange(
          "imp-race", 1, { kind: "ADD_CLAIM", claim: { id: "winner-b", statement: "B" } }, author,
          "2026-08-21T12:01:01.000Z",
        ),
      ]);
      expect(results.filter(({ kind }) => kind === "accepted")).toHaveLength(1);
      expect(results.filter(({ kind }) => kind === "conflict")).toEqual([
        { kind: "conflict", expectedRevision: 1, actualRevision: 2 },
      ]);
      expect(await fixture.repository.listImprovementEvents("imp-race")).toHaveLength(2);
    } finally {
      fixture.close();
    }
  });

  it("advances revisions for meaningful changes but not semantic no-ops", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "amfaa-improvement-contract-"));
    temporaryDirectories.push(root);
    const fixture = await makeFixture(root);
    try {
      await fixture.repository.createImprovement(initial("imp-no-op"));
      const unchanged = await fixture.repository.applyImprovementChange(
        "imp-no-op", 1, { kind: "SET_RISK", risk: "LOW" }, author, "2026-08-21T12:01:00.000Z",
      );
      expect(unchanged).toMatchObject({ kind: "accepted", improvement: { revision: 1 } });
      expect(await fixture.repository.listImprovementEvents("imp-no-op")).toHaveLength(1);

      const changed = await fixture.repository.applyImprovementChange(
        "imp-no-op", 1, { kind: "SET_RISK", risk: "GUARDED" }, author, "2026-08-21T12:02:00.000Z",
      );
      expect(changed).toMatchObject({ kind: "accepted", improvement: { revision: 2, risk: "GUARDED" } });
      expect((await fixture.repository.listImprovementEvents("imp-no-op")).map(({ revision }) => revision))
        .toEqual([1, 2]);
    } finally {
      fixture.close();
    }
  });

  it("survives reopen with history and emergency-stop state without changing room data", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "amfaa-improvement-contract-"));
    temporaryDirectories.push(root);
    const fixture = await makeFixture(root);
    try {
      await fixture.repository.addMessage("you", "transcript must survive", "chat", undefined, undefined, {
        id: "human-test-id", name: "Tester",
      });
      await fixture.repository.setSession("codex-terra", "session-to-preserve", "read-only");
      const roomBefore = await fixture.roomArtifact();
      await fixture.repository.createImprovement(initial("imp-restart"));
      await fixture.repository.applyImprovementChange(
        "imp-restart", 1,
        { kind: "ADD_EVIDENCE", evidence: { id: "persisted-evidence", uri: "test://persisted", description: "restart" } },
        reviewer, "2026-08-21T12:02:00.000Z",
      );
      expect(await fixture.repository.updateEmergencyStop(0, { active: true, reason: "operator halt" }, operator, "2026-08-21T12:03:00.000Z"))
        .toMatchObject({ kind: "accepted", emergencyStop: { revision: 1, active: true } });
      expect(await fixture.roomArtifact()).toEqual(roomBefore);

      const reopened = await fixture.reopen();
      expect(await reopened.getImprovement("imp-restart")).toMatchObject({
        revision: 2,
        evidence: [expect.objectContaining({ id: "persisted-evidence" })],
      });
      expect((await reopened.listImprovementEvents("imp-restart")).map(({ revision }) => revision)).toEqual([1, 2]);
      expect(await reopened.getEmergencyStop()).toMatchObject({ revision: 1, active: true, reason: "operator halt" });
      expect(reopened.snapshot().messages.at(-1)?.text).toBe("transcript must survive");
      expect(reopened.snapshot().sessions["codex-terra"]?.id).toBe("session-to-preserve");
    } finally {
      fixture.close();
    }
  });

  it("persists independent status fields and their immutable code location across reopen", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "amfaa-improvement-contract-"));
    temporaryDirectories.push(root);
    const fixture = await makeFixture(root);
    try {
      await fixture.repository.createImprovement(initial("imp-status"));
      const implemented = await fixture.repository.applyImprovementChange(
        "imp-status",
        1,
        {
          kind: "SET_STATUS_FIELD",
          transition: {
            field: "implementation",
            value: {
              state: "IMPLEMENTED",
              codeLocation: {
                immutableRevision: "9d7a4c1",
                repository: "https://example.test/friends/agents.git",
                branch: "codex/status-contract",
                worktree: null,
              },
            },
          },
        },
        operator,
        "2026-08-21T12:04:00.000Z",
      );
      expect(implemented.kind).toBe("accepted");
      if (implemented.kind !== "accepted") throw new Error("status update was not accepted");
      expect(implemented.improvement.statusContract.deployment).toEqual({ state: "UNKNOWN" });

      const reopened = await fixture.reopen();
      expect((await reopened.getImprovement("imp-status"))?.statusContract).toMatchObject({
        schemaVersion: 1,
        implementation: {
          state: "IMPLEMENTED",
          codeLocation: { immutableRevision: "9d7a4c1", repository: "https://example.test/friends/agents.git" },
        },
        deployment: { state: "UNKNOWN" },
        independentAcceptance: { state: "UNKNOWN" },
        upstreamPublication: { state: "UNKNOWN" },
      });
    } finally {
      fixture.close();
    }
  });
});
