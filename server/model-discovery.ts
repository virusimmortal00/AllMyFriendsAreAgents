import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  HARNESS_IDS,
  modelKey,
  validDiscoveryId,
  type DiscoveredModel,
  type HarnessDiscoveryResult,
  type HarnessId,
  type ModelReference,
} from "../shared/model-discovery.js";

const execFileAsync = promisify(execFile);
export const DISCOVERY_TIMEOUT_MS = 10_000;
export const DISCOVERY_OUTPUT_LIMIT = 256_000;
export const DISCOVERY_CACHE_TTL_MS = 30_000;

const COMMANDS: Record<HarnessId, string> = {
  codex: process.env.ALL_MY_FRIENDS_ARE_AGENTS_CODEX_COMMAND?.trim() || "codex",
  claude: process.env.ALL_MY_FRIENDS_ARE_AGENTS_CLAUDE_COMMAND?.trim() || "claude",
  cursor: process.env.ALL_MY_FRIENDS_ARE_AGENTS_CURSOR_COMMAND?.trim() || "agent",
  opencode: process.env.ALL_MY_FRIENDS_ARE_AGENTS_OPENCODE_COMMAND?.trim() || "opencode",
};

const CODEX_ALIASES: readonly DiscoveredModel[] = [
  { harness: "codex", modelId: "gpt-5.6-sol", displayName: "gpt-5.6 Sol", provenance: "documented-alias", capabilities: { reasoningEffort: ["low", "medium", "high", "xhigh"] } },
  { harness: "codex", modelId: "gpt-5.6-terra", displayName: "gpt-5.6 Terra", provenance: "documented-alias", capabilities: { reasoningEffort: ["low", "medium", "high", "xhigh"] } },
  { harness: "codex", modelId: "gpt-5.6-luna", displayName: "gpt-5.6 Luna", provenance: "documented-alias", capabilities: { reasoningEffort: ["low", "medium", "high"] } },
];

const CLAUDE_ALIASES: readonly DiscoveredModel[] = [
  { harness: "claude", modelId: "claude-sonnet-5", displayName: "Claude Sonnet 5", provenance: "documented-alias", capabilities: { reasoningEffort: ["low", "medium", "high"] } },
  { harness: "claude", modelId: "claude-opus-5", displayName: "Claude Opus 5", provenance: "documented-alias", capabilities: { reasoningEffort: ["low", "medium", "high"] } },
  { harness: "claude", modelId: "sonnet", displayName: "Sonnet (documented alias)", provenance: "documented-alias", capabilities: { reasoningEffort: ["low", "medium", "high"] } },
  { harness: "claude", modelId: "opus", displayName: "Opus (documented alias)", provenance: "documented-alias", capabilities: { reasoningEffort: ["low", "medium", "high"] } },
  { harness: "claude", modelId: "haiku", displayName: "Haiku (documented alias)", provenance: "documented-alias" },
];

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

function classifyError(error: unknown): Pick<HarnessDiscoveryResult, "status" | "diagnostic"> {
  const message = diagnostic(error);
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === "ENOENT") return { status: "cli_missing", diagnostic: "The harness CLI is not installed or is not on PATH." };
  if (/not logged in|not authenticated|authentication|oauth|login required|unauthorized/i.test(message)) {
    return { status: "authentication_required", diagnostic: "The harness requires authentication." };
  }
  if (/not configured|configuration|provider.*required|no provider|missing.*model/i.test(message)) {
    return { status: "configuration_required", diagnostic: "The harness requires provider or model configuration." };
  }
  return { status: "error", diagnostic: "Model discovery failed without exposing raw harness output." };
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

export function parseCursorModelCatalog(stdout: string): readonly DiscoveredModel[] {
  if (Buffer.byteLength(stdout) > DISCOVERY_OUTPUT_LIMIT) throw new Error("Cursor model catalog exceeded the discovery output limit.");
  const plain = stripAnsi(stdout);
  const models: DiscoveredModel[] = [];
  for (const line of plain.split("\n")) {
    const match = line.trim().match(/^([^\s]+)\s+-\s+(.+)$/);
    if (!match || !validDiscoveryId(match[1])) continue;
    models.push({ harness: "cursor", modelId: match[1], displayName: match[2].trim().slice(0, 200), provenance: "harness-catalog" });
  }
  return uniqueModels(models);
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
    models.push({ harness: "opencode", providerId, modelId, displayName: token, ...(variants?.length ? { variants } : {}), provenance: "harness-catalog" });
  }
  return uniqueModels(models);
}

function configuredReference(harness: HarnessId): ModelReference | undefined {
  const upper = harness.toUpperCase();
  const modelId = process.env[`ALL_MY_FRIENDS_ARE_AGENTS_${upper}_MODEL`]?.trim();
  const providerId = process.env[`ALL_MY_FRIENDS_ARE_AGENTS_${upper}_PROVIDER`]?.trim();
  if (!modelId || !validDiscoveryId(modelId) || providerId && !validDiscoveryId(providerId)) return undefined;
  return { harness, ...(providerId ? { providerId } : {}), modelId };
}

function configuredModel(reference: ModelReference): DiscoveredModel {
  return { ...reference, displayName: reference.providerId ? `${reference.providerId}/${reference.modelId}` : reference.modelId, provenance: "configured-default" };
}

export class ModelDiscoveryService {
  private readonly cache = new Map<HarnessId, { expiresAt: number; promise: Promise<HarnessDiscoveryResult> }>();

  constructor(
    private readonly execute: DiscoveryExecutor = executeDiscoveryCommand,
    private readonly now: () => number = Date.now,
    private readonly ttlMs = DISCOVERY_CACHE_TTL_MS,
  ) {}

  async discover(harness: HarnessId, refresh = false, signal?: AbortSignal) {
    const cached = this.cache.get(harness);
    if (!refresh && cached && cached.expiresAt > this.now()) return cached.promise;
    const promise = this.discoverUncached(harness, signal).catch((error): HarnessDiscoveryResult => ({
      ...classifyError(error), models: [], discoveredAt: new Date(this.now()).toISOString(),
    }));
    this.cache.set(harness, { expiresAt: this.now() + this.ttlMs, promise });
    return promise;
  }

  async discoverAll(refresh = false, signal?: AbortSignal) {
    return Object.fromEntries(await Promise.all(HARNESS_IDS.map(async (harness) => [harness, await this.discover(harness, refresh, signal)]))) as Record<HarnessId, HarnessDiscoveryResult>;
  }

  private async discoverUncached(harness: HarnessId, signal?: AbortSignal): Promise<HarnessDiscoveryResult> {
    const discoveredAt = new Date(this.now()).toISOString();
    const configuredDefault = configuredReference(harness);
    if (harness === "codex" || harness === "claude") {
      await this.execute(COMMANDS[harness], ["--version"], signal);
      const authentication = await this.execute(COMMANDS[harness], harness === "codex" ? ["login", "status"] : ["auth", "status"], signal);
      if (harness === "codex" && /not logged in|not authenticated|login required/i.test(`${authentication.stdout}\n${authentication.stderr}`)) {
        throw new Error("Not authenticated.");
      }
      if (harness === "claude") {
        try {
          const status = JSON.parse(authentication.stdout) as { loggedIn?: unknown };
          if (status.loggedIn !== true) throw new Error("Not authenticated.");
        } catch (error) {
          if (error instanceof Error && error.message === "Not authenticated.") throw error;
          throw new Error("Claude authentication status was malformed.");
        }
      }
      const aliases = harness === "codex" ? CODEX_ALIASES : CLAUDE_ALIASES;
      const models = uniqueModels(configuredDefault ? [...aliases, configuredModel(configuredDefault)] : aliases);
      return {
        status: "discovery_unsupported", models, configuredDefault, discoveredAt,
        diagnostic: `${harness === "codex" ? "Codex CLI" : "Claude Code"} has no supported complete machine-readable model catalog; documented aliases and any configured default are shown.`,
      };
    }
    if (harness === "cursor") {
      const output = await this.execute(COMMANDS.cursor, ["--list-models"], signal);
      const models = parseCursorModelCatalog(output.stdout);
      if (!models.length) throw new Error("Cursor returned a malformed or empty model catalog.");
      return { status: "available", models, configuredDefault, discoveredAt };
    }
    if (harness === "opencode") {
      const output = await this.execute(COMMANDS.opencode, ["models", "--verbose"], signal);
      const models = parseOpenCodeModelCatalog(output.stdout);
      if (!models.length) throw new Error("OpenCode returned a malformed or empty model catalog.");
      return { status: "available", models, configuredDefault, discoveredAt };
    }
    throw new Error(`Unsupported model-discovery harness: ${harness satisfies never}`);
  }
}
