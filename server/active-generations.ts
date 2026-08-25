import type { AgentId } from "../shared/participants.js";

export const ACTIVE_GENERATION_TIMEOUT_MS = 6 * 60_000;

export type ActiveGenerations = Record<string, AgentId>;

export class ActiveGenerationTracker {
  private readonly generations = new Map<string, AgentId>();
  private readonly timeouts = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly onChange: (activeGenerations: ActiveGenerations) => void = () => undefined,
    private readonly timeoutMs = ACTIVE_GENERATION_TIMEOUT_MS,
  ) {}

  start(generationId: string, agent: AgentId) {
    if (this.generations.has(generationId)) return false;
    this.generations.set(generationId, agent);
    const timeout = setTimeout(() => this.finish(generationId), this.timeoutMs);
    timeout.unref();
    this.timeouts.set(generationId, timeout);
    this.emit();
    return true;
  }

  finish(generationId: string) {
    if (!this.generations.delete(generationId)) return false;
    const timeout = this.timeouts.get(generationId);
    if (timeout) clearTimeout(timeout);
    this.timeouts.delete(generationId);
    this.emit();
    return true;
  }

  clear() {
    if (this.generations.size === 0) return false;
    for (const timeout of this.timeouts.values()) clearTimeout(timeout);
    this.generations.clear();
    this.timeouts.clear();
    this.emit();
    return true;
  }

  clearAgent(agent: AgentId) {
    const matching = [...this.generations].filter(([, candidate]) => candidate === agent).map(([generationId]) => generationId);
    for (const generationId of matching) this.finish(generationId);
    return matching.length > 0;
  }

  snapshot(): ActiveGenerations {
    return Object.fromEntries(this.generations);
  }

  private emit() {
    this.onChange(this.snapshot());
  }
}
