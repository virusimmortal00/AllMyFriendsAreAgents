import { randomUUID } from "node:crypto";
import { tool, type ToolDefinition } from "@opencode-ai/plugin";

const streams = ["server-service-lifecycle", "opencode-harness", "openrouter-provider", "generations", "capability-decisions", "security-audit"] as const;

const roomDiagnosticsTool: ToolDefinition = tool({
  description: "Query bounded, server-authorized room diagnostics. Start with only window and scope; omit optional filters unless needed (or use null when a field must be supplied). Never invent identities, correlations, or cursors. The server fixes participant, room, project, time, count, byte, visibility, and redaction policy.",
  args: {
    window: tool.schema.enum(["last-15-minutes", "last-hour", "last-day"]),
    scope: tool.schema.enum(["self", "room", "project"]),
    streams: tool.schema.array(tool.schema.enum(streams)).min(1).max(streams.length).nullish(),
    severities: tool.schema.array(tool.schema.enum(["debug", "info", "warn", "error"])).min(1).max(4).nullish(),
    identity: tool.schema.object({
      agentId: tool.schema.string().min(1).max(200).nullish(),
      generationId: tool.schema.string().min(1).max(200).nullish(),
    }).nullish(),
    correlation: tool.schema.object({
      correlationId: tool.schema.string().min(1).max(200).nullish(),
      traceId: tool.schema.string().min(1).max(200).nullish(),
      requestId: tool.schema.string().min(1).max(200).nullish(),
    }).nullish(),
    limit: tool.schema.number().int().min(1).max(50).nullish(),
    cursor: tool.schema.string().min(1).max(2_000).nullish().describe("Omit or use null on the first query. For pagination, copy nextCursor exactly from this tool's previous response in the current turn and keep the same query filters. Never invent a cursor."),
  },
  async execute(args) {
    const endpoint = process.env.AMFAA_ROOM_DIAGNOSTICS_URL;
    const token = process.env.AMFAA_ROOM_DIAGNOSTICS_TOKEN;
    if (!endpoint || !token) throw new Error("Room diagnostics are not available for this participant session.");
    const query = JSON.parse(JSON.stringify(args, (_key, value) => value === null ? undefined : value));
    for (const key of ["identity", "correlation"]) {
      if (query[key] && Object.keys(query[key]).length === 0) delete query[key];
    }
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: `room_diag_${randomUUID()}`, query }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      if (response.status === 400 && body?.error === "invalid-cursor") {
        throw new Error("Room diagnostics rejected the cursor. Start a new query without cursor, or copy nextCursor from a successful response in this turn and keep the same filters.");
      }
      throw new Error(`Room diagnostics returned ${response.status}.`);
    }
    return JSON.stringify(await response.json(), null, 2);
  },
});

export default roomDiagnosticsTool;
