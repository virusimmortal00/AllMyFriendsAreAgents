/** Observers may enqueue evidence, but must never become part of job control flow. */
export function observeSafely<T>(observer: ((event: T) => unknown) | undefined, event: T) {
  try {
    const result = observer?.(event);
    // TypeScript allows async functions where a void callback is expected.
    // Contain an accidental rejection without awaiting a sink or flush.
    if (result !== undefined) void Promise.resolve(result).catch(() => undefined);
  } catch {
    // Do not recursively log a failing observer's payload or change the job.
  }
}
