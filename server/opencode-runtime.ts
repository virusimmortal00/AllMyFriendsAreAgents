import type { ActiveAgentId } from "../shared/participants.js";
import type { OpenCodeRuntimeStatus, OpenCodeRuntimeUnavailableReason } from "../shared/opencode-runtime.js";
import { DISCOVERY_TIMEOUT_MS, executeDiscoveryCommand, parseOpenCodeRuntimeVersion, type DiscoveryExecutor } from "./model-discovery.js";

const OPENCODE_COMMAND = process.env.ALL_MY_FRIENDS_ARE_AGENTS_OPENCODE_COMMAND?.trim() || "opencode";
export const OPEN_CODE_RUNTIME_REFRESH_TTL_MS = 30_000;
const inspectionSettlements = new WeakMap<Promise<OpenCodeRuntimeStatus>, Promise<void>>();

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
export function inspectOpenCodeRuntime(
  execute: DiscoveryExecutor = executeDiscoveryCommand,
  now: () => number = Date.now,
  timeoutMs = DISCOVERY_TIMEOUT_MS,
): Promise<OpenCodeRuntimeStatus> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  const execution = Promise.resolve().then(() => execute(OPENCODE_COMMAND, ["--version"], controller.signal));
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(Object.assign(new Error("OpenCode runtime preflight timed out."), { code: "ETIMEDOUT" }));
    }, timeoutMs);
  });
  const result = Promise.race([execution, deadline])
    .then(({ stdout }) => {
      const runtime = parseOpenCodeRuntimeVersion(stdout);
      return runtime?.compatible
        ? { state: "ready", version: runtime.version, checkedAt: new Date(now()).toISOString() } as OpenCodeRuntimeStatus
        : unavailable("unsupported_version", now);
    })
    .catch((error) => unavailable(failureReason(error), now))
    .finally(() => {
      if (timeout) clearTimeout(timeout);
    });
  // A deadline makes the result safe to serve, but an ignored abort can leave
  // the child alive. Keep that underlying execution observable to the monitor
  // so it cannot launch another child until this one has actually settled.
  inspectionSettlements.set(result, execution.then(() => undefined, () => undefined));
  return result;
}

/**
 * Shares one bounded preflight between callers and retains its safe result for a
 * short interval. A new check cannot start until the preceding one settles, so
 * an older slow process cannot overwrite a newer observation.
 */
export class OpenCodeRuntimeMonitor {
  #refresh: Promise<OpenCodeRuntimeStatus> | undefined;
  #draining: Promise<void> | undefined;

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
    if (this.#draining) return Promise.resolve(this.current);
    const checkedAt = Date.parse(this.current.checkedAt);
    if (Number.isFinite(checkedAt) && this.now() - checkedAt < this.ttlMs) return Promise.resolve(this.current);
    let flight: Promise<OpenCodeRuntimeStatus>;
    const inspection = this.inspect();
    const settlement = inspectionSettlements.get(inspection) || inspection.then(() => undefined, () => undefined);
    let draining: Promise<void>;
    draining = settlement.finally(() => {
      if (this.#draining === draining) this.#draining = undefined;
    });
    this.#draining = draining;
    flight = inspection.then((next) => {
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
