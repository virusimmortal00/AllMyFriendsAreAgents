import { spawnSync } from "node:child_process";
import process from "node:process";
import { APPROVED_DOWNSTREAM_OPENCODE_VERSION, MAXIMUM_AUDITED_OPENCODE_VERSION, parseOpenCodeRuntimeVersion } from "../server/model-discovery.js";

function option(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const command = option("--command") || process.env.ALL_MY_FRIENDS_ARE_AGENTS_OPENCODE_COMMAND?.trim() || "opencode";
const output = (args: readonly string[]) => {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`OpenCode ${args.join(" ")} exited with ${result.status}: ${result.stderr || result.stdout}`);
  return `${result.stdout || ""}${result.stderr || ""}`;
};
const requireText = (value: string, expected: readonly string[], surface: string) => {
  const missing = expected.filter((item) => !value.includes(item));
  if (missing.length) throw new Error(`OpenCode ${surface} contract is missing: ${missing.join(", ")}`);
};

const versionOutput = output(["--version"]);
const runtime = parseOpenCodeRuntimeVersion(versionOutput);
const binaryContractVersions = [MAXIMUM_AUDITED_OPENCODE_VERSION, APPROVED_DOWNSTREAM_OPENCODE_VERSION];
if (!runtime?.compatible || !binaryContractVersions.includes(runtime.version)) {
  throw new Error(`Expected an audited OpenCode binary (${binaryContractVersions.join(" or ")}), received ${runtime?.version || versionOutput.trim() || "unrecognized output"}.`);
}

requireText(output(["run", "--help"]), [
  "--format", "json", "--dir", "--agent", "--model", "--variant", "--session", "--auto",
], "run --help");
requireText(output(["models", "--help"]), ["models [provider]", "--verbose", "--refresh"], "models --help");

console.log(`OpenCode ${runtime.distribution} binary contract verified at ${runtime.version}.`);
