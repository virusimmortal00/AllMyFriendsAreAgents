import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  modelKey,
  validDiscoveryId,
  validModelDiscoveryId,
  type DiscoveredModel,
  type ModelDiscoveryResult,
  type ModelReference,
} from "../shared/model-discovery.js";
import { friendlyModelName, modelAuthorId, providerDisplayName } from "../shared/model-presentation.js";

const execFileAsync = promisify(execFile);
export const DISCOVERY_TIMEOUT_MS = 10_000;
export const DISCOVERY_OUTPUT_LIMIT = 1_048_576;
export const DISCOVERY_CACHE_TTL_MS = 30_000;
export const MINIMUM_OPENCODE_VERSION = "1.18.18";
const OPENCODE_PROTOCOL = "opencode-cli-jsonl-v1" as const;
const OPENCODE_CAPABILITIES = ["verbose-model-catalog", "jsonl-events", "variant-selection"] as const;

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
    if (!validModelDiscoveryId(model.modelId) || model.providerId && !validDiscoveryId(model.providerId)) return false;
    const key = modelKey(model);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 500);
}

export function parseOpenCodeRuntimeVersion(stdout: string) {
  const match = stripAnsi(stdout).trim().match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/);
  if (!match) return undefined;
  const version = `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}${match[4] ? `-${match[4]}` : ""}${match[5] ? `+${match[5]}` : ""}`;
  const parts = [Number(match[1]), Number(match[2]), Number(match[3])];
  const minimum = MINIMUM_OPENCODE_VERSION.split(".").map(Number);
  const firstDifference = parts.findIndex((part, index) => part !== minimum[index]);
  const atLeastMinimum = firstDifference === -1 ? !match[4] : parts[firstDifference] > minimum[firstDifference];
  return {
    version,
    compatible: parts[0] === minimum[0] && atLeastMinimum,
    protocol: OPENCODE_PROTOCOL,
    capabilities: OPENCODE_CAPABILITIES,
  };
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
    if (!validDiscoveryId(providerId) || !validModelDiscoveryId(modelId)) continue;
    const variantMatch = line.match(/\bvariants?[:=]\s*([A-Za-z0-9._,+@/-]+)/i);
    let variantIds = variantMatch?.[1].split(",").filter(validDiscoveryId) || [];
    let detail: {
      name?: unknown;
      family?: unknown;
      status?: unknown;
      release_date?: unknown;
      cost?: { input?: unknown; output?: unknown; cache?: { read?: unknown; write?: unknown } };
      limit?: { context?: unknown; input?: unknown; output?: unknown };
      capabilities?: {
        reasoning?: unknown;
        toolcall?: unknown;
        attachment?: unknown;
        input?: Record<string, unknown>;
        output?: Record<string, unknown>;
      };
      variants?: Record<string, unknown>;
    } | undefined;
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
        const parsedDetail = JSON.parse(json) as NonNullable<typeof detail>;
        detail = parsedDetail;
        variantIds = Object.keys(parsedDetail.variants || {}).filter(validDiscoveryId);
      } catch {
        // Keep the model entry without metadata when verbose details are malformed.
      }
    }
    const variants = variantIds.map((id) => ({ id, displayName: id }));
    const authorId = modelAuthorId(providerId, modelId);
    const authorDisplayName = providerDisplayName(authorId);
    const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
    const modalities = (value: Record<string, unknown> | undefined) => Object.entries(value || {}).flatMap(([id, supported]) => supported === true ? [id] : []);
    const reasoningEffort = Object.entries(detail?.variants || {}).flatMap(([id, value]) => {
      if (!validDiscoveryId(id) || !value || typeof value !== "object") return [];
      const variant = value as { reasoningEffort?: unknown; reasoning?: { effort?: unknown } };
      return typeof variant.reasoningEffort === "string" || typeof variant.reasoning?.effort === "string" ? [id] : [];
    });
    const pricing = {
      inputPerMillion: number(detail?.cost?.input),
      outputPerMillion: number(detail?.cost?.output),
      cacheReadPerMillion: number(detail?.cost?.cache?.read),
      cacheWritePerMillion: number(detail?.cost?.cache?.write),
    };
    const limits = {
      context: number(detail?.limit?.context),
      input: number(detail?.limit?.input),
      output: number(detail?.limit?.output),
    };
    const capabilities = {
      ...(reasoningEffort.length ? { reasoningEffort } : {}),
      ...(typeof detail?.capabilities?.reasoning === "boolean" ? { reasoning: detail.capabilities.reasoning } : {}),
      ...(typeof detail?.capabilities?.toolcall === "boolean" ? { toolCall: detail.capabilities.toolcall } : {}),
      ...(typeof detail?.capabilities?.attachment === "boolean" ? { attachment: detail.capabilities.attachment } : {}),
      inputModalities: modalities(detail?.capabilities?.input),
      outputModalities: modalities(detail?.capabilities?.output),
    };
    models.push({
      providerId,
      modelId,
      displayName: typeof detail?.name === "string" && detail.name.trim() ? detail.name.trim().slice(0, 160) : friendlyModelName(modelId),
      ...(typeof detail?.family === "string" ? { family: detail.family.slice(0, 100) } : {}),
      ...(authorId ? { authorId, authorDisplayName } : {}),
      accessProviderDisplayName: providerDisplayName(providerId),
      ...(typeof detail?.status === "string" ? { status: detail.status.slice(0, 40) } : {}),
      ...(typeof detail?.release_date === "string" ? { releaseDate: detail.release_date.slice(0, 20) } : {}),
      ...(Object.values(pricing).some((value) => value !== undefined) ? { pricing } : {}),
      ...(Object.values(limits).some((value) => value !== undefined) ? { limits } : {}),
      ...(Object.keys(capabilities).length ? { capabilities } : {}),
      ...(variants.length ? { variants } : {}),
      provenance: "opencode-catalog",
    });
  }
  return uniqueModels(models);
}

function configuredReference(): ModelReference | undefined {
  const modelId = process.env.ALL_MY_FRIENDS_ARE_AGENTS_OPENCODE_MODEL?.trim();
  const providerId = process.env.ALL_MY_FRIENDS_ARE_AGENTS_OPENCODE_PROVIDER?.trim();
  if (!modelId || !validModelDiscoveryId(modelId) || providerId && !validDiscoveryId(providerId)) return undefined;
  return { ...(providerId ? { providerId } : {}), modelId };
}

function configuredModel(reference: ModelReference): DiscoveredModel {
  const authorId = modelAuthorId(reference.providerId, reference.modelId);
  return { ...reference, displayName: friendlyModelName(reference.modelId), ...(authorId ? { authorId, authorDisplayName: providerDisplayName(authorId) } : {}), accessProviderDisplayName: providerDisplayName(reference.providerId), provenance: "configured-default" };
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
    const versionOutput = await this.execute(OPENCODE_COMMAND, ["--version"], signal);
    const runtime = parseOpenCodeRuntimeVersion(versionOutput.stdout);
    if (!runtime?.compatible) {
      return {
        status: "runtime_incompatible",
        models: [],
        ...(runtime ? { runtime } : {}),
        diagnostic: runtime
          ? `OpenCode ${runtime.version} is incompatible; install ${MINIMUM_OPENCODE_VERSION} or a newer compatible 1.x release.`
          : "OpenCode returned an unrecognized version; install a supported 1.x release.",
        discoveredAt,
      };
    }
    try {
      const output = await this.execute(OPENCODE_COMMAND, ["models", "--verbose"], signal);
      const models = parseOpenCodeModelCatalog(output.stdout);
      if (!models.length) throw new Error("OpenCode returned a malformed or empty model catalog.");
      return { status: "available", models: uniqueModels(configuredDefault ? [...models, configuredModel(configuredDefault)] : models), runtime, configuredDefault, discoveredAt };
    } catch (error) {
      return { ...classifyError(error), models: [], runtime, discoveredAt };
    }
  }
}
