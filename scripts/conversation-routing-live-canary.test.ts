import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { parseLiveCanaryOptions, stopProcessGroup } from "./conversation-routing-live-canary.js";
import { buildLiveScenario, pilotScenarios } from "./conversation-routing-live-scenarios.js";

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
