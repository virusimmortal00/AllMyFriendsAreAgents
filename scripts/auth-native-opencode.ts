import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveOpenCodeRuntime, type OpenCodeRuntimeResolution } from "../server/opencode-runtime.js";

export type AuthenticationRunner = (command: string, args: readonly string[]) => Promise<number>;

function runInteractive(command: string, args: readonly string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(signal ? 128 : code ?? 1));
  });
}

export async function authenticateWithSelectedOpenCode(options: {
  resolve?: () => Promise<OpenCodeRuntimeResolution>;
  run?: AuthenticationRunner;
} = {}): Promise<number> {
  const runtime = await (options.resolve || resolveOpenCodeRuntime)();
  if (runtime.state !== "ready") throw new Error(`The application-owned OpenCode runtime is unavailable (${runtime.reason}). Run pnpm setup before authenticating.`);
  return (options.run || runInteractive)(runtime.command, ["auth", "login"]);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await authenticateWithSelectedOpenCode();
}
