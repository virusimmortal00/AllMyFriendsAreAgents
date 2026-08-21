import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DomainActor } from "../shared/improvement-domain.js";
import { SqliteRoomRepository } from "./storage/sqlite-room-repository.js";
import {
  advanceImprovementProposal,
  improvementPropose,
  listGovernedImprovements,
  projectParticipantImprovementManifest,
  readGovernedImprovement,
  resolveImprovementReferences,
} from "./governed-improvement-api.js";

const actor: DomainActor = { id: "developer-team", role: "AUTHOR", human: true };
const temporaryDirectories: string[] = [];
let repository: SqliteRoomRepository;

beforeEach(async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "amfaa-governed-retrieval-"));
  temporaryDirectories.push(root);
  repository = await SqliteRoomRepository.open(root, path.join(root, "room.sqlite"), { seedImprovements: true });
});

afterEach(async () => {
  repository.close();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("governed improvement retrieval", () => {
  it("returns active and all canonical lists with revision labels", async () => {
    await repository.applyImprovementChange(
      "source-control-adapter", 1, { kind: "TRANSITION", to: "CANCELED" }, actor, "2026-08-21T01:00:00.000Z",
    );

    const active = await listGovernedImprovements(repository, "active");
    const all = await listGovernedImprovements(repository, "all");
    expect(active.items.map(({ canonicalId }) => canonicalId).sort()).toEqual([
      "autonomous-improvement-foundation", "reconnect-ux",
    ]);
    expect(all.items).toHaveLength(3);
    expect(all.items.find(({ canonicalId }) => canonicalId === "source-control-adapter"))
      .toMatchObject({ revisionLabel: "r2", state: "CANCELED" });
  });

  it("returns typed details and keeps Developer Team evidence qualified", async () => {
    const result = await readGovernedImprovement(repository, "reconnect-ux");
    expect(result).toMatchObject({
      kind: "found",
      item: {
        canonicalId: "reconnect-ux",
        revisionLabel: "r1",
        state: "PROPOSED",
        status: { independentAcceptance: { state: "PENDING" } },
        revisions: [{ revision: 1, revisionLabel: "r1" }],
        milestones: [{ id: "wave-1-acceptance", revisionLabel: "r1" }],
      },
    });
    if (result.kind !== "found") throw new Error("seeded item missing");
    expect(result.item.evidence).toHaveLength(2);
    expect(result.item.evidence.every(({ sourceClass }) => sourceClass === "DEVELOPER_TEAM")).toBe(true);
    expect(result.item.status.independentAcceptance).toEqual({ state: "PENDING" });
  });

  it("never creates unknown formal references and returns a typed missing-item result", async () => {
    const before = (await listGovernedImprovements(repository, "all")).items.length;
    await expect(resolveImprovementReferences(
      repository,
      "Compare [[improvement:reconnect-ux]] with [[improvement:not-canonical]].",
    )).resolves.toMatchObject({ references: [
      { kind: "found", item: { canonicalId: "reconnect-ux" } },
      { kind: "missing_item", canonicalId: "not-canonical" },
    ] });
    expect((await listGovernedImprovements(repository, "all")).items).toHaveLength(before);
    await expect(repository.getImprovement("not-canonical")).resolves.toBeUndefined();
  });

  it("makes repeated semantic milestones a no-op and revision-links meaningful changes", async () => {
    const first = await repository.addImprovementMilestone(
      "reconnect-ux", 1, { id: "delivery", state: "PENDING", summary: "Ship reconnect recovery" }, actor,
      "2026-08-21T02:00:00.000Z",
    );
    expect(first).toMatchObject({ kind: "accepted", created: true, revision: 2, milestone: { introducedRevision: 2 } });
    const repeated = await repository.addImprovementMilestone(
      "reconnect-ux", 1, { id: " delivery ", state: "PENDING", summary: " Ship   reconnect recovery " }, actor,
      "2026-08-21T02:01:00.000Z",
    );
    expect(repeated).toMatchObject({ kind: "accepted", created: false, revision: 2 });
    const changed = await repository.addImprovementMilestone(
      "reconnect-ux", 2, { id: "delivery", state: "ACHIEVED", summary: "Ship reconnect recovery" }, actor,
      "2026-08-21T02:02:00.000Z",
    );
    expect(changed).toMatchObject({ kind: "accepted", created: true, revision: 3, milestone: { introducedRevision: 3 } });

    const detail = await readGovernedImprovement(repository, "reconnect-ux");
    if (detail.kind !== "found") throw new Error("seeded item missing");
    expect(detail.item.revisions.map(({ revisionLabel }) => revisionLabel)).toEqual(["r1", "r2", "r3"]);
    expect(detail.item.milestones.filter(({ id }) => id === "delivery").map(({ revisionLabel, state }) => ({ revisionLabel, state })))
      .toEqual([{ revisionLabel: "r2", state: "PENDING" }, { revisionLabel: "r3", state: "ACHIEVED" }]);
  });

  it("projects references and explicit retrievals only to addressed participants", async () => {
    const manifest = await projectParticipantImprovementManifest(repository, {
      interaction: {
        text: "Terra, inspect [[improvement:reconnect-ux]]; ignore [[improvement:unknown-id]].",
        addressedParticipants: ["codex-terra", "codex-sol"],
      },
      explicitRetrievals: [
        { participantId: "codex-terra", canonicalId: "source-control-adapter" },
        { participantId: "claude-opus", canonicalId: "autonomous-improvement-foundation" },
      ],
    });

    expect(manifest).toEqual({ participants: [
      {
        participantId: "codex-terra",
        improvements: [
          { canonicalId: "reconnect-ux", revisionLabel: "r1" },
          { canonicalId: "source-control-adapter", revisionLabel: "r1" },
        ],
      },
      {
        participantId: "codex-sol",
        improvements: [{ canonicalId: "reconnect-ux", revisionLabel: "r1" }],
      },
    ] });
    expect(JSON.stringify(manifest)).not.toContain("claude-opus");
    expect(JSON.stringify(manifest)).not.toContain("autonomous-improvement-foundation");
    expect(JSON.stringify(manifest)).not.toContain("evidence");
    expect(JSON.stringify(manifest)).not.toContain("audit");
  });
});

describe("species-neutral governed improvement proposals", () => {
  const proposedAt = "2026-08-21T10:00:00.000Z";
  const proposal = (id: string, kind: string) => ({
    proposer: { id, kind, capabilities: ["IMPROVEMENT_PROPOSE", "CHAT"] },
    idempotencyKey: `proposal:${kind}:${id}`,
    rationale: "The room should preserve a measurable improvement request.",
    requestedOutcome: "A governed reviewer can advance the request without executing it.",
  });

  it("accepts capability-bearing participant kinds through one command path", async () => {
    for (const [id, kind] of [["human-42", "human"], ["agent-7", "software-agent"], ["collective-3", "collective"]]) {
      const result = await improvementPropose(repository, proposal(id, kind), proposedAt);
      expect(result).toMatchObject({
        kind: "accepted",
        created: true,
        proposal: {
          revision: 1,
          state: "PROPOSED",
          authorId: id,
          proposal: {
            proposer: { id, kind },
            proposedAt,
            rationale: "The room should preserve a measurable improvement request.",
            requestedOutcome: "A governed reviewer can advance the request without executing it.",
          },
          actionAuthority: { status: "PENDING", allowedActions: [] },
          workClaim: { status: "UNCLAIMED", history: [] },
          statusContract: {
            schemaVersion: 1,
            implementation: { state: "UNKNOWN" },
            deployment: { state: "UNKNOWN" },
            developerTeamEvidence: { state: "UNKNOWN" },
            independentAcceptance: { state: "UNKNOWN" },
            upstreamPublication: { state: "UNKNOWN" },
            nextAction: { state: "ACTION_REQUIRED" },
          },
        },
      });
    }
  });

  it("assigns canonical IDs in the ledger and makes an idempotency replay audit-neutral", async () => {
    const command = proposal("agent-repeat", "agent");
    const first = await improvementPropose(repository, command, proposedAt);
    const second = await improvementPropose(repository, command, "2026-08-21T10:01:00.000Z");
    expect(first).toMatchObject({ kind: "accepted", created: true });
    expect(second).toMatchObject({ kind: "accepted", created: false });
    if (first.kind !== "accepted" || second.kind !== "accepted") throw new Error("proposal rejected");
    expect(first.proposal.id).toMatch(/^improvement-[a-f0-9]{20}$/);
    expect(second.proposal.id).toBe(first.proposal.id);
    expect(await repository.listImprovementEvents(first.proposal.id)).toHaveLength(1);
    expect((await repository.getImprovementLedgerRecords(first.proposal.id))?.audit).toHaveLength(1);
  });

  it("advances only with independently authorized governance and appends decision evidence", async () => {
    const created = await improvementPropose(repository, proposal("agent-governed", "agent"), proposedAt);
    if (created.kind !== "accepted") throw new Error("proposal rejected");
    const decision = {
      decisionId: "decision-1",
      decidedBy: { id: "governor-9", kind: "governance-member", capabilities: ["GOVERNANCE_DECIDE"] },
      authorityId: "charter-2026",
      evidence: ["ledger://governance/vote-81"],
    };
    const result = await advanceImprovementProposal(repository, {
      canonicalId: created.proposal.id,
      expectedRevision: 1,
      to: "IN_REVIEW",
      decision,
    }, (candidate) => candidate.authorityId === "charter-2026", "2026-08-21T10:02:00.000Z");

    expect(result).toMatchObject({ kind: "accepted", improvement: { state: "IN_REVIEW", revision: 2 } });
    const records = await repository.getImprovementLedgerRecords(created.proposal.id);
    expect(records?.audit).toEqual([
      expect.objectContaining({ revision: 1, eventKind: "CREATED", actorId: "agent-governed" }),
      expect.objectContaining({
        revision: 2,
        eventKind: "REVISED",
        actorId: "governor-9",
        details: {
          kind: "GOVERNANCE_ADVANCE",
          decision: expect.objectContaining({
            decisionId: "decision-1",
            authorityId: "charter-2026",
            evidence: ["ledger://governance/vote-81"],
            priorState: "PROPOSED",
            to: "IN_REVIEW",
          }),
        },
      }),
    ]);
  });

  it("rejects missing capability, unauthorized and self-asserted authority, stale revisions, and execution requests without mutation", async () => {
    await expect(improvementPropose(repository, {
      ...proposal("observer", "observer"),
      proposer: { id: "observer", kind: "observer", capabilities: ["CHAT"] },
    }, proposedAt)).resolves.toMatchObject({ kind: "rejected" });

    const created = await improvementPropose(repository, proposal("agent-safe", "agent"), proposedAt);
    if (created.kind !== "accepted") throw new Error("proposal rejected");
    const base = {
      canonicalId: created.proposal.id,
      expectedRevision: 1,
      to: "IN_REVIEW" as const,
      decision: {
        decisionId: "rogue-decision",
        decidedBy: { id: "rogue", kind: "agent", capabilities: ["GOVERNANCE_DECIDE"] },
        authorityId: "self-asserted-by-rogue",
        evidence: ["self://claim"],
      },
    };
    await expect(advanceImprovementProposal(repository, base, () => false, "2026-08-21T10:02:00.000Z"))
      .resolves.toMatchObject({ kind: "rejected", reason: expect.stringContaining("independently authorized") });
    await expect(advanceImprovementProposal(repository, { ...base, requestedAction: "DEPLOY" }, () => true))
      .resolves.toMatchObject({ kind: "rejected", reason: expect.stringContaining("cannot request or perform execution") });
    await expect(advanceImprovementProposal(repository, { ...base, to: "IN_PROGRESS" }, () => true))
      .resolves.toMatchObject({ kind: "rejected", reason: expect.stringContaining("is not allowed") });
    await expect(advanceImprovementProposal(repository, { ...base, expectedRevision: 9 }, () => true))
      .resolves.toEqual({ kind: "conflict", expectedRevision: 9, actualRevision: 1 });
    expect(await repository.getImprovement(created.proposal.id)).toMatchObject({
      revision: 1,
      state: "PROPOSED",
      actionAuthority: { status: "PENDING" },
      workClaim: { status: "UNCLAIMED" },
    });
    expect(await repository.listImprovementEvents(created.proposal.id)).toHaveLength(1);
  });
});
