import { readFile, stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { directAddressTargets } from "../shared/direct-address.js";
import { DIRECT_ADDRESS_FIXTURE_AGENTS, DIRECT_ADDRESS_FIXTURES } from "../shared/direct-address-fixtures.js";

interface ObservedTrigger {
  expectedDirectAgents?: string[];
  requiredAddressAgents: string[];
  attemptedTurns: number;
  yieldedTurns: number;
  respondingTurns: number;
  distinctAmbientContributions?: number;
  /** Explicit human judgment; never inferred from a missing scheduled turn. */
  missedDirectReplies?: number;
  unnecessaryReplies?: number;
  duplicateReplies?: number;
  humanCorrection?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  firstVisibleMs?: number;
}

const OPTIONAL_COUNTS = [
  "distinctAmbientContributions",
  "missedDirectReplies",
  "unnecessaryReplies",
  "duplicateReplies",
  "inputTokens",
  "outputTokens",
  "costUsd",
  "firstVisibleMs",
] as const;
const ROW_KEYS = new Set([
  "expectedDirectAgents",
  "requiredAddressAgents",
  "attemptedTurns",
  "yieldedTurns",
  "respondingTurns",
  "humanCorrection",
  ...OPTIONAL_COUNTS,
]);
const AGENT_ID = /^[a-z0-9-]{1,64}$/;

function boundedCount(value: unknown, maximum = 1_000_000_000) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

function agentList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= 32 &&
    value.every((agent) => typeof agent === "string" && AGENT_ID.test(agent)) &&
    new Set(value).size === value.length
  );
}

/** Accepts only bounded, transcript-free counts and explicit target judgments. */
export function parseObservedRoutingEvidence(value: unknown): ObservedTrigger[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Evidence must be an object.");
  const object = value as Record<string, unknown>;
  if (
    Object.keys(object).some((key) => !["schemaVersion", "triggers"].includes(key)) ||
    object.schemaVersion !== 1 ||
    !Array.isArray(object.triggers) ||
    object.triggers.length > 500
  )
    throw new Error("Evidence envelope is invalid.");
  return object.triggers.map((entry: unknown) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Evidence row is invalid.");
    const row = entry as Record<string, unknown>;
    if (
      Object.keys(row).some((key) => !ROW_KEYS.has(key)) ||
      !agentList(row.requiredAddressAgents) ||
      (row.expectedDirectAgents !== undefined && !agentList(row.expectedDirectAgents)) ||
      !boundedCount(row.attemptedTurns, 32) ||
      !boundedCount(row.yieldedTurns, 32) ||
      !boundedCount(row.respondingTurns, 32) ||
      Number(row.yieldedTurns) + Number(row.respondingTurns) > Number(row.attemptedTurns) ||
      (row.firstVisibleMs !== undefined && Number(row.respondingTurns) === 0) ||
      (row.missedDirectReplies !== undefined &&
        (row.expectedDirectAgents === undefined ||
          !boundedCount(row.missedDirectReplies, row.expectedDirectAgents.length))) ||
      (["distinctAmbientContributions", "unnecessaryReplies", "duplicateReplies"] as const).some(
        (key) => row[key] !== undefined && !boundedCount(row[key], Number(row.respondingTurns)),
      ) ||
      OPTIONAL_COUNTS.some(
        (key) =>
          row[key] !== undefined &&
          (key === "costUsd"
            ? typeof row[key] !== "number" ||
              !Number.isFinite(row[key]) ||
              Number(row[key]) < 0 ||
              Number(row[key]) > 1_000
            : !boundedCount(row[key], key === "firstVisibleMs" ? 3_600_000 : 1_000_000_000)),
      ) ||
      (row.humanCorrection !== undefined && typeof row.humanCorrection !== "boolean")
    ) {
      throw new Error("Evidence row contains invalid or unsupported fields.");
    }
    return row as unknown as ObservedTrigger;
  });
}

export function evaluateFixtureRouting() {
  let expectedTargets = 0;
  let missedRequiredTargets = 0;
  let falseRequiredTargets = 0;
  let baselineMissedTargets = 0;
  let baselineFalseTargets = 0;
  for (const fixture of DIRECT_ADDRESS_FIXTURES) {
    const expected = new Set(fixture.expected);
    const actual = new Set(
      directAddressTargets({
        text: fixture.text,
        agents: DIRECT_ADDRESS_FIXTURE_AGENTS,
        speaker: fixture.speaker ?? "human",
      }),
    );
    expectedTargets += expected.size;
    missedRequiredTargets += [...expected].filter((agent) => !actual.has(agent)).length;
    falseRequiredTargets += [...actual].filter((agent) => !expected.has(agent)).length;
    // At 6ad3215, human preflight used canonical mentions, structured targets,
    // and classifier scores; these fixtures carry none and assume the classifier
    // is unavailable/low. Agent follow-ups matched every roster name occurrence
    // in visible text with a word-boundary regex (conversation.ts:271-276).
    const baseline = new Set<string>(
      fixture.speaker === "agent"
        ? DIRECT_ADDRESS_FIXTURE_AGENTS.filter(({ name }) => new RegExp(`\\b${name}\\b`, "i").test(fixture.text)).map(
            ({ agentId }) => agentId,
          )
        : [],
    );
    baselineMissedTargets += [...expected].filter((agent) => !baseline.has(agent)).length;
    baselineFalseTargets += [...baseline].filter((agent) => !expected.has(agent)).length;
  }
  return {
    fixtures: DIRECT_ADDRESS_FIXTURES.length,
    expectedTargets,
    baseline: { missedAddressSignals: baselineMissedTargets, falseAddressSignals: baselineFalseTargets },
    candidate: { missedAddressSignals: missedRequiredTargets, falseAddressSignals: falseRequiredTargets },
    limitation:
      "Baseline 6ad3215 signal replay assumes no canonical mentions, structured targets, or high classifier scores. Signals are not actual provider turns. Fictional expectations measure no reply quality or real-room recall.",
  };
}

export function summarizeObservedRouting(rows: readonly ObservedTrigger[]) {
  const annotated = rows.filter((row) => row.expectedDirectAgents !== undefined);
  const sum = (field: keyof ObservedTrigger) =>
    rows.reduce((total, row) => total + (typeof row[field] === "number" ? (row[field] as number) : 0), 0);
  const optional = (field: keyof ObservedTrigger) =>
    rows.some((row) => row[field] !== undefined)
      ? { observedTriggers: rows.filter((row) => row[field] !== undefined).length, total: sum(field) }
      : null;
  return {
    triggers: rows.length,
    annotatedDirectAddressTriggers: annotated.length,
    expectedDirectTargets: annotated.reduce((total, row) => total + (row.expectedDirectAgents?.length ?? 0), 0),
    missedRequiredSelections: annotated.reduce(
      (total, row) =>
        total + (row.expectedDirectAgents ?? []).filter((agent) => !row.requiredAddressAgents.includes(agent)).length,
      0,
    ),
    falseMandatoryTargets: annotated.reduce(
      (total, row) =>
        total + row.requiredAddressAgents.filter((agent) => !row.expectedDirectAgents?.includes(agent)).length,
      0,
    ),
    attemptedTurns: sum("attemptedTurns"),
    yieldedTurns: sum("yieldedTurns"),
    respondingTurns: sum("respondingTurns"),
    distinctAmbientContributions: optional("distinctAmbientContributions"),
    missedDirectReplies: optional("missedDirectReplies"),
    unnecessaryReplies: optional("unnecessaryReplies"),
    duplicateReplies: optional("duplicateReplies"),
    humanCorrections: rows.some((row) => row.humanCorrection !== undefined)
      ? {
          observedTriggers: rows.filter((row) => row.humanCorrection !== undefined).length,
          total: rows.filter((row) => row.humanCorrection === true).length,
        }
      : null,
    inputTokens: optional("inputTokens"),
    outputTokens: optional("outputTokens"),
    providerCostUsd: optional("costUsd"),
    firstVisibleMs: rows.some((row) => row.firstVisibleMs !== undefined)
      ? {
          observedTriggers: rows.filter((row) => row.firstVisibleMs !== undefined).length,
          average: sum("firstVisibleMs") / rows.filter((row) => row.firstVisibleMs !== undefined).length,
        }
      : null,
    limitation:
      "Only observed turns and supplied human annotations are counted. Uninvoked agents' hypothetical replies are unknown.",
  };
}

async function main() {
  const source = process.argv[2];
  if (process.argv.length > 3) throw new Error("Invalid evidence invocation.");
  const output: Record<string, unknown> = { schemaVersion: 1, fixtureRouting: evaluateFixtureRouting() };
  if (source) {
    if ((await stat(source)).size > 512_000) throw new Error("Evidence file exceeds 512 KB.");
    output.observed = summarizeObservedRouting(
      parseObservedRoutingEvidence(JSON.parse(await readFile(source, "utf8"))),
    );
  }
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write("Invalid or unavailable sanitized evidence input.\n");
    process.exitCode = 1;
  });
}
