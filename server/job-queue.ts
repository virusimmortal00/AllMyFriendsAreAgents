export type QueuedJob = () => Promise<void>;

interface PendingJob {
  key: string;
  run: QueuedJob;
}

export class CoalescingJobQueue {
  private running = false;
  private readonly pending: PendingJob[] = [];

  get busy() {
    return this.running;
  }

  enqueue(key: string, run: QueuedJob) {
    if (this.running && this.pending.some((job) => job.key === key)) return false;
    this.pending.push({ key, run });
    if (!this.running) void this.drain();
    return true;
  }

  private async drain() {
    this.running = true;
    try {
      while (this.pending.length > 0) {
        await this.pending.shift()!.run();
      }
    } finally {
      this.running = false;
    }
  }
}
