import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pnpmInvocation } from "./package-manager-command.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(command: string, args: string[]) {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status}.`);
}

function runPnpm(args: string[]) {
  const invocation = pnpmInvocation(args);
  run(invocation.command, [...invocation.args]);
}

/** Produce the closed production tree consumed by the native packager. */
export function prepareNativeApplication(outputDirectory: string): void {
  const output = path.resolve(outputDirectory);
  const emitted = path.join(ROOT, ".runtime/native-application");
  const deployed = path.join(ROOT, ".runtime/native-production-dependencies");
  rmSync(output, { recursive: true, force: true });
  rmSync(emitted, { recursive: true, force: true });
  rmSync(deployed, { recursive: true, force: true });
  runPnpm(["run", "build"]);
  runPnpm(["exec", "tsc", "--project", "tsconfig.native.json"]);
  try {
    runPnpm(["--filter", "all-my-friends-are-agents", "deploy", "--prod", "--legacy", deployed]);
    mkdirSync(output, { recursive: true });
    for (const source of ["dist", "server", "shared"]) {
      const location = source === "dist" ? path.join(ROOT, source) : path.join(emitted, source);
      if (!existsSync(location)) throw new Error(`Native production build is missing ${source}.`);
      cpSync(location, path.join(output, source), { recursive: true, errorOnExist: true });
    }
    // pnpm's isolated graph uses only relative links into its copied .pnpm tree;
    // the packager inventories and bounds those links to the application root.
    cpSync(path.join(deployed, "node_modules"), path.join(output, "node_modules"), { recursive: true, verbatimSymlinks: true, errorOnExist: true });
    cpSync(path.join(ROOT, "server/storage/migrations"), path.join(output, "server/storage/migrations"), { recursive: true, errorOnExist: true });
    const sourcePackage = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { name: string; version: string; type: string };
    writeFileSync(path.join(output, "package.json"), `${JSON.stringify({ name: sourcePackage.name, version: sourcePackage.version, private: true, type: sourcePackage.type }, null, 2)}\n`);
  } finally {
    // Legacy deploy prunes the source install while constructing its exact
    // production graph. Restore the frozen development install for later jobs.
    try { runPnpm(["install", "--frozen-lockfile"]); }
    finally {
      rmSync(deployed, { recursive: true, force: true });
      rmSync(emitted, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = process.argv[2];
  if (!output || process.argv[3]) throw new Error("Usage: prepare-native-application.ts <output-directory>");
  prepareNativeApplication(output);
}
