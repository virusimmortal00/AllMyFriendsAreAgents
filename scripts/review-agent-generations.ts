import { readFile } from "node:fs/promises";
import path from "node:path";

interface JournalEntry {
  type: string;
  generationId: string;
  agent: string;
  timestamp: string;
  [key: string]: unknown;
}

const verbose = process.argv.includes("--verbose");
const limitArgument = process.argv.find((argument) => argument.startsWith("--limit="));
const limit = Math.max(1, Number(limitArgument?.split("=")[1]) || 20);
const journalPath = path.join(process.cwd(), ".allmyfriendsareagents", "generations.jsonl");

let contents: string;
try {
  contents = await readFile(journalPath, "utf8");
} catch (error) {
  if ((error as NodeJS.ErrnoException).code === "ENOENT") {
    console.log(`No agent generation journal exists yet at ${journalPath}`);
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

console.log(`Agent generation journal: ${journalPath}`);
console.log(`Showing ${generations.length} of ${grouped.size} generations (newest first).`);

for (const generation of generations) {
  const started = generation.find(({ type }) => type === "generation.started");
  const completed = generation.find(({ type }) => type === "generation.completed");
  const cancelled = generation.find(({ type }) => type === "generation.cancelled");
  const failed = generation.find(({ type }) => type === "generation.failed");
  const interpreted = generation.find(({ type }) => type === "generation.interpreted");
  const delivery = generation.find(({ type }) => type === "generation.delivery");
  const retries = generation.filter(({ type }) => type === "generation.retry").length;
  const status = cancelled ? "CANCELLED" : failed ? "FAILED" : String(delivery?.outcome || (completed ? "generated" : "started"));
  const duration = completed?.durationMs ?? cancelled?.durationMs ?? failed?.durationMs ?? "?";

  const model = started?.modelId || "legacy/unknown";
  console.log(`\n${started?.timestamp || generation[0]?.timestamp}  ${generation[0]?.agent}  model=${model}  ${status}  generation=${duration}ms  retries=${retries}`);
  console.log(`id=${generation[0]?.generationId}  prompt=${started?.promptCharacters ?? "?"} chars  raw=${completed?.responseCharacters ?? "?"} chars  visible=${interpreted?.visibleMessageCount ?? "?"}  removed/protocol=${interpreted?.removedOrProtocolCharacters ?? "?"} chars`);
  if (failed?.error) console.log(`error: ${failed.error}`);
  if (cancelled?.reason) console.log(`cancelled: ${cancelled.reason}`);
  if (completed?.rawResponse) console.log(`raw response:\n${completed.rawResponse}`);
  if (interpreted?.visibleMessages) console.log(`visible messages:\n${JSON.stringify(interpreted.visibleMessages, null, 2)}`);
  if (verbose && started?.prompt) console.log(`prompt:\n${started.prompt}`);
  if (verbose && completed?.cliStdout) console.log(`CLI stdout:\n${completed.cliStdout}`);
  if (verbose && completed?.cliStderr) console.log(`CLI stderr:\n${completed.cliStderr}`);
}
