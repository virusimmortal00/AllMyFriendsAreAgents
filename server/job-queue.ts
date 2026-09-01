import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { JobQueueDecision } from "../shared/conversation-observability.js";
import { observeSafely } from "./nonblocking-observer.js";

export type { JobQueueDecision } from "../shared/conversation-observability.js";
export interface QueuedJobIdentity { readonly jobId: string; readonly admissionId: string }
export type QueuedJob = (identity: QueuedJobIdentity) => Promise<void>;
export type JobQueueObserver = (decision: JobQueueDecision) => void;

interface PendingJob extends QueuedJobIdentity {
  key: string;
  run: () => Promise<void>;
  observe: JobQueueObserver;
}

export class CoalescingJobQueue {
  private running = false;
  private closed = false;
  private readonly pending: PendingJob[] = [];

  get busy() {
    return this.running;
  }

  enqueue(key: string, run: QueuedJob, observer?: JobQueueObserver) {
    const admissionId = randomUUID();
    const admission = { decisionId: admissionId, admissionId, key, active: this.running, pendingCount: this.pending.length };
    if (this.closed) {
      observeSafely(observer, { ...admission, action: "rejected", reason: "queue-closed", jobId: null, retainedJobId: null });
      return false;
    }
    const retained = this.running && this.pending.find((job) => job.key === key);
    if (retained) {
      observeSafely(observer, { ...admission, action: "coalesced", reason: "key-already-pending", jobId: null, retainedJobId: retained.jobId });
      return false;
    }
    const identity = { jobId: randomUUID(), admissionId };
    // The drain belongs to the first job; later jobs must restore their own
    // enqueue-time context, including the absence of a request context.
    this.pending.push({
      key, ...identity,
      run: AsyncLocalStorage.bind(() => run(identity)),
      observe: AsyncLocalStorage.bind((decision) => observeSafely(observer, decision)),
    });
    observeSafely(observer, { ...admission, ...identity, action: "queued", reason: "eligible", retainedJobId: null, pendingCount: this.pending.length });
    if (!this.running) void this.drain();
    return true;
  }

  close() {
    this.closed = true;
    const dropped = this.pending.splice(0);
    for (const job of dropped) {
      job.observe({ decisionId: randomUUID(), admissionId: job.admissionId, key: job.key, jobId: job.jobId, retainedJobId: null, action: "dropped", reason: "queue-closed", active: this.running, pendingCount: 0 });
    }
  }

  private async drain() {
    this.running = true;
    try {
      while (this.pending.length > 0) {
        const job = this.pending.shift()!;
        job.observe({ decisionId: randomUUID(), admissionId: job.admissionId, key: job.key, jobId: job.jobId, retainedJobId: null, action: "started", reason: "queue-ready", active: true, pendingCount: this.pending.length });
        await job.run();
      }
    } finally {
      this.running = false;
    }
  }
}
