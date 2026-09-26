import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, open, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { judgeConversationFrameOutcome, type FrameIntegrityOutcome } from "./conversation-routing-live-frame-judge.js";
import { JudgeFailure, type JudgeFailureCategory } from "./conversation-routing-live-judge.js";
import { judgeConversationQualityAxis, type QualityAxisOutcome } from "./conversation-routing-live-judge-v2.js";
import {
  CALIBRATION_PROBES,
  type CalibrationAxis,
  type CalibrationProbe,
} from "./conversation-routing-judge-calibration-fixtures.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pinnedFiles = [
  "scripts/conversation-routing-judge-calibration.ts",
  "scripts/conversation-routing-judge-calibration-fixtures.ts",
  "scripts/conversation-routing-live-judge-v2.ts",
  "scripts/conversation-routing-live-frame-judge.ts",
] as const;
const modelId = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:/-]*$/i;
const sha256 = /^[a-f0-9]{64}$/;
const execute = promisify(execFile);
const DEFAULT_TOTAL_TIMEOUT_MS = 480_000;
type Outcome = QualityAxisOutcome | FrameIntegrityOutcome;
type Rating = {
  status: "rated" | "not_applicable" | "not_assessable" | "failed";
  score: number | null;
  reasonCode: string | null;
  failureCategory: JudgeFailureCategory | null;
  reportedCostUsd: number | null;
  flags: {
    frameRejection: string | null;
    privateMachineryLeak: string | null;
    peerAmplification: string | null;
  } | null;
};

export interface CalibrationRow {
  id: string;
  axis: CalibrationAxis;
  normal: Rating;
  degraded: Rating;
  scoreGap: number | null;
  passed: boolean;
  failures: string[];
}

export interface CalibrationReport {
  schemaVersion: 1;
  kind: "judge-sensitivity-calibration";
  fixtureAndRubricSha256: string;
  judgeModel: string;
  actorModel: string;
  totalTimeoutMs: number;
  plannedCalls: number;
  observedCalls: number;
  reportedCostUsd: number | null;
  probesPassed: number;
  probesTotal: number;
  rows: CalibrationRow[];
}

export async function calibrationSourceDigest(): Promise<string> {
  const hash = createHash("sha256");
  for (const file of pinnedFiles) {
    hash.update(file);
    hash.update("\0");
    hash.update(await readFile(path.join(root, file)));
  }
  return hash.digest("hex");
}

export async function reservePrivateReportPath(output: string) {
  if (!path.isAbsolute(output)) throw new Error("Calibration report path must be absolute.");
  const relativeToRepository = path.relative(root, output);
  if (!relativeToRepository.startsWith("..") && !path.isAbsolute(relativeToRepository))
    throw new Error("Calibration report must stay outside the repository.");
  const directory = await lstat(path.dirname(output));
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) !== 0)
    throw new Error("Calibration report directory must be private (mode 0700).");
  return open(output, "wx", 0o600);
}

function rating(outcome: Outcome): Rating {
  if (outcome.status === "failed")
    return {
      status: "failed",
      score: null,
      reasonCode: null,
      failureCategory: outcome.category,
      reportedCostUsd: null,
      flags: null,
    };
  const { result } = outcome;
  return {
    status: result.status,
    score: result.score,
    reasonCode: result.reasonCode,
    failureCategory: null,
    reportedCostUsd: result.judgeUsage.reportedCostUsd,
    flags:
      result.axis === "frame_integrity"
        ? {
            frameRejection: result.details.frameRejection,
            privateMachineryLeak: result.details.privateMachineryLeak,
            peerAmplification: result.details.peerAmplification,
          }
        : null,
  };
}

export function evaluateCalibrationProbe(probe: CalibrationProbe, normal: Rating, degraded: Rating): CalibrationRow {
  const failures: string[] = [];
  if (normal.status !== "rated" || normal.score === null) failures.push("normal_unrated");
  if (degraded.status !== "rated" || degraded.score === null) failures.push("degraded_unrated");
  if (normal.score !== null && normal.score < probe.minimumNormalScore) failures.push("normal_below_floor");
  if (degraded.score !== null && degraded.score > probe.maximumDegradedScore) failures.push("degraded_above_ceiling");
  const scoreGap = normal.score === null || degraded.score === null ? null : normal.score - degraded.score;
  if (scoreGap !== null && scoreGap < probe.minimumGap) failures.push("gap_too_small");
  for (const flag of probe.expectedDegradedFlags ?? [])
    if (degraded.flags?.[flag] !== "present") failures.push(`missing_${flag}`);
  for (const flag of probe.expectedNormalAbsentFlags ?? [])
    if (normal.flags?.[flag] !== "absent") failures.push(`spurious_${flag}`);
  return { id: probe.id, axis: probe.axis, normal, degraded, scoreGap, passed: failures.length === 0, failures };
}

export async function runCalibration(options: {
  judgeModel: string;
  actorModel: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  totalTimeoutMs?: number;
  expectedSourceSha256?: string;
  signal?: AbortSignal;
}): Promise<CalibrationReport> {
  if (
    !modelId.test(options.judgeModel) ||
    options.judgeModel.endsWith("/auto") ||
    !modelId.test(options.actorModel.replace(/^openrouter\//, "")) ||
    options.actorModel.replace(/^openrouter\//, "") === options.judgeModel ||
    !options.apiKey ||
    options.apiKey.length > 300 ||
    (options.totalTimeoutMs !== undefined &&
      (!Number.isSafeInteger(options.totalTimeoutMs) ||
        options.totalTimeoutMs < 1_000 ||
        options.totalTimeoutMs > 900_000))
  )
    throw new Error("Invalid calibration model or credential configuration.");
  const fixtureAndRubricSha256 = await calibrationSourceDigest();
  if (options.expectedSourceSha256 && fixtureAndRubricSha256 !== options.expectedSourceSha256)
    throw new Error("Calibration source digest differs from the expected digest.");
  const totalTimeoutMs = options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;
  const deadline = AbortSignal.timeout(totalTimeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  let observedCalls = 0;
  const fetchImpl: typeof fetch = async (...args) => {
    observedCalls++;
    if (observedCalls > CALIBRATION_PROBES.length * 2) throw new Error("Calibration call cap exceeded.");
    return (options.fetchImpl ?? fetch)(...args);
  };
  const rows: CalibrationRow[] = [];
  for (const probe of CALIBRATION_PROBES) {
    const judge = async (input: CalibrationProbe["normal"]): Promise<Outcome> => {
      if (signal.aborted)
        return probe.axis === "frame_integrity"
          ? { axis: "frame_integrity", status: "failed", category: "cancelled" }
          : { axis: probe.axis, status: "failed", category: "cancelled" };
      const common = {
        model: options.judgeModel,
        actorModel: options.actorModel,
        apiKey: options.apiKey,
        fetchImpl,
        signal,
        conversationalNamesOnly: true,
      };
      return probe.axis === "frame_integrity"
        ? judgeConversationFrameOutcome(input, common)
        : judgeConversationQualityAxis(input, { ...common, axis: probe.axis })
            .then(
              (result): QualityAxisOutcome => ({
                axis: probe.axis as Exclude<CalibrationAxis, "frame_integrity">,
                status: "completed",
                result,
              }),
            )
            .catch((error: unknown): QualityAxisOutcome => {
              // The judge's closed error category is the only failure detail retained.
              if (error instanceof JudgeFailure)
                return {
                  axis: probe.axis as Exclude<CalibrationAxis, "frame_integrity">,
                  status: "failed",
                  category: error.category,
                };
              throw new Error("Calibration judge failed without a closed category.");
            });
    };
    const normal = rating(await judge(probe.normal));
    const degraded = rating(await judge(probe.degraded));
    rows.push(evaluateCalibrationProbe(probe, normal, degraded));
  }
  if ((await calibrationSourceDigest()) !== fixtureAndRubricSha256)
    throw new Error("Calibration source changed during the run.");
  const costs = rows.flatMap((row) => [row.normal.reportedCostUsd, row.degraded.reportedCostUsd]);
  return {
    schemaVersion: 1,
    kind: "judge-sensitivity-calibration",
    fixtureAndRubricSha256,
    judgeModel: options.judgeModel,
    actorModel: options.actorModel,
    totalTimeoutMs,
    plannedCalls: CALIBRATION_PROBES.length * 2,
    observedCalls,
    reportedCostUsd: costs.every((cost) => cost !== null)
      ? costs.reduce<number>((sum, cost) => sum + (cost ?? 0), 0)
      : null,
    probesPassed: rows.filter((row) => row.passed).length,
    probesTotal: rows.length,
    rows,
  };
}

function options(argv: string[]) {
  const allowed = new Set([
    "--dry-run",
    "--allow-paid",
    "--judge-model",
    "--actor-model",
    "--output",
    "--expected-source-sha256",
    "--total-timeout-ms",
  ]);
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index]!;
    if (!allowed.has(key) || values.has(key)) throw new Error("Invalid calibration option.");
    if (key === "--dry-run" || key === "--allow-paid") values.set(key, "true");
    else {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error("Invalid calibration option.");
      values.set(key, value);
    }
  }
  if (values.has("--dry-run") === values.has("--allow-paid")) throw new Error("Select exactly one calibration mode.");
  return values;
}

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env) {
  const values = options(argv);
  const dryRun = values.has("--dry-run");
  const judgeModel = values.get("--judge-model") ?? "";
  const actorModel = values.get("--actor-model") ?? "";
  const totalTimeoutMs = values.has("--total-timeout-ms")
    ? Number(values.get("--total-timeout-ms"))
    : DEFAULT_TOTAL_TIMEOUT_MS;
  if (
    !modelId.test(judgeModel) ||
    judgeModel.endsWith("/auto") ||
    !modelId.test(actorModel.replace(/^openrouter\//, "")) ||
    judgeModel === actorModel.replace(/^openrouter\//, "") ||
    !Number.isSafeInteger(totalTimeoutMs) ||
    totalTimeoutMs < 1_000 ||
    totalTimeoutMs > 900_000
  )
    throw new Error("Pinned judge and actor model IDs are required.");
  if (dryRun) {
    if (values.has("--output") || values.has("--expected-source-sha256"))
      throw new Error("Dry run does not accept a report path or expected digest.");
    return {
      schemaVersion: 1,
      kind: "judge-sensitivity-calibration-preview",
      fixtureAndRubricSha256: await calibrationSourceDigest(),
      judgeModel,
      actorModel,
      totalTimeoutMs,
      plannedCalls: CALIBRATION_PROBES.length * 2,
      probes: CALIBRATION_PROBES.map(({ id, axis, minimumNormalScore, maximumDegradedScore, minimumGap }) => ({
        id,
        axis,
        minimumNormalScore,
        maximumDegradedScore,
        minimumGap,
      })),
    };
  }
  const output = values.get("--output");
  const expectedSourceSha256 = values.get("--expected-source-sha256");
  if (!output || !path.isAbsolute(output) || !env.OPENROUTER_API_KEY)
    throw new Error("Paid calibration requires an absolute report path and OPENROUTER_API_KEY.");
  if (!expectedSourceSha256 || !sha256.test(expectedSourceSha256))
    throw new Error("Paid calibration requires a pinned source digest.");
  if ((await calibrationSourceDigest()) !== expectedSourceSha256)
    throw new Error("Calibration source digest differs from the expected digest.");
  const { stdout: status } = await execute("git", ["status", "--porcelain", "--untracked-files=normal"], {
    cwd: root,
    timeout: 5_000,
  });
  if (status.trim()) throw new Error("Calibration source worktree must be clean.");
  // Reserve the new report path before a provider call; never overwrite an earlier receipt.
  const reportFile = await reservePrivateReportPath(output);
  try {
    const report = await runCalibration({
      judgeModel,
      actorModel,
      apiKey: env.OPENROUTER_API_KEY,
      expectedSourceSha256,
      totalTimeoutMs,
    });
    await reportFile.writeFile(`${JSON.stringify(report, null, 2)}\n`);
    await reportFile.chmod(0o600);
    return report;
  } finally {
    await reportFile.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
    .then((report) => process.stdout.write(`${JSON.stringify(report)}\n`))
    .catch(() => {
      process.stderr.write("Calibration failed; no private text was printed.\n");
      process.exitCode = 1;
    });
}
