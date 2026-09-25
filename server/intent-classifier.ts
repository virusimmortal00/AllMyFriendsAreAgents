import type { AgentId } from "../shared/participants.js";
import type { PreflightClassificationAudit, PreflightClassificationSnapshot } from "../shared/preflight.js";
import { JEV_QUESTION_TEXT, jevQuestionForName, jevQuestionProfile, type JevQuestionProfileId } from "./jev-experiment-profiles.js";

/**
 * Published Jev pricing over OpenRouter: input is billed per million tokens,
 * output is free. Only used as a fallback when OpenRouter's response omits
 * `usage.cost`.
 */
export const JEV_INPUT_COST_PER_MILLION_TOKENS = 0.042;

const DEFAULT_MODEL = "~typesafe/jev-latest";
const DEFAULT_ENDPOINT = "https://openrouter.ai/api/alpha/decisions";
const DEFAULT_TIMEOUT_MS = 1_000;
const FAILURE_THRESHOLD = 3;
const FAILURE_COOLDOWN_MS = 5 * 60_000;
const REPORTED_MODEL_ID = /^(?=.{3,160}$)~?[a-zA-Z0-9._-]+\/[a-zA-Z0-9._/-]+$/;

export type IntentClassificationOutcome =
  | {
      outcome: "completed";
      durationMs: number;
      inputTokens: number;
      outputTokens: number;
      costUsd: number;
      reportedInputTokens?: number;
      reportedOutputTokens?: number;
      reportedCostUsd?: number;
    }
  | { outcome: "skipped"; durationMs: number; reason: "disabled" | "cooldown" | "empty_input" | "no_credential" }
  | {
      outcome: "failed";
      durationMs: number;
      failureCategory: "timeout" | "authentication" | "http" | "transport" | "schema";
    };

class ClassificationFailure extends Error {
  constructor(readonly category: Extract<IntentClassificationOutcome, { outcome: "failed" }>["failureCategory"]) {
    super(category);
  }
}

export interface IntentClassifierAgent {
  agentId: AgentId;
  /** Conversational name participants actually use when addressing this agent. */
  name: string;
}

export interface IntentClassifierOptions {
  /** Reads the room's existing OpenRouter credential; no separate provider key. */
  apiKey?: () => Promise<string | undefined> | string | undefined;
  model?: string;
  /** Closed question shape; the server selects nondefault values only in an isolated test room. */
  questionProfileId?: JevQuestionProfileId;
  endpoint?: string;
  /** Server-owned kill switch; when true the classifier never consults. */
  disabled?: boolean;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Diagnostic sink. Never receives message text or credentials. */
  log?: (level: "info" | "warn" | "error", event: string, fields: Record<string, unknown>) => void | Promise<void>;
}

export interface IntentClassificationInput {
  transcript: string;
  agents: readonly IntentClassifierAgent[];
  /** Per-consult outcome sink. A sink failure must not affect routing. */
  onOutcome?: (outcome: IntentClassificationOutcome) => unknown;
}

interface TypeSafeAnswer {
  type?: string;
  noul?: unknown;
  choice?: unknown;
}

interface TypeSafeResponse {
  model?: unknown;
  answers?: Record<string, TypeSafeAnswer>;
  usage?: { input_tokens?: unknown; output_tokens?: unknown; cost?: unknown };
}

type FetchLike = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

function probability(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined;
}

function boundedInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * Server-side consult of Jev (TypeSafe System One) routed through the room's
 * existing OpenRouter connection via the Decisions API. Classifies whether the
 * latest room message directly addresses each roster agent.
 *
 * The classifier is strictly advisory: every failure path returns undefined so
 * pre-flight routing falls back to the deterministic gate. Message text is
 * sent to the configured OpenRouter endpoint and never appears in logs or
 * errors.
 */
export class IntentClassifier {
  private readonly apiKey: IntentClassifierOptions["apiKey"];
  private readonly model: string;
  private readonly questionProfileId: JevQuestionProfileId;
  private readonly endpoint: string;
  private readonly disabled: boolean;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly log: IntentClassifierOptions["log"];
  private consecutiveFailures = 0;
  private cooldownUntilMs = 0;

  constructor(options: IntentClassifierOptions = {}) {
    this.apiKey = options.apiKey;
    this.model = options.model?.trim() || DEFAULT_MODEL;
    this.questionProfileId = options.questionProfileId ?? "current-v1";
    const endpoint = new URL(options.endpoint?.trim() || DEFAULT_ENDPOINT);
    if (endpoint.protocol !== "https:") throw new Error("The intent classifier endpoint must use HTTPS.");
    this.endpoint = endpoint.toString();
    this.disabled = options.disabled === true;
    const configuredTimeout = options.timeoutMs;
    this.timeoutMs = Math.min(DEFAULT_TIMEOUT_MS, Math.max(250, typeof configuredTimeout === "number" && Number.isFinite(configuredTimeout) ? configuredTimeout : DEFAULT_TIMEOUT_MS));
    this.fetchImpl = (options.fetchImpl ?? fetch) as unknown as FetchLike;
    this.now = options.now ?? Date.now;
    this.log = options.log;
  }

  async available(): Promise<boolean> {
    if (this.disabled || this.now() < this.cooldownUntilMs) return false;
    return Boolean(await this.resolveKey());
  }

  private async resolveKey(): Promise<string | undefined> {
    try {
      const key = await this.apiKey?.();
      return typeof key === "string" && key.trim() ? key.trim() : undefined;
    } catch {
      return undefined;
    }
  }

  async classify(input: IntentClassificationInput): Promise<PreflightClassificationSnapshot | undefined> {
    const startedAt = this.now();
    const durationMs = () => Math.max(0, this.now() - startedAt);
    const report = (outcome: IntentClassificationOutcome) => {
      try {
        void Promise.resolve(input.onOutcome?.(outcome)).catch(() => {});
      } catch {
        /* Observability cannot change routing. */
      }
      try {
        void Promise.resolve(
          this.log?.(outcome.outcome === "failed" ? "warn" : "info", `intent.classification.${outcome.outcome}`, {
            ...outcome,
            agentCount: input.agents.length,
          }),
        ).catch(() => {});
      } catch {
        /* Observability cannot change routing. */
      }
    };
    const skip = (reason: Extract<IntentClassificationOutcome, { outcome: "skipped" }>["reason"]) => {
      report({ outcome: "skipped", reason, durationMs: durationMs() });
      return undefined;
    };
    if (this.disabled) return skip("disabled");
    if (this.now() < this.cooldownUntilMs) return skip("cooldown");
    if (!input.agents.length || !input.transcript.trim()) return skip("empty_input");
    const profile = jevQuestionProfile(this.questionProfileId);
    const questions: Record<string, unknown> = {
      whole_room: {
        type: "noul",
        instructions: JEV_QUESTION_TEXT.wholeRoom,
      },
      ...(profile.primaryChoice ? { primary_addressee: {
        type: "choice",
        instructions: JEV_QUESTION_TEXT.primary,
        criteria: {
          ...Object.fromEntries(input.agents.map(({ agentId, name }) => [agentId, jevQuestionForName(JEV_QUESTION_TEXT.primaryAgent, name)])),
          human: JEV_QUESTION_TEXT.primaryHuman,
          none_of_the_above: JEV_QUESTION_TEXT.primaryNone,
        },
      } } : {}),
    };
    for (const { agentId, name } of input.agents) {
      questions[agentId] = {
        type: "noul",
        instructions: jevQuestionForName(JEV_QUESTION_TEXT.direct, name),
      };
      if (profile.optionalWorthQuestion) questions[`optional_worth_${agentId}`] = {
        type: "noul",
        instructions: jevQuestionForName(JEV_QUESTION_TEXT.optionalWorth, name),
      };
    }

    const controller = new AbortController();
    let expired = false;
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => {
          expired = true;
          controller.abort();
          reject(new ClassificationFailure("timeout"));
        },
        Math.max(0, this.timeoutMs - durationMs()),
      );
    });
    try {
      const attempt = async () => {
        if (durationMs() >= this.timeoutMs) throw new ClassificationFailure("timeout");
        const apiKey = await this.resolveKey();
        if (controller.signal.aborted || durationMs() >= this.timeoutMs) throw new ClassificationFailure("timeout");
        if (!apiKey) return undefined;
        return this.request(apiKey, input.transcript, questions, controller.signal);
      };
      const parsed = await Promise.race([attempt(), deadline]);
      if (expired || durationMs() >= this.timeoutMs) throw new ClassificationFailure("timeout");
      if (!parsed) return skip("no_credential");
      const agents: Partial<Record<AgentId, number>> = {};
      for (const { agentId } of input.agents) {
        const value = probability(parsed.answers?.[agentId]?.noul);
        if (value !== undefined) agents[agentId] = value;
      }
      const wholeRoom = probability(parsed.answers?.whole_room?.noul);
      const primaryAddressee = parsed.answers?.primary_addressee?.choice;
      const optionalWorth: Partial<Record<AgentId, number>> = {};
      if (profile.optionalWorthQuestion) for (const { agentId } of input.agents) {
        const value = probability(parsed.answers?.[`optional_worth_${agentId}`]?.noul);
        if (value !== undefined) optionalWorth[agentId] = value;
      }
      if (wholeRoom === undefined) throw new ClassificationFailure("schema");
      const inputTokens = boundedInteger(parsed.usage?.input_tokens);
      const reportedCost =
        typeof parsed.usage?.cost === "number" && Number.isFinite(parsed.usage.cost) && parsed.usage.cost >= 0
          ? parsed.usage.cost
          : undefined;
      const snapshot: PreflightClassificationSnapshot = {
        model: typeof parsed.model === "string" && parsed.model ? parsed.model : this.model,
        ...(typeof parsed.model === "string" && REPORTED_MODEL_ID.test(parsed.model) ? { providerResolvedModelId: parsed.model } : {}),
        agents,
        wholeRoom,
        ...(profile.optionalWorthQuestion ? { optionalWorth } : {}),
        ...(typeof primaryAddressee === "string" && primaryAddressee ? { primaryAddressee } : {}),
        usage: { inputTokens, outputTokens: boundedInteger(parsed.usage?.output_tokens) },
        costUsd: reportedCost ?? (inputTokens / 1_000_000) * JEV_INPUT_COST_PER_MILLION_TOKENS,
        latencyMs: durationMs(),
      };
      if (expired || durationMs() >= this.timeoutMs) throw new ClassificationFailure("timeout");
      this.consecutiveFailures = 0;
      report({
        outcome: "completed",
        durationMs: snapshot.latencyMs,
        inputTokens: snapshot.usage.inputTokens,
        outputTokens: snapshot.usage.outputTokens,
        costUsd: snapshot.costUsd,
        ...(typeof parsed.usage?.input_tokens === "number" && Number.isFinite(parsed.usage.input_tokens) && parsed.usage.input_tokens >= 0 ? { reportedInputTokens: inputTokens } : {}),
        ...(typeof parsed.usage?.output_tokens === "number" && Number.isFinite(parsed.usage.output_tokens) && parsed.usage.output_tokens >= 0 ? { reportedOutputTokens: snapshot.usage.outputTokens } : {}),
        ...(reportedCost === undefined ? {} : { reportedCostUsd: reportedCost }),
      });
      return snapshot;
    } catch (error) {
      const failureCategory = expired ? "timeout" : error instanceof ClassificationFailure ? error.category : "schema";
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures >= FAILURE_THRESHOLD) {
        this.cooldownUntilMs = this.now() + FAILURE_COOLDOWN_MS;
        this.consecutiveFailures = 0;
      }
      report({ outcome: "failed", failureCategory, durationMs: durationMs() });
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  private async request(
    apiKey: string,
    state: string,
    questions: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<TypeSafeResponse> {
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.model, state, questions }),
        signal,
      });
    } catch {
      throw new ClassificationFailure("transport");
    }
    if (!response.ok)
      throw new ClassificationFailure(response.status === 401 || response.status === 403 ? "authentication" : "http");
    let parsed: TypeSafeResponse;
    try {
      parsed = (await response.json()) as TypeSafeResponse;
    } catch {
      throw new ClassificationFailure("schema");
    }
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof parsed.answers !== "object" ||
      !parsed.answers ||
      Array.isArray(parsed.answers)
    ) {
      throw new ClassificationFailure("schema");
    }
    return parsed;
  }
}

/** Projects a completed consult plus the deterministic baseline into the durable audit shape. */
export function classificationAudit(
  classification: PreflightClassificationSnapshot,
  baseline: ReadonlyArray<{ agent: AgentId; outcome: "invoke" | "suppress" | "unavailable"; reason: string }>,
): PreflightClassificationAudit {
  return {
    model: classification.model,
    ...(classification.providerResolvedModelId ? { providerResolvedModelId: classification.providerResolvedModelId } : {}),
    latencyMs: classification.latencyMs,
    inputTokens: classification.usage.inputTokens,
    outputTokens: classification.usage.outputTokens,
    costUsd: classification.costUsd,
    wholeRoomProbability: classification.wholeRoom,
    addressProbabilities: { ...classification.agents },
    ...(classification.optionalWorth ? { optionalWorthProbabilities: { ...classification.optionalWorth } } : {}),
    baseline: baseline.map((entry) => ({ ...entry })),
  };
}
