import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import type { AssistantMessage } from "@opencode-ai/sdk/v2";
import { APPROVED_DOWNSTREAM_OPENCODE_VERSION, parseOpenCodeRuntimeVersion } from "./model-discovery.js";
import { STRUCTURED_ROOM_TURN_JSON_SCHEMA, validateStructuredRoomTurn, type StructuredRoomTurnOutput } from "./structured-room-turn.js";

const SERVER_HOST = "127.0.0.1";
const SERVER_START_TIMEOUT_MS = 10_000;

export interface OpenCodeStructuredTurnInput {
  readonly command: string;
  readonly projectPath: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly variant?: string;
  readonly agent: string;
  readonly prompt: string;
  readonly system?: string;
  readonly sessionId?: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
  readonly scope?: string | readonly string[];
}

export interface OpenCodeStructuredTurnResult {
  readonly sessionId: string;
  readonly messageId: string;
  readonly structured: StructuredRoomTurnOutput;
  readonly finish?: string;
  readonly cost: number;
  readonly tokens: AssistantMessage["tokens"];
}

export interface OpenCodeStructuredSdk {
  health(signal?: AbortSignal): Promise<{ healthy: true; version: string }>;
  createSession(input: Pick<OpenCodeStructuredTurnInput, "projectPath" | "providerId" | "modelId" | "variant" | "agent">, signal?: AbortSignal): Promise<string>;
  prompt(sessionId: string, input: Pick<OpenCodeStructuredTurnInput, "projectPath" | "providerId" | "modelId" | "variant" | "agent" | "prompt" | "system">, signal?: AbortSignal): Promise<{ info: AssistantMessage }>;
  abort(sessionId: string, projectPath: string): Promise<void>;
}

export interface OpenCodeProcessSupervisor {
  track(child: ChildProcess, scope?: string | readonly string[]): void;
  release(child: ChildProcess): Promise<void>;
}

export class OpenCodeStructuredTurnCancelledError extends Error {
  constructor() {
    super("OpenCode structured room turn was cancelled.");
    this.name = "OpenCodeStructuredTurnCancelledError";
  }
}

export async function executeOpenCodeStructuredTurn(client: OpenCodeStructuredSdk, input: Omit<OpenCodeStructuredTurnInput, "command" | "environment" | "timeoutMs" | "scope">): Promise<OpenCodeStructuredTurnResult> {
  if (input.signal?.aborted) throw new OpenCodeStructuredTurnCancelledError();
  const health = await client.health(input.signal);
  const runtime = parseOpenCodeRuntimeVersion(health.version);
  if (!health.healthy || runtime?.version !== APPROVED_DOWNSTREAM_OPENCODE_VERSION || runtime.distribution !== "downstream") {
    throw new Error("The structured OpenCode server does not match the approved downstream runtime.");
  }
  const sessionId = input.sessionId || await client.createSession(input, input.signal);
  let cancelled = false;
  const cancel = () => {
    cancelled = true;
    void client.abort(sessionId, input.projectPath).catch(() => undefined);
  };
  input.signal?.addEventListener("abort", cancel, { once: true });
  try {
    let cost = 0;
    const tokens: AssistantMessage["tokens"] = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const promptInput = attempt === 0 ? input : {
        ...input,
        prompt: "Your previous structured room-turn result did not satisfy the action-specific contract. Return one corrected result: yield requires a non-null reason, an empty messages array, and null conversationState; speak requires null reason, one to three messages, and a non-null conversationState.",
      };
      const response = await client.prompt(sessionId, promptInput, input.signal);
      cost += response.info.cost;
      tokens.input += response.info.tokens.input;
      tokens.output += response.info.tokens.output;
      tokens.reasoning += response.info.tokens.reasoning;
      tokens.cache.read += response.info.tokens.cache.read;
      tokens.cache.write += response.info.tokens.cache.write;
      if (cancelled || input.signal?.aborted) throw new OpenCodeStructuredTurnCancelledError();
      if (response.info.error) throw new Error("OpenCode failed to produce a structured room turn.");
      try {
        const structured = validateStructuredRoomTurn(response.info.structured);
        return {
          sessionId,
          messageId: response.info.id,
          structured,
          finish: response.info.finish,
          cost,
          tokens,
        };
      } catch (error) {
        if (attempt > 0) throw error;
      }
    }
    throw new Error("OpenCode returned an invalid structured room turn.");
  } catch (error) {
    if (cancelled || input.signal?.aborted || error instanceof OpenCodeStructuredTurnCancelledError) throw new OpenCodeStructuredTurnCancelledError();
    throw error;
  } finally {
    input.signal?.removeEventListener("abort", cancel);
  }
}

function sdkClient(baseUrl: string, username: string, password: string): OpenCodeStructuredSdk {
  const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  const client = createOpencodeClient({ baseUrl, headers: { Authorization: authorization } });
  return {
    async health(signal) {
      const result = await client.global.health({ throwOnError: true, signal });
      return result.data;
    },
    async createSession(input, signal) {
      const result = await client.session.create({
        directory: input.projectPath,
        title: "AllMyFriendsAreAgents read-only room turn",
        agent: input.agent,
        model: { id: input.modelId, providerID: input.providerId, ...(input.variant ? { variant: input.variant } : {}) },
      }, { throwOnError: true, signal });
      if (!result.data?.id) throw new Error("OpenCode did not create a structured room session.");
      return result.data.id;
    },
    async prompt(sessionId, input, signal) {
      const result = await client.session.prompt({
        sessionID: sessionId,
        directory: input.projectPath,
        model: { providerID: input.providerId, modelID: input.modelId },
        agent: input.agent,
        variant: input.variant,
        system: input.system,
        format: { type: "json_schema", schema: STRUCTURED_ROOM_TURN_JSON_SCHEMA, retryCount: 2 },
        parts: [{ type: "text", text: input.prompt }],
      }, { throwOnError: true, signal });
      if (!result.data?.info) throw new Error("OpenCode returned no structured room message.");
      return { info: result.data.info };
    },
    async abort(sessionId, projectPath) {
      await client.session.abort({ sessionID: sessionId, directory: projectPath }).catch(() => undefined);
    },
  };
}

async function availablePort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, SERVER_HOST, () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : 0;
      server.close((error) => error ? reject(error) : port ? resolve(port) : reject(new Error("No loopback port was allocated.")));
    });
  });
}

async function waitForServer(child: ChildProcess, expectedUrl: string, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    let output = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.off("data", data);
      child.off("error", failed);
      child.off("exit", exited);
      signal?.removeEventListener("abort", aborted);
      error ? reject(error) : resolve();
    };
    const data = (chunk: Buffer | string) => {
      output = `${output}${chunk}`.slice(-4_096);
      if (output.split(/\r?\n/).some((line) => line.trim() === `opencode server listening on ${expectedUrl}`)) finish();
    };
    const failed = () => finish(new Error("OpenCode structured server failed to start."));
    const exited = () => finish(new Error("OpenCode structured server exited before becoming ready."));
    const aborted = () => finish(new OpenCodeStructuredTurnCancelledError());
    const timer = setTimeout(() => finish(new Error("OpenCode structured server did not become ready in time.")), SERVER_START_TIMEOUT_MS);
    child.stdout?.on("data", data);
    child.once("error", failed);
    child.once("exit", exited);
    signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted) aborted();
  });
}

export class OpenCodePerTurnStructuredTransport {
  constructor(private readonly supervisor: OpenCodeProcessSupervisor) {}

  async run(input: OpenCodeStructuredTurnInput): Promise<OpenCodeStructuredTurnResult> {
    const timeoutSignal = AbortSignal.timeout(input.timeoutMs);
    const turnSignal = input.signal ? AbortSignal.any([input.signal, timeoutSignal]) : timeoutSignal;
    const port = await availablePort();
    const url = `http://${SERVER_HOST}:${port}`;
    const username = "amfaa";
    const password = randomBytes(32).toString("base64url");
    const child = spawn(input.command, ["serve", `--hostname=${SERVER_HOST}`, `--port=${port}`], {
      cwd: input.projectPath,
      env: { ...input.environment, OPENCODE_SERVER_USERNAME: username, OPENCODE_SERVER_PASSWORD: password },
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr?.resume();
    this.supervisor.track(child, input.scope);
    try {
      await waitForServer(child, url, turnSignal);
      child.stdout?.resume();
      return await executeOpenCodeStructuredTurn(sdkClient(url, username, password), { ...input, signal: turnSignal });
    } catch (error) {
      if (timeoutSignal.aborted && !input.signal?.aborted) throw new Error("OpenCode structured room turn timed out.");
      throw error;
    } finally {
      await this.supervisor.release(child);
    }
  }
}
