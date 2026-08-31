import { randomBytes, randomUUID } from "node:crypto";
import { withLogContext } from "./structured-logger.js";

/** A provider session may outlive many independent conversation runs and turns. */
export function withConversationRun<T>(run: () => T): T {
  return withLogContext({ runId: randomUUID(), spanId: randomBytes(8).toString("hex"), turnId: undefined, generationId: undefined, attemptOrdinal: undefined }, run);
}

export function withConversationTurn<T>(agentId: string, turn: () => T): T {
  return withLogContext({ turnId: randomUUID(), spanId: randomBytes(8).toString("hex"), agentId, generationId: undefined, attemptOrdinal: undefined }, turn);
}
