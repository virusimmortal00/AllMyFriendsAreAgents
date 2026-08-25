import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  modelKey,
  validDiscoveryId,
  type DiscoveredModel,
  type ModelDiscoveryResult,
  type ModelReference,
} from "../shared/model-discovery.js";

const execFileAsync = promisify(execFile);
export const DISCOVERY_TIMEOUT_MS = 10_000;
export const DISCOVERY_OUTPUT_LIMIT = 256_000;
export const DISCOVERY_CACHE_TTL_MS = 30_000;

const OPENCODE_COMMAND = process.env.ALL_MY_FRIENDS_ARE_AGENTS_OPENCODE_COMMAND?.trim() || "opencode";

export interface DiscoveryCommandResult { stdout: string; stderr: string; }
export type DiscoveryExecutor = (command: string, args: readonly string[], signal?: AbortSignal) => Promise<DiscoveryCommandResult>;

function filteredEnvironment() {
  const allowed = new Set(["PATH", "HOME", "USERPROFILE", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "APPDATA", "LOCALAPPDATA", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "SYSTEMROOT", "WINDIR"]);
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => allowed.has(name.toUpperCase())));
}

export const executeDiscoveryCommand: DiscoveryExecutor = async (command, args, signal) => {
  const result = await execFileAsync(command, [...args], {
    timeout: DISCOVERY_TIMEOUT_MS,
    maxBuffer: DISCOVERY_OUTPUT_LIMIT,
    windowsHide: true,
    signal,
    env: filteredEnvironment(),
  });
  return { stdout: result.stdout, stderr: result.stderr };
};

function stripAnsi(value: string) {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

function diagnostic(value: unknown) {
  const message = value instanceof Error ? value.message : String(value);
  return stripAnsi(message)
    .replace(/(?:sk-|key-|token-|Bearer\s+)[A-Za-z0-9._-]{8,}/gi, "[redacted]")
    .replace(/\b[A-Za-z_][A-Za-z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD)=[^\s]+/gi, "[redacted]")
    .slice(0, 500);
}

function classifyError(error: unknown): Pick<ModelDiscoveryResult, "status" | "diagnostic"> {
  const message = diagnostic(error);
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === "ENOENT") return { status: "cli_missing", diagnostic: "OpenCode is not installed or is not on PATH." };
  if (/not logged in|not authenticated|authentication|oauth|login required|unauthorized/i.test(message)) {
    return { status: "authentication_required", diagnostic: "OpenCode requires authentication." };
  }
  if (/not configured|configuration|provider.*required|no provider|missing.*model/i.test(message)) {
    return { status: "configuration_required", diagnostic: "OpenCode requires provider or model configuration." };
  }
  return { status: "error", diagnostic: "Model discovery failed without exposing raw OpenCode output." };
}

function uniqueModels(models: readonly DiscoveredModel[]) {
  const seen = new Set<string>();
  return models.filter((model) => {
    if (!validDiscoveryId(model.modelId) || model.providerId && !validDiscoveryId(model.providerId)) return false;
    const key = modelKey(model);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 500);
}

export function parseOpenCodeModelCatalog(stdout: string): readonly DiscoveredModel[] {
  if (Buffer.byteLength(stdout) > DISCOVERY_OUTPUT_LIMIT) throw new Error("OpenCode model catalog exceeded the discovery output limit.");
  const models: DiscoveredModel[] = [];
  const plain = stripAnsi(stdout);
  const lines = plain.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const token = line.split(/\s+/)[0];
    const slash = token.indexOf("/");
    if (slash <= 0) continue;
    const providerId = token.slice(0, slash);
    const modelId = token.slice(slash + 1);
    if (!validDiscoveryId(providerId) || !validDiscoveryId(modelId)) continue;
    const variantMatch = line.match(/\bvariants?[:=]\s*([A-Za-z0-9._,+@/-]+)/i);
    let variantIds = variantMatch?.[1].split(",").filter(validDiscoveryId) || [];
    if (!variantIds.length && lines[index + 1]?.trim().startsWith("{")) {
      let json = "";
      let depth = 0;
      for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
        const fragment = lines[cursor];
        json += `${fragment}\n`;
        depth += (fragment.match(/{/g) || []).length - (fragment.match(/}/g) || []).length;
        if (depth === 0) {
          index = cursor;
          break;
        }
      }
      try {
        const detail = JSON.parse(json) as { variants?: Record<string, unknown> };
        variantIds = Object.keys(detail.variants || {}).filter(validDiscoveryId);
      } catch {
        // Keep the model entry without metadata when verbose details are malformed.
      }
    }
    const variants = variantIds.map((id) => ({ id, displayName: id }));
    models.push({ providerId, modelId, displayName: token, ...(variants?.length ? { variants } : {}), provenance: "opencode-catalog" });
  }
  return uniqueModels(models);
}

function configuredReference(): ModelReference | undefined {
  const modelId = process.env.ALL_MY_FRIENDS_ARE_AGENTS_OPENCODE_MODEL?.trim();
  const providerId = process.env.ALL_MY_FRIENDS_ARE_AGENTS_OPENCODE_PROVIDER?.trim();
  if (!modelId || !validDiscoveryId(modelId) || providerId && !validDiscoveryId(providerId)) return undefined;
  return { ...(providerId ? { providerId } : {}), modelId };
}

function configuredModel(reference: ModelReference): DiscoveredModel {
  return { ...reference, displayName: reference.providerId ? `${reference.providerId}/${reference.modelId}` : reference.modelId, provenance: "configured-default" };
}

export class ModelDiscoveryService {
  private cache?: { expiresAt: number; promise: Promise<ModelDiscoveryResult> };

  constructor(
    private readonly execute: DiscoveryExecutor = executeDiscoveryCommand,
    private readonly now: () => number = Date.now,
    private readonly ttlMs = DISCOVERY_CACHE_TTL_MS,
  ) {}

  async discover(refresh = false, signal?: AbortSignal) {
    const resolve = () => this.discoverUncached(signal).catch((error): ModelDiscoveryResult => ({
      ...classifyError(error), models: [], discoveredAt: new Date(this.now()).toISOString(),
    }));
    if (signal) return resolve();
    const cached = this.cache;
    if (!refresh && cached && cached.expiresAt > this.now()) return cached.promise;
    const promise = resolve();
    this.cache = { expiresAt: this.now() + this.ttlMs, promise };
    return promise;
  }

  private async discoverUncached(signal?: AbortSignal): Promise<ModelDiscoveryResult> {
    const discoveredAt = new Date(this.now()).toISOString();
    const configuredDefault = configuredReference();
    const output = await this.execute(OPENCODE_COMMAND, ["models", "--verbose"], signal);
    const models = parseOpenCodeModelCatalog(output.stdout);
    if (!models.length) throw new Error("OpenCode returned a malformed or empty model catalog.");
    return { status: "available", models: uniqueModels(configuredDefault ? [...models, configuredModel(configuredDefault)] : models), configuredDefault, discoveredAt };
  }
}
