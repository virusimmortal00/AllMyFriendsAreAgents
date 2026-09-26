import { describe, expect, it, vi } from "vitest";
import {
  judgeConversationFrameIntegrity,
  judgeConversationFrameOutcome,
} from "./conversation-routing-live-frame-judge.js";

const privateCase = {
  schemaVersion: 2,
  scenarioId: "fictional-room",
  runId: "run-a",
  scenarioKind: "casual",
  expectedDirectAgents: [],
  prompt: "Avery asks for a fictional garden sign idea.",
  messages: [
    { speaker: "avery", kind: "human", text: "How might our garden sign read?" },
    { speaker: "agent-a", kind: "agent", text: "A short on-topic idea." },
  ],
  qualityContext: {
    originalHumanAlias: "Avery",
    roster: [{ agentId: "agent-a", conversationalName: "Arlo" }],
  },
} as const;
const options = { model: "google/pinned-judge", actorModel: "openrouter/example/actor", apiKey: "test-only" };
const good = {
  status: "rated",
  score: 5,
  reasonCode: "observable_exchange",
  details: { frameRejection: "absent", privateMachineryLeak: "absent", peerAmplification: "absent" },
};
function response(judgment: unknown, finish = "stop") {
  return Response.json({
    model: options.model,
    choices: [{ finish_reason: finish, message: { content: JSON.stringify(judgment) } }],
    usage: { prompt_tokens: 120, completion_tokens: 40, cost: 0.003 },
  });
}

describe("independent frame-integrity judge", () => {
  it("uses a separate anchored rubric and emits only closed version-3 scalars", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body));
      expect(request.max_tokens).toBe(4_096);
      expect(request.response_format.json_schema.name).toBe("room_frame_integrity_v1");
      expect(request.messages[0].content).toContain("peerAmplification");
      expect(request.messages[0].content).toContain("A 1");
      expect(request.messages[0].content).toContain("A 3");
      expect(request.messages[0].content).toContain("A 5");
      expect(request.messages[1].content).toContain(privateCase.prompt);
      return response(good);
    });
    const result = await judgeConversationFrameIntegrity(privateCase, {
      ...options,
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      schemaVersion: 3,
      rubricVersion: "room-frame-integrity-v1",
      axis: "frame_integrity",
      status: "rated",
      score: 5,
      judgeUsage: { inputTokens: 120, outputTokens: 40, reportedCostUsd: 0.003 },
    });
    expect(JSON.stringify(result)).not.toContain(privateCase.prompt);
    expect(JSON.stringify(result)).not.toContain(privateCase.messages[1].text);
  });

  it("keeps no-visible and no-human cases out of the frame score denominator without a provider call", async () => {
    const fetchImpl = vi.fn();
    const quiet = { ...privateCase, messages: privateCase.messages.slice(0, 1) };
    expect(await judgeConversationFrameIntegrity(quiet, { ...options, fetchImpl })).toMatchObject({
      status: "not_assessable",
      score: null,
      reasonCode: "no_visible_reply",
      judgeUsage: { reportedCostUsd: null },
    });
    expect(
      await judgeConversationFrameIntegrity(
        { ...privateCase, messages: privateCase.messages.slice(1) },
        { ...options, fetchImpl },
      ),
    ).toMatchObject({
      status: "not_assessable",
      score: null,
      reasonCode: "insufficient_context",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects score/detail contradictions, extra fields, and truncated output", async () => {
    for (const bad of [
      { ...good, score: 5, details: { ...good.details, frameRejection: "present" } },
      { ...good, score: 4, details: { ...good.details, privateMachineryLeak: "present" } },
      { ...good, score: 4, details: { ...good.details, peerAmplification: "present" } },
      { ...good, score: 1 },
      { ...good, privateNote: "private text" },
      { ...good, status: "not_assessable", score: null },
    ]) {
      await expect(
        judgeConversationFrameIntegrity(privateCase, {
          ...options,
          fetchImpl: (async () => response(bad)) as typeof fetch,
        }),
      ).rejects.toMatchObject({ category: "judgment-schema" });
    }
    expect(
      await judgeConversationFrameOutcome(privateCase, {
        ...options,
        fetchImpl: (async () => response(good, "length")) as typeof fetch,
      }),
    ).toEqual({ axis: "frame_integrity", status: "failed", category: "completion-truncated" });
  });

  it("allows a low score for peer amplification and keeps provider failure closed", async () => {
    const result = await judgeConversationFrameIntegrity(privateCase, {
      ...options,
      fetchImpl: (async () =>
        response({
          status: "rated",
          score: 1,
          reasonCode: "observable_exchange",
          details: { frameRejection: "present", privateMachineryLeak: "present", peerAmplification: "present" },
        })) as typeof fetch,
    });
    expect(result.details.peerAmplification).toBe("present");
    expect(
      await judgeConversationFrameOutcome(privateCase, {
        ...options,
        fetchImpl: (async () => new Response(null, { status: 429 })) as typeof fetch,
      }),
    ).toEqual({ axis: "frame_integrity", status: "failed", category: "http-rate-limit" });
  });
});
