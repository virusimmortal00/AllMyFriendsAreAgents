import type { ActiveAgentId } from "../shared/participants.js";
import type { OpenCodeRuntimeStatus, OpenCodeRuntimeUnavailableReason } from "../shared/opencode-runtime.js";
import { DISCOVERY_TIMEOUT_MS, executeDiscoveryCommand, parseOpenCodeRuntimeVersion, type DiscoveryExecutor } from "./model-discovery.js";

const OPENCODE_COMMAND = process.env.ALL_MY_FRIENDS_ARE_AGENTS_OPENCODE_COMMAND?.trim() || "opencode";
export const OPEN_CODE_RUNTIME_REFRESH_TTL_MS = 30_000;

function unavailable(reason: OpenCodeRuntimeUnavailableReason, now: () => number): OpenCodeRuntimeStatus {
  return { state: "unavailable", reason, checkedAt: new Date(now()).toISOString() };
}

function failureReason(error: unknown): OpenCodeRuntimeUnavailableReason {
  const processError = error as (NodeJS.ErrnoException & { killed?: boolean; signal?: string | null }) | undefined;
  const code = processError?.code;
  if (code === "ENOENT") return "command_not_found";
  if (code === "EACCES" || code === "EPERM") return "not_executable";
  if (code === "ETIMEDOUT" || (processError?.killed && processError.signal === "SIGTERM")) return "timed_out";
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
  timeoutMs = DISCOVERY_TIMEOUT_MS,
): Promise<OpenCodeRuntimeStatus> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const controller = new AbortController();
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(Object.assign(new Error("OpenCode runtime preflight timed out."), { code: "ETIMEDOUT" }));
      }, timeoutMs);
    });
    const { stdout } = await Promise.race([
      Promise.resolve().then(() => execute(OPENCODE_COMMAND, ["--version"], controller.signal)),
      deadline,
    ]);
    const runtime = parseOpenCodeRuntimeVersion(stdout);
    if (!runtime?.compatible) return unavailable("unsupported_version", now);
    return { state: "ready", version: runtime.version, checkedAt: new Date(now()).toISOString() };
  } catch (error) {
    return unavailable(failureReason(error), now);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/**
 * Shares one bounded preflight between callers and retains its safe result for a
 * short interval. A new check cannot start until the preceding one settles, so
 * an older slow process cannot overwrite a newer observation.
 */
export class OpenCodeRuntimeMonitor {
  #refresh: Promise<OpenCodeRuntimeStatus> | undefined;

  constructor(
    private current: OpenCodeRuntimeStatus,
    private readonly inspect: () => Promise<OpenCodeRuntimeStatus> = () => inspectOpenCodeRuntime(),
    private readonly now: () => number = Date.now,
    private readonly ttlMs = OPEN_CODE_RUNTIME_REFRESH_TTL_MS,
  ) {}

  snapshot() {
    return this.current;
  }

  refresh() {
    if (this.#refresh) return this.#refresh;
    const checkedAt = Date.parse(this.current.checkedAt);
    if (Number.isFinite(checkedAt) && this.now() - checkedAt < this.ttlMs) return Promise.resolve(this.current);
    let flight: Promise<OpenCodeRuntimeStatus>;
    flight = this.inspect().then((next) => {
      this.current = next;
      return next;
    }).finally(() => {
      if (this.#refresh === flight) this.#refresh = undefined;
    });
    this.#refresh = flight;
    return flight;
  }
}

export function runtimeAvailability(agents: readonly ActiveAgentId[], runtime: OpenCodeRuntimeStatus): Partial<Record<ActiveAgentId, boolean>> {
  return Object.fromEntries(agents.map((agent) => [agent, runtime.state === "ready"])) as Partial<Record<ActiveAgentId, boolean>>;
}
