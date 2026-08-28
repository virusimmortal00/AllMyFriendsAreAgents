import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type express from "express";
import type { CommandInput, CommandInvocation, RoomCommandName } from "../shared/command-domain.js";
import type { ActiveAgentId } from "../shared/participants.js";
import type { CommandRuntime, CommandResponse } from "./command-runtime.js";

const LEASE_LIFETIME_MS = 10 * 60_000;

interface CommandToolLease {
  readonly digest: Buffer;
  readonly agentId: ActiveAgentId;
  readonly displayName: string;
  readonly providerSessionId: string | null;
  readonly allowedCommands: readonly RoomCommandName[];
  readonly expiresAt: number;
  readonly issuedAt: number;
  readonly manifestRevision: number;
  readonly requests: Map<string, { readonly fingerprint: string; readonly result: Promise<unknown> }>;
}

export type CommandToolLeaseOutcome = "issued" | "refreshed" | "expired" | "revoked" | "accepted" | "rejected";
export type CommandToolRejectionReason = "invalid-request-id" | "request-id-substitution" | "bounded-call-limit" | "permission-not-granted";
export type CommandToolLeaseReason = "lease-issued" | "lease-refreshed" | "lease-expired" | "provider-session-stale" | "tool-call-accepted" | CommandToolRejectionReason;
export type CommandToolSelectorFamily = "recent" | "pr" | "issue" | "ci";
export interface CommandToolLeaseEvent { readonly id: string; readonly at: string; readonly agentId: ActiveAgentId; readonly outcome: CommandToolLeaseOutcome; readonly reason: CommandToolLeaseReason; readonly command: RoomCommandName | null; readonly selectorFamily: CommandToolSelectorFamily | null; readonly issuedAt: string | null; readonly expiresAt: string | null; readonly manifestRevision: number | null }
export interface CommandToolLeaseSnapshot { readonly agentId: ActiveAgentId; readonly present: boolean; readonly status: "active" | "missing" | "expired" | "revoked"; readonly issuedAt: string | null; readonly expiresAt: string | null; readonly providerSessionFresh: boolean; readonly effectiveCommands: readonly RoomCommandName[]; readonly lastManifestIssuance: { readonly revision: number; readonly issuedAt: string } | null; readonly lastRejection: { readonly at: string; readonly reason: CommandToolRejectionReason } | null }

function digest(value: string) { return createHash("sha256").update(value).digest(); }
function fingerprint(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

export class RoomCommandToolBroker {
  private readonly leases = new Map<string, CommandToolLease>();
  private readonly events: CommandToolLeaseEvent[] = [];
  private readonly lastByAgent = new Map<ActiveAgentId, CommandToolLeaseSnapshot>();
  private readonly recorded = new Set<string>();
  private manifestRevision = 0;

  constructor(private readonly runtime: CommandRuntime, private readonly now: () => number = Date.now, private readonly currentProviderSessionId?: (agentId:ActiveAgentId)=>string|null, private readonly operationLog?: (event: CommandToolLeaseEvent) => Promise<unknown> | unknown) {}

  issue(input: { agentId: ActiveAgentId; displayName: string; providerSessionId: string | null; allowedCommands: readonly RoomCommandName[] }) {
    this.prune();
    const existing = [...this.leases.entries()].find(([, lease]) => lease.agentId === input.agentId);
    if (existing) this.leases.delete(existing[0]);
    const token = `${randomUUID()}${randomUUID()}`;
    const key = digest(token).toString("hex");
    const issuedAt = this.now(); const manifestRevision = ++this.manifestRevision;
    this.leases.set(key, { digest: digest(token), ...input, allowedCommands: [...input.allowedCommands], issuedAt, expiresAt: issuedAt + LEASE_LIFETIME_MS, manifestRevision, requests: new Map() });
    this.record(input.agentId, existing ? "refreshed" : "issued", existing ? "lease-refreshed" : "lease-issued", issuedAt, issuedAt + LEASE_LIFETIME_MS, manifestRevision, `${manifestRevision}:issue`);
    return token;
  }

  async execute(token: string, input: { invocation: CommandInput | {command:"polls"}|{command:"poll_vote";pollId:string;optionIndex:number}|{command:"poll_close";pollId:string;expectedRevision:number}|{command:"gh_diagnostic";submissionId:string}; clientSubmissionId: string }) {
    this.prune();
    const supplied = digest(token);
    const lease = this.leases.get(supplied.toString("hex"));
    if (!lease || lease.digest.length !== supplied.length || !timingSafeEqual(lease.digest, supplied)) return undefined;
    const metadata = commandMetadata(input.invocation);
    if(this.currentProviderSessionId&&this.currentProviderSessionId(lease.agentId)!==lease.providerSessionId){this.leases.delete(supplied.toString("hex"));this.record(lease.agentId,"revoked","provider-session-stale",lease.issuedAt,lease.expiresAt,lease.manifestRevision,`${lease.manifestRevision}:revoked`,metadata);return undefined;}
    if (!/^[a-zA-Z0-9_-]{8,100}$/.test(input.clientSubmissionId)) { this.record(lease.agentId,"rejected","invalid-request-id",lease.issuedAt,lease.expiresAt,lease.manifestRevision,`${lease.manifestRevision}:invalid:${input.clientSubmissionId}`,metadata); return { kind: "private-error", message: "A valid command request ID is required." } as const; }
    const requestFingerprint = fingerprint(input);
    const replay = lease.requests.get(input.clientSubmissionId);
    if (replay) { if(replay.fingerprint !== requestFingerprint)this.record(lease.agentId,"rejected","request-id-substitution",lease.issuedAt,lease.expiresAt,lease.manifestRevision,`${lease.manifestRevision}:substitution:${input.clientSubmissionId}`,metadata); return replay.fingerprint === requestFingerprint ? replay.result : { kind: "private-error", message: "That request ID is already bound to a different room command." } as const; }
    if (lease.requests.size >= 8) { this.record(lease.agentId,"rejected","bounded-call-limit",lease.issuedAt,lease.expiresAt,lease.manifestRevision,`${lease.manifestRevision}:limit:${input.clientSubmissionId}`,metadata); return { kind: "private-error", message: "This room command session has reached its bounded call limit." } as const; }
    const operation = typeof input.invocation === "object" && input.invocation ? input.invocation.command : undefined;
    const command = operation==="polls"||operation==="poll_vote"||operation==="poll_close"?"poll":operation==="gh_diagnostic"?"gh":operation;
    if (!command || !lease.allowedCommands.includes(command as RoomCommandName)) {
      const rejected = Promise.resolve({ kind: "private-error", message: "That command is not available to this participant." } as const);
      lease.requests.set(input.clientSubmissionId, { fingerprint: requestFingerprint, result: rejected });
      this.record(lease.agentId,"rejected","permission-not-granted",lease.issuedAt,lease.expiresAt,lease.manifestRevision,`${lease.manifestRevision}:permission:${input.clientSubmissionId}`,metadata);
      return rejected;
    }
    const invoker={ kind: "agent" as const, id: lease.agentId, displayName: lease.displayName };
    const special=input.invocation as {command:string;pollId?:string;optionIndex?:number;expectedRevision?:number;submissionId?:string};
    const result = operation==="polls"?this.runtime.listOpenPolls(invoker):operation==="poll_vote"?this.runtime.vote(special.pollId||"",invoker,input.clientSubmissionId,special.optionIndex??-1):operation==="poll_close"?this.runtime.closePoll(special.pollId||"",invoker,input.clientSubmissionId,special.expectedRevision??-1):operation==="gh_diagnostic"?this.runtime.getGhDiagnostic(invoker,special.submissionId||""):this.runtime.submit(input.invocation as CommandInvocation,invoker,input.clientSubmissionId);
    lease.requests.set(input.clientSubmissionId, { fingerprint: requestFingerprint, result });
    this.record(lease.agentId,"accepted","tool-call-accepted",lease.issuedAt,lease.expiresAt,lease.manifestRevision,`${lease.manifestRevision}:accepted:${input.clientSubmissionId}`,metadata);
    return result;
  }

  snapshot(agentId: ActiveAgentId): CommandToolLeaseSnapshot {
    this.prune(); const located = [...this.leases.entries()].find(([, candidate]) => candidate.agentId === agentId); const lease = located?.[1]; const previous = this.lastByAgent.get(agentId);
    if (!lease) return previous || { agentId, present: false, status: "missing", issuedAt: null, expiresAt: null, providerSessionFresh: true, effectiveCommands: [], lastManifestIssuance: null, lastRejection: null };
    const providerSessionFresh = !this.currentProviderSessionId || this.currentProviderSessionId(agentId) === lease.providerSessionId;
    if (!providerSessionFresh) { this.leases.delete(located![0]); this.record(agentId,"revoked","provider-session-stale",lease.issuedAt,lease.expiresAt,lease.manifestRevision,`${lease.manifestRevision}:revoked`); return this.lastByAgent.get(agentId)!; }
    return { agentId, present: true, status: providerSessionFresh ? "active" : "revoked", issuedAt: new Date(lease.issuedAt).toISOString(), expiresAt: new Date(lease.expiresAt).toISOString(), providerSessionFresh, effectiveCommands: [...lease.allowedCommands], lastManifestIssuance: { revision: lease.manifestRevision, issuedAt: new Date(lease.issuedAt).toISOString() }, lastRejection: previous?.lastRejection || null };
  }

  audit(limit = 100) { return this.events.slice(-Math.max(1, Math.min(limit, 200))); }

  private record(agentId: ActiveAgentId, outcome: CommandToolLeaseOutcome, reason: CommandToolLeaseReason, issuedAt: number | null, expiresAt: number | null, manifestRevision: number | null, dedupe: string, metadata: { command: RoomCommandName | null; selectorFamily: CommandToolSelectorFamily | null } = { command: null, selectorFamily: null }) {
    const dedupeId = createHash("sha256").update(dedupe).digest("hex");
    if (this.recorded.has(dedupeId)) return; this.recorded.add(dedupeId); if (this.recorded.size > 1_000) this.recorded.delete(this.recorded.values().next().value!);
    const event = { id: dedupeId.slice(0, 24), at: new Date(this.now()).toISOString(), agentId, outcome, reason, ...metadata, issuedAt: issuedAt === null ? null : new Date(issuedAt).toISOString(), expiresAt: expiresAt === null ? null : new Date(expiresAt).toISOString(), manifestRevision } satisfies CommandToolLeaseEvent;
    this.events.push(event); if (this.events.length > 500) this.events.splice(0, this.events.length - 500);
    const prior = this.lastByAgent.get(agentId); this.lastByAgent.set(agentId, { agentId, present: outcome === "issued" || outcome === "refreshed" || outcome === "accepted" || outcome === "rejected", status: outcome === "expired" ? "expired" : outcome === "revoked" ? "revoked" : "active", issuedAt: event.issuedAt, expiresAt: event.expiresAt, providerSessionFresh: outcome !== "revoked", effectiveCommands: outcome === "expired" || outcome === "revoked" ? [] : this.snapshotCommands(agentId), lastManifestIssuance: manifestRevision && event.issuedAt ? { revision: manifestRevision, issuedAt: event.issuedAt } : prior?.lastManifestIssuance || null, lastRejection: outcome === "rejected" ? { at: event.at, reason: reason as CommandToolRejectionReason } : prior?.lastRejection || null });
    void this.operationLog?.(event);
  }

  private snapshotCommands(agentId: ActiveAgentId) { return [...this.leases.values()].find((lease) => lease.agentId === agentId)?.allowedCommands || []; }

  private prune() {
    const now = this.now();
    for (const [key, lease] of this.leases) if (lease.expiresAt <= now) { this.leases.delete(key); this.record(lease.agentId,"expired","lease-expired",lease.issuedAt,lease.expiresAt,lease.manifestRevision,`${lease.manifestRevision}:expired`); }
  }
}

function commandMetadata(invocation: CommandInput | { command: string }) {
  if (!invocation || typeof invocation !== "object") return { command: null, selectorFamily: null } as const;
  const operation = invocation.command;
  const command: RoomCommandName | null = operation === "polls" || operation === "poll_vote" || operation === "poll_close" ? "poll" : operation === "gh_diagnostic" ? "gh" : operation === "task" || operation === "pov" || operation === "poll" || operation === "help" || operation === "gh" ? operation : null;
  const selector = operation === "gh" && "selector" in invocation && invocation.selector && typeof invocation.selector === "object" ? (invocation.selector as { kind?: unknown }).kind : undefined;
  const selectorFamily: CommandToolSelectorFamily | null = selector === "recent" || selector === "pr" || selector === "issue" || selector === "ci" ? selector : null;
  return { command, selectorFamily };
}

export function registerRoomCommandToolRoute(app: express.Express, broker: RoomCommandToolBroker) {
  app.post("/api/agent-tools/room-command", async (request, response) => {
    const authorization = request.header("authorization") || "";
    const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!token) return response.status(404).json({ error: "Not found." });
    const clientSubmissionId = typeof request.body?.clientSubmissionId === "string" ? request.body.clientSubmissionId.trim() : "";
    const result = await broker.execute(token, { invocation: request.body?.invocation as CommandInput, clientSubmissionId });
    if (!result) return response.status(404).json({ error: "Not found." });
    return response.set("Cache-Control", "no-store").json(result);
  });
}
