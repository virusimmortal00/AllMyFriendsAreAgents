import { describe, expect, it, vi } from "vitest";
import { JudgeFailure, parsePrivateJudgeCase } from "./conversation-routing-live-judge.js";
import {
  judgeConversationQualityAxes,
  judgeConversationQualityAxis,
  parsePrivateQualityCase,
  QUALITY_AXES,
  type QualityAxis,
} from "./conversation-routing-live-judge-v2.js";

const privateCase = {
  schemaVersion: 2,
  scenarioId: "fictional-direct",
  runId: "run-a",
  scenarioKind: "direct",
  expectedDirectAgents: ["agent-a"],
  prompt: "Avery asks Arlo for a short fictional answer.",
  messages: [
    { speaker: "avery", kind: "human", text: "Arlo, please answer the fictional question." },
    { speaker: "agent-a", kind: "agent", text: "A brief fictional answer for Avery." },
  ],
  qualityContext: {
    originalHumanAlias: "Avery",
    roster: [
      { agentId: "agent-a", conversationalName: "Arlo" },
      { agentId: "agent-b", conversationalName: "Bex" },
    ],
  },
} as const;
const options = { model: "google/pinned-judge", actorModel: "openrouter/example/actor", apiKey: "test-only-key" };
const judgments = {
  social_cadence: {
    status: "rated",
    score: 4,
    reasonCode: "observable_exchange",
    details: { cueFit: "attuned", textTurnRhythm: "smooth" },
  },
  length_fit: {
    status: "rated",
    score: 5,
    reasonCode: "observable_exchange",
    details: { direction: "appropriate" },
  },
  address_radius: {
    status: "rated",
    score: 5,
    reasonCode: "observable_exchange",
    details: { observedAudience: "user", audienceFit: "aligned" },
  },
  contribution_value: {
    status: "rated",
    score: 3,
    reasonCode: "observable_exchange",
    details: { valueMode: "knowledge" },
  },
} as const;

function response(judgment: unknown, finishReason = "stop") {
  return Response.json({
    model: options.model,
    choices: [{ finish_reason: finishReason, message: { content: JSON.stringify(judgment) } }],
    usage: { prompt_tokens: 45, completion_tokens: 25, cost: 0.002 },
  });
}

describe("versioned private conversation-quality graders", () => {
  it("accepts bounded private roster context without changing the strict v1 parser", () => {
    expect(parsePrivateQualityCase(privateCase).qualityContext?.roster).toHaveLength(2);
    expect(() => parsePrivateJudgeCase(privateCase)).toThrow();
    const { qualityContext: _context, ...legacy } = privateCase;
    expect(parsePrivateQualityCase(parsePrivateQualityCase({ ...legacy, schemaVersion: 1 })).qualityContext).toBeNull();
    for (const bad of [
      { ...privateCase, qualityContext: { ...privateCase.qualityContext, originalHumanAlias: "Arlo" } },
      { ...privateCase, qualityContext: { ...privateCase.qualityContext, roster: [] } },
      {
        ...privateCase,
        qualityContext: { ...privateCase.qualityContext, roster: [{ agentId: "agent-b", conversationalName: "Bex" }] },
      },
      { ...privateCase, prompt: "x".repeat(4_001) },
      { ...privateCase, routingPolicy: "enforce" },
    ]) {
      expect(() => parsePrivateQualityCase(bad)).toThrow();
    }
  });

  it.each(QUALITY_AXES)("uses a separate anchored %s rubric and exports only its scalar result", async (axis) => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body));
      expect(request.model).toBe(options.model);
      expect(request.max_tokens).toBe(1_024);
      expect(request.provider.require_parameters).toBe(true);
      expect(request.response_format.json_schema.strict).toBe(true);
      expect(request.response_format.json_schema.name).toBe(`room_${axis}_v2`);
      expect(request.messages[0].content).toMatch(/A 1 .*; 3 .*; 5 /);
      expect(JSON.stringify(request)).not.toContain("routingPolicy");
      expect(JSON.stringify(request)).not.toContain("reportedCostUsd");
      if (axis === "social_cadence") expect(request.messages[0].content).toContain("measured latency is outside");
      if (axis === "length_fit") expect(request.messages[0].content).toContain("too_short");
      if (axis === "address_radius") expect(request.messages[0].content).toContain("original human");
      if (axis === "contribution_value") expect(request.messages[0].content).toContain("entertainment");
      return response(judgments[axis]);
    });
    const result = await judgeConversationQualityAxis(privateCase, {
      ...options,
      axis,
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      schemaVersion: 2,
      rubricVersion: "room-quality-v2",
      axis,
      status: "rated",
      judgeModel: options.model,
      resolvedJudgeModel: options.model,
      judgeUsage: { inputTokens: 45, outputTokens: 25, reportedCostUsd: 0.002 },
    });
    expect(result.details).toEqual(judgments[axis].details);
    expect(JSON.stringify(result)).not.toContain(privateCase.prompt);
    expect(JSON.stringify(result)).not.toContain(privateCase.qualityContext.originalHumanAlias);
    expect(JSON.stringify(result)).not.toContain(privateCase.messages[1].text);
  });

  it("rates a missing required direct reply as too short and leaves ambiguous quiet cases unassessable", async () => {
    const fetchImpl = vi.fn();
    const noReply = { ...privateCase, messages: privateCase.messages.slice(0, 1) };
    const length = await judgeConversationQualityAxis(noReply, { ...options, axis: "length_fit", fetchImpl });
    expect(length).toMatchObject({
      status: "rated",
      score: 1,
      reasonCode: "required_reply_missing",
      details: { direction: "too_short" },
      judgeUsage: { inputTokens: null, outputTokens: null, reportedCostUsd: null },
    });
    for (const axis of ["social_cadence", "address_radius", "contribution_value"] as const) {
      const result = await judgeConversationQualityAxis(noReply, { ...options, axis, fetchImpl });
      expect(result).toMatchObject({ status: "not_assessable", score: null, reasonCode: "no_visible_reply" });
    }
    const casual = { ...noReply, scenarioKind: "casual", expectedDirectAgents: [] };
    expect(await judgeConversationQualityAxis(casual, { ...options, axis: "length_fit", fetchImpl })).toMatchObject({
      status: "not_assessable",
      score: null,
      reasonCode: "no_visible_reply",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("marks a visible v1 exchange's audience insufficient without inventing recipients", async () => {
    const { qualityContext: _context, ...withoutContext } = privateCase;
    const fetchImpl = vi.fn();
    const result = await judgeConversationQualityAxis(
      { ...withoutContext, schemaVersion: 1 },
      {
        ...options,
        axis: "address_radius",
        fetchImpl,
      },
    );
    expect(result).toMatchObject({
      status: "not_assessable",
      score: null,
      reasonCode: "insufficient_context",
      details: { observedAudience: null, audienceFit: null },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("preserves independent not-applicable and not-assessable scores", async () => {
    const length = await judgeConversationQualityAxis(privateCase, {
      ...options,
      axis: "length_fit",
      fetchImpl: (async () =>
        response({
          status: "not_applicable",
          score: null,
          reasonCode: "no_applicable_obligation",
          details: { direction: null },
        })) as typeof fetch,
    });
    expect(length).toMatchObject({ status: "not_applicable", score: null, details: { direction: null } });
    const value = await judgeConversationQualityAxis(privateCase, {
      ...options,
      axis: "contribution_value",
      fetchImpl: (async () =>
        response({
          status: "not_assessable",
          score: null,
          reasonCode: "insufficient_context",
          details: { valueMode: null },
        })) as typeof fetch,
    });
    expect(value).toMatchObject({ status: "not_assessable", score: null, details: { valueMode: null } });
  });

  it("rejects malformed, oversized, invalid, and truncated responses without retaining private text", async () => {
    const privateFragment = "private fictitious output";
    const cases: Array<[Response, string]> = [
      [new Response(privateFragment), "response-envelope-json"],
      [
        Response.json({ choices: [{ finish_reason: "stop", message: { content: `{${privateFragment}` } }] }),
        "response-content-json",
      ],
      [response(judgments.length_fit, "length"), "completion-truncated"],
      [response({ ...judgments.length_fit, details: { direction: "novel" } }), "judgment-schema"],
      [response({ ...judgments.length_fit, privateExplanation: privateFragment }), "judgment-schema"],
      [new Response("x".repeat(32_769)), "response-too-large"],
    ];
    for (const [providerResponse, category] of cases) {
      try {
        await judgeConversationQualityAxis(privateCase, {
          ...options,
          axis: "length_fit",
          fetchImpl: (async () => providerResponse) as typeof fetch,
        });
        throw new Error("Expected the mocked response to fail.");
      } catch (error) {
        expect(error).toBeInstanceOf(JudgeFailure);
        expect(error).toMatchObject({ category });
        expect(JSON.stringify(error)).not.toContain(privateFragment);
      }
    }
  });

  it("keeps four axis outcomes separate and stops new calls after cancellation", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body));
      const axis = String(request.response_format.json_schema.name)
        .replace(/^room_/, "")
        .replace(/_v2$/, "") as QualityAxis;
      return axis === "social_cadence" ? Response.json({}, { status: 429 }) : response(judgments[axis]);
    });
    const outcomes = await judgeConversationQualityAxes(privateCase, {
      ...options,
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(outcomes.map((outcome) => outcome.axis)).toEqual(QUALITY_AXES);
    expect(outcomes[0]).toEqual({ axis: "social_cadence", status: "failed", category: "http-rate-limit" });
    expect(outcomes.slice(1).every((outcome) => outcome.status === "completed")).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    const controller = new AbortController();
    controller.abort();
    expect(
      await judgeConversationQualityAxes(privateCase, {
        ...options,
        signal: controller.signal,
        fetchImpl: fetchImpl as typeof fetch,
      }),
    ).toEqual(QUALITY_AXES.map((axis) => ({ axis, status: "failed", category: "cancelled" })));
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });
});
