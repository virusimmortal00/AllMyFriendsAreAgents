import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentContextSummarizer } from "./transcript.js";

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 30_000;
const OUTPUT_LIMIT = 64 * 1024;
const OPENCODE_COMMAND = process.env.ALL_MY_FRIENDS_ARE_AGENTS_OPENCODE_COMMAND?.trim() || "opencode";
type SummarizerExecutor = (command: string, args: readonly string[], options: { timeout: number; maxBuffer: number; env: NodeJS.ProcessEnv }) => Promise<{ stdout: string; stderr: string }>;

function textFromJsonLines(stdout: string) {
  const text: string[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as { type?: string; part?: { type?: string; text?: string } };
      if (event.type === "text" && event.part?.type === "text" && event.part.text) text.push(event.part.text);
    } catch {
      // Non-protocol progress is ignored.
    }
  }
  return text.join("").trim();
}

function summarizerEnvironment(environment: NodeJS.ProcessEnv = process.env) {
  return {
    ...Object.fromEntries(Object.entries(environment).filter(([name]) => {
      const normalized = name.toUpperCase();
      return !normalized.startsWith("ALL_MY_FRIENDS_ARE_AGENTS_")
        && !normalized.startsWith("AGENTWIRE_")
        && normalized !== "DATABASE_URL";
    })),
    OPENCODE_PERMISSION: JSON.stringify({ "*": "deny" }),
  };
}

export class OpenCodeContextSummarizer implements AgentContextSummarizer {
  constructor(
    private readonly command = OPENCODE_COMMAND,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
    private readonly execute: SummarizerExecutor = (command, args, options) => execFileAsync(command, [...args], options),
  ) {}

  async summarize(input: Parameters<AgentContextSummarizer["summarize"]>[0]) {
    const prompt = input.promptTemplate
      .replaceAll("{{tokenTarget}}", String(input.tokenTarget))
      .replaceAll("{{transcript}}", input.transcript);
    const failures: string[] = [];
    for (const model of input.models) {
      const selection = model.providerId ? `${model.providerId}/${model.modelId}` : model.modelId;
      try {
        const { stdout } = await this.execute(this.command, [
          "run", "--format", "json", "--dir", input.projectPath, "--agent", "plan",
          "--model", selection,
          ...(model.variant ? ["--variant", model.variant] : []),
          prompt,
        ], {
          timeout: this.timeoutMs,
          maxBuffer: OUTPUT_LIMIT,
          env: summarizerEnvironment(),
        });
        const summary = textFromJsonLines(stdout);
        if (summary) return summary;
        failures.push(`${selection}: empty response`);
      } catch (error) {
        failures.push(`${selection}: ${error instanceof Error ? error.message.slice(0, 200) : "failed"}`);
      }
    }
    throw new Error(`Context summarization unavailable (${failures.join("; ")}).`);
  }
}

export const __testing = { textFromJsonLines, summarizerEnvironment };
