import { describe, expect, it, vi } from "vitest";
import { classificationAudit, IntentClassifier, JEV_INPUT_COST_PER_MILLION_TOKENS } from "./intent-classifier.js";
import { requiredAt } from "./test-invariants.js";

interface FetchCall {
  input: string;
  init: { method: string; headers: Record<string, string>; body: string };
}

function responseFor(payload: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => payload };
}

function classifiedResponse(overrides: Record<string, unknown> = {}) {
  return {
    model: "typesafe/jev-1.13-20260917",
    answers: {
      whole_room: { type: "noul", noul: 0.02 },
      primary_addressee: { type: "choice", choice: "codex-sol", confidence: 0.9 },
      "codex-sol": { type: "noul", noul: 0.94 },
      "claude-sonnet": { type: "noul", noul: 0.03 },
    },
    usage: { input_tokens: 1500, output_tokens: 60, cost: 0.000063 },
    ...overrides,
  };
}

const agents = [
  { agentId: "codex-sol" as const, name: "Sol" },
  { agentId: "claude-sonnet" as const, name: "Claude" },
];

describe("intent classifier", () => {
  it("rejects non-HTTPS endpoints before a request can be made", () => {
    expect(() => new IntentClassifier({ endpoint: "http://localhost:8787/api/alpha/decisions" })).toThrow("must use HTTPS");
  });

  it("returns undefined without any network attempt when no OpenRouter credential is readable", async () => {
    const fetchImpl = vi.fn();
    const classifier = new IntentClassifier({ apiKey: async () => undefined, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await classifier.available()).toBe(false);
    expect(await classifier.classify({ transcript: "Sol, thoughts?", agents })).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("never consults when the server-owned kill switch is set", async () => {
    const fetchImpl = vi.fn();
    const classifier = new IntentClassifier({ apiKey: () => "stored-key", disabled: true, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await classifier.available()).toBe(false);
    expect(await classifier.classify({ transcript: "Sol, thoughts?", agents })).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sends one decisions request through OpenRouter and projects the answers", async () => {
    const calls: FetchCall[] = [];
    let clock = 1_000;
    const classifier = new IntentClassifier({
      apiKey: () => "stored-openrouter-key",
      fetchImpl: (async (input: string, init: FetchCall["init"]) => {
        calls.push({ input, init });
        clock += 120;
        return responseFor(classifiedResponse());
      }) as unknown as typeof fetch,
      now: () => clock,
    });
    const snapshot = await classifier.classify({ transcript: "[YOU]\nSol, thoughts?", agents });
    expect(snapshot).toEqual({
      model: "typesafe/jev-1.13-20260917",
      agents: { "codex-sol": 0.94, "claude-sonnet": 0.03 },
      wholeRoom: 0.02,
      primaryAddressee: "codex-sol",
      usage: { inputTokens: 1500, outputTokens: 60 },
      costUsd: 0.000063,
      latencyMs: 120,
    });
    expect(calls).toHaveLength(1);
    const call=requiredAt(calls,0,"classifier request");
    expect(call.input).toBe("https://openrouter.ai/api/alpha/decisions");
    expect(call.init.method).toBe("POST");
    expect(call.init.headers.Authorization).toBe("Bearer stored-openrouter-key");
    const body = JSON.parse(call.init.body) as { model: string; state: string; questions: Record<string, { type: string }> };
    expect(body.model).toBe("~typesafe/jev-latest");
    expect(body.state).toBe("[YOU]\nSol, thoughts?");
    expect(Object.entries(body.questions).map(([id, question]) => [id, question.type])).toEqual(expect.arrayContaining([
      ["whole_room", "noul"],
      ["primary_addressee", "choice"],
      ["codex-sol", "noul"],
      ["claude-sonnet", "noul"],
    ]));
  });

  it("falls back to computed cost when OpenRouter omits usage cost", async () => {
    const classifier = new IntentClassifier({
      apiKey: () => "stored-openrouter-key",
      fetchImpl: (async () => responseFor(classifiedResponse({ usage: { input_tokens: 1500, output_tokens: 60 } }))) as unknown as typeof fetch,
    });
    const snapshot = await classifier.classify({ transcript: "Sol, thoughts?", agents });
    expect(snapshot?.costUsd).toBe((1500 / 1_000_000) * JEV_INPUT_COST_PER_MILLION_TOKENS);
  });

  it("fails open on transport errors, HTTP failures, and malformed answers", async () => {
    const cases: Array<unknown> = [
      responseFor(classifiedResponse(), false, 503),
      responseFor(null),
      responseFor({ answers: {} }),
      responseFor(classifiedResponse({ answers: { "codex-sol": { type: "noul", noul: 0.9 } } })),
    ];
    for (const payload of cases) {
      const classifier = new IntentClassifier({
        apiKey: () => "stored-openrouter-key",
        fetchImpl: (async () => payload) as unknown as typeof fetch,
      });
      expect(await classifier.classify({ transcript: "Sol, thoughts?", agents })).toBeUndefined();
    }
  });

  it("stops consulting after repeated failures until the cooldown elapses", async () => {
    let clock = 0;
    const fetchImpl = vi.fn(async () => { throw new Error("network down"); });
    const classifier = new IntentClassifier({
      apiKey: () => "stored-openrouter-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => clock,
    });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(await classifier.classify({ transcript: "Sol, thoughts?", agents })).toBeUndefined();
    }
    expect(await classifier.available()).toBe(false);
    expect(await classifier.classify({ transcript: "Sol, thoughts?", agents })).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    clock = 5 * 60_000 + 1;
    expect(await classifier.available()).toBe(true);
  });

  it("never logs message text or credentials", async () => {
    const logged: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const classifier = new IntentClassifier({
      apiKey: () => "secret-key",
      fetchImpl: (async () => { throw new Error("network down"); }) as unknown as typeof fetch,
      log: (level, event, fields) => { logged.push({ event, fields }); expect(level).toBe("warn"); },
    });
    await classifier.classify({ transcript: "PRIVATE ROOM TEXT Sol, thoughts?", agents });
    await classifier.classify({ transcript: "PRIVATE ROOM TEXT Sol, thoughts?", agents });
    await classifier.classify({ transcript: "PRIVATE ROOM TEXT Sol, thoughts?", agents });
    expect(logged).not.toHaveLength(0);
    for (const entry of logged) {
      expect(JSON.stringify(entry)).not.toContain("PRIVATE ROOM TEXT");
      expect(JSON.stringify(entry)).not.toContain("secret-key");
    }
  });

  it("skips classification for an empty transcript or empty roster", async () => {
    const fetchImpl = vi.fn();
    const classifier = new IntentClassifier({
      apiKey: () => "stored-openrouter-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await classifier.classify({ transcript: "   ", agents })).toBeUndefined();
    expect(await classifier.classify({ transcript: "Sol, thoughts?", agents: [] })).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("classification audit projection", () => {
  it("carries the consult metrics and the deterministic baseline", () => {
    const audit = classificationAudit(
      {
        model: "typesafe/jev-1.13-20260917",
        agents: { "codex-sol": 0.94 },
        wholeRoom: 0.02,
        primaryAddressee: "codex-sol",
        usage: { inputTokens: 1500, outputTokens: 60 },
        costUsd: 0.000063,
        latencyMs: 120,
      },
      [{ agent: "codex-sol", outcome: "invoke", reason: "fallback" }],
    );
    expect(audit).toEqual({
      model: "typesafe/jev-1.13-20260917",
      latencyMs: 120,
      inputTokens: 1500,
      outputTokens: 60,
      costUsd: 0.000063,
      wholeRoomProbability: 0.02,
      addressProbabilities: { "codex-sol": 0.94 },
      baseline: [{ agent: "codex-sol", outcome: "invoke", reason: "fallback" }],
    });
  });
});
