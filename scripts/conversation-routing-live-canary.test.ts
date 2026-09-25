import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  buildPrivateReviewPayload,
  matchesPinnedJevResolution,
  parseLiveCanaryOptions,
  projectCaseFailedEvent,
  projectFailedCaseEvidence,
  stopProcessGroup,
} from "./conversation-routing-live-canary.js";
import type { LiveScenarioResult } from "./conversation-routing-live-evidence.js";
import { JudgeFailure } from "./conversation-routing-live-judge.js";
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

describe("routing canary selection", () => {
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
    const tooLow = [...args];
    tooLow[tooLow.indexOf("--max-generations") + 1] = "8";
    expect(() => parseLiveCanaryOptions(tooLow, {}, study)).toThrow("roster-by-trigger planning minimum");
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
    });
    expect(JSON.stringify(projected)).not.toMatch(/private fictional response|do-not-copy|rawText|credential/);
    const failed = projectCaseFailedEvent({
      scenarioId: collected.scenarioId,
      variant: collected.variant,
      stage: "judge",
      category: "internal",
      completedCases: 0,
      triggers: [collected],
      judgeCategory: new JudgeFailure("judgment-schema").category,
    });
    expect(failed).toMatchObject({
      event: "case-failed",
      judgeCategory: "judgment-schema",
      observedTriggers: [projected],
    });
    expect(JSON.stringify(failed)).not.toMatch(/private fictional response|do-not-copy|rawText|credential/);
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
