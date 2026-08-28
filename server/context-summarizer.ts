import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import type { AgentContextSummarizer } from "./transcript.js";
import { classifyAgentFailure } from "./agent-health.js";
import { ProviderInvocationError, providerFailuresFromOpenCodeOutput } from "./provider-failure.js";
import { classifyProviderScopedFailure, type ProviderHealthRegistry } from "./provider-health.js";

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 30_000;
const OUTPUT_LIMIT = 64 * 1024;
const OPENCODE_COMMAND = process.env.ALL_MY_FRIENDS_ARE_AGENTS_OPENCODE_COMMAND?.trim() || "opencode";
type SummarizerExecutor = (command: string, args: readonly string[], options: { timeout: number; maxBuffer: number; env: NodeJS.ProcessEnv }) => Promise<{ stdout: string; stderr: string }>;

interface SummarizerHealthIntegration {
  readonly providers: ProviderHealthRegistry;
  readonly onChange?: () => void;
}

function textFromJsonLines(stdout: string) {
  const text: string[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as { type?: string; part?: { type?: string; text?: string } };
      if (event.type === "text" && event.part?.type === "text" && event.part.text) text.push(event.part.text);
    } catch {
      // Non-protocol progress is ignored.
    }
  }
  return text.join("").trim();
}

function summarizerEnvironment(environment: NodeJS.ProcessEnv = process.env) {
  return {
    ...Object.fromEntries(Object.entries(environment).filter(([name]) => {
      const normalized = name.toUpperCase();
      return !normalized.startsWith("ALL_MY_FRIENDS_ARE_AGENTS_")
        && !normalized.startsWith("AGENTWIRE_")
        && normalized !== "DATABASE_URL";
    })),
    OPENCODE_PERMISSION: JSON.stringify({ "*": "deny" }),
  };
}

export class OpenCodeContextSummarizer implements AgentContextSummarizer {
  private readonly inFlight = new Map<string, Promise<string>>();
  private readonly completed = new Map<string, string>();
  private readonly routeCooldowns = new Map<string, number>();

  constructor(
    private readonly command = OPENCODE_COMMAND,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
    private readonly execute: SummarizerExecutor = (command, args, options) => execFileAsync(command, [...args], options),
    private readonly health?: SummarizerHealthIntegration,
  ) {}

  summarize(input: Parameters<AgentContextSummarizer["summarize"]>[0]) {
    const key = createHash("sha256").update(JSON.stringify({
      projectPath: input.projectPath,
      transcript: input.transcript,
      tokenTarget: input.tokenTarget,
      promptTemplate: input.promptTemplate,
      models: input.models,
      configRevision: input.configRevision ?? 0,
    })).digest("hex");
    const completed = this.completed.get(key);
    if (completed) return Promise.resolve(completed);
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const pending = this.summarizeUncached(input).then((summary) => {
      this.completed.set(key, summary);
      if (this.completed.size > 32) this.completed.delete(this.completed.keys().next().value!);
      return summary;
    }).finally(() => {
      if (this.inFlight.get(key) === pending) this.inFlight.delete(key);
    });
    this.inFlight.set(key, pending);
    return pending;
  }

  private async summarizeUncached(input: Parameters<AgentContextSummarizer["summarize"]>[0]) {
    const prompt = input.promptTemplate
      .replaceAll("{{tokenTarget}}", String(input.tokenTarget))
      .replaceAll("{{transcript}}", input.transcript);
    const failures: string[] = [];
    for (const model of input.models) {
      const selection = model.providerId ? `${model.providerId}/${model.modelId}` : model.modelId;
      const routeRetryAt = this.routeCooldowns.get(selection);
      if (routeRetryAt !== undefined && routeRetryAt > Date.now()) {
        failures.push(`${selection}: route cooling down`);
        continue;
      }
      if (routeRetryAt !== undefined) this.routeCooldowns.delete(selection);
      const providerAttempt = model.providerId && this.health ? this.health.providers.claimAttempt(model.providerId) : "regular";
      if (providerAttempt === "blocked") {
        failures.push(`${selection}: provider unavailable`);
        continue;
      }
      try {
        const { stdout } = await this.execute(this.command, [
          "run", "--format", "json", "--dir", input.projectPath, "--agent", "plan",
          "--model", selection,
          ...(model.variant ? ["--variant", model.variant] : []),
          prompt,
        ], {
          timeout: this.timeoutMs,
          maxBuffer: OUTPUT_LIMIT,
          env: summarizerEnvironment(),
        });
        const protocolFailure = providerFailuresFromOpenCodeOutput(stdout, 1)[0];
        if (protocolFailure) throw new ProviderInvocationError(protocolFailure);
        const summary = textFromJsonLines(stdout);
        if (summary) {
          this.routeCooldowns.delete(selection);
          if (model.providerId && this.health && await this.health.providers.recordSuccess(model.providerId)) this.health.onChange?.();
          return summary;
        }
        this.routeCooldowns.set(selection, Date.now() + 60_000);
        failures.push(`${selection}: empty response`);
      } catch (error) {
        const stdout = error && typeof error === "object" && "stdout" in error ? (error as { stdout?: unknown }).stdout : undefined;
        const protocolFailure = providerFailuresFromOpenCodeOutput(stdout, 1)[0];
        const classifiedError = protocolFailure ? new ProviderInvocationError(protocolFailure) : error;
        const providerFailure = model.providerId ? classifyProviderScopedFailure(classifiedError, model.providerId) : undefined;
        if (model.providerId && this.health && providerFailure?.status === "action_required") {
          await this.health.providers.recordActionRequired(model.providerId, providerFailure.reason);
          this.health.onChange?.();
          failures.push(`${selection}: provider action required`);
          continue;
        }
        if (model.providerId && this.health && providerFailure?.status === "cooldown") {
          await this.health.providers.recordCooldown(model.providerId, providerFailure);
          this.health.onChange?.();
          failures.push(`${selection}: provider cooling down`);
          continue;
        }
        if (model.providerId && this.health && providerAttempt === "recovery") this.health.providers.recordRecoveryFailure(model.providerId);
        const local = classifyAgentFailure(classifiedError);
        const retryAt = local.status === "cooldown" && local.retryAt ? Date.parse(local.retryAt) : Date.now() + 5 * 60_000;
        this.routeCooldowns.set(selection, retryAt);
        failures.push(`${selection}: route unavailable`);
      }
    }
    throw new Error(`Context summarization unavailable (${failures.join("; ")}).`);
  }
}

export const __testing = { textFromJsonLines, summarizerEnvironment };
