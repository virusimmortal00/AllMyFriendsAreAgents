import { describe, expect, it, vi } from "vitest";
import { DEFAULT_PARTICIPANT_STYLES } from "../shared/chat-style.js";
import { runAgent } from "./agent-runner.js";
import type { CommandRuntime } from "./command-runtime.js";
import type { DiagnosticQueryResult } from "./diagnostics-query.js";
import type { ModelDiscoveryService } from "./model-discovery.js";
import { RoomCommandToolBroker } from "./room-command-tool.js";
import { RoomDiagnosticsToolBroker, type RoomDiagnosticsCapabilityBinding } from "./room-diagnostics-tool.js";
import type { RoomToolAttempt } from "./room-tool-attempt.js";
import type { RoomState } from "./types.js";

function fixture() {
  const epoch = `deployment-v1:${"a".repeat(64)}`;
  const state: RoomState = {
    messages: [], sessions: {}, status: "idle",
    roster: { schemaVersion: 3, revision: 1, entries: [{ agentId: "codex-sol", conversationalName: "Sol", providerId: "openai", modelId: "gpt-5.6-sol", enabled: true, configurationRevision: 1 }] },
    settings: { roomName: "Room", topic: "Lease transitions", writableAgent: "nobody", conversationEnergy: "balanced", projectPath: process.cwd(), participantStyles: structuredClone(DEFAULT_PARTICIPANT_STYLES) },
    deployment: { schemaVersion: 1, commitSha: "b".repeat(40), reference: { kind: "branch", name: "main" }, worktree: "clean", epoch, observedAt: "2026-09-08T00:00:00.000Z" },
  };
  const discovery = { discover: async () => ({ status: "available", discoveredAt: "2026-09-08T00:00:00.000Z", runtime: { version: "1.18.25-amfaa.2", compatible: true, distribution: "downstream" }, models: [{ providerId: "openai", modelId: "gpt-5.6-sol", displayName: "Fixture model", provenance: "opencode-catalog" }] }) } as unknown as ModelDiscoveryService;
  const submit = vi.fn(async () => ({ kind: "private-help", commands: ["help"] }));
  const command = new RoomCommandToolBroker({ submit } as unknown as CommandRuntime);
  let binding: RoomDiagnosticsCapabilityBinding = { effective: true, participantId: "codex-sol", roomId: "room-one", projectId: "project-one", manifestRevision: 1, caller: { principalId: "codex-sol", selfId: "codex-sol", roomIds: ["room-one"], projectIds: ["project-one"], operator: false }, allowedScopes: ["self", "room"] };
  const query = vi.fn(async (): Promise<DiagnosticQueryResult> => ({ records: [], chunks: [], nextCursor: null, scannedBytes: 0, serializedBytes: 200, malformedRecords: 0, scanLimitReached: false }));
  const diagnostics = new RoomDiagnosticsToolBroker({ query }, () => binding);
  const issued: { attempt: RoomToolAttempt; command: string; diagnostics: string }[] = [];
  const controller = new AbortController();
  const commandInput = { invocation: { command: "help" as const }, clientSubmissionId: "attempt-help-0001" };
  const diagnosticsInput = { requestId: "attempt-diagnostics-0001", query: { window: "last-hour", scope: "room" } };
  const use = async (lease = issued.at(-1)!) => [await command.execute(lease.command, commandInput), await diagnostics.execute(lease.diagnostics, diagnosticsInput)];
  const invalidations = vi.fn(async (agent: string) => { delete state.sessions[agent]; });
  const run = (execute: () => Promise<void>, accepted = true, failPreparation = false) => runAgent("codex-sol", state, "Answer once.", false, undefined, controller.signal, undefined, undefined, { invalidate: invalidations }, undefined, undefined, undefined, discovery, {
    refreshScopedTools: (attempt) => {
      const commandToken = command.issue({ agentId: "codex-sol", displayName: "Sol", attempt, allowedCommands: ["help"], roomId: "room-one" });
      const diagnosticsToken = diagnostics.issue("codex-sol", attempt)!;
      issued.push({ attempt, command: commandToken, diagnostics: diagnosticsToken });
      if (failPreparation) throw new Error("fixture preparation failure");
      return { commandTool: { url: "http://127.0.0.1/command", token: commandToken, allowedCommands: ["help"], guide: "Room commands" }, diagnosticsTool: { url: "http://127.0.0.1/diagnostics", token: diagnosticsToken } };
    },
    structuredTransport: { run: async () => {
      await execute();
      return { sessionId: "replacement-provider-session", messageId: "fixture-message", structured: { schemaVersion: 1, action: "speak", messages: ["Done."], conversationState: "settled" }, finish: "stop", cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } };
    } },
  }, { onGenerationStart: async () => accepted });
  const stored = { id: "prior-provider-session", permission: "read-only" as const, codeEpoch: epoch, configurationFingerprint: JSON.stringify({ providerId: "openai", modelId: "gpt-5.6-sol" }) };
  return { state, stored, command, diagnostics, issued, use, run, submit, query, invalidations, controller, revokeCapability: () => { binding = { ...binding, effective: false }; } };
}

describe("room tool generation-attempt lifetime", () => {
  it.each(["first", "reuse", "deployment", "configuration", "permission", "missing-session"] as const)("keeps both tools usable through %s session transition and retires every lease on completion", async (mode) => {
    const api = fixture();
    if (mode !== "first") api.state.sessions["codex-sol"] = { ...api.stored,
      ...(mode === "deployment" ? { codeEpoch: "older-epoch" } : {}),
      ...(mode === "configuration" ? { configurationFingerprint: "older-model" } : {}),
      ...(mode === "permission" ? { permission: "writable" as const } : {}),
    };
    let invocations = 0;
    const result = await api.run(async () => {
      invocations++;
      if (mode === "missing-session" && invocations === 1) {
        expect((await api.use()).every(Boolean)).toBe(true);
        throw new Error("session prior-provider-session not found");
      }
      if (invocations === 2) {
        expect(await api.use(api.issued[0])).toEqual([undefined, undefined]);
        expect(api.issued[0].attempt.isActive()).toBe(false);
      }
      // Persisting a replacement session must not change attempt authority.
      api.state.sessions["codex-sol"] = { ...api.stored, id: "replacement-provider-session" };
      expect((await api.use()).every(Boolean)).toBe(true);
      expect((await api.use()).every(Boolean)).toBe(true);
    });
    expect(api.submit).toHaveBeenCalledTimes(invocations);
    expect(api.query).toHaveBeenCalledTimes(invocations);
    expect(api.invalidations).toHaveBeenCalledTimes(["first", "reuse"].includes(mode) ? 0 : 1);
    expect(api.issued.map(({ attempt }) => attempt.attemptOrdinal)).toEqual(mode === "missing-session" ? [1, 2] : [1]);
    for (const lease of api.issued) {
      expect(lease.attempt.generationId).toBe(result.generationId);
      expect(lease.attempt.isActive()).toBe(false);
      expect(await api.use(lease)).toEqual([undefined, undefined]);
    }
    expect(api.command.snapshot("codex-sol")).toMatchObject({ present: false, status: "revoked" });
    const audit = JSON.stringify([api.command.audit(), api.diagnostics.audit()]);
    expect(audit).toContain(result.generationId);
    expect(audit).not.toMatch(/prior-provider-session|replacement-provider-session|http:\/\//);
    for (const lease of api.issued) { expect(audit).not.toContain(lease.command); expect(audit).not.toContain(lease.diagnostics); }
  });

  it("denies cached calls immediately on cancellation", async () => {
    const api = fixture();
    await api.run(async () => {
      expect((await api.use()).every(Boolean)).toBe(true);
      api.controller.abort();
      expect(await api.use()).toEqual([undefined, undefined]);
    });
    expect(api.submit).toHaveBeenCalledTimes(1);
    expect(api.query).toHaveBeenCalledTimes(1);
  });

  it("retires leases after provider failure and a refused generation reservation", async () => {
    for (const accepted of [true, false]) {
      const api = fixture();
      await expect(api.run(async () => { throw new Error("fixture provider failure"); }, accepted)).rejects.toThrow();
      expect(await api.use()).toEqual([undefined, undefined]);
      expect(api.issued[0].attempt.isActive()).toBe(false);
    }
  });

  it("does not reactivate completed leases when the same participant starts another generation", async () => {
    const api = fixture();
    await api.run(async () => { expect((await api.use()).every(Boolean)).toBe(true); });
    const old = api.issued[0];
    await api.run(async () => {
      expect(api.issued.at(-1)!.attempt.generationId).not.toBe(old.attempt.generationId);
      expect(await api.use(old)).toEqual([undefined, undefined]);
      expect((await api.use()).every(Boolean)).toBe(true);
    });
    expect(api.submit).toHaveBeenCalledTimes(2);
    expect(api.query).toHaveBeenCalledTimes(2);
  });

  it("rechecks queued command authority and coalesces concurrent identical requests before runtime resolution", async () => {
    for (const cancelled of [false, true]) {
      let active = true;
      let resolve!: (runtime: CommandRuntime) => void;
      const pending = new Promise<CommandRuntime>((done) => { resolve = done; });
      const resolver = vi.fn(() => pending);
      const submit = vi.fn(async () => ({ kind: "accepted" }));
      const broker = new RoomCommandToolBroker(resolver);
      const token = broker.issue({ agentId: "codex-sol", displayName: "Sol", roomId: "room-one", allowedCommands: ["help"], attempt: { agentId: "codex-sol", generationId: "fixture-generation", attemptOrdinal: 1, isActive: () => active } });
      const input = { invocation: { command: "help" as const }, clientSubmissionId: "queued-request-0001" };
      const first = broker.execute(token, input);
      const replay = broker.execute(token, input);
      await Promise.resolve();
      active = !cancelled;
      resolve({ submit } as unknown as CommandRuntime);
      expect(await first).toEqual(cancelled ? undefined : { kind: "accepted" });
      expect(await replay).toEqual(cancelled ? undefined : { kind: "accepted" });
      expect(resolver).toHaveBeenCalledTimes(1);
      expect(submit).toHaveBeenCalledTimes(cancelled ? 0 : 1);
    }
  });

  it("retires prepared leases when startup fails before generation activation", async () => {
    const api = fixture();
    await expect(api.run(async () => undefined, true, true)).rejects.toThrow("fixture preparation failure");
    expect(await api.use()).toEqual([undefined, undefined]);
    expect(api.submit).not.toHaveBeenCalled();
    expect(api.query).not.toHaveBeenCalled();
  });

  it("keeps current diagnostics capability enforcement within an active attempt", async () => {
    const api = fixture();
    await api.run(async () => {
      expect((await api.use()).every(Boolean)).toBe(true);
      api.revokeCapability();
      const result = await api.use();
      expect(result[0]).toBeDefined();
      expect(result[1]).toBeUndefined();
    });
    expect(api.query).toHaveBeenCalledTimes(1);
  });
});
