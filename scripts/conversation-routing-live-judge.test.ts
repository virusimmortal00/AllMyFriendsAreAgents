import { describe, expect, it, vi } from "vitest";
import {
  JudgeFailure,
  type JudgeScalarResult,
  judgeConversationCase,
  parsePrivateJudgeCase,
  selectHumanSpotChecks,
} from "./conversation-routing-live-judge.js";

const privateCase = {
  schemaVersion: 1,
  scenarioId: "direct-2",
  runId: "run-1",
  scenarioKind: "direct",
  expectedDirectAgents: ["agent-a"],
  prompt: "Agent A, please answer the fictional room question.",
  messages: [{ speaker: "agent-a", kind: "agent", text: "A brief fictional reply." }],
};
const judgment = {
  status: "rated",
  directMisses: 0,
  responsiveness: 4,
  naturalness: 4,
  distinctValue: 3,
  unnecessaryReplies: 0,
  duplicateReplies: 0,
  handoffCorrect: null,
  closureCorrect: true,
} as const;
const options = {
  model: "example/pinned-model",
  actorModel: "openrouter/example/actor-model",
  apiKey: "test-only-key-123456",
};

describe("private live conversation judge", () => {
  it("validates private bounded input without accepting policy, costs, or arbitrary fields", () => {
    expect(parsePrivateJudgeCase(privateCase).messages).toHaveLength(1);
    for (const extra of [{ routingPolicy: "enforce" }, { reportedCostUsd: 0.1 }, { url: "https://private.test" }]) {
      expect(() => parsePrivateJudgeCase({ ...privateCase, ...extra })).toThrow();
    }
    expect(() => parsePrivateJudgeCase({ ...privateCase, prompt: "x".repeat(4_001) })).toThrow();
    expect(() =>
      parsePrivateJudgeCase({ ...privateCase, messages: [{ ...privateCase.messages[0], output: "private" }] }),
    ).toThrow();
  });

  it("makes one strict structured-output call and returns only scalar judgments and separate judge usage", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.method).toBe("POST");
      const request = JSON.parse(String(init.body));
      expect(request.model).toBe(options.model);
      expect(request.provider.require_parameters).toBe(true);
      expect(request.response_format.type).toBe("json_schema");
      expect(request.response_format.json_schema.strict).toBe(true);
      expect(request.response_format.json_schema.schema.properties.directMisses.maximum).toBe(1);
      expect(request.response_format.json_schema.schema.properties.unnecessaryReplies.maximum).toBe(1);
      expect(JSON.stringify(request)).not.toContain("routingPolicy");
      expect(JSON.stringify(request)).not.toContain("reportedCostUsd");
      return Response.json({
        choices: [{ message: { content: JSON.stringify(judgment) } }],
        usage: { prompt_tokens: 40, completion_tokens: 20, cost: 0.001 },
      });
    });
    const result = await judgeConversationCase(privateCase, { ...options, fetchImpl: fetchImpl as typeof fetch });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      scenarioId: "direct-2",
      runId: "run-1",
      naturalness: 4,
      judgeUsage: { inputTokens: 40, outputTokens: 20, reportedCostUsd: 0.001 },
    });
    expect(JSON.stringify(result)).not.toContain(privateCase.prompt);
    expect(JSON.stringify(result)).not.toContain(privateCase.messages[0]!.text);
  });

  it("keeps unassessable scores null and rejects malformed/private output without echoing it", async () => {
    const response = (content: string) => vi.fn(async () => Response.json({ choices: [{ message: { content } }] }));
    const missing = {
      ...judgment,
      status: "not_assessable",
      responsiveness: null,
      naturalness: null,
      distinctValue: null,
    };
    const result = await judgeConversationCase(privateCase, {
      ...options,
      fetchImpl: response(JSON.stringify(missing)) as typeof fetch,
    });
    expect(result.status).toBe("not_assessable");
    expect(result.naturalness).toBeNull();
    expect(result.judgeUsage).toEqual({ inputTokens: null, outputTokens: null, reportedCostUsd: null });
    await expect(
      judgeConversationCase(privateCase, {
        ...options,
        fetchImpl: response(JSON.stringify({ ...judgment, explanation: "secret output" })) as typeof fetch,
      }),
    ).rejects.toThrow("Judge request or result failed; private content was not exported.");
    await expect(
      judgeConversationCase(privateCase, {
        ...options,
        fetchImpl: vi.fn(async () => Response.json({ error: "secret key" }, { status: 401 })) as typeof fetch,
      }),
    ).rejects.toThrow("Judge request or result failed; private content was not exported.");
    await expect(
      judgeConversationCase(privateCase, {
        ...options,
        fetchImpl: vi.fn(async () => new Response("x".repeat(32_769))) as typeof fetch,
      }),
    ).rejects.toThrow("Judge request or result failed; private content was not exported.");
    await expect(judgeConversationCase(privateCase, { ...options, actorModel: options.model })).rejects.toThrow(
      "Judge configuration is invalid.",
    );
  });

  it("aligns broadcast count bounds and returns only closed failure categories", async () => {
    const broadcast = { ...privateCase, scenarioKind: "broadcast", expectedDirectAgents: [] };
    const requests: number[] = [];
    const schemaFailure = async (_url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body));
      requests.push(request.response_format.json_schema.schema.properties.directMisses.maximum);
      return Response.json({
        choices: [
          { message: { content: JSON.stringify({ ...judgment, directMisses: 1, rationale: "private reply" }) } },
        ],
      });
    };
    await expect(
      judgeConversationCase(broadcast, { ...options, fetchImpl: schemaFailure as typeof fetch }),
    ).rejects.toMatchObject({ category: "judgment-schema" });
    expect(requests).toEqual([0]);
    const categories = [
      [Response.json({ error: "private key" }, { status: 401 }), "http-auth"],
      [Response.json({ error: "private key" }, { status: 429 }), "http-rate-limit"],
      [new Response("not-json"), "response-json"],
      [new Response("x".repeat(32_769)), "response-too-large"],
      [Response.json({ choices: [] }), "response-shape"],
    ] as const;
    for (const [response, category] of categories) {
      try {
        await judgeConversationCase(broadcast, { ...options, fetchImpl: (async () => response) as typeof fetch });
        throw new Error("Expected the judge fixture to fail.");
      } catch (error) {
        expect(error).toBeInstanceOf(JudgeFailure);
        expect(error).toMatchObject({ category });
        expect(
          JSON.stringify({ category: (error as JudgeFailure).category, message: (error as Error).message }),
        ).not.toContain("private key");
      }
    }
  });

  it("selects discordance, low scores, then a seeded sample without output text", () => {
    const make = (runId: string, changes: Partial<JudgeScalarResult> = {}): JudgeScalarResult => ({
      schemaVersion: 1,
      scenarioId: "direct-2",
      runId,
      judgeModel: options.model,
      ...judgment,
      judgeUsage: { inputTokens: null, outputTokens: null, reportedCostUsd: null },
      ...changes,
    });
    const rows = [make("high-a"), make("low", { naturalness: 2 }), make("discordant"), make("high-b")];
    const human = [{ scenarioId: "direct-2", runId: "discordant", score: 1 as const }];
    const selected = selectHumanSpotChecks(rows, human, { seed: "pilot-1", maxCases: 3 });
    expect(selected.map((row) => row.reason)).toEqual([
      "judge-human-discordance",
      "low-or-unassessable",
      "seeded-sample",
    ]);
    expect(selectHumanSpotChecks(rows, human, { seed: "pilot-1", maxCases: 3 })).toEqual(selected);
    expect(() => selectHumanSpotChecks([rows[0]!, rows[0]!], [], { seed: "pilot-1", maxCases: 2 })).toThrow();
  });
});
