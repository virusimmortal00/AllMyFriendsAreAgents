import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ConversationEnergy } from "../shared/conversation-energy.js";
import type { PreflightEvidence, PreflightMode } from "../shared/preflight.js";
import { isAgentId, type AgentId } from "../shared/participants.js";
import type { AgentRoutingDecision, PreflightDecision, PreflightRoutingState } from "./preflight-gate.js";
import { PREFLIGHT_REASONS } from "./preflight-gate.js";
import { isConversationEnergy } from "../shared/conversation-energy.js";

export interface ShadowDisposition {
  action: "speak" | "yield";
  distinct?: boolean;
}

export interface PreflightAuditRecord {
  decisionId: string;
  triggerMessageId: string;
  at: string;
  mode: Exclude<PreflightMode, "off">;
  energy: ConversationEnergy;
  qualifyingForStarvation: boolean;
  agents: Array<AgentRoutingDecision & { disposition?: ShadowDisposition }>;
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
      const shadowDisposition = shadow?.action === "yield"
        ? { action: "yield" as const }
        : shadow?.action === "speak" && typeof shadow.distinct === "boolean"
          ? { action: "speak" as const, distinct: shadow.distinct }
          : undefined;
      return [{ agent: entry.agent, outcome: entry.outcome, reason: entry.reason, ...(shadowDisposition ? { disposition: shadowDisposition } : {}) } as AgentRoutingDecision & { disposition?: ShadowDisposition }];
    });
    return [{
      decisionId: candidate.decisionId,
      triggerMessageId: candidate.triggerMessageId,
      at: candidate.at,
      mode: candidate.mode,
      energy: candidate.energy,
      qualifyingForStarvation: candidate.qualifyingForStarvation === true,
      agents,
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
    const enoughTraffic = evaluated.length >= 200;
    const enoughTime = shadowDaysRecorded >= 7;
    const falseSuppressionRate = evaluated.length ? falseSuppressions / evaluated.length : null;
    const promotionEligible = evaluated.length > 0 && (enoughTraffic || enoughTime) && falseSuppressionRate !== null && falseSuppressionRate < 0.05;
    return {
      recordedDecisions: this.state.decisions.length,
      recordedAgents: agents.length,
      shadowSuppressions: suppressions.length,
      evaluatedShadowSuppressions: evaluated.length,
      falseSuppressions,
      falseSuppressionRate,
      firstShadowDecisionAt,
      shadowDaysRecorded,
      promotionEligible,
      promotionEligibilityReasons: [
        ...(evaluated.length === 0 ? ["no_evaluable_suppressions"] : []),
        ...(!enoughTraffic && !enoughTime ? ["minimum_shadow_window_not_reached"] : []),
        ...(falseSuppressionRate !== null && falseSuppressionRate >= 0.05 ? ["false_suppression_rate_too_high"] : []),
      ],
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
