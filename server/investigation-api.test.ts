import type { AddressInfo } from "node:net";
import express from "express";
import { describe, expect, it, vi } from "vitest";
import { investigationRequestValidationError, projectInvestigation, registerInvestigationRoutes } from "./investigation-api.js";
import { INVESTIGATION_POLICY_VERSION, investigationProjectHash, type InvestigationRecord } from "./investigation-record.js";
import type { InvestigationProgressChannel, InvestigationService } from "./investigation-service.js";
import type { HumanPresenceRegistry } from "./human-presence.js";
import type { HumanTaskSessions } from "./task-api.js";

describe("investigation API boundary", () => {
  it("does not expose raw context, project identity, capabilities, checkpoint state, or provider session", () => {
    const job: InvestigationRecord = { schemaVersion: 1, investigationId: "investigation", revision: 3, owner: "codex-sol", objective: "Check", trigger: "Signal", signal: "AGENT_DECISION", evidenceRefs: [], contextSnapshot: "private room context", projectPathHash: investigationProjectHash("/secret/project"), policyRevision: 2, policyVersion: INVESTIGATION_POLICY_VERSION, capabilities: ["READ_PROJECT", "READ_OBSERVABILITY", "RUN_READ_ONLY_TESTS"], status: "CHECKPOINTED", budget: { timeMs: 1_000, tokenLimit: 10, toolCallLimit: 2, retryLimit: 0 }, usage: { elapsedMs: 5, tokens: 1, toolCalls: 1, attempts: 1 }, providerSessionId: "raw-provider-session", checkpoint: { schemaVersion: 1, attempt: 1, summary: "safe", opaqueState: "private-executor-state", createdAt: "2026-08-25T00:00:00Z", digest: "a".repeat(64) }, resultSummary: null, resultEvidence: [], unresolvedQuestions: [], resultWaiting: false, blocker: null, createdAt: "2026-08-25T00:00:00Z", startedAt: "2026-08-25T00:00:00Z", updatedAt: "2026-08-25T00:00:00Z", completedAt: null };
    const json = JSON.stringify(projectInvestigation(job)); expect(json).not.toMatch(/private room context|secret\/project|private-executor-state|raw-provider-session|READ_PROJECT/); expect(projectInvestigation(job)).toMatchObject({ providerSessionEstablished: true, checkpoint: { summary: "safe" } });
  });
  it("rejects malformed request shapes", () => { const valid = { owner: "codex-sol", objective: "bounded", trigger: "credible", evidenceRefs: [{ kind: "project_artifact", ref: "server/types.ts" }] }; expect(investigationRequestValidationError(valid)).toBeNull(); for (const input of [{ ...valid, owner: "attacker" }, { ...valid, objective: 4 }, { ...valid, evidenceRefs: "all" }, { ...valid, budget: { unknown: 4 } }]) expect(investigationRequestValidationError(input)).toMatch(/bounded owner/i); });
  it("does not let unauthenticated floods launch provider work and rejects forged progress tokens", async () => {
    const request = vi.fn(); const progress = vi.fn(async () => "unauthorized" as const); const app = express(); app.use(express.json()); registerInvestigationRoutes({ app, service: { request } as unknown as InvestigationService, progressChannel: { handleProgress: progress } as InvestigationProgressChannel, humans: { get: () => undefined } as unknown as HumanPresenceRegistry, sessions: { humanId: () => undefined } as unknown as HumanTaskSessions, broadcast() {} }); const server = app.listen(0); await new Promise<void>((resolve) => server.once("listening", resolve)); const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try { const responses = await Promise.all(Array.from({ length: 12 }, () => fetch(`${base}/api/investigations`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ owner: "codex-sol", objective: "burn quota", trigger: "forged" }) }))); expect(responses.every((response) => response.status === 401)).toBe(true); expect(request).not.toHaveBeenCalled(); const forged = await fetch(`${base}/api/investigation-executor/progress/job/1`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer forged" }, body: JSON.stringify({ state: "WAITING_TOOL" }) }); expect(forged.status).toBe(401); }
    finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  });
});
