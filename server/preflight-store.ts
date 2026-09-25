import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ConversationEnergy } from "../shared/conversation-energy.js";
import type { PreflightClassificationAudit, PreflightClassificationEvidence, PreflightEvidence, PreflightMode } from "../shared/preflight.js";

import { isAgentId, type AgentId } from "../shared/participants.js";
import type { AgentRoutingDecision, PreflightDecision, PreflightRoutingState } from "./preflight-gate.js";
import { PREFLIGHT_REASONS } from "./preflight-gate.js";
import { isConversationEnergy } from "../shared/conversation-energy.js";

export interface ShadowDisposition {
  action: "speak" | "yield";
  distinct?: boolean;
  /** Provider-reported cost of the turn that produced this disposition, when available. */
  costUsd?: number;
  /** Wall-clock generation duration of the turn, when available. */
  durationMs?: number;
}

export interface PreflightAuditRecord {
  decisionId: string;
  triggerMessageId: string;
  at: string;
  mode: Exclude<PreflightMode, "off">;
  energy: ConversationEnergy;
  qualifyingForStarvation: boolean;
  agents: Array<AgentRoutingDecision & { disposition?: ShadowDisposition }>;
  /** Advisory classifier consult behind this decision, absent when unconfigured or failed. */
  classification?: PreflightClassificationAudit;
}


interface PreflightState {
  schemaVersion: 1;
  routing: PreflightRoutingState;
  decisions: PreflightAuditRecord[];
}

const AUDIT_LIMIT = 10_000;

function emptyState(): PreflightState {
  return { schemaVersion: 1, routing: {}, decisions: [] };
}

function normalizeClassification(value: unknown): PreflightClassificationAudit | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<PreflightClassificationAudit>;
  const latencyMs = Number(candidate.latencyMs);
  const inputTokens = Number(candidate.inputTokens);
  const outputTokens = Number(candidate.outputTokens);
  const costUsd = Number(candidate.costUsd);
  const wholeRoomProbability = Number(candidate.wholeRoomProbability);
  if (typeof candidate.model !== "string" || !candidate.model || candidate.model.length > 100
    || !Number.isFinite(latencyMs) || latencyMs < 0
    || !Number.isFinite(inputTokens) || inputTokens < 0
    || !Number.isFinite(outputTokens) || outputTokens < 0
    || !Number.isFinite(costUsd) || costUsd < 0
    || !Number.isFinite(wholeRoomProbability) || wholeRoomProbability < 0 || wholeRoomProbability > 1) return undefined;
  const addressProbabilities: Partial<Record<AgentId, number>> = {};
  if (candidate.addressProbabilities && typeof candidate.addressProbabilities === "object") {
    for (const [agent, probability] of Object.entries(candidate.addressProbabilities)) {
      const value = Number(probability);
      if (isAgentId(agent) && Number.isFinite(value) && value >= 0 && value <= 1) addressProbabilities[agent] = value;
    }
  }
  const optionalWorthProbabilities: Partial<Record<AgentId, number>> = {};
  if (candidate.optionalWorthProbabilities && typeof candidate.optionalWorthProbabilities === "object") {
    for (const [agent, probability] of Object.entries(candidate.optionalWorthProbabilities)) {
      if (isAgentId(agent) && typeof probability === "number" && Number.isFinite(probability) && probability >= 0 && probability <= 1)
        optionalWorthProbabilities[agent] = probability;
    }
  }
  const baseline = Array.isArray(candidate.baseline) ? candidate.baseline.slice(0, 200).flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const decision = entry as { agent?: unknown; outcome?: unknown; reason?: unknown };
    const outcome: "invoke" | "suppress" | "unavailable" | undefined = decision.outcome === "invoke" || decision.outcome === "suppress" || decision.outcome === "unavailable"
      ? decision.outcome
      : undefined;
    if (!isAgentId(decision.agent) || !outcome || typeof decision.reason !== "string" || !PREFLIGHT_REASONS.includes(decision.reason as AgentRoutingDecision["reason"])) return [];
    return [{ agent: decision.agent, outcome, reason: decision.reason }];
  }) : [];
  return {
    model: candidate.model,
    ...(typeof candidate.providerResolvedModelId === "string" && /^(?=.{3,160}$)~?[a-zA-Z0-9._-]+\/[a-zA-Z0-9._/-]+$/.test(candidate.providerResolvedModelId)
      ? { providerResolvedModelId: candidate.providerResolvedModelId } : {}),
    latencyMs,
    inputTokens,
    outputTokens,
    costUsd,
    wholeRoomProbability,
    addressProbabilities,
    ...(candidate.optionalWorthProbabilities ? { optionalWorthProbabilities } : {}),
    baseline,
  };
}

function normalizeState(value: unknown): PreflightState {
  if (!value || typeof value !== "object") return emptyState();
  const raw = value as Partial<PreflightState>;
  const routing: PreflightRoutingState = {};
  if (raw.routing && typeof raw.routing === "object") {
    for (const [agent, entry] of Object.entries(raw.routing)) {
      const count = Number((entry as { consecutiveQualifyingSuppressions?: unknown })?.consecutiveQualifyingSuppressions);
      if (isAgentId(agent) && Number.isSafeInteger(count) && count >= 0) routing[agent] = { consecutiveQualifyingSuppressions: count };
    }
  }
  const decisions = Array.isArray(raw.decisions) ? raw.decisions.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const candidate = entry as Partial<PreflightAuditRecord>;
    if (typeof candidate.decisionId !== "string" || !candidate.decisionId || candidate.decisionId.length > 200
      || typeof candidate.triggerMessageId !== "string" || !candidate.triggerMessageId || candidate.triggerMessageId.length > 200
      || typeof candidate.at !== "string" || !Number.isFinite(Date.parse(candidate.at))
      || candidate.mode !== "shadow" && candidate.mode !== "enforce"
      || !isConversationEnergy(candidate.energy) || !Array.isArray(candidate.agents)) return [];
    const agents = candidate.agents.slice(0, 200).flatMap((entry) => {
      if (!entry || !isAgentId(entry.agent) || !["invoke", "suppress", "unavailable"].includes(entry.outcome)
        || !PREFLIGHT_REASONS.includes(entry.reason)) return [];
      const shadow = entry.disposition;
      const metrics: { costUsd?: number; durationMs?: number } = {};
      if (typeof shadow?.costUsd === "number" && Number.isFinite(shadow.costUsd) && shadow.costUsd >= 0) metrics.costUsd = shadow.costUsd;
      if (typeof shadow?.durationMs === "number" && Number.isFinite(shadow.durationMs) && shadow.durationMs >= 0) metrics.durationMs = shadow.durationMs;
      const shadowDisposition = shadow?.action === "yield"
        ? { action: "yield" as const, ...metrics }
        : shadow?.action === "speak" && typeof shadow.distinct === "boolean"
          ? { action: "speak" as const, distinct: shadow.distinct, ...metrics }
          : undefined;
      return [{ agent: entry.agent, outcome: entry.outcome, reason: entry.reason, ...(shadowDisposition ? { disposition: shadowDisposition } : {}) } as AgentRoutingDecision & { disposition?: ShadowDisposition }];
    });
    const classification = normalizeClassification(candidate.classification);
    return [{
      decisionId: candidate.decisionId,
      triggerMessageId: candidate.triggerMessageId,
      at: candidate.at,
      mode: candidate.mode,
      energy: candidate.energy,
      qualifyingForStarvation: candidate.qualifyingForStarvation === true,
      agents,
      ...(classification ? { classification } : {}),
    } satisfies PreflightAuditRecord];
  }).slice(-AUDIT_LIMIT) : [];
  return { schemaVersion: 1, routing, decisions };
}

export class PreflightStore {
  readonly path: string;
  private state: PreflightState;
  private queue: Promise<void> = Promise.resolve();

  private constructor(filePath: string, state: PreflightState) {
    this.path = filePath;
    this.state = state;
  }

  static async open(dataDirectory: string) {
    await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
    await chmod(dataDirectory, 0o700);
    const filePath = path.join(dataDirectory, "preflight-routing.json");
    const state = await readFile(filePath, "utf8")
      .then((raw) => normalizeState(JSON.parse(raw)))
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return emptyState();
        throw error;
      });
    return new PreflightStore(filePath, state);
  }

  async routingState() {
    await this.queue;
    return structuredClone(this.state.routing);
  }

  async recordDecision(input: {
    triggerMessageId: string;
    mode: Exclude<PreflightMode, "off">;
    energy: ConversationEnergy;
    decision: PreflightDecision;
    classification?: PreflightClassificationAudit;
    at?: string;
  }) {
    const record: PreflightAuditRecord = {
      decisionId: randomUUID(),
      triggerMessageId: input.triggerMessageId,
      at: input.at || new Date().toISOString(),
      mode: input.mode,
      energy: input.energy,
      qualifyingForStarvation: input.decision.qualifyingForStarvation,
      agents: structuredClone(input.decision.decisions),
      ...(input.classification ? { classification: structuredClone(input.classification) } : {}),
    };
    return this.mutate((state) => {
      if (input.decision.qualifyingForStarvation) {
        for (const decision of input.decision.decisions) {
          if (decision.outcome === "unavailable") continue;
          state.routing[decision.agent] = {
            consecutiveQualifyingSuppressions: decision.outcome === "suppress"
              ? (state.routing[decision.agent]?.consecutiveQualifyingSuppressions || 0) + 1
              : 0,
          };
        }
      }
      state.decisions.push(record);
      if (state.decisions.length > AUDIT_LIMIT) state.decisions.splice(0, state.decisions.length - AUDIT_LIMIT);
      return { state, result: structuredClone(record) };
    });
  }

  async recordDisposition(decisionId: string, agent: AgentId, disposition: ShadowDisposition) {
    return this.mutate((state) => {
      const record = state.decisions.find((candidate) => candidate.decisionId === decisionId);
      const candidate = record?.agents.find((entry) => entry.agent === agent
        && (entry.outcome === "invoke" || record.mode === "shadow" && entry.outcome === "suppress"));
      if (!candidate || candidate.disposition) return { result: false };
      candidate.disposition = structuredClone(disposition);
      return { state, result: true };
    });
  }

  async rawDecisions(limit = 200) {
    await this.queue;
    return structuredClone(this.state.decisions.slice(-Math.max(1, Math.min(1_000, Math.floor(limit)))).reverse());
  }

  async evidence(_now = Date.now()): Promise<PreflightEvidence> {
    await this.queue;
    const agents = this.state.decisions.flatMap((decision) => decision.agents);
    const suppressions = this.state.decisions
      .filter(({ mode }) => mode === "shadow")
      .flatMap((decision) => decision.agents)
      .filter(({ outcome }) => outcome === "suppress");
    const evaluated = suppressions.filter(({ disposition }) => Boolean(disposition));
    const falseSuppressions = evaluated.filter(({ disposition }) => disposition?.action === "speak" && disposition.distinct !== false).length;
    const observedDispositions = agents.filter(({ disposition }) => Boolean(disposition));
    const shadowDecisions = this.state.decisions.filter(({ mode }) => mode === "shadow");
    const firstShadowDecisionAt = shadowDecisions[0]?.at || null;
    const lastShadowDecisionAt = shadowDecisions.at(-1)?.at || null;
    const shadowDaysRecorded = firstShadowDecisionAt && lastShadowDecisionAt
      ? Math.max(0, (new Date(lastShadowDecisionAt).getTime() - new Date(firstShadowDecisionAt).getTime()) / 86_400_000)
      : 0;
    const falseSuppressionRate = evaluated.length ? falseSuppressions / evaluated.length : null;
    return {
      recordedDecisions: this.state.decisions.length,
      recordedAgents: agents.length,
      shadowSuppressions: suppressions.length,
      evaluatedShadowSuppressions: evaluated.length,
      falseSuppressions,
      falseSuppressionRate,
      firstShadowDecisionAt,
      shadowDaysRecorded,
      outcomeTallies: {
        invoke: agents.filter(({ outcome }) => outcome === "invoke").length,
        suppress: agents.filter(({ outcome }) => outcome === "suppress").length,
        unavailable: agents.filter(({ outcome }) => outcome === "unavailable").length,
      },
      reasonTallies: Object.fromEntries([...new Set(agents.map(({ reason }) => reason))].map((reason) => [reason, agents.filter((entry) => entry.reason === reason).length])),
      dispositionTallies: {
        speak: observedDispositions.filter(({ disposition }) => disposition?.action === "speak").length,
        yield: observedDispositions.filter(({ disposition }) => disposition?.action === "yield").length,
      },
      ...classificationEvidence(this.state.decisions.filter((decision) => decision.classification)),
    };
  }

  private mutate<T>(operation: (state: PreflightState) => { state?: PreflightState; result: T }): Promise<T> {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const result = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    this.queue = this.queue.then(async () => {
      try {
        const next = operation(structuredClone(this.state));
        if (next.state) {
          const validated = normalizeState(next.state);
          const temporary = `${this.path}.${process.pid}.tmp`;
          await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600 });
          await chmod(temporary, 0o600);
          await rename(temporary, this.path);
          this.state = validated;
        }
        resolve(next.result);
      } catch (error) {
        reject(error);
      }
    });
    this.queue.catch(() => undefined);
    return result;
  }
}

/**
 * Aggregates classified decisions into the pre/post measurement surface.
 * Counterfactual savings only count turns that actually ran and reported
 * metrics, so gross savings and false suppressions are both observable.
 */
function classificationEvidence(decisions: PreflightAuditRecord[]): { classification: PreflightClassificationEvidence } | Record<string, never> {
  if (!decisions.length) return {};
  const models = new Set<string>();
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCostUsd = 0;
  let totalLatencyMs = 0;
  let additionalSuppressions = 0;
  let additionalInvocations = 0;
  let suppressedSpoke = 0;
  let suppressedYield = 0;
  let rescuedSpoke = 0;
  let counterfactualSavedCostUsd = 0;
  let counterfactualSavedDurationMs = 0;
  for (const decision of decisions) {
    const classification = decision.classification!;
    models.add(classification.model);
    totalInputTokens += classification.inputTokens;
    totalOutputTokens += classification.outputTokens;
    totalCostUsd += classification.costUsd;
    totalLatencyMs += classification.latencyMs;
    const baseline = new Map(classification.baseline.map((entry) => [entry.agent, entry]));
    for (const agent of decision.agents) {
      const before = baseline.get(agent.agent);
      if (!before) continue;
      if (before.outcome === "invoke" && agent.outcome === "suppress") {
        additionalSuppressions += 1;
        if (agent.disposition) {
          if (agent.disposition.action === "speak") suppressedSpoke += 1;
          else suppressedYield += 1;
          counterfactualSavedCostUsd += agent.disposition.costUsd || 0;
          counterfactualSavedDurationMs += agent.disposition.durationMs || 0;
        }
      } else if (before.outcome === "suppress" && agent.outcome === "invoke") {
        additionalInvocations += 1;
        if (agent.disposition?.action === "speak") rescuedSpoke += 1;
      }
    }
  }
  return {
    classification: {
      calls: decisions.length,
      model: models.size === 1 ? models.values().next().value! : "mixed",
      totalInputTokens,
      totalOutputTokens,
      totalCostUsd,
      averageLatencyMs: totalLatencyMs / decisions.length,
      additionalSuppressions,
      additionalInvocations,
      suppressedSpoke,
      suppressedYield,
      rescuedSpoke,
      counterfactualSavedCostUsd,
      counterfactualSavedDurationMs,
    },
  };
}
