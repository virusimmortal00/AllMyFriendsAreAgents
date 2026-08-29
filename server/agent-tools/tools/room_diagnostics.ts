import { randomUUID } from "node:crypto";
import { tool, type ToolDefinition } from "@opencode-ai/plugin";

const streams = ["server-service-lifecycle", "opencode-harness", "openrouter-provider", "generations", "capability-decisions", "security-audit"] as const;

const roomDiagnosticsTool: ToolDefinition = tool({
  description: "Query bounded, server-authorized room diagnostics. The server fixes participant, room, project, time, count, byte, visibility, and redaction policy.",
  args: {
    window: tool.schema.enum(["last-15-minutes", "last-hour", "last-day"]),
    scope: tool.schema.enum(["self", "room", "project"]),
    streams: tool.schema.array(tool.schema.enum(streams)).min(1).max(streams.length).optional(),
    severities: tool.schema.array(tool.schema.enum(["debug", "info", "warn", "error"])).min(1).max(4).optional(),
    identity: tool.schema.object({
      agentId: tool.schema.string().min(1).max(200).optional(),
      generationId: tool.schema.string().min(1).max(200).optional(),
    }).optional(),
    correlation: tool.schema.object({
      correlationId: tool.schema.string().min(1).max(200).optional(),
      traceId: tool.schema.string().min(1).max(200).optional(),
      requestId: tool.schema.string().min(1).max(200).optional(),
    }).optional(),
    limit: tool.schema.number().int().min(1).max(50).optional(),
    cursor: tool.schema.string().min(1).max(2_000).optional(),
  },
  async execute(args) {
    const endpoint = process.env.AMFAA_ROOM_DIAGNOSTICS_URL;
    const token = process.env.AMFAA_ROOM_DIAGNOSTICS_TOKEN;
    if (!endpoint || !token) throw new Error("Room diagnostics are not available for this participant session.");
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: `room_diag_${randomUUID()}`, query: args }),
    });
    if (!response.ok) throw new Error(`Room diagnostics returned ${response.status}.`);
    return JSON.stringify(await response.json(), null, 2);
  },
});

export default roomDiagnosticsTool;
