// Deterministic provider-free CLI used only in disposable application tests.
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
if (process.argv.includes("--version")) process.stdout.write("1.18.25\n");
else if (process.argv.includes("models")) process.stdout.write("openai/fixture-model\n");
else if (process.argv.includes("run")) {
  const { probe } = JSON.parse(await readFile(join(dirname(fileURLToPath(import.meta.url)), "protected.json"), "utf8"));
  if (new URL(probe).hostname !== "127.0.0.1") throw new Error("Loopback fixture required");
  const returning = process.argv.join(" ").includes("Return from protected read-only work");
  await fetch(probe, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ returning, hasCommandTool: Boolean(process.env.AMFAA_ROOM_COMMAND_TOKEN), resumed: process.argv.includes("--session") }) });
  const text = returning ? JSON.stringify({ relevance: "qualified", text: "Protected review is complete; these findings reflect the current conversation." }) : "Fixture ordinary reply.\nCONVERSATION_STATE: settled";
  process.stdout.write(JSON.stringify({ type: "text", sessionID: "ses_fixture_return", part: { type: "text", text } }) + "\n");
} else process.exitCode = 1;
