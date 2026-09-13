import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { waitForReadiness } from './container-readiness.mjs';

const servers = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
async function fixture(handler) {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}/api/ready`;
}

describe('container readiness polling', () => {
  it('accepts a healthy response that takes longer than the former one-second budget', async () => {
    const url = await fixture((_request, response) => setTimeout(() => response.end('ready'), 1100));
    const result = await waitForReadiness({ url, timeoutMs: 4000 });
    expect(result).toMatchObject({ ready: true, attempts: 1, last: { outcome: 'http', status: 200 } });
  });

  it('retries unavailable HTTP responses until the application becomes ready', async () => {
    let requests = 0;
    const url = await fixture((_request, response) => { response.statusCode = ++requests === 1 ? 503 : 200; response.end(); });
    expect(await waitForReadiness({ url, timeoutMs: 1000, intervalMs: 1 })).toMatchObject({ ready: true, attempts: 2 });
  });

  it('keeps a hard deadline for a server that accepts connections but never responds', async () => {
    const url = await fixture(() => {});
    const result = await waitForReadiness({ url, timeoutMs: 100, requestTimeoutMs: 10000 });
    expect(result).toMatchObject({ ready: false, last: { outcome: 'timeout' } });
    expect(result.elapsedMs).toBeLessThan(1000);
  });

  it('reports HTTP failure without including the response body', async () => {
    const url = await fixture((_request, response) => { response.statusCode = 500; response.end('fictional-secret-body'); });
    const result = await waitForReadiness({ url, timeoutMs: 1000, intervalMs: 1000 });
    expect(result).toMatchObject({ ready: false, last: { outcome: 'http', status: 500 } });
    expect(JSON.stringify(result)).not.toContain('fictional-secret-body');
  });

  it('bounds connection failures without exposing the endpoint', async () => {
    const url = await fixture((_request, response) => response.end());
    const server = servers.pop();
    await new Promise((resolve) => server.close(resolve));
    const result = await waitForReadiness({ url, timeoutMs: 1000, intervalMs: 1000 });
    expect(result).toMatchObject({ ready: false, last: { outcome: 'connection-error' } });
    expect(JSON.stringify(result)).not.toContain(url);
  });
});
