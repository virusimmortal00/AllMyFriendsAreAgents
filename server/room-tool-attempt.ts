import type { AgentId } from "../shared/participants.js";

/** Server-owned lifetime; never accepted from a tool request or persisted. */
export interface RoomToolAttempt {
  readonly generationId: string;
  readonly attemptOrdinal: number;
  readonly agentId: AgentId;
  readonly isActive: () => boolean;
}
