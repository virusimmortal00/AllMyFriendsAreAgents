import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

interface JournalEntry {
  type?: string;
  event?: string;
  generationId: string;
  agent: string;
  timestamp: string;
  [key: string]: unknown;
}

const verbose = process.argv.includes("--verbose");
const limitArgument = process.argv.find((argument) => argument.startsWith("--limit="));
const limit = Math.max(1, Number(limitArgument?.split("=")[1]) || 20);
const journalDirectory = path.join(process.cwd(), ".allmyfriendsareagents", "logs", "authoritative-v1");

let contents: string;
try {
  const files = (await readdir(journalDirectory)).filter((name) => /^(?:generations|openrouter-provider|opencode-harness)\./.test(name) && name.endsWith(".jsonl")).sort();
  contents = (await Promise.all(files.map((name) => readFile(path.join(journalDirectory, name), "utf8")))).join("");
} catch (error) {
  if ((error as NodeJS.ErrnoException).code === "ENOENT") {
    console.log(`No agent generation exchange stream exists yet at ${journalDirectory}`);
    process.exit(0);
  }
  throw error;
}

const entries = contents
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line) as JournalEntry);
const grouped = new Map<string, JournalEntry[]>();
for (const entry of entries) {
  const generation = grouped.get(entry.generationId) || [];
  generation.push(entry);
  grouped.set(entry.generationId, generation);
}

const generations = [...grouped.values()]
  .sort((left, right) => Date.parse(String(right[0]?.timestamp)) - Date.parse(String(left[0]?.timestamp)))
  .slice(0, limit);

console.log(`Agent generation exchange stream: ${journalDirectory}`);
console.log(`Showing ${generations.length} of ${grouped.size} generations (newest first).`);

for (const generation of generations) {
  const kind = (entry: JournalEntry) => entry.type || entry.event;
  const started = generation.find((entry) => kind(entry) === "generation.started");
  const completed = generation.find((entry) => kind(entry) === "generation.completed");
  const cancelled = generation.find((entry) => kind(entry) === "generation.cancelled");
  const failed = generation.find((entry) => kind(entry) === "generation.failed");
  const interpreted = generation.find((entry) => kind(entry) === "generation.interpreted");
  const delivery = generation.find((entry) => kind(entry) === "generation.delivery");
  const provider = generation.find((entry) => kind(entry)?.startsWith("provider.exchange."));
  const stdout = generation.find((entry) => kind(entry) === "opencode.stdout");
  const stderr = generation.find((entry) => kind(entry) === "opencode.stderr");
  const retries = generation.filter((entry) => kind(entry) === "generation.retry").length;
  const status = cancelled ? "CANCELLED" : failed ? "FAILED" : String(delivery?.outcome || (completed ? "generated" : "started"));
  const duration = completed?.durationMs ?? cancelled?.durationMs ?? failed?.durationMs ?? "?";

  const model = started?.modelId || "legacy/unknown";
  const selection = [started?.providerId, model].filter(Boolean).join("/");
  const variant = started?.variant ? ` variant=${started.variant}` : "";
  console.log(`\n${started?.timestamp || generation[0]?.timestamp}  ${generation[0]?.agent}  model=${selection}${variant}  ${status}  generation=${duration}ms  retries=${retries}`);
  console.log(`id=${generation[0]?.generationId}  prompt=${started?.promptCharacters ?? "?"} chars  raw=${completed?.responseCharacters ?? "?"} chars  visible=${interpreted?.visibleMessageCount ?? "?"}  removed/protocol=${interpreted?.removedOrProtocolCharacters ?? "?"} chars`);
  const usage = provider?.usage as Record<string, unknown> | undefined;
  if (usage) console.log(`usage=${usage.totalTokens ?? "?"} tokens (${usage.inputTokens ?? "?"} in, ${usage.outputTokens ?? "?"} out, ${usage.reasoningTokens ?? "?"} reasoning, ${usage.cacheReadTokens ?? "?"} cache read, ${usage.cacheWriteTokens ?? "?"} cache write)  cost=$${Number(provider?.costUsd || 0).toFixed(6)}`);
  if (provider?.error || failed?.error) console.log(`error: ${provider?.error ?? failed?.error}`);
  if (cancelled?.reason) console.log(`cancelled: ${cancelled.reason}`);
  if (completed?.rawResponse) console.log(`raw response:\n${completed.rawResponse}`);
  if (interpreted?.visibleMessages) console.log(`visible messages:\n${JSON.stringify(interpreted.visibleMessages, null, 2)}`);
  if (verbose && started?.prompt) console.log(`prompt:\n${started.prompt}`);
  if (verbose && stdout?.output) console.log(`CLI stdout:\n${stdout.output}`);
  if (verbose && stderr?.output) console.log(`CLI stderr:\n${stderr.output}`);
}
