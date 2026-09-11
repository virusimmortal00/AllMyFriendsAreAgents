import type { ActiveAgentId } from "../shared/participants.js";
import type { OpenCodeRuntimeStatus, OpenCodeRuntimeUnavailableReason } from "../shared/opencode-runtime.js";
import { executeDiscoveryCommand, parseOpenCodeRuntimeVersion, type DiscoveryExecutor } from "./model-discovery.js";

const OPENCODE_COMMAND = process.env.ALL_MY_FRIENDS_ARE_AGENTS_OPENCODE_COMMAND?.trim() || "opencode";

function unavailable(reason: OpenCodeRuntimeUnavailableReason, now: () => number): OpenCodeRuntimeStatus {
  return { state: "unavailable", reason, checkedAt: new Date(now()).toISOString() };
}

function failureReason(error: unknown): OpenCodeRuntimeUnavailableReason {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT") return "command_not_found";
  if (code === "EACCES" || code === "EPERM") return "not_executable";
  if (/timed out|timeout|aborted/i.test(error instanceof Error ? error.message : "")) return "timed_out";
  return "command_failed";
}

/**
 * Runs one bounded, sanitized OpenCode preflight. It deliberately never returns
 * the configured path, subprocess output, or raw error to a room client.
 */
export async function inspectOpenCodeRuntime(
  execute: DiscoveryExecutor = executeDiscoveryCommand,
  now: () => number = Date.now,
): Promise<OpenCodeRuntimeStatus> {
  try {
    const { stdout } = await execute(OPENCODE_COMMAND, ["--version"]);
    const runtime = parseOpenCodeRuntimeVersion(stdout);
    if (!runtime?.compatible) return unavailable("unsupported_version", now);
    return { state: "ready", version: runtime.version, checkedAt: new Date(now()).toISOString() };
  } catch (error) {
    return unavailable(failureReason(error), now);
  }
}

export function runtimeAvailability(agents: readonly ActiveAgentId[], runtime: OpenCodeRuntimeStatus): Partial<Record<ActiveAgentId, boolean>> {
  return Object.fromEntries(agents.map((agent) => [agent, runtime.state === "ready"])) as Partial<Record<ActiveAgentId, boolean>>;
}
