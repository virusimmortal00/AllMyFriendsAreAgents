import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

let child;
try {
  const version = execFileSync('/usr/local/bin/opencode', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  if (version !== '1.18.25-amfaa.2') throw new Error('version');
  const listener = createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const password = randomBytes(32).toString('base64url');
  child = spawn('/usr/local/bin/opencode', ['serve', '--hostname=127.0.0.1', `--port=${port}`], {
    cwd: '/tmp', stdio: 'ignore', env: { ...process.env, OPENCODE_SERVER_USERNAME: 'opencode', OPENCODE_SERVER_PASSWORD: password },
  });
  let succeeded = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (child.exitCode !== null) throw new Error('process');
    try {
      const url = `http://127.0.0.1:${port}/global/health`;
      const response = await fetch(url, { headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` }, signal: AbortSignal.timeout(2000) });
      const body = await response.json();
      if (response.status === 200 && body.healthy === true && body.version === version) {
        const unauthenticated = await fetch(url, { signal: AbortSignal.timeout(2000) });
        if (unauthenticated.status !== 401) throw new Error('auth boundary');
        console.log(JSON.stringify({ version, authenticatedHealth: 200, unauthenticatedHealth: 401 }));
        succeeded = true;
        break;
      }
    } catch {}
    await delay(500);
  }
  if (!succeeded) throw new Error('health');
} catch {
  console.error('OpenCode health verification failed; process output and credentials suppressed.');
  process.exitCode = 1;
} finally {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(3000)]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
}
