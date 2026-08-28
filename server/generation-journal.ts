import { appendFile, chmod, mkdir } from "node:fs/promises";
import path from "node:path";
import type { AgentId } from "./types.js";
import { sanitizeLogValue } from "./structured-logger.js";

export interface GenerationJournalEvent {
  type: "session.fresh" | "session.reused" | "session.invalidated" | "generation.started" | "generation.retry" | "generation.completed" | "generation.cancelled" | "generation.failed" | "generation.interpreted" | "generation.delivery";
  generationId: string;
  agent: AgentId;
  timestamp?: string;
  [key: string]: unknown;
}

export class GenerationJournal {
  readonly path: string;
  private queue: Promise<void> = Promise.resolve();

  private constructor(journalPath: string, private readonly onError?: (error: unknown) => unknown) {
    this.path = journalPath;
  }

  static async open(projectRoot: string, stateDirectory = path.join(projectRoot, ".allmyfriendsareagents"), onError?: (error: unknown) => unknown) {
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    await chmod(stateDirectory, 0o700);
    return new GenerationJournal(path.join(stateDirectory, "generations.jsonl"), onError);
  }

  async append(event: GenerationJournalEvent) {
    const { prompt: _prompt, rawResponse: _rawResponse, cliStdout: _cliStdout, cliStderr: _cliStderr, instruction: _instruction, visibleMessages: _visibleMessages, ...metadata } = event;
    const line = `${JSON.stringify(sanitizeLogValue({ ...metadata, timestamp: event.timestamp || new Date().toISOString() }))}\n`;
    const operation = this.queue.catch(() => undefined).then(async () => {
      await appendFile(this.path, line, { encoding: "utf8", mode: 0o600 });
      await chmod(this.path, 0o600);
    });
    this.queue = operation.catch((error) => {
      try { void Promise.resolve(this.onError?.(error)).catch(() => undefined); } catch { /* Error reporting is best effort. */ }
    });
    await operation.catch(() => undefined);
  }
}
