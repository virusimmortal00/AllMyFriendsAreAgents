import http from 'node:http';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

// Run inside one container process: repeatedly starting Node and its HTTP client
// under QEMU can exhaust a one-second request budget against a healthy server.
export async function waitForReadiness({
  url = 'http://127.0.0.1:53147/api/ready',
  timeoutMs = 150_000,
  requestTimeoutMs = 10_000,
  intervalMs = 250,
} = {}) {
  const started = performance.now();
  let attempts = 0;
  let last = { outcome: 'not-attempted' };
  while (performance.now() - started < timeoutMs) {
    attempts++;
    const remaining = timeoutMs - (performance.now() - started);
    last = await new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
        request.destroy();
      };
      const request = http.get(url, (response) => {
        // Do not print response bodies, URLs, or arbitrary exception messages.
        response.resume();
        finish({ outcome: 'http', status: response.statusCode });
      });
      const timer = setTimeout(() => finish({ outcome: 'timeout' }), Math.min(requestTimeoutMs, remaining));
      request.on('error', () => finish({ outcome: 'connection-error' }));
    });
    if (last.outcome === 'http' && last.status === 200) {
      return { ready: true, attempts, elapsedMs: Math.round(performance.now() - started), last };
    }
    const remainingAfterAttempt = timeoutMs - (performance.now() - started);
    // Preserve the last observed outcome when there is not enough budget for
    // the configured retry interval. Starting a near-zero-budget request here
    // can overwrite a useful HTTP or connection result with a timer artifact.
    if (remainingAfterAttempt <= intervalMs) break;
    await delay(intervalMs);
  }
  return { ready: false, attempts, elapsedMs: Math.round(performance.now() - started), last };
}
