import type { AgentId } from "../shared/participants.js";
import type { PreflightClassificationAudit, PreflightClassificationSnapshot } from "../shared/preflight.js";

/**
 * Published Jev pricing over OpenRouter: input is billed per million tokens,
 * output is free. Only used as a fallback when OpenRouter's response omits
 * `usage.cost`.
 */
export const JEV_INPUT_COST_PER_MILLION_TOKENS = 0.042;

const DEFAULT_MODEL = "~typesafe/jev-latest";
const DEFAULT_ENDPOINT = "https://openrouter.ai/api/alpha/decisions";
const DEFAULT_TIMEOUT_MS = 2_500;
const FAILURE_THRESHOLD = 3;
const FAILURE_COOLDOWN_MS = 5 * 60_000;
const ERROR_MESSAGE_LIMIT = 200;

export interface IntentClassifierAgent {
  agentId: AgentId;
  /** Conversational name participants actually use when addressing this agent. */
  name: string;
}

export interface IntentClassifierOptions {
  /** Reads the room's existing OpenRouter credential; no separate provider key. */
  apiKey?: () => Promise<string | undefined> | string | undefined;
  model?: string;
  endpoint?: string;
  /** Server-owned kill switch; when true the classifier never consults. */
  disabled?: boolean;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Diagnostic sink. Never receives message text or credentials. */
  log?: (level: "info" | "warn" | "error", event: string, fields: Record<string, unknown>) => void;
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

type FetchLike = (input: string, init: {
  method: string;
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
}) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

function probability(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined;
}

function boundedInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, ERROR_MESSAGE_LIMIT);
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
    const endpoint = new URL(options.endpoint?.trim() || DEFAULT_ENDPOINT);
    if (endpoint.protocol !== "https:") throw new Error("The intent classifier endpoint must use HTTPS.");
    this.endpoint = endpoint.toString();
    this.disabled = options.disabled === true;
    this.timeoutMs = Math.max(250, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
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

  async classify(input: { transcript: string; agents: readonly IntentClassifierAgent[] }): Promise<PreflightClassificationSnapshot | undefined> {
    if (this.disabled || this.now() < this.cooldownUntilMs || !input.agents.length || !input.transcript.trim()) return undefined;
    const apiKey = await this.resolveKey();
    if (!apiKey) return undefined;
    const questions: Record<string, unknown> = {
      whole_room: {
        type: "noul",
        instructions: "The most recent message in this conversation invites every participant to respond.",
      },
      primary_addressee: {
        type: "choice",
        instructions: "Who is the most recent message primarily addressed to?",
        criteria: {
          ...Object.fromEntries(input.agents.map(({ agentId, name }) => [agentId, `The agent participant ${name}`])),
          human: "The human who sent the most recent message is themselves the addressee",
          none_of_the_above: "No single participant is primarily addressed",
        },
      },
    };
    for (const { agentId, name } of input.agents) {
      questions[agentId] = {
        type: "noul",
        instructions: `The most recent message directly addresses ${name}: it asks ${name} to answer, act, or reply. A recap, attribution, correction of someone else, or aside that merely mentions ${name} without requesting a response from them does not count.`,
      };
    }

    const startedAt = this.now();
    try {
      const parsed = await this.request(apiKey, input.transcript, questions);
      const agents: Partial<Record<AgentId, number>> = {};
      for (const { agentId } of input.agents) {
        const value = probability(parsed.answers?.[agentId]?.noul);
        if (value !== undefined) agents[agentId] = value;
      }
      const wholeRoom = probability(parsed.answers?.whole_room?.noul);
      const primaryAddressee = parsed.answers?.primary_addressee?.choice;
      if (wholeRoom === undefined) throw new Error("the decisions response is missing the whole_room answer");
      const inputTokens = boundedInteger(parsed.usage?.input_tokens);
      const reportedCost = typeof parsed.usage?.cost === "number" && Number.isFinite(parsed.usage.cost) && parsed.usage.cost >= 0
        ? parsed.usage.cost
        : undefined;
      const snapshot: PreflightClassificationSnapshot = {
        model: typeof parsed.model === "string" && parsed.model ? parsed.model : this.model,
        agents,
        wholeRoom,
        ...(typeof primaryAddressee === "string" && primaryAddressee ? { primaryAddressee } : {}),
        usage: { inputTokens, outputTokens: boundedInteger(parsed.usage?.output_tokens) },
        costUsd: reportedCost ?? (inputTokens / 1_000_000) * JEV_INPUT_COST_PER_MILLION_TOKENS,
        latencyMs: Math.max(0, this.now() - startedAt),
      };
      this.consecutiveFailures = 0;
      this.log?.("info", "intent.classification.completed", {
        model: snapshot.model,
        agentCount: input.agents.length,
        latencyMs: snapshot.latencyMs,
        inputTokens,
        costUsd: snapshot.costUsd,
        wholeRoom: snapshot.wholeRoom,
      });
      return snapshot;
    } catch (error) {
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures >= FAILURE_THRESHOLD) {
        this.cooldownUntilMs = this.now() + FAILURE_COOLDOWN_MS;
        this.consecutiveFailures = 0;
        this.log?.("warn", "intent.classification.cooldown", { model: this.model, failureThreshold: FAILURE_THRESHOLD, cooldownMs: FAILURE_COOLDOWN_MS, error: sanitizeError(error) });
      } else {
        this.log?.("warn", "intent.classification.failed", { model: this.model, consecutiveFailures: this.consecutiveFailures, error: sanitizeError(error) });
      }
      return undefined;
    }
  }

  private async request(apiKey: string, state: string, questions: Record<string, unknown>): Promise<TypeSafeResponse> {
    const fetchPromise = this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.model, state, questions }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`decisions classification timed out after ${this.timeoutMs}ms`)), this.timeoutMs);
    });
    try {
      const response = await Promise.race([fetchPromise, timeout]);
      if (!response.ok) throw new Error(`OpenRouter decisions responded with HTTP ${response.status}`);
      const parsed = (await response.json()) as TypeSafeResponse;
      if (!parsed || typeof parsed !== "object" || typeof parsed.answers !== "object" || !parsed.answers) {
        throw new Error("OpenRouter decisions response is missing answers");
      }
      return parsed;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Projects a completed consult plus the deterministic baseline into the durable audit shape. */
export function classificationAudit(
  classification: PreflightClassificationSnapshot,
  baseline: ReadonlyArray<{ agent: AgentId; outcome: "invoke" | "suppress" | "unavailable"; reason: string }>,
): PreflightClassificationAudit {
  return {
    model: classification.model,
    latencyMs: classification.latencyMs,
    inputTokens: classification.usage.inputTokens,
    outputTokens: classification.usage.outputTokens,
    costUsd: classification.costUsd,
    wholeRoomProbability: classification.wholeRoom,
    addressProbabilities: { ...classification.agents },
    baseline: baseline.map((entry) => ({ ...entry })),
  };
}
