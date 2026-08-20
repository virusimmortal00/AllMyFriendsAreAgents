import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { AgentId } from "./types.js";

export interface GenerationJournalEvent {
  type: "generation.started" | "generation.retry" | "generation.completed" | "generation.cancelled" | "generation.failed" | "generation.interpreted" | "generation.delivery";
  generationId: string;
  agent: AgentId;
  timestamp?: string;
  [key: string]: unknown;
}

export class GenerationJournal {
  readonly path: string;
  private queue: Promise<void> = Promise.resolve();

  private constructor(journalPath: string) {
    this.path = journalPath;
  }

  static async open(projectRoot: string, stateDirectory = path.join(projectRoot, ".allmyfriendsareagents")) {
    await mkdir(stateDirectory, { recursive: true });
    return new GenerationJournal(path.join(stateDirectory, "generations.jsonl"));
  }

  async append(event: GenerationJournalEvent) {
    const line = `${JSON.stringify({ ...event, timestamp: event.timestamp || new Date().toISOString() })}\n`;
    const operation = this.queue.then(() => appendFile(this.path, line, "utf8"));
    this.queue = operation.catch((error) => {
      console.error(`Could not write agent generation journal: ${error instanceof Error ? error.message : String(error)}`);
    });
    await operation.catch(() => undefined);
  }
}
