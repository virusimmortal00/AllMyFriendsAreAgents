// Copied to a disposable directory and invoked instead of OpenCode by the smoke.
// This fixture has no provider integration. Tool credentials stay in memory.
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

if (process.argv.includes('--version')) {
  process.stdout.write('1.18.25\n');
} else if (process.argv.includes('models')) {
  process.stdout.write('openai/fixture-model\n');
} else if (process.argv.includes('run')) {
  const configuration = JSON.parse(await readFile(join(dirname(fileURLToPath(import.meta.url)), 'smoke.json'), 'utf8'));
  const sessionIndex = process.argv.indexOf('--session');
  const resumed = sessionIndex >= 0;
  const failedResume = configuration.phase === 'retry' && resumed;
  const stage = failedResume ? 'retry-resume' : configuration.phase === 'retry' ? 'retry-fresh' : configuration.phase;
  const command = { url: process.env.AMFAA_ROOM_COMMAND_URL, token: process.env.AMFAA_ROOM_COMMAND_TOKEN };
  const diagnostics = { url: process.env.AMFAA_ROOM_DIAGNOSTICS_URL, token: process.env.AMFAA_ROOM_DIAGNOSTICS_TOKEN };
  const call = async (tool, body) => {
    if (!tool.url || !tool.token) return { status: 0, noStore: false };
    const url = new URL(tool.url);
    if (url.hostname !== '127.0.0.1') throw new Error('Fixture tool must be loopback.');
    const result = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(5_000), headers: { authorization: `Bearer ${tool.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    await result.arrayBuffer();
    return { status: result.status, noStore: result.headers.get('cache-control') === 'no-store' };
  };
  const commandResult = await call(command, { invocation: { command: 'help' }, clientSubmissionId: 'smoke-child-help-0001' });
  const diagnosticsResult = await call(diagnostics, { requestId: 'smoke-child-diagnostics-0001', query: { window: 'last-hour', scope: 'self' } });
  const probe = new URL(configuration.probe);
  if (probe.hostname !== '127.0.0.1') throw new Error('Fixture probe must be loopback.');
  const report = await fetch(probe, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ stage, resumed, command, diagnostics, commandResult, diagnosticsResult }) });
  await report.arrayBuffer();
  if (failedResume) {
    process.stderr.write('session fixture-session not found\n');
    process.exitCode = 1;
  } else {
    // Keep the real generation alive until the test releases it or the app cancels it.
    while (true) {
      const response = await fetch(probe);
      if ((await response.json()).release === stage) break;
      await delay(25);
    }
    const sessionID = resumed ? process.argv[sessionIndex + 1] : `ses_fixture_${configuration.phase}`;
    process.stdout.write(JSON.stringify({ type: 'text', sessionID, part: { type: 'text', text: `Fixture ${configuration.phase} complete.\nCONVERSATION_STATE: settled` } }) + '\n');
  }
} else {
  process.exitCode = 1;
}
