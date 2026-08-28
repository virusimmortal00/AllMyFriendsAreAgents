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
    this.path = path.join(logging.logDirectory, "generation-provider-exchanges.jsonl");
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
      const { cliStdout, cliStderr, providerErrors, toolOutcomes, ...exchange } = event;
      const context = { generationId: event.generationId, selfId: event.agent };
      this.logging.log("generation-provider-exchanges", event.type === "generation.failed" ? "error" : "info", event.type, exchange, context);
      if (cliStdout !== undefined) {
        this.logging.log("opencode-stdout", "info", "opencode.stdout", { output: cliStdout, generationEvent: event.type }, context);
        for (const line of String(cliStdout).split("\n")) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line) as { type?: string; part?: { type?: string; state?: unknown; tool?: string; callID?: string; id?: string } };
            if (parsed.type === "tool_use" || parsed.part?.type === "tool") this.logging.log("tool-outcomes", "info", "opencode.tool.outcome", { raw: line, interpreted: parsed }, context);
            if (parsed.type === "error") this.logging.log("provider-errors", "error", "opencode.provider.error", { raw: line, interpreted: parsed }, context);
          } catch {
            // The complete malformed line remains preserved in the stdout stream.
          }
        }
      }
      if (cliStderr !== undefined) this.logging.log("opencode-stderr", "warn", "opencode.stderr", { output: cliStderr, generationEvent: event.type }, context);
      if (providerErrors !== undefined || event.type === "generation.failed") {
        this.logging.log("provider-errors", "error", "provider.exchange.failed", { errors: providerErrors, error: event.error, routing: event.routing, rateLimit: event.rateLimit, cooldown: event.cooldown }, context);
      }
      if (toolOutcomes !== undefined) this.logging.log("tool-outcomes", "info", "tool.outcomes", { outcomes: toolOutcomes }, context);
      else if (event.toolCalls !== undefined) this.logging.log("tool-outcomes", "info", "tool.outcomes.summary", { toolCalls: event.toolCalls, toolFailures: event.toolFailures, generationEvent: event.type }, context);
    } catch {
      // Logging is diagnostic infrastructure and never fails the served generation.
    }
  }
}
