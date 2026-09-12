import process from "node:process";
import { resolveOpenCodeRuntime } from "../server/opencode-runtime.js";

function option(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const override = option("--command");
const runtime = await resolveOpenCodeRuntime({ ...(override ? { override } : {}) });
if (runtime.state !== "ready") throw new Error(`OpenCode binary contract verification failed (${runtime.reason}).`);
console.log(`OpenCode ${runtime.source} binary contract verified at ${runtime.version}.`);
