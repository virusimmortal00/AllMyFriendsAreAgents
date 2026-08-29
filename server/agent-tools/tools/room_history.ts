import { tool, type ToolDefinition } from "@opencode-ai/plugin";

const roomHistoryTool: ToolDefinition = tool({
  description: "Retrieve exact verbatim room messages from durable history. Use this when a summary is insufficient or an older ruling/decision must be quoted exactly.",
  args: {
    after: tool.schema.string().max(200).optional().describe("Return messages after this message ID. Omit to start at the beginning."),
    limit: tool.schema.number().int().min(1).max(100).optional().describe("Maximum messages to return (default 50)."),
  },
  async execute(args) {
    const endpoint = process.env.AMFAA_ROOM_HISTORY_URL;
    const token = process.env.AMFAA_ROOM_HISTORY_TOKEN;
    if (!endpoint || !token) throw new Error("Room history is not configured for this agent process.");
    const url = new URL(endpoint);
    if (args.after) url.searchParams.set("after", args.after);
    url.searchParams.set("limit", String(args.limit || 50));
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
    if (!response.ok) throw new Error(`Room history returned ${response.status}.`);
    return JSON.stringify(await response.json(), null, 2);
  },
});

export default roomHistoryTool;
