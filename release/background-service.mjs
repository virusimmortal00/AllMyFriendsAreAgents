import { withLifecycleLock } from './lifecycle-lock.mjs';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { lstat, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

const file = root => path.join(root, '.amfaa-service.json');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function record(root) {
  try {
    const meta = await lstat(file(root));
    if (!meta.isFile() || meta.isSymbolicLink() || (process.getuid && meta.uid !== process.getuid()) || (process.platform !== 'win32' && (meta.mode & 0o077))) throw new Error('Unsafe service metadata.');
    const value = JSON.parse(await readFile(file(root), 'utf8'));
    if (value.version !== 1 || !/^[a-f0-9]{64}$/.test(value.token) || !Number.isInteger(value.port) || value.port < 0 || value.port > 65535 || !Number.isFinite(value.created)) throw new Error('Invalid service metadata.');
    return value;
  } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}
async function removeUnlocked(root, token) {
  if ((await record(root))?.token === token) await unlink(file(root));
}
async function remove(root, token) { return withLifecycleLock(root, () => removeUnlocked(root, token)); }
function confirmedDead(value) {
  if (!Number.isSafeInteger(value?.pid) || value.pid <= 0) return false;
  try { process.kill(value.pid, 0); return false; }
  catch (error) { return error.code === 'ESRCH'; }
}
async function request(value, action) {
  if (!value?.port) return undefined;
  try {
    const response = await fetch(`http://127.0.0.1:${value.port}/${action}`, {
      method: action === 'stop' ? 'POST' : 'GET', redirect: 'error',
      headers: { Authorization: `Bearer ${value.token}` }, signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) return undefined;
    const result = await response.json();
    return result.service === 'amfaa' ? result : undefined;
  } catch { return undefined; }
}
export async function serviceStatus(root) {
  const value = await record(root);
  return await request(value, 'status') || { state: !value || confirmedDead(value) ? 'stopped' : value.mode === 'foreground' ? 'foreground' : value.port === 0 ? 'starting' : 'unknown' };
}
async function foregroundActive(root) {
  const value = await record(root);
  return value?.mode === 'foreground' && !confirmedDead(value);
}
export async function stopService(root) {
  if (await foregroundActive(root)) throw new Error('AMFAA is running in a foreground terminal. Stop it with Ctrl+C in that terminal.');
  const value = await withLifecycleLock(root, async () => {
    const current = await record(root);
    if (!current) return undefined;
    if (confirmedDead(current)) { await removeUnlocked(root, current.token); return undefined; }
    if (!await request(current, 'stop')) throw new Error('AMFAA cannot be reached; its control metadata has been preserved. Try amfaa status shortly.');
    return current;
  });
  if (!value) return { state: 'stopped' };
  for (let i = 0; i < 120; i++) {
    const current = await record(root);
    if (!current || current.token !== value.token || confirmedDead(value)) return { state: 'stopped' };
    await delay(250);
  }
  throw new Error('AMFAA is still stopping. Check amfaa status.');
}
// Foreground diagnostics keep the same lifecycle lock for their entire process
// lifetime. beforeExit occurs only after the application's shutdown has drained.
export async function serveForeground({ root, start }) {
  return withLifecycleLock(root, async () => {
    const current = await record(root);
    if (current && !confirmedDead(current)) throw new Error('Stop the existing AMFAA service before starting foreground diagnostics.');
    if (current) await removeUnlocked(root, current.token);
    const value = { version: 1, token: randomBytes(32).toString('hex'), port: 0, created: Date.now(), pid: process.pid, mode: 'foreground' };
    await writeFile(file(root), JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    let onIdle;
    const idle = new Promise(resolve => { onIdle = resolve; });
    process.once('beforeExit', onIdle);
    try {
      let startupError;
      try { await start(); } catch (error) { startupError = error; }
      // A partial startup can still own handles; retain ownership until they drain.
      await idle;
      if (startupError) throw startupError;
    }
    finally { process.off('beforeExit', onIdle); await removeUnlocked(root, value.token); }
  });
}
export async function startService({ root, cliFile, project, environment = process.env }) {
  if (await foregroundActive(root)) throw new Error('AMFAA is running in a foreground terminal. Stop it with Ctrl+C in that terminal.');
  let child, value, spawnError;
  try {
    const running = await withLifecycleLock(root, async () => {
      const current = await record(root);
      const existing = await request(current, 'status');
      if (existing?.state === 'running') return existing;
      if (existing) throw new Error(`AMFAA is ${existing.state === 'stopping' ? 'stopping' : 'starting'}. Wait for shutdown or startup to finish, then try amfaa start again.`);
      if (current) {
        if (!confirmedDead(current)) throw new Error('AMFAA is starting or unreachable. Its control metadata has been preserved. Try amfaa status shortly.');
        await removeUnlocked(root, current.token);
      }
      value = { version: 1, token: randomBytes(32).toString('hex'), port: 0, created: Date.now(), pid: process.pid };
      await writeFile(file(root), JSON.stringify(value), { flag: 'wx', mode: 0o600 });
      child = spawn(process.execPath, [cliFile, '__serve'], {
        cwd: project, env: environment, detached: true, windowsHide: true,
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
      // Attach immediately so asynchronous spawn errors cannot escape.
      child.on('error', error => { spawnError = error; });
      value.pid = child.pid || process.pid;
      const temporary = `${file(root)}.${value.token}`;
      await writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
      await rename(temporary, file(root));
      return undefined;
    });
    if (running) return running;
    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('AMFAA did not start within 60 seconds. Run amfaa start --foreground for diagnostics.')), 60000);
      const finish = (error, result) => { clearTimeout(timer); child.removeListener('exit', exited); child.removeListener('error', failed); child.removeListener('message', message); error ? reject(error) : resolve(result); };
      const exited = () => finish(new Error('AMFAA could not start. Run amfaa start --foreground for diagnostics.'));
      const failed = () => exited();
      const message = msg => { if (msg?.ready) finish(undefined, msg.ready); else if (msg?.failed) exited(); };
      child.once('exit', exited); child.once('error', failed); child.on('message', message);
      if (spawnError || child.exitCode !== null || child.signalCode !== null) queueMicrotask(exited);
    });
    if (child.connected) child.send(value, error => { if (error) child.emit('error', error); });
    const result = await ready;
    child.disconnect(); child.unref();
    return result;
  } catch (error) {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill();
      await new Promise(resolve => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
    child?.unref();
    if (child?.connected) child.disconnect();
    if (value) await remove(root, value.token);
    throw error;
  }
}

// The control port is loopback-only and authenticated with a private per-run token.
// It never controls a process by a saved PID, which may have been reused.
export async function serveBackground({ root, start }) {
  if (!process.send) throw new Error('This command is internal. Use amfaa start.');
  const value = await new Promise(resolve => process.once('message', resolve));
  if ((await record(root))?.token !== value.token) throw new Error('Service startup ownership changed.');
  let state = 'starting', application, url;
  const control = createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.headers.authorization !== `Bearer ${value.token}` || req.headers.origin || req.headers.host !== `127.0.0.1:${value.port}`) { res.writeHead(403); res.end(); return; }
    if ((req.url !== '/status' || req.method !== 'GET') && (req.url !== '/stop' || req.method !== 'POST')) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ service: 'amfaa', state, url }));
    if (req.url === '/stop') void stop();
  });
  const stop = async () => {
    if (state === 'stopping') return;
    state = 'stopping';
    const deadline = setTimeout(() => process.exit(1), 25000);
    try { await application?.shutdown('service-stop'); await remove(root, value.token); control.closeAllConnections(); await new Promise(resolve => control.close(resolve)); clearTimeout(deadline); process.exit(0); }
    catch { process.exit(1); }
  };
  process.once('disconnect', () => { if (state === 'starting') void stop(); });
  try {
    application = await start();
    if (!application?.ready || !application?.shutdown) throw new Error('Server lifecycle unavailable.');
    const address = await application.ready;
    url = `http://127.0.0.1:${address.port}`;
    await new Promise((resolve, reject) => { control.once('error', reject); control.listen(0, '127.0.0.1', resolve); });
    value.port = control.address().port;
    await withLifecycleLock(root, async () => {
      if ((await record(root))?.token !== value.token) throw new Error('Service ownership changed.');
      const temporary = `${file(root)}.${value.token}`;
      await writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
      await rename(temporary, file(root));
    });
    state = 'running';
    process.send({ ready: { service: 'amfaa', state, url } });
    process.on('SIGTERM', stop); process.on('SIGINT', stop);
  } catch {
    process.send?.({ failed: true });
    await remove(root, value.token);
    process.exit(1);
  }
}
