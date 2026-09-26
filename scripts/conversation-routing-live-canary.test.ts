import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  type AvailabilityCheckV1,
  actorModelForCase,
  buildPrivateReviewPayload,
  CANARY_SOURCE_FILES,
  checkIsolatedRosterAvailability,
  isolatedRoomSystemProfileEnvironment,
  matchesPinnedJevResolution,
  parseLiveCanaryOptions,
  projectCaseFailedEvent,
  projectFailedCaseEvidence,
  projectPairCompleteProgress,
  stopProcessGroup,
  validateQualityJudgeObservation,
} from "./conversation-routing-live-canary.js";
import type { LiveScenarioResult } from "./conversation-routing-live-evidence.js";
import { JudgeFailure } from "./conversation-routing-live-judge.js";
import type { QualityAxisOutcome } from "./conversation-routing-live-judge-v2.js";
import { buildLiveScenario, pilotScenarios } from "./conversation-routing-live-scenarios.js";
import { parseStudyPlan } from "./conversation-routing-live-study.js";

const base = [
  "--model",
  "openrouter/anthropic/claude-haiku-4.5",
  "--opencode",
  "/fixture/opencode",
  "--secret-launcher",
  "/fixture/bws-run",
];
const execute = promisify(execFile);
const fixtureCsrf = "11111111-2222-4333-8444-555555555555";

describe("isolated identity study execution", () => {
  it("prints one V4 pair with per-case models and no prompt text or credentials", async () => {
    const { stdout } = await execute(
      "pnpm",
      [
        "exec",
        "tsx",
        "scripts/conversation-routing-live-canary.ts",
        "--dry-run",
        "--study-plan",
        path.resolve("docs/testing/conversation-routing-study-model-v4.json"),
        "--model",
        "openrouter/anthropic/claude-haiku-4.5",
        "--jev-model",
        "typesafe/jev-1.13",
        "--judge-model",
        "openrouter/google/gemini-3.8-flash",
        "--judge-rubric",
        "v3",
        "--batch-index",
        "0",
        "--pairs-per-batch",
        "1",
        "--max-cases",
        "6",
        "--max-judge-calls",
        "10",
        "--max-generations",
        "1",
        "--timeout-ms",
        "120000",
        "--total-timeout-ms",
        "900000",
      ],
      { env: { ...process.env, OPENROUTER_API_KEY: "", AMFAA_CANARY_ALLOW_REAL_PROVIDER: "false" } },
    );
    const projected = JSON.parse(stdout) as {
      actorModelScope: string;
      cases: Array<{ actorModel: string }>;
      maximumScheduledJudgeCalls: number;
      maxGenerationsPerCase: number;
    };
    expect(projected.actorModelScope).toBe("per-case-v1");
    expect(projected.cases.map(({ actorModel }) => actorModel)).toEqual([
      "openrouter/anthropic/claude-sonnet-4.6",
      "openrouter/anthropic/claude-haiku-4.5",
    ]);
    expect(projected.maximumScheduledJudgeCalls).toBe(10);
    expect(projected.maxGenerationsPerCase).toBe(1);
    expect(stdout).not.toMatch(/reusable cups|frozen spinach|bus leaves|OPENROUTER_API_KEY/i);
  });
  it("selects each V4 case model and rejects unsafe defaults and judge overlap", async () => {
    const study = parseStudyPlan(
      JSON.parse(await readFile("docs/testing/conversation-routing-study-model-v4.json", "utf8")),
    );
    const args = [
      "--dry-run",
      "--study-plan",
      "/fixture/model.json",
      "--model",
      "openrouter/anthropic/claude-haiku-4.5",
      "--jev-model",
      "typesafe/jev-1.13",
      "--judge-model",
      "openrouter/google/gemini-3.8-flash",
      "--judge-rubric",
      "v3",
      "--max-cases",
      "6",
      "--max-judge-calls",
      "30",
      "--max-generations",
      "1",
      "--timeout-ms",
      "120000",
      "--total-timeout-ms",
      "2400000",
    ];
    const selected = parseLiveCanaryOptions(args, {}, study);
    expect(selected.cases).toHaveLength(6);
    expect(selected.cases.map((scenario) => actorModelForCase(scenario, selected.model))).toEqual(
      selected.cases.map((scenario) => (scenario.study?.schemaVersion === 4 ? scenario.study.actorModelId : "")),
    );
    expect(new Set(selected.cases.map((scenario) => actorModelForCase(scenario, selected.model)))).toEqual(
      new Set(["openrouter/anthropic/claude-haiku-4.5", "openrouter/anthropic/claude-sonnet-4.6"]),
    );
    expect(selected.cases.map(({ study }) => isolatedRoomSystemProfileEnvironment(study))).toContainEqual({
      AMFAA_ROUTING_ROOM_SYSTEM_PROFILE: "room-v1",
      AMFAA_ROUTING_TERMINAL_INSTRUCTION_PROFILE: "contribution-first-v1",
    });
    const changedDefault = [...args];
    changedDefault[changedDefault.indexOf("--model") + 1] = "openrouter/anthropic/claude-sonnet-4.6";
    expect(() => parseLiveCanaryOptions(changedDefault, {}, study)).toThrow("declared Haiku default");
    expect(() =>
      parseLiveCanaryOptions(
        args.filter((_, index) => index !== args.indexOf("--model") && index !== args.indexOf("--model") + 1),
        { AMFAA_ROUTING_ROOM_MODEL: "openrouter/anthropic/claude-haiku-4.5" },
        study,
      ),
    ).toThrow("declared Haiku default");
    const judgeOverlap = [...args];
    judgeOverlap[judgeOverlap.indexOf("--judge-model") + 1] = "openrouter/anthropic/claude-sonnet-4.6";
    expect(() => parseLiveCanaryOptions(judgeOverlap, {}, study)).toThrow("both actor models");
    const broken = selected.cases[0]!.study as Extract<
      NonNullable<(typeof selected.cases)[number]["study"]>,
      { schemaVersion: 4 }
    >;
    expect(() => isolatedRoomSystemProfileEnvironment({ ...broken, scenarioProfileDigest: "0".repeat(64) })).toThrow();
  });
  it("prints the V2 identity plan before credential access without fixture text", async () => {
    const { stdout } = await execute(
      "pnpm",
      [
        "exec",
        "tsx",
        "scripts/conversation-routing-live-canary.ts",
        "--dry-run",
        "--allow-wide-matrix",
        "--study-plan",
        path.resolve("docs/testing/conversation-routing-study-identity-v2.json"),
        "--model",
        "openrouter/anthropic/claude-haiku-4.5",
        "--jev-model",
        "typesafe/jev-1.13",
        "--judge-model",
        "openrouter/google/gemini-3.8-flash",
        "--judge-rubric",
        "v3",
        "--max-cases",
        "12",
        "--max-judge-calls",
        "130",
        "--max-generations",
        "18",
        "--timeout-ms",
        "120000",
        "--total-timeout-ms",
        "9000000",
      ],
      { env: { ...process.env, OPENROUTER_API_KEY: "", AMFAA_CANARY_ALLOW_REAL_PROVIDER: "false" } },
    );
    const projected = JSON.parse(stdout) as Record<string, unknown>;
    expect(projected).toMatchObject({
      kind: "conversation-routing-study-dry-run",
      maximumScheduledJudgeCalls: 130,
      planningAllowanceMs: 7_630_000,
    });
    expect(projected.cases as unknown[]).toHaveLength(12);
    expect(stdout).not.toMatch(/garden path|path material|wooden|metal sign/i);
  });
  it("binds the fifth rubric and profile implementation to the source fingerprint", () => {
    expect(CANARY_SOURCE_FILES).toContain("scripts/conversation-routing-live-frame-judge.ts");
    expect(CANARY_SOURCE_FILES).toContain("scripts/conversation-routing-live-study.ts");
    expect(CANARY_SOURCE_FILES).toContain("scripts/conversation-routing-live-scenarios.ts");
    expect(CANARY_SOURCE_FILES).toContain("server/agent-runner.ts");
  });
  it("passes only a validated V2 selector and budgets all five rubric calls per trigger", async () => {
    const study = parseStudyPlan(
      JSON.parse(await readFile("docs/testing/conversation-routing-study-identity-v2.json", "utf8")),
    );
    const args = [
      "--allow-wide-matrix",
      "--study-plan",
      "/fixture/identity.json",
      "--model",
      "openrouter/anthropic/claude-haiku-4.5",
      "--jev-model",
      "typesafe/jev-1.13",
      "--judge-model",
      "openrouter/google/gemini-3.8-flash",
      "--judge-rubric",
      "v3",
      "--opencode",
      "/fixture/opencode",
      "--secret-launcher",
      "/fixture/bws-run",
      "--max-cases",
      "12",
      "--max-judge-calls",
      "130",
      "--max-generations",
      "18",
      "--timeout-ms",
      "120000",
      "--total-timeout-ms",
      "9000000",
    ];
    const options = parseLiveCanaryOptions(args, {}, study);
    expect(options.maxJudgeCalls).toBe(130);
    expect(options.cases).toHaveLength(12);
    expect(options.studyPlan?.schemaVersion).toBe(2);
    expect(options.cases.map(({ study: meta }) => isolatedRoomSystemProfileEnvironment(meta))).toContainEqual({
      AMFAA_ROUTING_ROOM_SYSTEM_PROFILE: "legacy-v1",
    });
    expect(isolatedRoomSystemProfileEnvironment(undefined)).toEqual({});
    expect(
      isolatedRoomSystemProfileEnvironment(
        parseLiveCanaryOptions(
          [
            "--study-plan",
            "/fixture/v1.json",
            "--model",
            "openrouter/anthropic/claude-haiku-4.5",
            "--jev-model",
            "typesafe/jev-1.13",
            "--opencode",
            "/fixture/opencode",
            "--secret-launcher",
            "/fixture/bws-run",
            "--max-cases",
            "12",
            "--max-generations",
            "18",
            "--timeout-ms",
            "120000",
            "--total-timeout-ms",
            "7200000",
          ],
          {},
          parseStudyPlan(JSON.parse(await readFile("docs/testing/conversation-routing-study-example.json", "utf8"))),
        ).cases[0]?.study,
      ),
    ).toEqual({});
    const low = [...args];
    low[low.indexOf("--max-judge-calls") + 1] = "129";
    expect(() => parseLiveCanaryOptions(low, {}, study)).toThrow("judge-call cap");
    const v2Rubric = [...args];
    v2Rubric[v2Rubric.indexOf("--judge-rubric") + 1] = "v2";
    expect(() => parseLiveCanaryOptions(v2Rubric, {}, study)).toThrow("frame-integrity rubric v3");
    expect(() =>
      parseLiveCanaryOptions(args, {}, {
        ...study,
        blocks: [{ ...study.blocks[0], scenarioProfileId: "garden-v1" }],
      } as never),
    ).toThrow();
  });
  it("passes the V3 terminal selector with a 30-call dry-run cap and rejects a smaller cap", async () => {
    const study = parseStudyPlan(
      JSON.parse(await readFile("docs/testing/conversation-routing-study-terminal-v3.json", "utf8")),
    );
    const args = [
      "--dry-run",
      "--study-plan",
      "/fixture/terminal.json",
      "--model",
      "openrouter/anthropic/claude-haiku-4.5",
      "--jev-model",
      "typesafe/jev-1.13",
      "--judge-model",
      "openrouter/google/gemini-3.8-flash",
      "--judge-rubric",
      "v3",
      "--max-cases",
      "6",
      "--max-judge-calls",
      "30",
      "--max-generations",
      "1",
      "--timeout-ms",
      "120000",
      "--total-timeout-ms",
      "2400000",
    ];
    const selected = parseLiveCanaryOptions(args, {}, study);
    expect(selected.cases).toHaveLength(6);
    expect(selected.maxJudgeCalls).toBe(30);
    expect(selected.cases.map(({ study: metadata }) => isolatedRoomSystemProfileEnvironment(metadata))).toContainEqual({
      AMFAA_ROUTING_ROOM_SYSTEM_PROFILE: "room-v1",
      AMFAA_ROUTING_TERMINAL_INSTRUCTION_PROFILE: "contribution-first-v1",
    });
    const tooFew = [...args];
    tooFew[tooFew.indexOf("--max-judge-calls") + 1] = "29";
    expect(() => parseLiveCanaryOptions(tooFew, {}, study)).toThrow("judge-call cap");
    const noIsolation = selected.cases[0]!.study as Extract<
      NonNullable<(typeof selected.cases)[number]["study"]>,
      { schemaVersion: 3 }
    >;
    expect(() =>
      isolatedRoomSystemProfileEnvironment({ ...noIsolation, terminalInstructionProfileDigest: "0".repeat(64) }),
    ).toThrow();
  });
});

const lengthOutcome = (
  reasonCode: "required_reply_missing" | "silence_fit" | "observable_exchange",
): QualityAxisOutcome => ({
  axis: "length_fit",
  status: "completed",
  result: {
    schemaVersion: 2,
    rubricVersion: "room-quality-v2",
    scenarioId: "fixture",
    runId: "run-fixture",
    judgeModel: "google/pinned-judge",
    resolvedJudgeModel: null,
    axis: "length_fit",
    status: "rated",
    score: reasonCode === "required_reply_missing" ? 1 : 3,
    reasonCode,
    details: { direction: reasonCode === "required_reply_missing" ? "too_short" : "appropriate" },
    judgeUsage: { inputTokens: null, outputTokens: null, reportedCostUsd: null },
  },
});

describe("quality judge acquisition semantics", () => {
  it("downgrades a missing-reply obligation contradicted by authoritative routing", () => {
    expect(validateQualityJudgeObservation([lengthOutcome("required_reply_missing")], 0, 0)).toEqual([
      { axis: "length_fit", status: "failed", category: "judgment-schema" },
    ]);
    expect(validateQualityJudgeObservation([lengthOutcome("required_reply_missing")], 0, 1)).toEqual([
      lengthOutcome("required_reply_missing"),
    ]);
  });

  it("keeps valid optional silence and visible replies but rejects a reply claim without delivery", () => {
    expect(validateQualityJudgeObservation([lengthOutcome("silence_fit")], 0, 0)).toEqual([
      lengthOutcome("silence_fit"),
    ]);
    expect(validateQualityJudgeObservation([lengthOutcome("observable_exchange")], 1, 0)).toEqual([
      lengthOutcome("observable_exchange"),
    ]);
    expect(validateQualityJudgeObservation([lengthOutcome("observable_exchange")], 0, 0)).toEqual([
      { axis: "length_fit", status: "failed", category: "judgment-schema" },
    ]);
  });
});

async function withAvailabilityServer(
  input: {
    initialStatus: string;
    initialReason: string;
    refreshedStatus?: string;
    refreshedReason?: string;
    refreshHttpStatus?: number;
  },
  check: (base: string, requests: Array<{ route: string; method: string; authorized: boolean }>) => Promise<void>,
) {
  const requests: Array<{ route: string; method: string; authorized: boolean }> = [];
  let refreshed = false;
  const server = createServer((request, response) => {
    const route = request.url ?? "";
    const authorized =
      request.headers.cookie === "fixture-session=known" && request.headers["x-amfaa-csrf"] === fixtureCsrf;
    requests.push({ route, method: request.method ?? "", authorized });
    response.setHeader("content-type", "application/json");
    if (route === "/api/model-discovery/refresh") {
      response.statusCode = authorized ? (input.refreshHttpStatus ?? 200) : 403;
      if (response.statusCode === 200) refreshed = true;
      response.end(JSON.stringify({ status: refreshed ? input.refreshedStatus : input.initialStatus }));
      return;
    }
    if (route !== "/api/roster") {
      response.statusCode = 404;
      response.end("{}");
      return;
    }
    const status = refreshed ? input.refreshedStatus : input.initialStatus;
    const reason = refreshed ? input.refreshedReason : input.initialReason;
    response.end(
      JSON.stringify({
        modelDiscovery: { status },
        participantAvailability: {
          "codex-sol": reason ? { available: false, reason } : { available: true },
        },
        access: { kind: "room-member", csrfToken: fixtureCsrf },
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture server port is unavailable.");
    await check(`http://127.0.0.1:${address.port}`, requests);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("routing canary selection", () => {
  it("refreshes one transient discovery error with the room-member CSRF token before a prompt", async () => {
    await withAvailabilityServer(
      { initialStatus: "error", initialReason: "runtime_unavailable", refreshedStatus: "available" },
      async (base, requests) => {
        const result = await checkIsolatedRosterAvailability(base, "fixture-session=known", ["codex-sol"]);
        expect(result).toEqual({
          available: true,
          check: {
            initialDiscoveryStatus: "error",
            initialUnavailableReasons: ["runtime_unavailable"],
            refreshAttempted: true,
            finalDiscoveryStatus: "available",
            finalUnavailableReasons: [],
            recovered: true,
          },
        });
        expect(requests).toEqual([
          { route: "/api/roster", method: "GET", authorized: false },
          { route: "/api/model-discovery/refresh", method: "POST", authorized: true },
          { route: "/api/roster", method: "GET", authorized: false },
        ]);
      },
    );
  });

  it("fails closed when the authenticated refresh is denied", async () => {
    await withAvailabilityServer(
      { initialStatus: "error", initialReason: "runtime_unavailable", refreshHttpStatus: 403 },
      async (base, requests) => {
        const result = await checkIsolatedRosterAvailability(base, "fixture-session=known", ["codex-sol"]);
        expect(result.available).toBe(false);
        expect(result.check).toMatchObject({ refreshAttempted: true, recovered: false, finalDiscoveryStatus: "error" });
        expect(requests.map(({ route }) => route)).toEqual(["/api/roster", "/api/model-discovery/refresh"]);
        expect(requests[1]?.authorized).toBe(true);
      },
    );
  });

  it("does not proceed when the single refresh leaves discovery unavailable", async () => {
    await withAvailabilityServer(
      {
        initialStatus: "error",
        initialReason: "runtime_unavailable",
        refreshedStatus: "error",
        refreshedReason: "runtime_unavailable",
      },
      async (base, requests) => {
        const result = await checkIsolatedRosterAvailability(base, "fixture-session=known", ["codex-sol"]);
        expect(result.available).toBe(false);
        expect(result.check).toMatchObject({ refreshAttempted: true, finalDiscoveryStatus: "error", recovered: false });
        expect(requests.map(({ route }) => route)).toEqual([
          "/api/roster",
          "/api/model-discovery/refresh",
          "/api/roster",
        ]);
      },
    );
  });

  it.each([
    { status: "authentication_required", reason: "runtime_unavailable" },
    { status: "configuration_required", reason: "runtime_unavailable" },
    { status: "runtime_incompatible", reason: "runtime_unavailable" },
    { status: "available", reason: "model_removed" },
  ])("never refreshes $status/$reason exclusions", async ({ status, reason }) => {
    await withAvailabilityServer({ initialStatus: status, initialReason: reason }, async (base, requests) => {
      const result = await checkIsolatedRosterAvailability(base, "fixture-session=known", ["codex-sol"]);
      expect(result.available).toBe(false);
      expect(result.check.refreshAttempted).toBe(false);
      expect(requests.map(({ route }) => route)).toEqual(["/api/roster"]);
    });
  });
  it("selects six bounded whole-pair batches from the 72-case plan", async () => {
    const study = parseStudyPlan(
      JSON.parse(await readFile("docs/testing/conversation-routing-study-large-v1.json", "utf8")),
    );
    const shared = [
      "--study-plan",
      "/fixture/large-study.json",
      "--allow-large-study",
      "--allow-wide-matrix",
      "--model",
      "openrouter/anthropic/claude-haiku-4.5",
      "--jev-model",
      "typesafe/jev-1.13",
      "--judge-model",
      "openrouter/google/gemini-3.8-flash",
      "--judge-rubric",
      "v2",
      "--max-cases",
      "72",
      "--max-judge-calls",
      "144",
      "--max-generations",
      "24",
      "--timeout-ms",
      "120000",
      "--total-timeout-ms",
      "10800000",
      "--pairs-per-batch",
      "6",
      "--dry-run",
    ];
    const batches = Array.from({ length: 6 }, (_, index) =>
      parseLiveCanaryOptions([...shared, "--batch-index", String(index)], { OPENROUTER_API_KEY: "" }, study),
    );
    expect(batches.every(({ cases }) => cases.length === 12)).toBe(true);
    expect(batches.every(({ studyBatch }) => studyBatch?.batchCount === 6 && studyBatch.pairCount === 6)).toBe(true);
    expect(new Set(batches.flatMap(({ cases }) => cases.map(({ study: meta }) => meta?.caseId))).size).toBe(72);
    for (const batch of batches) {
      const exactJudgeCalls = batch.cases.reduce(
        (sum, scenario) => sum + 4 * (1 + (scenario.scriptedFollowups?.length ?? 0)),
        0,
      );
      expect(batch.maxJudgeCalls).toBe(exactJudgeCalls);
      expect(batch.maxJudgeCalls).toBeLessThanOrEqual(144);
      expect(batch.planningAllowanceMs).toBeLessThanOrEqual(batch.totalTimeoutMs);
      expect(batch.studyBatch?.pairIds).toEqual([...new Set(batch.cases.map(({ study: meta }) => meta?.pairId))]);
      expect(
        batch.cases.every(
          ({ agentCount, scriptedFollowups }) =>
            agentCount * (1 + (scriptedFollowups?.length ?? 0)) <= batch.maxGenerations,
        ),
      ).toBe(true);
    }
    const rerun = parseLiveCanaryOptions([...shared, "--batch-index", "0"], { OPENROUTER_API_KEY: "" }, study);
    expect(rerun.cases.map(({ study: meta }) => meta?.caseId)).toEqual(
      batches[0]?.cases.map(({ study: meta }) => meta?.caseId),
    );
    const withoutLarge = shared.filter((part) => part !== "--allow-large-study");
    expect(() => parseLiveCanaryOptions([...withoutLarge, "--batch-index", "0"], {}, study)).toThrow(
      "Maximum cases is out of range",
    );
    const withoutBatch = shared.filter(
      (part, index) => part !== "--pairs-per-batch" && shared[index - 1] !== "--pairs-per-batch",
    );
    expect(() => parseLiveCanaryOptions(withoutBatch, {}, study)).toThrow("explicit whole-pair batch");
    expect(() => parseLiveCanaryOptions([...shared, "--batch-index", "6"], {}, study)).toThrow("batch index");
    const tooFewJudges = [...shared];
    tooFewJudges[tooFewJudges.indexOf("--max-judge-calls") + 1] = "4";
    expect(() => parseLiveCanaryOptions([...tooFewJudges, "--batch-index", "0"], {}, study)).toThrow("judge-call cap");
  });

  it("publishes batch progress only after both distinct arms complete", () => {
    const a = { study: { pairId: "garden-pair-r1", arm: "a" as const } };
    const b = { study: { pairId: "garden-pair-r1", arm: "b" as const } };
    const nextA = { study: { pairId: "garden-pair-r2", arm: "a" as const } };
    const nextB = { study: { pairId: "garden-pair-r2", arm: "b" as const } };
    expect(projectPairCompleteProgress([])).toBeNull();
    expect(projectPairCompleteProgress([a])).toBeNull();
    expect(projectPairCompleteProgress([a, b])).toMatchObject({
      event: "pair-complete",
      pairId: "garden-pair-r1",
      completedPairs: 1,
      cases: [a, b],
    });
    expect(projectPairCompleteProgress([a, b, nextA])).toBeNull();
    expect(projectPairCompleteProgress([a, b, nextA, nextB])).toMatchObject({
      pairId: "garden-pair-r2",
      completedPairs: 2,
      cases: [nextA, nextB],
    });
    expect(() => projectPairCompleteProgress([a, { study: { pairId: "other", arm: "b" } }])).toThrow();
    expect(() => projectPairCompleteProgress([a, a])).toThrow();
  });

  it("dry-runs an expanded batch without a credential or live executable", async () => {
    const { stdout } = await execute(
      "pnpm",
      [
        "exec",
        "tsx",
        "scripts/conversation-routing-live-canary.ts",
        "--dry-run",
        "--study-plan",
        path.resolve("docs/testing/conversation-routing-study-large-v1.json"),
        "--allow-large-study",
        "--allow-wide-matrix",
        "--pairs-per-batch",
        "6",
        "--batch-index",
        "5",
        "--model",
        "openrouter/anthropic/claude-haiku-4.5",
        "--jev-model",
        "typesafe/jev-1.13",
        "--judge-model",
        "openrouter/google/gemini-3.8-flash",
        "--judge-rubric",
        "v2",
        "--max-cases",
        "72",
        "--max-judge-calls",
        "144",
        "--max-generations",
        "24",
        "--timeout-ms",
        "120000",
        "--total-timeout-ms",
        "10800000",
      ],
      { env: { ...process.env, AMFAA_CANARY_ALLOW_REAL_PROVIDER: "false", OPENROUTER_API_KEY: "" } },
    );
    const printed = JSON.parse(stdout) as Record<string, unknown>;
    expect(printed).toMatchObject({
      kind: "conversation-routing-study-dry-run",
      studyBatch: { batchIndex: 5, batchCount: 6, pairCount: 6, planCaseCount: 72, planPairCount: 36 },
      maximumScheduledJudgeCalls: 72,
      watchdogCoversPlanningAllowance: true,
    });
    expect(printed.cases as unknown[]).toHaveLength(12);
    expect(stdout).not.toContain("OPENROUTER_API_KEY");
    expect(stdout).not.toContain("Avery:");
  });

  it("rejects an invalid expanded plan before credential or executable access", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "amfaa-routing-invalid-study-"));
    const file = path.join(root, "invalid.json");
    try {
      await writeFile(file, JSON.stringify({ schemaVersion: 1, planId: "invalid" }));
      await expect(
        execute(
          "pnpm",
          [
            "exec",
            "tsx",
            "scripts/conversation-routing-live-canary.ts",
            "--study-plan",
            file,
            "--model",
            "openrouter/anthropic/claude-haiku-4.5",
            "--opencode",
            "/missing/opencode",
            "--secret-launcher",
            "/missing/bws-run",
          ],
          { env: { ...process.env, AMFAA_CANARY_ALLOW_REAL_PROVIDER: "false", OPENROUTER_API_KEY: "" } },
        ),
      ).rejects.toMatchObject({ stdout: "" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("accepts only the pinned Jev release or its valid dated snapshot family", () => {
    expect(matchesPinnedJevResolution("typesafe/jev-1.13", "typesafe/jev-1.13")).toBe(true);
    expect(matchesPinnedJevResolution("typesafe/jev-1.13", "typesafe/jev-1.13-20260917")).toBe(true);
    expect(matchesPinnedJevResolution("typesafe/jev-1.13", "typesafe/jev-1.14-20260917")).toBe(false);
    expect(matchesPinnedJevResolution("typesafe/jev-1.13", "other/jev-1.13-20260917")).toBe(false);
    expect(matchesPinnedJevResolution("typesafe/jev-1.13", "typesafe/jev-1.13-20260230")).toBe(false);
    expect(matchesPinnedJevResolution("typesafe/jev-1.13", "typesafe/jev-1.13-20260917-extra")).toBe(false);
  });
  it("accepts the checked-in twelve-case study under explicit live time and judge-call caps", async () => {
    const raw = JSON.parse(await readFile("docs/testing/conversation-routing-study-example.json", "utf8"));
    const study = parseStudyPlan(raw);
    const args = [
      "--study-plan",
      "/fixture/study.json",
      "--model",
      "openrouter/anthropic/claude-haiku-4.5",
      "--jev-model",
      "typesafe/jev-1.13",
      "--judge-model",
      "openrouter/google/gemini-3.8-flash",
      "--judge-rubric",
      "v2",
      "--opencode",
      "/fixture/opencode",
      "--secret-launcher",
      "/fixture/bws-run",
      "--max-cases",
      "12",
      "--max-judge-calls",
      "104",
      "--max-generations",
      "18",
      "--timeout-ms",
      "120000",
      "--total-timeout-ms",
      "7200000",
    ];
    const options = parseLiveCanaryOptions(args, {}, study);
    expect(options.cases).toHaveLength(12);
    expect(options.maxGenerations).toBe(18);
    expect(options.maxJudgeCalls).toBe(104);
    expect(options.planningAllowanceMs).toBe(6_850_000);
    expect(options.totalTimeoutMs).toBeGreaterThan(options.planningAllowanceMs);
    expect(() => parseLiveCanaryOptions([...args, "--require-visible"], {}, study)).toThrow(
      "Study plans must retain quiet outcomes",
    );
    const tooLow = [...args];
    tooLow[tooLow.indexOf("--max-generations") + 1] = "8";
    expect(() => parseLiveCanaryOptions(tooLow, {}, study)).toThrow("roster-by-trigger planning minimum");
  });
  it("budgets a fifth independent frame call only for rubric v3", async () => {
    const study = parseStudyPlan(
      JSON.parse(await readFile("docs/testing/conversation-routing-study-example.json", "utf8")),
    );
    const base = [
      "--study-plan",
      "/fixture/study.json",
      "--model",
      "openrouter/anthropic/claude-haiku-4.5",
      "--jev-model",
      "typesafe/jev-1.13",
      "--judge-model",
      "openrouter/google/gemini-3.8-flash",
      "--judge-rubric",
      "v3",
      "--opencode",
      "/fixture/opencode",
      "--secret-launcher",
      "/fixture/bws-run",
      "--max-cases",
      "12",
      "--max-generations",
      "18",
      "--timeout-ms",
      "120000",
      "--total-timeout-ms",
      "9000000",
      "--max-judge-calls",
      "130",
    ];
    const options = parseLiveCanaryOptions(base, {}, study);
    expect(options.judgeRubric).toBe("v3");
    expect(options.maxJudgeCalls).toBe(130);
    expect(options.planningAllowanceMs).toBe(7_630_000);
    const insufficient = [...base];
    insufficient[insufficient.indexOf("--max-judge-calls") + 1] = "129";
    expect(() => parseLiveCanaryOptions(insufficient, {}, study)).toThrow("judge-call cap");
  });
  it("keeps v2 audience context private and excludes study policy from judge input", () => {
    const scenario = {
      ...buildLiveScenario({
        dynamic: "multi-address",
        agentCount: 2,
        energy: "balanced",
        preflightMode: "enforce",
        classifierEnabled: true,
      }),
      rosterOrder: ["claude-sonnet", "codex-sol"] as Array<"claude-sonnet" | "codex-sol">,
      study: { factor: "gate", gateProfileId: "relevance-v1" },
    };
    const payload = buildPrivateReviewPayload(
      scenario as Parameters<typeof buildPrivateReviewPayload>[0],
      { scenarioId: scenario.scenarioId, runId: "run_fixture" } as LiveScenarioResult,
      "Sol and Nova, respond briefly.",
      ["codex-sol", "claude-sonnet"],
      [
        { speaker: "you", kind: "chat", text: "Sol and Nova, respond briefly." },
        { speaker: "codex-sol", kind: "chat", text: "One fictional idea." },
      ],
      false,
      true,
    );
    expect(payload).toMatchObject({
      schemaVersion: 2,
      qualityContext: {
        originalHumanAlias: "Avery",
        roster: [
          { agentId: "claude-sonnet", conversationalName: "Nova" },
          { agentId: "codex-sol", conversationalName: "Sol" },
        ],
      },
    });
    expect(JSON.stringify(payload)).not.toMatch(/gateProfileId|relevance-v1|factor|study/);
  });
  it("passes the everyday profile's card names to private quality review", () => {
    const scenario = buildLiveScenario({
      dynamic: "multi-address",
      agentCount: 2,
      energy: "balanced",
      preflightMode: "enforce",
      classifierEnabled: true,
      scenarioProfileId: "everyday-chat-v3",
    });
    const payload = buildPrivateReviewPayload(
      scenario,
      { scenarioId: scenario.scenarioId, runId: "run_fixture" } as LiveScenarioResult,
      scenario.text,
      scenario.expectedDirectAgents,
      [{ speaker: "you", kind: "chat", text: scenario.text }],
      false,
      true,
    );
    expect(payload).toMatchObject({
      qualityContext: {
        roster: [
          { agentId: "codex-sol", conversationalName: "Riley" },
          { agentId: "claude-sonnet", conversationalName: "Jordan" },
        ],
      },
    });
  });
  it("prints a credential-free closed study dry-run with ordering and judge-call budget", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "amfaa-routing-study-test-"));
    const file = path.join(root, "plan.json");
    const plan = {
      schemaVersion: 1,
      planId: "fixture",
      orderSeed: 42,
      maxCases: 2,
      blocks: [
        {
          blockId: "direct",
          replicateId: "r1",
          dynamic: "direct",
          arcProfileId: "single-v1",
          rosterOrder: ["codex-sol"],
          energy: "low",
          arms: {
            a: { jevProfileId: "current-v1", gateProfileId: "current-v1", agentPromptProfileId: "current-v1" },
            b: { jevProfileId: "current-v1", gateProfileId: "current-v1", agentPromptProfileId: "social-v1" },
          },
        },
      ],
    };
    try {
      await writeFile(file, JSON.stringify(plan));
      const { stdout } = await execute(
        "pnpm",
        [
          "exec",
          "tsx",
          "scripts/conversation-routing-live-canary.ts",
          "--dry-run",
          "--study-plan",
          file,
          "--model",
          "openrouter/anthropic/claude-haiku-4.5",
          "--jev-model",
          "typesafe/jev-1.13",
          "--judge-model",
          "openrouter/google/gemini-3.8-flash",
          "--judge-rubric",
          "v2",
          "--max-judge-calls",
          "8",
          "--total-timeout-ms",
          "600000",
        ],
        { env: { ...process.env, AMFAA_CANARY_ALLOW_REAL_PROVIDER: "false", OPENROUTER_API_KEY: "" } },
      );
      const printed = JSON.parse(stdout) as Record<string, unknown>;
      expect(printed).toMatchObject({
        kind: "conversation-routing-study-dry-run",
        planId: "fixture",
        maximumScheduledJudgeCalls: 8,
        judgeRubric: "v2",
        watchdogCoversPlanningAllowance: true,
      });
      expect(printed.cases as unknown[]).toHaveLength(2);
      expect(stdout).not.toContain("fictional garden path");
      expect(stdout).not.toContain(file);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("retains closed scalar evidence on a visible-delivery failure without copying private fields", () => {
    const poisonedAttribution = {
      schemaVersion: 1 as const,
      category: "completed-yielded" as const,
      generations: [{ ordinal: 1, category: "yielded" as const, rawText: "private generation text" }],
      rawText: "private attribution text",
    };
    const collected = {
      schemaVersion: 1,
      openCodeUsageProvenance: "step-fields-v1",
      scenarioId: "direct-1-low-enforce",
      variant: "jev-on",
      runId: "run_fixture",
      preflightMode: "enforce",
      requiredAddressAgents: ["codex-sol"],
      routing: [{ agentId: "codex-sol", outcome: "invoke", reason: "required_plain_address" }],
      classifier: {
        outcome: "completed",
        reason: null,
        resolvedModelId: "typesafe/jev-1.13",
        durationMs: 73,
        reportedInputTokens: null,
        reportedOutputTokens: null,
        reportedCostUsd: null,
      },
      queueDelayMs: 12,
      firstVisibleMs: null,
      terminalReason: "no-visible-output",
      attemptedTurns: 1,
      respondedTurns: 0,
      yieldedTurns: 1,
      confirmedDeliveredBursts: 0,
      generationStarts: 1,
      generationCompletions: 1,
      generationFailures: 0,
      noVisibleAttributionV1: poisonedAttribution,
      openCodeObservedInputTokens: 2,
      openCodeObservedOutputTokens: 20,
      openCodeObservedReasoningTokens: 0,
      openCodeObservedCacheReadTokens: 18,
      openCodeObservedCacheWriteTokens: 0,
      openCodeObservedTotalTokens: 40,
      openCodeEstimatedCostUsd: 0.01,
      openCodeUsageCoverage: "reported",
      openCodeTotalCoverage: "reported",
      rawText: "private fictional response",
      credential: "do-not-copy",
    } satisfies LiveScenarioResult & { rawText: string; credential: string };
    const projected = projectFailedCaseEvidence(collected);
    expect(projected).toMatchObject({
      terminalReason: "no-visible-output",
      classifier: { outcome: "completed" },
      yieldedTurns: 1,
      confirmedDeliveredBursts: 0,
      openCodeObservedTotalTokens: 40,
      openCodeTotalCoverage: "reported",
      noVisibleAttributionV1: {
        schemaVersion: 1,
        category: "completed-yielded",
        generations: [{ ordinal: 1, category: "yielded" }],
      },
    });
    expect(JSON.stringify(projected)).not.toMatch(
      /private fictional response|do-not-copy|private generation text|private attribution text|rawText|credential/,
    );
    const unsupported = projectFailedCaseEvidence({
      ...collected,
      noVisibleAttributionV1: {
        ...poisonedAttribution,
        category: "private unbounded attribution" as "completed-yielded",
      },
    });
    expect(unsupported.noVisibleAttributionV1).toBeUndefined();
    const poisonedAvailabilityCheck = {
      initialDiscoveryStatus: "error",
      initialUnavailableReasons: ["runtime_unavailable"],
      refreshAttempted: true,
      finalDiscoveryStatus: "error",
      finalUnavailableReasons: ["runtime_unavailable"],
      recovered: false,
      diagnostic: "private diagnostic must not be copied",
    } as AvailabilityCheckV1 & { diagnostic: string };
    const failed = projectCaseFailedEvent({
      scenarioId: collected.scenarioId,
      variant: collected.variant,
      stage: "judge",
      category: "internal",
      completedCases: 0,
      triggers: [collected],
      judgeCategory: new JudgeFailure("judgment-schema").category,
      availabilityCheck: poisonedAvailabilityCheck,
    });
    expect(failed).toMatchObject({
      event: "case-failed",
      judgeCategory: "judgment-schema",
      availabilityCheck: { refreshAttempted: true, finalDiscoveryStatus: "error", recovered: false },
      observedTriggers: [projected],
    });
    expect(JSON.stringify(failed)).not.toMatch(
      /private fictional response|do-not-copy|rawText|credential|private diagnostic|diagnostic/,
    );
  });
  it("makes six matched Jev-on/off pairs in twelve isolated cases", () => {
    const scenarios = pilotScenarios();
    expect(scenarios).toHaveLength(12);
    expect(new Set(scenarios.map(({ scenarioId }) => scenarioId)).size).toBe(6);
    for (const scenarioId of new Set(scenarios.map(({ scenarioId }) => scenarioId))) {
      expect(scenarios.filter((scenario) => scenario.scenarioId === scenarioId).map(({ variant }) => variant)).toEqual([
        "jev-on",
        "jev-off",
      ]);
    }
    expect(scenarios.every(({ agentCount, preflightMode }) => agentCount <= 3 && preflightMode === "enforce")).toBe(
      true,
    );
  });

  it("requires explicit bounded selections and a wide flag for four agents", () => {
    expect(() => parseLiveCanaryOptions(base, {})).toThrow();
    expect(() => parseLiveCanaryOptions([...base, "--case", "direct:4:low:enforce:jev-off"], {})).toThrow();
    const wide = parseLiveCanaryOptions([...base, "--allow-wide-matrix", "--case", "direct:4:low:enforce:jev-off"], {});
    expect(wide.cases[0]?.agentCount).toBe(4);
    expect(() => parseLiveCanaryOptions([...base, "--pilot", "--max-cases", "11"], {})).toThrow();
    expect(() =>
      parseLiveCanaryOptions(
        [...base, "--case", "direct:1:low:enforce:jev-on", "--case", "direct:1:low:enforce:jev-on"],
        {},
      ),
    ).toThrow();
  });

  it("allows only the closed everyday profile for a custom delivery smoke", () => {
    const selection = [...base, "--case", "direct:1:low:enforce:jev-on"];
    const ordinary = parseLiveCanaryOptions(selection, {});
    expect(ordinary.cases[0]?.scenarioProfileId).toBeUndefined();
    expect(ordinary.cases[0]?.text).toContain("fictional garden path");
    const selected = parseLiveCanaryOptions([...selection, "--scenario-profile", "everyday-chat-v3"], {});
    expect(selected.cases[0]?.scenarioProfileId).toBe("everyday-chat-v3");
    expect(selected.cases[0]?.text).toContain("20-minute check-in");
    expect(() => parseLiveCanaryOptions([...selection, "--scenario-profile", "garden-chat-v2"], {})).toThrow();
    expect(() => parseLiveCanaryOptions([...base, "--pilot", "--scenario-profile", "everyday-chat-v3"], {})).toThrow();
    expect(() =>
      parseLiveCanaryOptions(
        [...selection, "--scenario-profile", "everyday-chat-v3", "--scenario-profile", "everyday-chat-v3"],
        {},
      ),
    ).toThrow();
  });

  it("keeps matched scenario identity stable across classifier variants and adds a resolution step", () => {
    const on = buildLiveScenario({
      dynamic: "disagreement",
      agentCount: 3,
      energy: "lively",
      preflightMode: "enforce",
      classifierEnabled: true,
    });
    const off = buildLiveScenario({
      dynamic: "disagreement",
      agentCount: 3,
      energy: "lively",
      preflightMode: "enforce",
      classifierEnabled: false,
    });
    expect(on.scenarioId).toBe(off.scenarioId);
    expect(on.followup?.scenarioId).toBe(off.followup?.scenarioId);
    expect(on.followup?.expectedDirectAgents).toEqual(["claude-opus"]);
  });
});

it.skipIf(process.platform === "win32")(
  "stops a detached server group even after its leader exits",
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "amfaa-routing-group-test-"));
    const pidFile = path.join(root, "descendant-pid");
    const script =
      `const {spawn}=require('node:child_process');const {writeFileSync}=require('node:fs');` +
      `const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});` +
      `writeFileSync(${JSON.stringify(pidFile)},String(child.pid));setInterval(()=>{},1000);`;
    const leader = spawn(process.execPath, ["-e", script], { detached: true, stdio: "ignore" });
    let descendantPid = 0;
    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        descendantPid = Number(await readFile(pidFile, "utf8").catch(() => ""));
        if (descendantPid > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(descendantPid).toBeGreaterThan(0);
      leader.kill("SIGTERM");
      for (let attempt = 0; attempt < 100 && leader.exitCode === null && leader.signalCode === null; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await stopProcessGroup(leader);
      let alive = true;
      for (let attempt = 0; attempt < 100; attempt++) {
        const status = await execute("ps", ["-o", "stat=", "-p", String(descendantPid)]).then(
          ({ stdout }) => stdout.trim(),
          () => "",
        );
        alive = Boolean(status && !status.startsWith("Z"));
        if (!alive) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(alive).toBe(false);
    } finally {
      await stopProcessGroup(leader);
      await rm(root, { recursive: true, force: true });
    }
  },
  15_000,
);
