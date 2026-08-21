import type { EmergencyStop, Improvement } from "./improvement-domain.js";

/** The deliberately small, room-safe projection used by the workshop. */
export interface ImprovementWorkshopView {
  id: string;
  revision: number;
  state: Improvement["state"];
  risk: Improvement["risk"];
  technicalConsensus: Improvement["technicalConsensus"];
  actionAuthority: Pick<Improvement["actionAuthority"], "status" | "grantedByHuman" | "allowedActions">;
  claims: readonly Improvement["claims"][number][];
  workClaim: Pick<Improvement["workClaim"], "holderMemberId" | "leaseExpiresAt" | "status">;
  evidence: readonly Pick<Improvement["evidence"][number], "id" | "uri" | "description" | "addedAt">[];
  updatedAt: string;
}

export function workshopView(improvement: Improvement): ImprovementWorkshopView {
  return {
    id: improvement.id, revision: improvement.revision, state: improvement.state, risk: improvement.risk,
    technicalConsensus: improvement.technicalConsensus,
    actionAuthority: { status: improvement.actionAuthority.status, grantedByHuman: improvement.actionAuthority.grantedByHuman, allowedActions: improvement.actionAuthority.allowedActions },
    claims: improvement.claims.map(({ id, statement }) => ({ id, statement })),
    workClaim: { holderMemberId: improvement.workClaim.holderMemberId, leaseExpiresAt: improvement.workClaim.leaseExpiresAt, status: improvement.workClaim.status },
    evidence: improvement.evidence.map(({ id, uri, description, addedAt }) => ({ id, uri, description, addedAt })),
    updatedAt: improvement.updatedAt,
  };
}

export interface WorkshopReference { id: string; start: number; end: number; label: string; }
const REF = /\[\[improvement:([A-Za-z0-9_-]{1,120})\]\]/g;

export function improvementReferences(text: string): WorkshopReference[] {
  const references: WorkshopReference[] = [];
  for (const match of text.matchAll(REF)) references.push({ id: match[1], start: match.index!, end: match.index! + match[0].length, label: `Improvement ${match[1]}` });
  return references;
}

export function workshopEmergencyStop(stop: EmergencyStop) {
  return { active: stop.active, reason: stop.reason, activatedAt: stop.activatedAt };
}
