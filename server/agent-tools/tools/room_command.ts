import { randomUUID } from "node:crypto";
import { tool } from "@opencode-ai/plugin";

const known = ["help", "task", "pov", "poll"] as const;
type Command = typeof known[number];
const configured = (() => {
  try {
    const parsed = JSON.parse(process.env.AMFAA_ROOM_COMMANDS || "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((value): value is Command => known.includes(value as Command)) : [];
  } catch { return []; }
})();

const variants = configured.map((command) => {
  if (command === "help") return tool.schema.object({ command: tool.schema.literal("help") });
  if (command === "task") return tool.schema.object({
    command: tool.schema.literal("task"),
    prompt: tool.schema.string().min(1).max(8_000),
    selection: tool.schema.discriminatedUnion("kind", [
      tool.schema.object({ kind: tool.schema.literal("round-robin") }),
      tool.schema.object({ kind: tool.schema.literal("pinned"), agentId: tool.schema.string().min(1).max(100) }),
    ]),
  });
  if (command === "pov") return tool.schema.object({ command: tool.schema.literal("pov"), prompt: tool.schema.string().min(1).max(8_000) });
  return tool.schema.object({ command: tool.schema.literal("poll"), question: tool.schema.string().min(1).max(500), options: tool.schema.array(tool.schema.string().min(1).max(500)).min(2).max(12) });
});

const unavailable = tool.schema.object({ command: tool.schema.literal("unavailable") });
const inputSchema = variants.length === 1 ? variants[0]! : variants.length > 1 ? tool.schema.discriminatedUnion("command", variants as never) : unavailable;

export default tool({
  description: "Run a server-owned room command using typed arguments. Only operations currently authorized for this room agent appear in the schema.",
  args: { input: inputSchema },
  async execute(args) {
    const endpoint = process.env.AMFAA_ROOM_COMMAND_URL;
    const token = process.env.AMFAA_ROOM_COMMAND_TOKEN;
    if (!endpoint || !token || !configured.length) throw new Error("Room commands are not available for this agent session.");
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ invocation: args.input, clientSubmissionId: `agent_command_${randomUUID()}` }),
    });
    if (!response.ok) throw new Error(`Room command returned ${response.status}.`);
    return JSON.stringify(await response.json(), null, 2);
  },
});
