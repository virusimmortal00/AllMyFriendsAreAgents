import express from "express";

type Mode = "success" | "hold" | "checkpoint-hold" | "collision" | "over-budget" | "failure" | "malformed";
interface Dispatch { sequence: number; investigationId: string; attempt: number; owner: string; mode: Mode; capabilities: string[]; excludedCapabilities: string[]; forbiddenProviderSessionIds: string[]; checkpoint: unknown; remainingBudget: { timeMs: number; tokenLimit: number; toolCallLimit: number }; receivedAt: string; aborted: boolean }
interface Pending { dispatch: Dispatch; response: express.Response }

const port = Number(process.env.AMFAA_CANARY_EXECUTOR_PORT || 54148);
const app = express(); app.use(express.json({ limit: "64kb" }));
let mode: Mode = "success"; let sequence = 0; const dispatches: Dispatch[] = []; const pending: Pending[] = [];
const result = (dispatch: Dispatch, body: Record<string, unknown>) => ({ providerSessionId: `canary-investigation-session-${dispatch.sequence}`, summary: `Canary result for ${dispatch.investigationId}`, evidenceRefs: body.evidenceRefs || [], unresolvedQuestions: ["Canary-only unresolved question"], usage: { tokens: 7, toolCalls: 1 } });

app.get("/health", (_request, response) => response.json({ ready: true, mode }));
app.get("/control/state", (_request, response) => response.json({ mode, dispatches, pending: pending.map(({ dispatch }) => ({ sequence: dispatch.sequence, investigationId: dispatch.investigationId, aborted: dispatch.aborted })) }));
app.post("/control/mode", (request, response) => { const candidate = request.body?.mode; if (!["success", "hold", "checkpoint-hold", "collision", "over-budget", "failure", "malformed"].includes(candidate)) return response.status(400).json({ error: "Unknown executor mode." }); mode = candidate; response.json({ mode }); });
app.post("/control/release", (request, response) => { const count = Math.max(1, Number(request.body?.count) || 1); const released: number[] = []; while (pending.length && released.length < count) { const item = pending.shift()!; if (!item.dispatch.aborted && !item.response.headersSent) item.response.json(result(item.dispatch, {})); released.push(item.dispatch.sequence); } response.json({ released, remaining: pending.length }); });
app.post("/v1/investigations", async (request, response) => {
  const body = request.body as Record<string, any>; const dispatch: Dispatch = { sequence: ++sequence, investigationId: String(body.investigationId || ""), attempt: Number(body.attempt || 0), owner: String(body.owner || ""), mode, capabilities: Array.isArray(body.capabilities) ? body.capabilities.map(String) : [], excludedCapabilities: Array.isArray(body.excludedCapabilities) ? body.excludedCapabilities.map(String) : [], forbiddenProviderSessionIds: Array.isArray(body.forbiddenProviderSessionIds) ? body.forbiddenProviderSessionIds.map(String) : [], checkpoint: body.checkpoint ?? null, remainingBudget: body.remainingBudget || {}, receivedAt: new Date().toISOString(), aborted: false }; dispatches.push(dispatch); request.once("aborted", () => { dispatch.aborted = true; }); response.once("close", () => { if (!response.writableEnded) dispatch.aborted = true; });
  if (mode === "failure") return response.status(503).json({ error: "Intentional canary provider failure." });
  if (mode === "malformed") return response.json({ providerSessionId: 4, summary: null });
  if (mode === "collision") return response.json({ ...result(dispatch, body), providerSessionId: dispatch.forbiddenProviderSessionIds[0] || "canary-collision-session" });
  if (mode === "over-budget") return response.json({ ...result(dispatch, body), usage: { tokens: Number(dispatch.remainingBudget.tokenLimit || 0) + 1, toolCalls: 0 } });
  if (mode === "checkpoint-hold") {
    const progress = body.progress as { url?: string; authorization?: string } | undefined;
    if (!progress?.url || !progress.authorization) return response.status(400).json({ error: "Checkpoint mode requires progress credentials." });
    const callback = await fetch(progress.url, { method: "POST", headers: { "content-type": "application/json", authorization: progress.authorization }, body: JSON.stringify({ state: "WAITING_TOOL", detail: "Canary executor is paused at a tool boundary.", checkpoint: { summary: "Canary durable checkpoint", opaqueState: `resume:${dispatch.sequence}` } }) });
    if (callback.status !== 202) return response.status(502).json({ error: `Progress callback returned ${callback.status}.` });
  }
  if (mode === "hold" || mode === "checkpoint-hold") { pending.push({ dispatch, response }); return; }
  return response.json(result(dispatch, body));
});

const server = app.listen(port, "127.0.0.1", () => process.stdout.write(`CANARY_EXECUTOR_READY http://127.0.0.1:${port}\n`));
const shutdown = () => server.close(() => process.exit(0)); process.once("SIGINT", shutdown); process.once("SIGTERM", shutdown);
