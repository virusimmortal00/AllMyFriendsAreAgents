// Test-only HTTP observation. Persist only structural input and bounded errors.
import http from "node:http";
import { appendFileSync } from "node:fs";
const emit = http.Server.prototype.emit;
http.Server.prototype.emit = function (event, ...args) {
  if (event === "request") {
    const [request, response] = args;
    if (request.url === "/api/agent-tools/room-diagnostics") {
      let body = "", result = "";
      request.on("data", (chunk) => { if (body.length < 16_384) body += chunk.toString(); });
      const end = response.end;
      response.end = function (chunk, ...rest) { if (typeof chunk === "string" || Buffer.isBuffer(chunk)) result = String(chunk); return end.call(this, chunk, ...rest); };
      response.on("finish", () => {
        try {
          const input = JSON.parse(body).query || {}, error = JSON.parse(result).error;
          appendFileSync(process.env.AMFAA_LIVE_EVIDENCE, JSON.stringify({ kind: "diagnostics", status: response.statusCode,
            fields: ["window", "scope", "streams", "severities", "identity", "correlation", "limit", "cursor"].filter((key) => input[key] !== undefined),
            cursorPresent: Boolean(input.cursor), emptySelectors: ["identity", "correlation"].filter((key) => input[key] && Object.keys(input[key]).length === 0),
            error: ["invalid-query", "invalid-cursor", "forbidden", "record-too-large"].includes(error) ? error : null,
          }) + "\n", { mode: 0o600 });
        } catch { /* Do not retain unrecognized bodies. */ }
      });
    }
  }
  return emit.call(this, event, ...args);
};
