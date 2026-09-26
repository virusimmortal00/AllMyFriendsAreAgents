import { describe, expect, it, vi } from "vitest";
import { CALIBRATION_PROBES } from "./conversation-routing-judge-calibration-fixtures.js";
import { main, runCalibration } from "./conversation-routing-judge-calibration.js";

const judgeModel = "google/gemini-3.8-flash";
const actorModel = "openrouter/anthropic/claude-haiku-4.5";

function judgment(axis: string, degraded: boolean, scoreOverride?: number, spuriousMachinery = false) {
  const score =
    scoreOverride ?? (degraded ? (axis === "social_cadence" || axis === "preface-vs-machinery" ? 3 : 1) : 5);
  const base = { status: "rated", score, reasonCode: "observable_exchange" };
  switch (axis) {
    case "social_cadence":
      return {
        ...base,
        details: { cueFit: degraded ? "missed" : "attuned", textTurnRhythm: degraded ? "disruptive" : "smooth" },
      };
    case "length_fit":
      return { ...base, details: { direction: degraded ? "too_long" : "appropriate" } };
    case "address_radius":
      return {
        ...base,
        details: { observedAudience: degraded ? "agent" : "user", audienceFit: degraded ? "misdirected" : "aligned" },
      };
    case "contribution_value":
      return { ...base, details: { valueMode: degraded ? "neither" : "knowledge" } };
    default:
      return {
        ...base,
        details: {
          frameRejection: degraded && axis !== "preface-vs-machinery" ? "present" : "absent",
          privateMachineryLeak:
            (degraded && axis === "preface-vs-machinery") || spuriousMachinery ? "present" : "absent",
          peerAmplification: degraded && axis === "peer-amplification" ? "present" : "absent",
        },
      };
  }
}

function fakeJudge(scoreOverride?: (index: number) => number | undefined, spuriousMachinery = false) {
  let index = 0;
  return vi.fn(async (_url: string | URL | Request, init: RequestInit) => {
    const request = JSON.parse(String(init.body));
    const probe = CALIBRATION_PROBES[Math.floor(index / 2)]!;
    const degraded = index % 2 === 1;
    const schema = request.response_format.json_schema.name;
    expect(request.model).toBe(judgeModel);
    expect(request.temperature).toBe(0);
    expect(schema).toBe(probe.axis === "frame_integrity" ? "room_frame_integrity_v1" : `room_${probe.axis}_v2`);
    expect(request.messages[0].content).toContain("untrusted data");
    expect(request.messages[1].content).toContain('"originalHumanAlias":"Avery"');
    expect(request.messages[1].content).not.toContain('"speaker":"jordan"');
    const outcome = judgment(
      probe.axis === "frame_integrity" ? probe.id : probe.axis,
      degraded,
      scoreOverride?.(index),
      spuriousMachinery && index === 12,
    );
    index++;
    return Response.json({
      model: judgeModel,
      choices: [{ finish_reason: "stop", message: { content: JSON.stringify(outcome) } }],
      usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0.001 },
    });
  });
}

describe("conversation judge calibration", () => {
  it("runs each normal/degraded control through exactly one existing independent rubric", async () => {
    const fetchImpl = fakeJudge();
    const report = await runCalibration({
      judgeModel,
      actorModel,
      apiKey: "test-key",
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(14);
    expect(report.plannedCalls).toBe(14);
    expect(report.observedCalls).toBe(14);
    expect(report.probesPassed).toBe(7);
    expect(report.rows.map((row) => row.axis)).toEqual(CALIBRATION_PROBES.map((probe) => probe.axis));
    expect(report.rows.every((row) => row.passed)).toBe(true);
    expect(report.rows[5]?.degraded.flags?.peerAmplification).toBe("present");
    expect(report.rows[6]?.degraded.flags?.privateMachineryLeak).toBe("present");
    expect(report.rows[6]?.normal.flags?.privateMachineryLeak).toBe("absent");
    expect(report.reportedCostUsd).toBeCloseTo(0.014);
    expect(JSON.stringify(report)).not.toContain("sketchbooks");
    expect(JSON.stringify(report)).not.toContain("coding assistant");
  });

  it("identifies ceiling false negatives rather than silently treating 5s as sensitivity", async () => {
    const fetchImpl = fakeJudge((index) => (index === 1 || index === 3 || index === 7 ? 5 : undefined));
    const report = await runCalibration({
      judgeModel,
      actorModel,
      apiKey: "test-key",
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(report.probesPassed).toBe(4);
    expect(report.rows[0]?.failures).toContain("degraded_above_ceiling");
    expect(report.rows[1]?.failures).toContain("gap_too_small");
    expect(report.rows[3]?.passed).toBe(false);
  });

  it("flags a false positive on an ordinary planning preface", async () => {
    const fetchImpl = fakeJudge((index) => (index === 12 ? 3 : undefined), true);
    const report = await runCalibration({
      judgeModel,
      actorModel,
      apiKey: "test-key",
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(report.rows[6]?.failures).toContain("spurious_privateMachineryLeak");
    expect(report.rows[6]?.failures).toContain("normal_below_floor");
    expect(report.rows[6]?.passed).toBe(false);
  });

  it("keeps provider failure as a closed missing rating", async () => {
    const base = fakeJudge();
    let terminalCalls = 0;
    const finalFetch = vi.fn(async (...args: Parameters<typeof fetch>) => {
      terminalCalls++;
      return terminalCalls === 14
        ? new Response("provider details must stay private", { status: 429 })
        : base(args[0], args[1] ?? {});
    });
    const report = await runCalibration({
      judgeModel,
      actorModel,
      apiKey: "test-key",
      fetchImpl: finalFetch as typeof fetch,
    });
    expect(report.observedCalls).toBe(14);
    expect(report.probesPassed).toBe(6);
    expect(report.rows[6]?.degraded).toMatchObject({
      status: "failed",
      failureCategory: "http-rate-limit",
      score: null,
    });
    expect(report.reportedCostUsd).toBeNull();
    expect(JSON.stringify(report)).not.toContain("provider details");
  });

  it("previews without a key and rejects ambiguous paid setup", async () => {
    const preview = await main(["--dry-run", "--judge-model", judgeModel, "--actor-model", actorModel], {});
    expect(preview).toMatchObject({ plannedCalls: 14, judgeModel, actorModel });
    expect(JSON.stringify(preview)).not.toContain("sketchbooks");
    await expect(
      main(["--allow-paid", "--judge-model", judgeModel, "--actor-model", actorModel], {}),
    ).rejects.toThrow();
    await expect(
      main(["--dry-run", "--allow-paid", "--judge-model", judgeModel, "--actor-model", actorModel], {}),
    ).rejects.toThrow();
  });
});
