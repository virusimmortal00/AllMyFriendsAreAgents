import { constants } from "node:fs";
import { access, lstat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ActiveAgentId } from "../shared/participants.js";
import type { OpenCodeRuntimeStatus, OpenCodeRuntimeUnavailableReason } from "../shared/opencode-runtime.js";
import { APPROVED_DOWNSTREAM_OPENCODE_VERSION, DISCOVERY_TIMEOUT_MS, executeDiscoveryCommand, validateOpenCodeBinaryContract, type DiscoveryExecutor } from "./model-discovery.js";

export const OPEN_CODE_RUNTIME_REFRESH_TTL_MS = 30_000;
const applicationRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const inspectionSettlements = new WeakMap<Promise<OpenCodeRuntimeResolution>, Promise<void>>();

export type OpenCodeRuntimeSource = "operator-override" | "packaged" | "source-setup";
export type OpenCodeRuntimeResolution = {
  readonly state: "ready";
  readonly command: string;
  readonly source: OpenCodeRuntimeSource;
  readonly version: string;
  readonly checkedAt: string;
} | {
  readonly state: "unavailable";
  readonly reason: OpenCodeRuntimeUnavailableReason;
  readonly checkedAt: string;
};

export interface OpenCodeRuntimeResolutionOptions {
  readonly root?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly execute?: DiscoveryExecutor;
  readonly now?: () => number;
  readonly timeoutMs?: number;
  readonly override?: string;
}

function unavailable(reason: OpenCodeRuntimeUnavailableReason, now: () => number): OpenCodeRuntimeResolution {
  return { state: "unavailable", reason, checkedAt: new Date(now()).toISOString() };
}

function failureReason(error: unknown): OpenCodeRuntimeUnavailableReason {
  const processError = error as (NodeJS.ErrnoException & { killed?: boolean; signal?: string | null }) | undefined;
  const code = processError?.code;
  if (code === "ENOENT") return "command_not_found";
  if (code === "EACCES" || code === "EPERM") return "not_executable";
  if (code === "ETIMEDOUT" || (processError?.killed && processError.signal === "SIGTERM")) return "timed_out";
  if (code === "EBINARYCONTRACT") return "binary_contract_failed";
  if (/timed out|timeout|aborted/i.test(error instanceof Error ? error.message : "")) return "timed_out";
  return "command_failed";
}

function executableName(platform: NodeJS.Platform) {
  return platform === "win32" ? "opencode.exe" : "opencode";
}

export function openCodeRuntimePaths(root = applicationRoot, platform: NodeJS.Platform = process.platform) {
  const executable = executableName(platform);
  return {
    packaged: path.join(root, "runtime", "opencode", "bin", executable),
    sourceSetup: path.join(root, ".runtime", "opencode", "bin", executable),
  };
}

async function pathAvailability(command: string, platform: NodeJS.Platform) {
  try {
    const metadata = await lstat(command);
    if (!metadata.isFile() || metadata.isSymbolicLink()) return "not_executable" as const;
    await access(command, platform === "win32" ? constants.F_OK : constants.X_OK);
    return "available" as const;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" as const : "not_executable" as const;
  }
}

function explicitPath(command: string) {
  return path.isAbsolute(command) || command.includes("/") || command.includes("\\");
}

/** Resolve and verify one runtime without consulting PATH as an implicit fallback. */
export function resolveOpenCodeRuntime(options: OpenCodeRuntimeResolutionOptions = {}): Promise<OpenCodeRuntimeResolution> {
  const root = options.root || applicationRoot;
  const environment = options.environment || process.env;
  const platform = options.platform || process.platform;
  const execute = options.execute || executeDiscoveryCommand;
  const now = options.now || Date.now;
  const timeoutMs = options.timeoutMs ?? DISCOVERY_TIMEOUT_MS;
  const override = options.override === undefined ? environment.ALL_MY_FRIENDS_ARE_AGENTS_OPENCODE_COMMAND?.trim() : options.override.trim();
  const paths = openCodeRuntimePaths(root, platform);

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  const execution = Promise.resolve().then(async () => {
    let candidate: { command: string; source: OpenCodeRuntimeSource } | undefined;
    if (override) {
      if (explicitPath(override)) {
        const availability = await pathAvailability(override, platform);
        if (availability === "missing") throw Object.assign(new Error("Configured OpenCode runtime is missing."), { code: "ENOENT" });
        if (availability === "not_executable") throw Object.assign(new Error("Configured OpenCode runtime is not executable."), { code: "EACCES" });
      }
      candidate = { command: override, source: "operator-override" };
    } else {
      const packaged = await pathAvailability(paths.packaged, platform);
      if (packaged === "available") candidate = { command: paths.packaged, source: "packaged" };
      else if (packaged === "not_executable") throw Object.assign(new Error("Packaged OpenCode runtime is not executable."), { code: "EACCES" });
      else {
        const sourceSetup = await pathAvailability(paths.sourceSetup, platform);
        if (sourceSetup === "available") candidate = { command: paths.sourceSetup, source: "source-setup" };
        else if (sourceSetup === "not_executable") throw Object.assign(new Error("Source-setup OpenCode runtime is not executable."), { code: "EACCES" });
      }
    }
    if (!candidate) throw Object.assign(new Error("Application OpenCode runtime is missing."), { code: "ENOENT" });
    const version = await execute(candidate.command, ["--version"], controller.signal);
    const runHelp = await execute(candidate.command, ["run", "--help"], controller.signal);
    const modelsHelp = await execute(candidate.command, ["models", "--help"], controller.signal);
    const runtime = validateOpenCodeBinaryContract(
      `${version.stdout}${version.stderr}`,
      `${runHelp.stdout}${runHelp.stderr}`,
      `${modelsHelp.stdout}${modelsHelp.stderr}`,
    );
    if (candidate.source !== "operator-override" && runtime.version !== APPROVED_DOWNSTREAM_OPENCODE_VERSION) {
      throw Object.assign(new Error("Application-owned OpenCode runtime does not match the approved downstream identity."), { code: "EBINARYCONTRACT" });
    }
    return { state: "ready", command: candidate.command, source: candidate.source, version: runtime.version, checkedAt: new Date(now()).toISOString() } as const;
  });
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(Object.assign(new Error("OpenCode runtime preflight timed out."), { code: "ETIMEDOUT" }));
    }, timeoutMs);
  });
  const result = Promise.race([execution, deadline])
    .catch((error) => unavailable(failureReason(error), now))
    .finally(() => { if (timeout) clearTimeout(timeout); });
  inspectionSettlements.set(result, execution.then(() => undefined, () => undefined));
  return result;
}

export function publicOpenCodeRuntimeStatus(resolution: OpenCodeRuntimeResolution): OpenCodeRuntimeStatus {
  return resolution.state === "ready"
    ? { state: "ready", version: resolution.version, checkedAt: resolution.checkedAt }
    : resolution;
}

export class OpenCodeRuntimeMonitor {
  #refresh: Promise<OpenCodeRuntimeResolution> | undefined;
  #draining: Promise<void> | undefined;

  constructor(
    private current: OpenCodeRuntimeResolution,
    private readonly inspect: () => Promise<OpenCodeRuntimeResolution> = () => resolveOpenCodeRuntime(),
    private readonly now: () => number = Date.now,
    private readonly ttlMs = OPEN_CODE_RUNTIME_REFRESH_TTL_MS,
  ) {}

  snapshot() { return this.current; }

  refresh() {
    if (this.#refresh) return this.#refresh;
    if (this.#draining) return Promise.resolve(this.current);
    const checkedAt = Date.parse(this.current.checkedAt);
    if (Number.isFinite(checkedAt) && this.now() - checkedAt < this.ttlMs) return Promise.resolve(this.current);
    const inspection = this.inspect();
    const settlement = inspectionSettlements.get(inspection) || inspection.then(() => undefined, () => undefined);
    let draining: Promise<void>;
    draining = settlement.finally(() => { if (this.#draining === draining) this.#draining = undefined; });
    this.#draining = draining;
    let flight: Promise<OpenCodeRuntimeResolution>;
    flight = inspection.then((next) => { this.current = next; return next; }).finally(() => { if (this.#refresh === flight) this.#refresh = undefined; });
    this.#refresh = flight;
    return flight;
  }
}

export function runtimeAvailability(agents: readonly ActiveAgentId[], runtime: OpenCodeRuntimeStatus): Partial<Record<ActiveAgentId, boolean>> {
  return Object.fromEntries(agents.map((agent) => [agent, runtime.state === "ready"])) as Partial<Record<ActiveAgentId, boolean>>;
}
