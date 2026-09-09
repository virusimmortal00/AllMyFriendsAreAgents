import type { AgentId } from "./participants.js";

export const PROTECTED_WORK_PHASES = ["queued", "busy", "stopping", "catching-up", "report-pending", "blocked", "available"] as const;
export type ProtectedWorkPhase = typeof PROTECTED_WORK_PHASES[number];
export interface ProtectedWorkView {
  workId: string;
  roomId: string;
  owner: AgentId;
  objective: string;
  phase: ProtectedWorkPhase;
  createdAt: string;
  startedAt: string | null;
  stoppedAt: string | null;
  updatedAt: string;
  blocker: string | null;
  disposition: "delivered" | "no-update" | null;
}
export interface ProtectedWorkRequest {
  roomId: string;
  owner: AgentId;
  objective: string;
  requestId: string;
}
