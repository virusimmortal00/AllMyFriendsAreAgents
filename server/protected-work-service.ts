import { createHash } from "node:crypto";
import type { AgentId } from "../shared/participants.js";
import type { ProtectedWorkRequest, ProtectedWorkView } from "../shared/protected-work.js";
import type { InvestigationService } from "./investigation-service.js";
import { investigationIsNonterminal, redactInvestigationText } from "./investigation-record.js";
import { ParticipantReservations, ProtectedWorkStore, type ProtectedReturnReport, type ProtectedWorkRecord } from "./protected-work-store.js";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export class ProtectedReturnCapacityError extends Error {
  constructor() { super("Return is waiting for generation capacity."); }
}
export function protectedWorkView(record: ProtectedWorkRecord): ProtectedWorkView {
  const { workId, roomId, owner, objective, phase, createdAt, startedAt, stoppedAt, updatedAt, blocker, disposition } = record;
  return { workId, roomId, owner: owner as AgentId, objective, phase, createdAt, startedAt, stoppedAt, updatedAt, blocker, disposition };
}
export class ProtectedWorkService {
  private timer?: NodeJS.Timeout;
  private closed = false;
  private processing = false;
  private readonly admissions = new Set<string>();
  private readonly starts = new Map<string, { digest: string; promise: Promise<ProtectedWorkView> }>();
  private readonly mutations = new Map<string, Promise<unknown>>();
  private retentionMutation = 0;
  private retentionCleaned = -1;
  private async exclusive<T>(workId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.mutations.get(workId) || Promise.resolve();
    const pending = previous.catch(() => undefined).then(operation);
    this.mutations.set(workId, pending);
    try { return await pending; }
    finally { if (this.mutations.get(workId) === pending) this.mutations.delete(workId); }
  }
  private readonly returns = new Map<string, AbortController>();
  constructor(private readonly store: ProtectedWorkStore, private readonly investigations: InvestigationService,
    readonly reservations: ParticipantReservations, private readonly options: {
      roomId: string;
      canStart: (owner: AgentId) => boolean;
      departureCursor: () => string | null;
      cursor: () => string;
      hasDelivered: (workId: string) => boolean;
      runReturn: (record: ProtectedWorkRecord, signal: AbortSignal) => Promise<ProtectedReturnReport>;
      scheduleReturn: (workId: string, operation: () => Promise<void>) => Promise<void>;
      deliver: (record: ProtectedWorkRecord) => Promise<boolean>;
      changed?: () => void;
      onError?: (error: unknown) => void;
    }) {}
  async initialize() {
    await this.pruneRetiredInvestigations();
    for (const record of await this.store.list()) {
      if (record.roomId !== this.options.roomId) throw new Error("Protected work belongs to a different room.");
      if (record.phase !== "available") this.reservations.restore(record.owner, record.workId);
    }
    this.timer = setInterval(() => void this.tick().catch((error) => this.options.onError?.(error)), 1_000);
    this.timer.unref();
  }
  async list() { return (await this.store.list()).map(protectedWorkView); }
  async start(input: ProtectedWorkRequest, actor: string) {
    if (this.closed || input.roomId !== this.options.roomId) throw new Error("Protected work is unavailable for this room.");
    const workId = `protected-${digest([input.roomId, actor, input.requestId])}`;
    const requestDigest = digest([input.roomId, input.owner, input.objective]);
    const pending = this.starts.get(workId);
    if (pending) {
      if (pending.digest !== requestDigest) throw new Error("Request ID already belongs to different protected work.");
      return pending.promise;
    }
    const promise = this.admit(input, workId, requestDigest);
    this.starts.set(workId, { digest: requestDigest, promise });
    try { return await promise; } finally { this.starts.delete(workId); }
  }
  private async admit(input: ProtectedWorkRequest, workId: string, requestDigest: string) {
    const existing = await this.store.get(workId);
    if (existing) {
      if (existing.requestDigest !== requestDigest) throw new Error("Request ID already belongs to different protected work.");
      if (existing.phase === "available" && existing.blocker && !existing.package) throw new Error(existing.blocker);
      return protectedWorkView(existing);
    }
    if (!this.options.canStart(input.owner)) throw new Error("Participant is unavailable for protected work.");
    if (!this.reservations.claim(input.owner, workId)) throw new Error("Participant already has active or protected work.");
    const now = new Date().toISOString();
    const record: ProtectedWorkRecord = { schemaVersion: 1, revision: 1, workId, roomId: input.roomId, owner: input.owner,
      objective: redactInvestigationText(input.objective).trim(), requestDigest, phase: "queued", createdAt: now,
      startedAt: null, stoppedAt: null, updatedAt: now, blocker: null, disposition: null,
      departureCursor: this.options.departureCursor(), returnAttempts: 0, package: null, report: null };
    this.admissions.add(workId);
    let saved = false;
    try {
      await this.pruneRetiredInvestigations(true);
      saved = await this.store.put(record, 0);
      if (!saved) throw new Error("Protected work changed concurrently.");
      this.retentionMutation += 1;
      await this.pruneRetiredInvestigations();
      const result = await this.investigations.request({ investigationId: workId, owner: input.owner, objective: record.objective,
        trigger: "Explicit protected read-only review/research", signal: "AUTHENTICATED_HUMAN" });
      if (result.kind !== "ok") {
        const rejected = await this.patch(record, { phase: "available", disposition: "no-update", blocker: result.kind === "not_found" ? "Investigation unavailable." : result.reason });
        if (rejected) this.reservations.release(input.owner, workId);
        throw new Error(result.kind === "not_found" ? "Investigation unavailable." : result.reason);
      }
      this.options.changed?.();
      return protectedWorkView(record);
    } catch (error) {
      if (!saved) this.reservations.release(input.owner, workId);
      throw error;
    } finally { this.admissions.delete(workId); }
  }
  async action(workId: string, action: "stop" | "retry-return" | "dismiss", request?: { actor: string; id: string }) {
    return this.exclusive(workId, () => this.applyAction(workId, action, request));
  }
  private async applyAction(workId: string, action: "stop" | "retry-return" | "dismiss", request?: { actor: string; id: string }) {
    const record = await this.store.get(workId);
    if (!record || record.roomId !== this.options.roomId) throw new Error("Protected work not found.");
    const key = request ? digest([request.actor, request.id]) : undefined;
    const receipt = key ? record.actions?.find((entry) => entry.key === key) : undefined;
    if (receipt && receipt.action !== action) throw new Error("Request ID already belongs to a different operation.");
    if (receipt || record.phase === "available") return protectedWorkView(record);
    if (this.options.hasDelivered(workId)) {
      const acknowledgement = key && this.store.actionReceiptAvailable(record, action) ? { actions: [...(record.actions || []), { key, action }] } : {};
      await this.finish(record, "delivered", acknowledgement);
      return protectedWorkView((await this.store.get(workId))!);
    }
    if (key && !this.store.actionReceiptAvailable(record, action)) throw new Error(action === "retry-return"
      ? "Protected-work retry receipt budget is exhausted; stop and terminal recovery remain available."
      : "Protected-work action receipt budget is exhausted.");
    const acknowledgement = key ? { actions: [...(record.actions || []), { key, action }] } : {};
    if (action === "dismiss") {
      if (!record.stoppedAt) throw new Error("Worker termination must be confirmed before returning without an update.");
      this.returns.get(workId)?.abort();
      await this.finish(record, "no-update", acknowledgement, true);
    } else if (action === "retry-return") {
      if (record.stoppedAt && record.phase === "catching-up") {
        if (key) await this.patch(record, acknowledgement);
        return protectedWorkView((await this.store.get(workId))!);
      }
      if (record.phase !== "blocked" || !record.stoppedAt || !record.package) throw new Error("No blocked return is ready to retry.");
      await this.patch(record, { ...acknowledgement, phase: "catching-up", returnAttempts: 0, blocker: null });
    } else {
      if (record.stoppedAt || record.phase === "stopping") return protectedWorkView(record);
      await this.patch(record, { ...acknowledgement, phase: "stopping", blocker: "Stop requested; waiting for confirmed worker termination." });
      await this.investigations.cancel(workId, "Stopped protected work; retain partial findings for return.");
    }
    this.options.changed?.();
    return protectedWorkView((await this.store.get(workId))!);
  }
  async tick() {
    if (this.closed || this.processing) return;
    this.processing = true;
    try {
      await this.pruneRetiredInvestigations();
      for (let record of await this.store.list()) {
        if (this.admissions.has(record.workId)) continue;
        if (record.phase === "available") continue;
        if (this.options.hasDelivered(record.workId)) { await this.exclusive(record.workId, async () => { const current = await this.store.get(record.workId); if (current && current.phase !== "available") await this.finish(current, "delivered"); }); continue; }
        if (record.phase === "blocked") continue;
        const job = (await this.investigations.list()).find((job) => job.investigationId === record.workId);
        if (!job) {
          const recovered = await this.patch(record, { phase: "available", disposition: "no-update", blocker: "Admission was interrupted before worker creation." });
          if (recovered) this.reservations.release(record.owner, record.workId);
          continue;
        }
        if (!record.package) {
          const revoked = await this.investigations.returnBlocker(record.workId);
          if (revoked && investigationIsNonterminal(job)) await this.investigations.cancel(job.investigationId, "Protected authority revoked; retain findings for return.");
          if (!revoked && record.phase !== "stopping" && ["REQUESTED", "QUEUED", "RUNNING", "WAITING_TOOL"].includes(job.status)) {
            const phase = job.startedAt ? "busy" : "queued";
            if (record.phase !== phase || record.startedAt !== job.startedAt) await this.patch(record, { phase, startedAt: job.startedAt });
            continue;
          }
          if (investigationIsNonterminal(job)) await this.investigations.cancel(job.investigationId, "Protected worker ended or was interrupted; retain its checkpoint for return.");
          if (!await this.investigations.confirmStopped(job.investigationId)) {
            await this.patch(record, { phase: "blocked", blocker: "Worker termination is unconfirmed. Stop again after the executor is reachable." });
            continue;
          }
          const now = new Date().toISOString();
          const next = await this.patch(record, { phase: "catching-up", startedAt: job.startedAt, stoppedAt: now,
            package: { summary: job.resultSummary || job.checkpoint?.summary || "No partial findings are available.",
              evidenceRefs: [...(job.resultEvidence.length ? job.resultEvidence : job.evidenceRefs)], unresolvedQuestions: [...job.unresolvedQuestions],
              status: job.status === "COMPLETED" ? "completed" : record.phase === "stopping" || job.status === "CHECKPOINTED" || job.status === "CANCELLED" ? "interrupted" : "failed", createdAt: now }, blocker: null });
          if (!next) continue;
          record = next;
        }
        await this.options.scheduleReturn(record.workId, () => this.returnToChat(record.workId));
      }
    } finally { this.processing = false; }
  }
  private async returnToChat(workId: string) {
    let record = await this.store.get(workId);
    if (this.closed || !record?.package || record.phase === "available" || record.phase === "blocked") return;
    if (this.options.hasDelivered(workId)) { await this.exclusive(workId, async () => { const current = await this.store.get(workId); if (current && current.phase !== "available") await this.finish(current, "delivered"); }); return; }
    try {
      const authority = await this.investigations.returnBlocker(workId);
      if (authority || !this.options.canStart(record.owner as AgentId)) {
        await this.patch(record, { phase: "blocked", blocker: authority || "Participant is unavailable for return." });
        return;
      }
      if (!record.report || record.report.cursor !== this.options.cursor()) {
        if (record.returnAttempts >= 3) throw new Error("Return attempt budget exhausted. Findings are retained; retry return when the room is ready.");
        const current = await this.patch(record, { phase: "catching-up", report: null, returnAttempts: record.returnAttempts + 1 });
        if (!current) return;
        record = current;
        const controller = new AbortController();
        this.returns.set(workId, controller);
        const timeout = setTimeout(() => controller.abort(), 60_000); timeout.unref();
        let report: ProtectedReturnReport;
        try { report = await this.options.runReturn(record, controller.signal); }
        finally { clearTimeout(timeout); this.returns.delete(workId); }
        if (controller.signal.aborted || this.closed) throw new Error("Return interrupted. Findings are retained.");
        const next = await this.exclusive(workId, async () => {
          if (controller.signal.aborted || this.closed) return undefined;
          return this.patch(record, { phase: "report-pending", report });
        });
        if (!next) return;
        record = next;
      }
      if (record.report!.cursor !== this.options.cursor()) return;
      if (await this.investigations.returnBlocker(workId) || !this.options.canStart(record.owner as AgentId)) {
        await this.patch(record, { phase: "blocked", blocker: "Return authority changed. Findings are retained." });
        return;
      }
      await this.exclusive(workId, async () => {
        const current = await this.store.get(workId);
        if (!current || current.revision !== record.revision || current.phase !== "report-pending" || current.report?.cursor !== this.options.cursor()) return;
        if (!current.report.text) { await this.finish(current, "no-update"); return; }
        if (await this.options.deliver(current)) await this.finish(current, "delivered");
      });
    } catch (error) {
      await this.exclusive(workId, async () => {
        const latest = await this.store.get(workId);
        if (latest && latest.phase !== "available" && error instanceof ProtectedReturnCapacityError) {
          await this.patch(latest, { phase: "catching-up", returnAttempts: Math.max(0, latest.returnAttempts - 1), blocker: error.message });
          return;
        }
        if (latest && latest.phase !== "available") await this.patch(latest, {
          phase: latest.returnAttempts >= 3 || !latest.returnAttempts ? "blocked" : "catching-up",
          blocker: redactInvestigationText(error instanceof Error ? error.message : "Return failed.").slice(0, 2_000),
        });
      });
    }
  }
  private async finish(record: ProtectedWorkRecord, disposition: "delivered" | "no-update", acknowledgement: Partial<ProtectedWorkRecord> = {}, explicit = false) {
    for (const entry of await this.investigations.inbox(record.owner as AgentId)) {
      if (entry.investigationId === record.workId && (entry.status === "UNREAD" || entry.status === "ACKNOWLEDGED")) {
        const result = await this.investigations.acknowledge(entry.inboxEntryId, true);
        if (result.kind !== "ok") throw new Error("Return acknowledgement failed. Findings are retained; retry return.");
      }
    }
    if (!explicit && disposition === "no-update" && record.report?.cursor !== this.options.cursor()) return;
    if (await this.patch(record, { ...acknowledgement, phase: "available", disposition, blocker: null })) this.reservations.release(record.owner, record.workId);
  }
  private async patch(record: ProtectedWorkRecord, patch: Partial<ProtectedWorkRecord>) {
    const next = { ...record, ...patch, revision: record.revision + 1, updatedAt: new Date().toISOString() };
    if (!await this.store.put(next, record.revision)) return undefined;
    this.retentionMutation += 1;
    await this.pruneRetiredInvestigations();
    this.options.changed?.();
    return next;
  }
  private async pruneRetiredInvestigations(required = false) {
    const target = this.retentionMutation;
    if (!required && this.retentionCleaned >= target) return;
    try {
      await this.investigations.pruneTerminalProtectedWork(await this.store.retainedWorkIds());
      this.retentionCleaned = Math.max(this.retentionCleaned, target);
    }
    catch (error) {
      this.options.onError?.(error);
      if (required) throw error;
    }
  }
  async shutdown() { this.closed = true; if (this.timer) clearInterval(this.timer); for (const controller of this.returns.values()) controller.abort(); }
}
