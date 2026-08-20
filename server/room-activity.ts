export class RoomActivity {
  private revision = 0;
  private readonly interruptions = new Set<() => void>();

  current() {
    return this.revision;
  }

  isCurrent(revision: number) {
    return revision === this.revision;
  }

  interrupt() {
    this.revision += 1;
    for (const interrupt of this.interruptions) interrupt();
    this.interruptions.clear();
  }

  abortSignal(revision: number) {
    const controller = new AbortController();
    if (!this.isCurrent(revision)) {
      controller.abort();
      return { signal: controller.signal, dispose: () => undefined };
    }

    const abort = () => controller.abort();
    this.interruptions.add(abort);
    return {
      signal: controller.signal,
      dispose: () => this.interruptions.delete(abort),
    };
  }

  wait(milliseconds: number, revision: number): Promise<boolean> {
    if (!this.isCurrent(revision)) return Promise.resolve(false);
    if (milliseconds <= 0) return Promise.resolve(true);

    return new Promise((resolve) => {
      let settled = false;
      const finish = (current: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.interruptions.delete(cancel);
        resolve(current);
      };
      const cancel = () => finish(false);
      const timer = setTimeout(() => finish(this.isCurrent(revision)), milliseconds);
      this.interruptions.add(cancel);
    });
  }
}
