import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DomainActor } from "../shared/improvement-domain.js";
import { SqliteRoomRepository } from "./storage/sqlite-room-repository.js";
import {
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
