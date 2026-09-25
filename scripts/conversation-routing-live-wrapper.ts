import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const CHILD_ENVIRONMENT = [
  "PATH",
  "XDG_DATA_HOME",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
  "TMPDIR",
  "LANG",
  "USER",
  "OPENROUTER_API_KEY",
  "OPENCODE_PERMISSION",
  "OPENCODE_CONFIG_DIR",
  "AMFAA_ROOM_HISTORY_URL",
  "AMFAA_ROOM_HISTORY_TOKEN",
  "AMFAA_ROOM_COMMAND_URL",
  "AMFAA_ROOM_COMMAND_TOKEN",
  "AMFAA_ROOM_COMMANDS",
  "AMFAA_ROOM_DIAGNOSTICS_URL",
  "AMFAA_ROOM_DIAGNOSTICS_TOKEN",
] as const;

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * The server filters provider keys from agent children. This private command wrapper asks the
 * workstation's existing secret launcher to supply the key directly to OpenCode at process
 * launch. No credential literal is written to disk or forwarded through a product tool env.
 */
export async function createLiveOpenCodeWrapper(input: {
  root: string;
  realCommand: string;
  secretLauncher: string;
  launcherHome: string;
  isolatedHome: string;
  modelId: string;
}) {
  const configDirectory = path.join(input.root, "xdg-config", "opencode");
  await mkdir(configDirectory, { recursive: true, mode: 0o700 });
  const configPath = path.join(configDirectory, "opencode.json");
  await writeFile(
    configPath,
    JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      provider: { openrouter: { options: { apiKey: "{env:OPENROUTER_API_KEY}" }, models: { [input.modelId]: {} } } },
    }),
    { mode: 0o600, flag: "wx" },
  );
  await chmod(configPath, 0o600);
  const shimPath = path.join(input.root, "opencode-filter.mjs");
  const shim = [
    "import { spawn } from 'node:child_process';",
    "import { readFileSync } from 'node:fs';",
    "const encodedArgs = readFileSync(0);",
    "if (encodedArgs.length > 1_048_576 || encodedArgs.at(-1) !== 0) process.exit(64);",
    "const args = encodedArgs.toString('utf8').slice(0, -1).split('\\0');",
    `const names = ${JSON.stringify(CHILD_ENVIRONMENT)};`,
    "const env = Object.fromEntries(names.flatMap(name => typeof process.env[name] === 'string' ? [[name, process.env[name]]] : []));",
    `env.HOME = ${JSON.stringify(input.isolatedHome)};`,
    "if (!/^[A-Za-z0-9._-]{10,300}$/.test(env.OPENROUTER_API_KEY ?? '')) process.exit(65);",
    `const child = spawn(${JSON.stringify(input.realCommand)}, args, { env, stdio: 'inherit' });`,
    "for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => child.kill(signal));",
    "child.on('error', () => process.exit(127));",
    "child.on('exit', (code, signal) => process.exit(code ?? (signal ? 128 : 1)));",
  ].join("\n");
  await writeFile(shimPath, `${shim}\n`, { mode: 0o700, flag: "wx" });
  await chmod(shimPath, 0o700);
  const wrapperPath = path.join(input.root, "opencode-secret-launcher");
  const wrapper = [
    "#!/bin/sh",
    `HOME=${shellQuote(input.launcherHome)}; export HOME`,
    'USER="$(id -un)"; export USER',
    `printf '%s\\0' "$@" | ${shellQuote(input.secretLauncher)} ${shellQuote(process.execPath)} ${shellQuote(shimPath)}`,
  ].join("\n");
  await writeFile(wrapperPath, `${wrapper}\n`, { mode: 0o700, flag: "wx" });
  await chmod(wrapperPath, 0o700);
  return { wrapperPath, shimPath, configPath };
}
