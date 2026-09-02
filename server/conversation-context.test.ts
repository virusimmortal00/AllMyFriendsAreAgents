import { describe, expect, it } from "vitest";
import { withConversationRun, withConversationTurn } from "./conversation-context.js";
import { conversationLogFields, currentLogContext, withLogContext, type LogContext } from "./structured-logger.js";

describe("conversation identity scopes", () => {
  it("isolates concurrent turns while preserving the originating job, trace, and request", async () => {
    const seen: LogContext[] = [];
    await withLogContext({ jobId: "job-one", traceId: "a".repeat(32), requestId: "request-one" }, () => withConversationRun(async () => {
      const run = currentLogContext()!;
      await Promise.all(["agent-a", "agent-b"].map((agent) => withConversationTurn(agent, async () => {
        await Promise.resolve();
        seen.push(currentLogContext()!);
        expect(currentLogContext()).toMatchObject({ runId: run.runId, jobId: "job-one", traceId: "a".repeat(32), requestId: "request-one", agentId: agent });
        expect(currentLogContext()?.spanId).not.toBe(run.spanId);
        expect(currentLogContext()?.generationId).toBeUndefined();
      })));
      expect(currentLogContext()).toBe(run);
    }));
    expect(new Set(seen.map(({ turnId }) => turnId)).size).toBe(2);
    expect(new Set(seen.map(({ spanId }) => spanId)).size).toBe(2);
    expect(currentLogContext()).toBeUndefined();
  });

  it("allocates a fresh run and turn for later work even in inherited generation context", () => {
    const observed: LogContext[] = [];
    withLogContext({ runId: "previous-run", turnId: "previous-turn", generationId: "previous-generation", attemptOrdinal: 2 }, () => {
      for (let index = 0; index < 2; index++) withConversationRun(() => withConversationTurn("agent", () => observed.push(currentLogContext()!)));
    });
    expect(new Set(observed.map(({ runId }) => runId)).size).toBe(2);
    expect(new Set(observed.map(({ turnId }) => turnId)).size).toBe(2);
    expect(observed.every(({ generationId, attemptOrdinal, requestId }) => generationId === undefined && attemptOrdinal === undefined && requestId === undefined)).toBe(true);
  });

  it("does not invent missing identities when reading older or non-conversation evidence", () => {
    expect(conversationLogFields()).toEqual({});
    expect(conversationLogFields({ generationId: "generation-only" })).toEqual({});
  });
});
