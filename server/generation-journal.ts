import path from "node:path";
import type { AgentId } from "./types.js";
import { AuthoritativeLogging } from "./authoritative-logging.js";

export interface GenerationJournalEvent {
  type: "session.fresh" | "session.reused" | "session.invalidated" | "generation.started" | "generation.retry" | "generation.completed" | "generation.cancelled" | "generation.failed" | "generation.interpreted" | "generation.delivery";
  generationId: string;
  agent: AgentId;
  timestamp?: string;
  [key: string]: unknown;
}

/** Compatibility facade routing generation evidence into the six-stream foundation. */
export class GenerationJournal {
  readonly path: string;
  private constructor(readonly logging: AuthoritativeLogging) {
    this.path = path.join(logging.logDirectory, "generations.jsonl");
  }

  static async open(projectRoot: string, stateDirectory = path.join(projectRoot, ".allmyfriendsareagents"), onError?: (error: unknown) => unknown, logging?: AuthoritativeLogging) {
    try {
      const foundation = logging || await AuthoritativeLogging.open({ dataDirectory: stateDirectory, projectId: path.basename(projectRoot), projectPath: projectRoot });
      return new GenerationJournal(foundation);
    } catch (error) {
      onError?.(error);
      throw error;
    }
  }

  async append(event: GenerationJournalEvent) {
    try {
      const {
        cliStdout, cliStderr, providerErrors, providerUsage, providerCostUsd,
        routing, rateLimit, cooldown, toolOutcomes, toolCalls, toolFailures, error,
        ...generation
      } = event;
      const context = { generationId: event.generationId, correlationId: event.generationId, agentId: event.agent, selfId: event.agent, visibility: "project" as const };
      this.logging.log("generations", event.type === "generation.failed" ? "error" : "info", event.type, generation, context);
      if (cliStdout !== undefined) {
        this.logging.log("opencode-harness", "info", "opencode.stdout", { output: cliStdout, generationEvent: event.type }, context);
        for (const line of String(cliStdout).split("\n")) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line) as { type?: string; part?: { type?: string; state?: unknown; tool?: string; callID?: string; id?: string } };
            if (parsed.type === "tool_use" || parsed.part?.type === "tool") this.logging.log("opencode-harness", "info", "opencode.tool.outcome", { interpreted: parsed }, context);
          } catch {
            // The complete malformed line remains preserved in the stdout stream.
          }
        }
      }
      if (cliStderr !== undefined) this.logging.log("opencode-harness", "warn", "opencode.stderr", { output: cliStderr, generationEvent: event.type }, context);
      if (providerErrors !== undefined || providerUsage !== undefined || providerCostUsd !== undefined || routing !== undefined || rateLimit !== undefined || cooldown !== undefined || error !== undefined || event.type === "generation.failed") {
        this.logging.log("openrouter-provider", providerErrors !== undefined || event.type === "generation.failed" ? "error" : "info", providerErrors !== undefined || event.type === "generation.failed" ? "provider.exchange.failed" : "provider.exchange.observed", {
          errors: providerErrors, usage: providerUsage, costUsd: providerCostUsd,
          routing, rateLimit, cooldown, error,
        }, context);
      }
      if (toolOutcomes !== undefined) this.logging.log("opencode-harness", "info", "opencode.tool.outcomes", { outcomes: toolOutcomes }, context);
      else if (toolCalls !== undefined) this.logging.log("opencode-harness", "info", "opencode.tool.outcomes.summary", { toolCalls, toolFailures, generationEvent: event.type }, context);
    } catch {
      // Logging is diagnostic infrastructure and never fails the served generation.
    }
  }
}
