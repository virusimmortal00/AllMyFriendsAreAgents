import type { AgentId } from "../shared/participants.js";
import { randomUUID } from "node:crypto";

export const ACTIVE_GENERATION_TIMEOUT_MS = 6 * 60_000;

export type ActiveGenerations = Record<string, AgentId>;

export class ActiveGenerationTracker {
  private readonly generations = new Map<string, AgentId>();
  private readonly reservations = new Map<string, AgentId>();
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
    if (this.generations.size === 0 && this.reservations.size === 0) return false;
    for (const timeout of this.timeouts.values()) clearTimeout(timeout);
    this.generations.clear();
    this.reservations.clear();
    this.timeouts.clear();
    this.emit();
    return true;
  }

  clearAgent(agent: AgentId) {
    const matching = [...this.generations].filter(([, candidate]) => candidate === agent).map(([generationId]) => generationId);
    for (const generationId of matching) this.finish(generationId);
    for (const [reservationId, candidate] of this.reservations) if (candidate === agent) this.reservations.delete(reservationId);
    return matching.length > 0;
  }

  snapshot(): ActiveGenerations {
    return Object.fromEntries(this.generations);
  }

  size() { return this.generations.size + this.reservations.size; }

  reserve(agent: AgentId, limit: number) {
    if (this.size() >= limit || [...this.generations.values(), ...this.reservations.values()].includes(agent)) return undefined;
    const reservationId = `command:${randomUUID()}`;
    this.reservations.set(reservationId, agent);
    let released = false;
    return { release: () => { if (released) return false; released = true; return this.reservations.delete(reservationId); } };
  }

  private emit() {
    this.onChange(this.snapshot());
  }
}
