import { realpath } from "node:fs/promises";
import type { RoomRepository } from "./storage/room-repository.js";
import { identityDigest, sourceWorkAuthorityReason, type IdentityRepository } from "./storage/identity-domain.js";

/** Admission is read-only investigation authority, never implementation authority. */
export interface InvestigationAdmission {
  readonly schemaVersion: 1;
  readonly kind: "read-only-investigation";
  readonly participantEpoch?: { agentId: string; rosterRevision: number; configurationRevision: number };
  readonly scopeDigest: string;
}

export async function investigationAdmission(rooms: RoomRepository): Promise<InvestigationAdmission> {
  const repository = rooms as RoomRepository & Partial<IdentityRepository> & { stateDirectory?: string };
  let scope: unknown;
  if (repository.getStorageScope) {
    const durable = await repository.getStorageScope(rooms.roomId);
    if (!durable || durable.roomId !== rooms.roomId) throw new Error("Investigation room authority is unavailable.");
    scope = { backend: "sqlite", ...durable };
  } else {
    // JSON supports one room per directory. Relocation requires new admission;
    // copying a work file to another room directory must not transfer authority.
    if (!repository.stateDirectory) throw new Error("Investigation room authority is unavailable.");
    scope = { backend: "json", roomId: rooms.roomId, directory: await realpath(repository.stateDirectory) };
  }
  return { schemaVersion: 1, kind: "read-only-investigation", scopeDigest: identityDigest(scope) };
}

export async function investigationAdmissionBlocker(rooms: RoomRepository, workId: string, admission: InvestigationAdmission | undefined) {
  if (!admission) return "investigation-admission-missing";
  if (admission.scopeDigest !== (await investigationAdmission(rooms)).scopeDigest) return "investigation-room-scope-changed";
  // Preserve explicit migration/reconciliation denials. A missing source-writing
  // binding is expected: read-only investigations do not own implementation jobs.
  const repository = rooms as RoomRepository & Partial<IdentityRepository>;
  const overlay = await repository.getSourceWorkBinding?.("investigation", workId);
  return overlay ? sourceWorkAuthorityReason(overlay) : null;
}
