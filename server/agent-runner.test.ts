import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { AIM_5_COLOR_PALETTE, DEFAULT_PARTICIPANT_STYLES } from "../shared/chat-style.js";
import { AgentProcessSupervisor, __testing, runAgent } from "./agent-runner.js";
import { roomCommandGuide } from "../shared/command-domain.js";
import { ProviderInvocationError, providerFailureCode, providerRetryAfterMs } from "./provider-failure.js";
import type { ModelDiscoveryService } from "./model-discovery.js";
import type { RoomState } from "./types.js";
import { parseAgentTurn } from "./conversation.js";

const execFileAsync = promisify(execFile);

describe("OpenCode runtime contract", () => {
  it("builds resumable OpenCode invocations", () => {
    expect(__testing.opencodeArgs("read-only", "/tmp/project")).toEqual([
      "run", "--format", "json", "--dir", "/tmp/project", "--agent", "plan",
    ]);
    expect(__testing.opencodeArgs("writable", "/tmp/worktree", "ses_123")).toEqual([
      "run", "--format", "json", "--dir", "/tmp/worktree", "--agent", "build", "--auto", "--session", "ses_123",
    ]);
    expect(__testing.opencodeArgs("read-only", "/tmp/project", "ses_456", "anthropic/claude-sonnet", "high")).toEqual([
      "run", "--format", "json", "--dir", "/tmp/project", "--agent", "plan", "--model", "anthropic/claude-sonnet", "--variant", "high", "--session", "ses_456",
    ]);
  });

  it("keeps separate completed text parts separate when identity is unavailable", () => {
    expect(__testing.parseOpenCodeOutput([
      JSON.stringify({ type: "step_start", sessionID: "ses_open", part: { type: "step-start" } }),
      JSON.stringify({ type: "text", sessionID: "ses_open", part: { type: "text", text: "One " } }),
      "non-protocol progress",
      JSON.stringify({ type: "text", sessionID: "ses_open", part: { type: "text", text: "answer." } }),
    ].join("\n"))).toMatchObject({ sessionId: "ses_open", text: "One \n\nanswer.", cost: 0, toolCalls: 0, steps: 0, errors: [] });
  });

  it("preserves source-audited message and part boundaries through room delivery", async () => {
    const fixture = JSON.parse(await readFile(new URL("./fixtures/opencode-completed-text-parts.json", import.meta.url), "utf8"));
    const contract = JSON.parse(await readFile(new URL("../integration-contracts/opencode.json", import.meta.url), "utf8"));
    expect(fixture.provenance.commit).toBe(contract.upstream.auditedCommit);
    expect(fixture.provenance.tag).toBe(contract.upstream.auditedTag);
    expect(contract.review.paths).toEqual(expect.arrayContaining(fixture.provenance.paths));
    const parsed = __testing.parseOpenCodeOutput(fixture.events.map((event: unknown) => JSON.stringify(event)).join("\n"));
    expect(parsed).toMatchObject({
      text: 'Plan mode is active. This is not a coding task.\n\nThe answer is a map.\n\nTURN_DISPOSITION: {"action":"speak"}\n\nCONVERSATION_STATE: SETTLED',
      toolCalls: 2, steps: 3, finishReason: "stop",
    });
    expect(parseAgentTurn("codex-sol", parsed.text)).toMatchObject({
      visibleMessages: ["The answer is a map."], disposition: "speak", conversationState: "settled",
    });
  });

  it("replaces repeated completed snapshots in place without merging distinct identities", () => {
    const textEvent = (messageID: string, id: string, text: string, sessionID = "ses_example") => JSON.stringify({
      type: "text", sessionID, part: { type: "text", sessionID, messageID, id, text, time: { start: 1, end: 2 } },
    });
    const parsed = __testing.parseOpenCodeOutput([
      textEvent("msg_first", "prt_first", "First."),
      textEvent("msg_first", "prt_second", "Second."),
      textEvent("msg_second", "prt_first", "Second."),
      textEvent("msg_first", "prt_first", "Updated first."),
      textEvent("msg_first", "prt_first", "Updated first."),
      textEvent("msg_first", "prt_first", "Other session.", "ses_other"),
    ].join("\n"));
    expect(parsed.text).toBe("Updated first.\n\nSecond.\n\nSecond.\n\nOther session.");
  });

  it("does not treat deltas, reasoning, tool output, or malformed text as completed chat", () => {
    const parsed = __testing.parseOpenCodeOutput([
      "progress", "null", "{broken",
      JSON.stringify({ type: "text", part: { type: "text", text: { value: "Not text" } } }),
      JSON.stringify({ type: "text", part: { type: "text", text: "Incomplete", time: { start: 1 } } }),
      JSON.stringify({ type: "text", part: { type: "text", text: "Bad time", time: null } }),
      JSON.stringify({ type: "message.part.delta", properties: { delta: "A delta" } }),
      JSON.stringify({ type: "reasoning", part: { type: "reasoning", text: "Reasoning is not room chat." } }),
      JSON.stringify({ type: "tool_use", part: { type: "tool", state: { status: "completed", output: "Tool output" } } }),
      JSON.stringify({ type: "text", part: { type: "text", text: "[aside] Ordinary chat." } }),
    ].join("\n"));
    expect(parsed.text).toBe("[aside] Ordinary chat.");
  });

  it("preserves content on both sides of a tool without requiring a terminal-only answer", () => {
    const parts = ["A useful first observation.\nA second line.", "A useful follow-up."];
    const events = parts.map((text, index) => ({
      type: "text", sessionID: "ses_example", part: { type: "text", messageID: `msg_${index}`, id: `prt_${index}`, text },
    }));
    const stdout = [
      JSON.stringify(events[0]),
      JSON.stringify({ type: "tool_use", part: { type: "tool", state: { status: "completed" } } }),
      JSON.stringify(events[1]),
    ].join("\n");
    const parsed = __testing.parseOpenCodeOutput(stdout);
    expect(parsed.text).toBe(parts.join("\n\n"));
    expect(parseAgentTurn("codex-sol", parsed.text).visibleMessages).toEqual([parts.join("\n\n")]);
  });

  it("uses separate-part fallback for incomplete or malformed identity without dropping chat", () => {
    const stdout = [
      { id: "prt_shared", messageID: "msg_shared" },
      { id: "prt_shared", messageID: "msg_shared" },
      { id: "prt_shared", messageID: 17, sessionID: "ses_example" },
      { id: "prt_shared", messageID: 17, sessionID: "ses_example" },
    ].map((identity) => JSON.stringify({ type: "text", part: { ...identity, type: "text", text: "Same text." } })).join("\n");
    expect(__testing.parseOpenCodeOutput(stdout).text).toBe(Array(4).fill("Same text.").join("\n\n"));
  });

  it("lets an empty completed snapshot replace earlier text without leaving a phantom paragraph", () => {
    const stdout = ["Old text.", ""].map((text) => JSON.stringify({
      type: "text", sessionID: "ses_example", part: { type: "text", messageID: "msg_example", id: "prt_example", text },
    })).join("\n");
    expect(__testing.parseOpenCodeOutput(stdout).text).toBe("");
  });

  it.each([
    { directive: undefined, expected: ["A useful answer."] },
    { directive: 'TURN_DISPOSITION: {"action":"speak"}', expected: ["A useful answer."] },
    { directive: 'TURN_DISPOSITION: {"action":"yield","reason":"already_covered"}', expected: [] },
    { directive: "TURN_DISPOSITION: {not-json}", expected: [] },
    { directive: 'TURN_DISPOSITION: {"action":"speak"}\nTURN_DISPOSITION: {"action":"speak"}', expected: [] },
  ])("retains disposition compatibility for a separate tool-free part: $directive", ({ directive, expected }) => {
    const parts = ["A useful answer.", directive].filter((text) => text !== undefined);
    const stdout = parts.map((text, index) => JSON.stringify({
      type: "text", sessionID: "ses_example",
      part: { type: "text", id: `prt_${index}`, messageID: "msg_example", text, time: { start: 1, end: 2 } },
    })).join("\n");
    expect(parseAgentTurn("codex-sol", __testing.parseOpenCodeOutput(stdout).text).visibleMessages).toEqual(expected);
  });

  it("extracts bounded provider usage, tool, finish, and error diagnostics", () => {
    const parsed = __testing.parseOpenCodeOutput([
      JSON.stringify({ type: "tool_use", sessionID: "ses_open", part: { id: "part-1", callID: "call-1", type: "tool", tool: "read", state: { status: "completed" } } }),
      JSON.stringify({ type: "tool_use", sessionID: "ses_open", part: { id: "part-2", callID: "call-2", type: "tool", tool: "grep", state: { status: "error" } } }),
      JSON.stringify({ type: "step_finish", sessionID: "ses_open", part: { type: "step-finish", reason: "tool-calls", cost: 0.01, tokens: { total: 15, input: 10, output: 3, reasoning: 2, cache: { read: 4, write: 1 } } } }),
      JSON.stringify({ type: "step_finish", sessionID: "ses_open", part: { type: "step-finish", reason: "stop", cost: 0.02, tokens: { input: 7, output: 5, reasoning: 0, cache: { read: 2, write: 0 } } } }),
      JSON.stringify({ type: "error", sessionID: "ses_open", error: { name: "APIError", data: { message: "Bearer provider-secret-value failed", statusCode: 429, isRetryable: true, responseBody: "not retained" } } }),
    ].join("\n"));

    expect(parsed).toMatchObject({
      sessionId: "ses_open",
      usage: { inputTokens: 17, outputTokens: 8, reasoningTokens: 2, cacheReadTokens: 6, cacheWriteTokens: 1, totalTokens: 27 },
      cost: 0.03,
      toolCalls: 2,
      toolFailures: 1,
      steps: 2,
      finishReason: "stop",
      errors: [{ name: "APIError", message: "[redacted] failed", statusCode: 429, retryable: true }],
    });
  });

  it("reduces provider response bodies to allowlisted classification codes", () => {
    expect(providerFailureCode(JSON.stringify({ type: "error", error: { code: "insufficient_quota", message: "private account detail" } }))).toBe("insufficient_quota");
    expect(providerFailureCode(JSON.stringify({ type: "error", error: { type: "GoUsageLimitError" }, metadata: { workspace: "wrk_private" } }))).toBe("account_rate_limit");
    expect(providerFailureCode(JSON.stringify({ error: { code: "unknown", credential: "secret" } }))).toBeUndefined();

    const parsed = __testing.parseOpenCodeOutput(JSON.stringify({
      type: "error",
      sessionID: "ses_private",
      error: { name: "APIError", data: { message: "Quota exceeded", isRetryable: false, responseBody: JSON.stringify({ type: "error", error: { code: "insufficient_quota", account: "private" } }) } },
    }));
    expect(parsed.errors).toEqual([{ source: "opencode", name: "APIError", message: "Quota exceeded", retryable: false, code: "insufficient_quota" }]);
    const error = new ProviderInvocationError(parsed.errors[0]);
    expect(error).not.toHaveProperty("process");
    expect(error.message).toBe("Provider invocation failed.");
    expect(Object.keys(error)).not.toContain("failure");
  });

  it("reduces Retry-After headers to bounded timing without retaining headers", () => {
    const now = Date.parse("2026-08-27T12:00:00.000Z");
    expect(providerRetryAfterMs({ "retry-after-ms": "2500", authorization: "private" }, now)).toBe(2_500);
    expect(providerRetryAfterMs({ "Retry-After": "120" }, now)).toBe(120_000);
    expect(providerRetryAfterMs({ "retry-after": "Thu, 27 Aug 2026 12:05:00 GMT" }, now)).toBe(300_000);
    expect(providerRetryAfterMs({ "retry-after": "invalid", authorization: "private" }, now)).toBeUndefined();

    const parsed = __testing.parseOpenCodeOutput(JSON.stringify({
      type: "error",
      error: { name: "APIError", data: { message: "Rate limited", statusCode: 429, isRetryable: true, responseHeaders: { "retry-after": "90", authorization: "private" } } },
    }));
    expect(parsed.errors).toEqual([{ source: "opencode", name: "APIError", message: "Rate limited", statusCode: 429, retryable: true, retryAfterMs: 90_000 }]);
    expect(JSON.stringify(parsed.errors)).not.toMatch(/authorization|private|responseHeaders/i);
  });

  it("maps room permissions without replacing OpenCode provider configuration", () => {
    const environment = { PATH: "/bin", OPENCODE_CONFIG: "/tmp/config" };
    expect(__testing.opencodeEnvironment(environment, "read-only")).toMatchObject({
      OPENCODE_CONFIG: "/tmp/config",
      OPENCODE_PERMISSION: JSON.stringify({
        "*": "deny", read: "allow", glob: "allow", grep: "allow", list: "allow",
        webfetch: "allow", websearch: "allow", lsp: "allow", StructuredOutput: "allow", room_history: "allow", room_command: "deny", room_diagnostics: "deny",
      }),
    });
    expect(__testing.opencodeEnvironment(environment, "writable")).toBe(environment);
  });

  it("does not resume model-compatible sessions without deployment provenance", () => {
    const codex = { agentId: "codex-sol", conversationalName: "Sol", providerId: "openai", modelId: "gpt-5.6-sol", enabled: true, configurationRevision: 1 };
    const openCode = { agentId: "opencode-configured", conversationalName: "OpenCode", modelId: "configured", enabled: true, configurationRevision: 1 };
    const unversioned = { id: "legacy", permission: "read-only" as const };
    expect(__testing.resumableOpenCodeSession("codex-sol", codex, unversioned, "read-only")).toBeUndefined();
    expect(__testing.resumableOpenCodeSession("opencode-configured", openCode, unversioned, "read-only")).toBeUndefined();
    const fingerprinted = { ...unversioned, configurationFingerprint: JSON.stringify({ harness: "opencode", providerId: "openai", modelId: "gpt-5.6-sol" }) };
    expect(__testing.resumableOpenCodeSession("codex-sol", codex, fingerprinted, "read-only")).toBeUndefined();
  });

  it("reuses only same-epoch sessions and invalidates changed or pre-migration epochs", () => {
    const participant = { agentId: "agent-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", conversationalName: "Alpha", providerId: "openai", modelId: "gpt-5.6-sol", enabled: true, configurationRevision: 1 };
    const fingerprint = JSON.stringify({ providerId: "openai", modelId: "gpt-5.6-sol" });
    const deployment = { schemaVersion: 1 as const, commitSha: "a".repeat(40), reference: { kind: "branch" as const, name: "main" }, worktree: "clean" as const, epoch: `deployment-v1:${"b".repeat(64)}`, observedAt: "2026-08-26T00:00:00.000Z" };
    const matching = { id: "same-epoch", permission: "read-only" as const, configurationFingerprint: fingerprint, codeEpoch: deployment.epoch };
    const changed = { ...matching, id: "old-epoch", codeEpoch: `deployment-v1:${"c".repeat(64)}` };
    const legacy = { id: "legacy", permission: "read-only" as const, configurationFingerprint: fingerprint };

    expect(__testing.openCodeSessionDecision(participant.agentId, participant, matching, "read-only", deployment)).toMatchObject({ kind: "reuse", session: matching, reason: expect.stringContaining("deployment code epoch match") });
    expect(__testing.openCodeSessionDecision(participant.agentId, participant, changed, "read-only", deployment)).toEqual({ kind: "invalidate", reason: "deployment code epoch changed" });
    expect(__testing.openCodeSessionDecision(participant.agentId, participant, legacy, "read-only", deployment)).toEqual({ kind: "invalidate", reason: "persisted session predates deployment epoch binding" });
    expect(__testing.openCodeSessionDecision(participant.agentId, participant, { ...matching, id: "legacy-writer", permission: "writable" }, "read-only", deployment)).toEqual({ kind: "invalidate", reason: "permission changed from writable to read-only" });
  });

  it("rejects migrated confirmations and unavailable models before invoking OpenCode", async () => {
    const participant = { agentId: "agent-55555555-5555-4555-8555-555555555555", conversationalName: "Alpha", providerId: "openai", modelId: "gpt-5.6", enabled: true, supportsProjectWrites: true, configurationRevision: 1 };
    const state = {
      messages: [], sessions: {}, roster: { schemaVersion: 3 as const, revision: 1, entries: [participant] },
      settings: { roomName: "Room", topic: "Topic", writableAgent: "nobody" as const, conversationEnergy: "balanced" as const, projectPath: process.cwd(), participantStyles: structuredClone(DEFAULT_PARTICIPANT_STYLES) }, status: "idle" as const,
    };
    await expect(runAgent(participant.agentId, { ...state, roster: { ...state.roster, entries: [{ ...participant, selectionConfirmationRequired: true, sessionInvalidationReason: "Confirm selection." }] } }, "Join if useful.")).rejects.toThrow("Confirm selection.");
    const unavailable = { discover: async () => ({ status: "available" as const, models: [], discoveredAt: new Date(0).toISOString() }) } as unknown as ModelDiscoveryService;
    await expect(runAgent(participant.agentId, state, "Join if useful.", false, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, unavailable)).rejects.toThrow("selected OpenCode model is no longer available");
  });

  it("recognizes stale OpenCode sessions without treating provider failures as recoverable", () => {
    expect(__testing.isMissingOpenCodeSessionError(new Error("session ses_old not found"))).toBe(true);
    expect(__testing.isMissingOpenCodeSessionError(new Error("provider request timed out"))).toBe(false);
  });

  it("uses the structured SDK lane only for an approved downstream read-only runtime", async () => {
    const participant = { agentId: "codex-sol" as const, conversationalName: "Sol", providerId: "openai", modelId: "gpt-5.6-sol", enabled: true, configurationRevision: 1 };
    const state = {
      messages: [], sessions: {}, roster: { schemaVersion: 3 as const, revision: 1, entries: [participant] },
      settings: { roomName: "Room", topic: "Structured turns", writableAgent: "nobody" as const, conversationEnergy: "balanced" as const, projectPath: process.cwd(), participantStyles: structuredClone(DEFAULT_PARTICIPANT_STYLES) }, status: "idle" as const,
    } satisfies RoomState;
    const discovery = { discover: async () => ({
      status: "available" as const,
      discoveredAt: "2026-09-01T00:00:00.000Z",
      runtime: { version: "1.18.25-amfaa.1", compatible: true, distribution: "downstream" as const, protocol: "opencode-cli-jsonl-v1" as const, capabilities: ["verbose-model-catalog", "jsonl-events", "variant-selection"] as const },
      models: [{ providerId: "openai", modelId: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", provenance: "opencode-catalog" as const }],
    }) } as unknown as ModelDiscoveryService;
    const structuredTransport = { run: vi.fn(async (input) => ({
      sessionId: "ses_structured",
      messageId: "msg_structured",
      structured: { schemaVersion: 1 as const, action: "speak" as const, messages: ["A typed answer."], conversationState: "settled" as const },
      finish: "stop",
      cost: 0,
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      input,
    })) };

    const result = await runAgent("codex-sol", state, "Answer once.", false, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, discovery, { structuredTransport });

    expect(result).toMatchObject({ sessionId: "ses_structured", text: "A typed answer.", structuredTurn: { action: "speak" } });
    const invocation = structuredTransport.run.mock.calls[0][0];
    expect(invocation).toMatchObject({ providerId: "openai", modelId: "gpt-5.6-sol", agent: "plan" });
    expect(invocation.prompt).toContain("Return only the requested structured room-turn object");
    expect(invocation.prompt).not.toContain("<<<NEXT>>>");
    expect(invocation.prompt).not.toContain("TURN_DISPOSITION:");
  });
});

describe("agent permissions", () => {
  const state = {
    messages: [],
    sessions: {},
    settings: {
      roomName: "The Agent Room",
      topic: "Open conversation",
      writableAgent: "codex-sol",
      conversationEnergy: "balanced",
      projectPath: "/tmp/project",
      participantStyles: structuredClone(DEFAULT_PARTICIPANT_STYLES),
    },
    status: "idle",
  } satisfies RoomState;

  it("keeps explicit review turns read-only", () => {
    expect(__testing.resolvePermission("codex-sol", state, true, "/tmp/worktree")).toBe("read-only");
  });

  it("keeps ordinary room turns read-only even with a legacy write selection and assignment workspace", () => {
    expect(__testing.resolvePermission("codex-sol", state, false, "/tmp/worktree")).toBe("read-only");
    expect(__testing.resolvePermission("claude-sonnet", state, false, "/tmp/worktree")).toBe("read-only");
    expect(__testing.resolvePermission("codex-sol", state, false)).toBe("read-only");
  });

  it("does not let a dynamic legacy selection change the room lane", () => {
    const cursorState = { ...state, settings: { ...state.settings, writableAgent: "cursor-grok" as const } };
    expect(__testing.resolvePermission("cursor-grok", cursorState, false, "/tmp/worktree")).toBe("read-only");
    expect(__testing.resolvePermission("cursor-grok", cursorState, true, "/tmp/worktree")).toBe("read-only");
  });
});

describe("room prompt context", () => {
  const state = {
    messages: [
      { id: "old", speaker: "you", humanId: "alice-id", speakerName: "Alice", text: "Please review the implementation.", timestamp: "2026-08-19T12:00:00.000Z", kind: "chat" },
      { id: "topic", speaker: "system", text: "Room topic: Weekend cooking", timestamp: "2026-08-19T12:01:00.000Z", kind: "topic" },
      { id: "new", speaker: "you", humanId: "bob-id", speakerName: "Bob", text: "What should we make?", timestamp: "2026-08-19T12:02:00.000Z", kind: "chat" },
    ],
    sessions: {},
    settings: {
      roomName: "The Agent Room",
      topic: "Weekend cooking",
      writableAgent: "nobody",
      conversationEnergy: "balanced",
      projectPath: process.cwd(),
      participantStyles: structuredClone(DEFAULT_PARTICIPANT_STYLES),
    },
    status: "idle",
    humans: [
      { id: "alice-id", name: "Alice", style: DEFAULT_PARTICIPANT_STYLES.you },
      { id: "bob-id", name: "Bob", style: { ...DEFAULT_PARTICIPANT_STYLES.you, textColor: "#ed36ff" } },
    ],
  } satisfies RoomState;

  it("keeps ordinary chat casual and scoped to the latest topic", async () => {
    const prompt = await __testing.buildPrompt("codex-sol", state, "Join if useful.", false, "read-only");

    expect(prompt).toContain("ROOM THEME\nWeekend cooking");
    expect(prompt).toContain("ROOM NAME\nThe Agent Room");
    expect(prompt).toContain("What should we make?");
    expect(prompt).toContain("NO_RESPONSE_NEEDED");
    expect(prompt).toContain("Output only the chat message participants should see");
    expect(prompt).toContain("Never narrate your reasoning about system instructions");
    expect(prompt).toContain("separate it with <<<NEXT>>>");
    expect(prompt).toContain("Use at most 3 messages and usually 1");
    expect(prompt).toContain("Do not split a single sentence merely for effect");
    expect(prompt).toContain("Do not output Unicode emoji");
    expect(prompt).toContain(":-), :-!, :-[, O:-)");
    expect(prompt).toContain("not every message is addressed to everyone");
    expect(prompt).toContain("Do not assume that \"you\" or \"your\" refers to you");
    expect(prompt).toContain("frame it as a side reaction rather than answering as though you were addressed");
    expect(prompt).toContain("do not apologize, agree to comply, accept the correction");
    expect(prompt).toContain("make your observer perspective unmistakable");
    expect(prompt).toContain("only messages labeled [SOL] are your own history");
    expect(prompt).toContain("including agents from the same provider");
    expect(prompt).toContain('Before using continuity language such as "still," "as I said," or "my earlier point,"');
    expect(prompt).not.toContain("CURRENT PARTICIPANT STYLES");
    expect(prompt).not.toContain(`Alice: ${JSON.stringify(state.humans[0].style)}`);
    expect(prompt).not.toContain(`Bob: ${JSON.stringify(state.humans[1].style)}`);
    expect(prompt).toContain("shared room with humans (Alice, Bob)");
    expect(prompt).toContain(`Your current outgoing message-body style is ${JSON.stringify(state.settings.participantStyles["codex-sol"])}`);
    expect(prompt).not.toContain(JSON.stringify(state.settings.participantStyles["claude-sonnet"]));
    expect(prompt).toContain("You are OpenCode [openai/gpt-5.6-sol] (Sol)");
    expect(prompt).toContain("Your own outgoing style is included below as visual context");
    expect(prompt).toContain("Do not change it unless a comment is clearly self-directed");
    expect(prompt).toContain("backgroundColor highlights your message text only");
    expect(prompt).toContain("local transcript magnification are application-controlled");
    expect(prompt).toContain("Tahoma, Verdana");
    expect(prompt).not.toContain(AIM_5_COLOR_PALETTE.join(", "));
    expect(prompt).not.toContain("Please review the implementation.");
    expect(prompt).not.toContain("CURRENT TRACKED WORKTREE DIFF AGAINST DEPLOYED COMMIT");
    expect(prompt).toContain('TURN_DISPOSITION: {"action":"yield","reason":"not_addressed"}');
    expect(prompt).toContain("Read-only research, including web search");
    expect(prompt).toContain("Ordinary room turns are read-only against project source");
    expect(prompt).toContain("Runtime lane selection is server-owned");
    expect(prompt).toContain("Never tell a human to switch, toggle, enter, or exit OpenCode plan/build mode");
    expect(prompt).toContain("DEPLOYMENT SOURCE PROVENANCE");
    expect(prompt).toContain("Commit: unavailable (do not guess a revision)");
    expect(prompt).toContain("Reading a current file establishes only its current contents");
    expect(prompt).toContain("Claim a commit-to-commit or worktree diff only when explicit diff evidence is present");
  });

  it("injects only the current permission-filtered room command guide without credentials", async () => {
    const secret="opaque-command-capability-secret";const guide=roomCommandGuide(["poll","help"]);const prompt=await __testing.buildPrompt("codex-sol",state,"Join if useful.",false,"read-only",{commandTool:{url:"http://127.0.0.1/internal",token:secret,allowedCommands:["poll","help"],guide}});
    expect(prompt).toContain("ROOM COMMANDS (server-owned");expect(prompt).toContain("poll:");expect(prompt).toContain("help:");expect(prompt).not.toContain("task:");expect(prompt).not.toContain("pov:");expect(prompt).not.toContain(secret);expect(JSON.parse(__testing.opencodeEnvironment({},"read-only",true).OPENCODE_PERMISSION!)).toHaveProperty("room_command","allow");
  });

  it("advertises room diagnostics only with an effective lease and never places its token in the prompt", async () => {
    const secret = "opaque-room-diagnostics-secret";
    const unavailable = await __testing.buildPrompt("codex-sol", state, "Join if useful.", false, "read-only");
    expect(unavailable).not.toContain("ROOM DIAGNOSTICS (server-owned");
    expect(JSON.parse(__testing.opencodeEnvironment({}, "read-only").OPENCODE_PERMISSION!)).toHaveProperty("room_diagnostics", "deny");
    const prompt = await __testing.buildPrompt("codex-sol", state, "Join if useful.", false, "read-only", { diagnosticsTool: { url: "http://127.0.0.1/internal", token: secret } });
    expect(prompt).toContain("ROOM DIAGNOSTICS (server-owned, lease-bound)");
    expect(prompt).not.toContain(secret);
    expect(JSON.parse(__testing.opencodeEnvironment({}, "read-only", false, true).OPENCODE_PERMISSION!)).toHaveProperty("room_diagnostics", "allow");
  });

  it("adds the room base prompt without displacing per-agent identity rules", async () => {
    const prompt = await __testing.buildPrompt("codex-sol", { ...state, roomConfiguration: { configurationRevision: 1, basePromptRevision: 1, basePromptText: "Treat evidence as primary.", summarizerModel: null, summarizerPromptText: "{{transcript}}", summarizerPromptRevision: 0, featureFlags: { preflightInvocationGating: false }, preflightMode: "off", updatedAt: "2026-08-27T00:00:00.000Z" } }, "Join if useful.", false, "read-only");
    expect(prompt).toContain("You are OpenCode [openai/gpt-5.6-sol] (Sol)");
    expect(prompt).toContain("ROOM BASE PROMPT\nTreat evidence as primary.");
    expect(prompt.indexOf("You are OpenCode")).toBeLessThan(prompt.indexOf("ROOM BASE PROMPT"));
    expect(prompt).toContain("only messages labeled [SOL] are your own history");
  });

  it("gives read-only agents the exact server-derived commit without granting shell permission", async () => {
    const deploymentState = { ...state, deployment: { schemaVersion: 1 as const, commitSha: "d".repeat(40), reference: { kind: "branch" as const, name: "main" }, worktree: "clean" as const, epoch: `deployment-v1:${"e".repeat(64)}`, observedAt: "2026-08-26T00:00:00.000Z" } };
    const prompt = await __testing.buildPrompt("codex-sol", deploymentState, "Which commit is deployed?", false, "read-only");
    expect(prompt).toContain(`Commit: ${"d".repeat(40)}`);
    expect(prompt).toContain("Checkout: branch main");
    expect(JSON.parse(__testing.opencodeEnvironment({}, "read-only").OPENCODE_PERMISSION!)).not.toHaveProperty("bash", "allow");
  });

  it.each([
    ["codex-terra", "[TERRA]"],
    ["codex-sol", "[SOL]"],
    ["claude-sonnet", "[CLAUDE]"],
    ["claude-opus", "[OPUS]"],
    ["cursor-grok", "[GROK]"],
    ["cursor-gemini", "[GEMINI]"],
    ["cursor-composer", "[COMPOSER]"],
    ["cursor-gemini-flash", "[FLASH]"],
    ["cursor-glm", "[GLM]"],
    ["opencode-configured", "[OPENCODE]"],
  ] as const)("anchors %s self-history to its unique transcript label", async (agent, label) => {
    const prompt = await __testing.buildPrompt(agent, state, "Join if useful.", false, "read-only");

    expect(prompt).toContain(`only messages labeled ${label} are your own history`);
    expect(prompt).toContain(`only on ${label} messages`);
  });

  it("adds worktree context only for an explicit review turn", async () => {
    const prompt = await __testing.buildPrompt("claude-sonnet", state, "Review the changes.", true, "read-only");

    expect(prompt).toContain("EXPLICIT REVIEW CONTEXT");
    expect(prompt).toContain("CURRENT TRACKED WORKTREE DIFF AGAINST DEPLOYED COMMIT (unavailable)");
    expect(prompt).toContain("no diff comparison was attempted");
    expect(prompt).toContain("Your current access is read-only");
  });

  it("anchors explicit review evidence to the captured deployed commit after HEAD moves", async () => {
    const projectPath = await mkdtemp(path.join(tmpdir(), "amfaa-deployed-diff-"));
    try {
      await execFileAsync("git", ["init", "-b", "main", projectPath]);
      await execFileAsync("git", ["-C", projectPath, "config", "user.email", "tests@example.invalid"]);
      await execFileAsync("git", ["-C", projectPath, "config", "user.name", "Tests"]);
      const sourcePath = path.join(projectPath, "source.txt");
      await writeFile(sourcePath, "deployed\n", "utf8");
      await execFileAsync("git", ["-C", projectPath, "add", "source.txt"]);
      await execFileAsync("git", ["-C", projectPath, "commit", "-m", "deployed"]);
      const deployedCommit = (await execFileAsync("git", ["-C", projectPath, "rev-parse", "HEAD"])).stdout.trim();
      await writeFile(sourcePath, "new head\n", "utf8");
      await execFileAsync("git", ["-C", projectPath, "add", "source.txt"]);
      await execFileAsync("git", ["-C", projectPath, "commit", "-m", "advance head"]);
      const moved = { ...state, settings: { ...state.settings, projectPath }, deployment: { schemaVersion: 1 as const, commitSha: deployedCommit, reference: { kind: "branch" as const, name: "main" }, worktree: "clean" as const, epoch: `deployment-v1:${"f".repeat(64)}`, observedAt: "2026-08-26T00:00:00.000Z" } };

      const prompt = await __testing.buildPrompt("codex-sol", moved, "Review the changes.", true, "read-only");
      expect(prompt).toContain(`CURRENT TRACKED WORKTREE DIFF AGAINST DEPLOYED COMMIT ${deployedCommit}`);
      expect(prompt).toContain("-deployed");
      expect(prompt).toContain("+new head");
    } finally {
      await rm(projectPath, { recursive: true, force: true });
    }
  });
});

describe("OpenCode runtime safety", () => {
  it("keeps ordinary chat short while allowing bounded writable development", () => {
    expect(__testing.runTimeout("read-only", false)).toBe(90_000);
    expect(__testing.runTimeout("read-only", true)).toBe(5 * 60_000);
    expect(__testing.runTimeout("writable", false)).toBe(10 * 60_000);
  });

  it("does not expose live service storage or bridge configuration to agent commands", () => {
    expect(__testing.agentProcessEnvironment({
      PATH: "/bin",
      HOME: "/tmp/home",
      DATABASE_URL: "postgres://live",
      ALL_MY_FRIENDS_ARE_AGENTS_SQLITE_PATH: "/live/room.sqlite",
      ALL_MY_FRIENDS_ARE_AGENTS_COORDINATOR_EXECUTOR_TOKEN: "secret",
      AGENTWIRE_PORT: "53147",
      Database_Url: "postgres://mixed-case-live",
      All_My_Friends_Are_Agents_Data_Dir: "/mixed-case-live",
      GH_TOKEN: "gh-secret",
      GITHUB_TOKEN: "github-secret",
      OPENAI_API_KEY: "provider-secret",
      AMFAA_ROOM_COMMAND_URL: "http://127.0.0.1/command",
      AMFAA_ROOM_COMMAND_TOKEN: "command-secret",
      AMFAA_ROOM_COMMANDS: '["gh"]',
      AMFAA_ROOM_HISTORY_URL: "http://127.0.0.1/history",
      AMFAA_ROOM_HISTORY_TOKEN: "history-secret",
      AMFAA_ROOM_DIAGNOSTICS_URL: "http://127.0.0.1/diagnostics",
      AMFAA_ROOM_DIAGNOSTICS_TOKEN: "diagnostics-secret",
      SOME_PASSWORD: "password-secret",
      PGPASSWORD: "postgres-secret",
      PgPassFile: "/private/postgres-password-file",
      MYSQL_PWD: "mysql-secret",
    })).toEqual({ PATH: "/bin", HOME: "/tmp/home" });
  });

  it("passes only the complete scoped room-tool environment alongside a filtered agent environment", async () => {
    const environment = {
      PATH: process.env.PATH,
      GITHUB_TOKEN: "github-secret",
      OPENAI_API_KEY: "provider-secret",
      DATABASE_URL: "postgres://live",
      OTHER_TOKEN: "other-secret",
      AMFAA_ROOM_COMMAND_TOKEN: "unscoped-command-secret",
    };
    const scopedToolEnvironment = {
      AMFAA_ROOM_COMMAND_URL: "http://127.0.0.1/command",
      AMFAA_ROOM_COMMAND_TOKEN: "command-secret",
      AMFAA_ROOM_COMMANDS: '["gh","help"]',
      AMFAA_ROOM_HISTORY_URL: "http://127.0.0.1/history",
      AMFAA_ROOM_HISTORY_TOKEN: "history-secret",
      AMFAA_ROOM_DIAGNOSTICS_URL: "http://127.0.0.1/diagnostics",
      AMFAA_ROOM_DIAGNOSTICS_TOKEN: "diagnostics-secret",
      GITHUB_TOKEN: "scoped-github-secret",
      OPENAI_API_KEY: "scoped-provider-secret",
      DATABASE_URL: "postgres://scoped-live",
      OTHER_TOKEN: "scoped-other-secret",
    };
    const keys = [
      "AMFAA_ROOM_COMMAND_URL",
      "AMFAA_ROOM_COMMAND_TOKEN",
      "AMFAA_ROOM_COMMANDS",
      "AMFAA_ROOM_HISTORY_URL",
      "AMFAA_ROOM_HISTORY_TOKEN",
      "AMFAA_ROOM_DIAGNOSTICS_URL",
      "AMFAA_ROOM_DIAGNOSTICS_TOKEN",
      "GITHUB_TOKEN",
      "OPENAI_API_KEY",
      "DATABASE_URL",
      "OTHER_TOKEN",
    ];
    const command = ["-e", `process.stdout.write(JSON.stringify(Object.fromEntries(${JSON.stringify(keys)}.map((key) => [key, Object.hasOwn(process.env, key)]))))`];

    const result = await __testing.runProcess(process.execPath, command, process.cwd(), { environment, scopedToolEnvironment });

    expect(JSON.parse(result.stdout)).toEqual({
      AMFAA_ROOM_COMMAND_URL: true,
      AMFAA_ROOM_COMMAND_TOKEN: true,
      AMFAA_ROOM_COMMANDS: true,
      AMFAA_ROOM_HISTORY_URL: true,
      AMFAA_ROOM_HISTORY_TOKEN: true,
      AMFAA_ROOM_DIAGNOSTICS_URL: true,
      AMFAA_ROOM_DIAGNOSTICS_TOKEN: true,
      GITHUB_TOKEN: false,
      OPENAI_API_KEY: false,
      DATABASE_URL: false,
      OTHER_TOKEN: false,
    });
  });

  it("reports bounded room-tool subprocess readiness without credential or endpoint values", async () => {
    const environment = __testing.agentChildProcessEnvironment({
      environment: { PATH: process.env.PATH, GITHUB_TOKEN: "github-secret" },
      scopedToolEnvironment: {
        AMFAA_ROOM_COMMAND_URL: "http://127.0.0.1/command",
        AMFAA_ROOM_COMMAND_TOKEN: "command-secret",
        AMFAA_ROOM_COMMANDS: '["gh"]',
        AMFAA_ROOM_HISTORY_URL: "http://127.0.0.1/history",
        AMFAA_ROOM_HISTORY_TOKEN: "history-secret",
        AMFAA_ROOM_DIAGNOSTICS_URL: "http://127.0.0.1/diagnostics",
      },
    });
    const operationLog = vi.fn();

    await __testing.logScopedAgentToolReadiness(
      operationLog,
      "generation-1",
      "codex-sol",
      environment,
      { roomCommand: true, roomHistory: true, roomDiagnostics: true },
    );

    expect(operationLog).toHaveBeenCalledWith("error", "agent.tool-policy.environment", {
      generationId: "generation-1",
      agentId: "codex-sol",
      outcome: "failed",
      reason: "scoped-tool-environment-missing",
      roomCommand: "ready",
      roomHistory: "ready",
      roomDiagnostics: "missing",
    });
    expect(JSON.stringify(operationLog.mock.calls)).not.toMatch(/command-secret|history-secret|github-secret|127\.0\.0\.1/);
  });

  it("wires the complete scoped room-tool family through a real runAgent subprocess", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "amfaa-room-tool-env-"));
    try {
      const capturePath = path.join(directory, "environment.json");
      const openCodePath = path.join(directory, "fake-opencode.mjs");
      const scopedKeys = [
        "AMFAA_ROOM_COMMAND_URL",
        "AMFAA_ROOM_COMMAND_TOKEN",
        "AMFAA_ROOM_COMMANDS",
        "AMFAA_ROOM_HISTORY_URL",
        "AMFAA_ROOM_HISTORY_TOKEN",
        "AMFAA_ROOM_DIAGNOSTICS_URL",
        "AMFAA_ROOM_DIAGNOSTICS_TOKEN",
      ];
      const blockedKeys = ["GITHUB_TOKEN", "OPENAI_API_KEY", "DATABASE_URL"];
      await writeFile(openCodePath, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
if (process.argv.includes("--session")) {
  process.stderr.write("session ses_stale not found " + process.env.AMFAA_ROOM_COMMAND_TOKEN + "\\n");
  process.exit(1);
}
const scopedKeys = ${JSON.stringify(scopedKeys)};
const blockedKeys = ${JSON.stringify(blockedKeys)};
writeFileSync(process.env.AMFAA_TEST_CAPTURE_PATH, JSON.stringify({
  scoped: Object.fromEntries(scopedKeys.map((key) => [key, Object.hasOwn(process.env, key)])),
  blocked: Object.fromEntries(blockedKeys.map((key) => [key, Object.hasOwn(process.env, key)])),
  commands: JSON.parse(process.env.AMFAA_ROOM_COMMANDS || "[]"),
  freshBinding: process.env.AMFAA_ROOM_COMMAND_TOKEN === "command-fresh-placeholder" && process.env.AMFAA_ROOM_DIAGNOSTICS_TOKEN === "diagnostics-fresh-placeholder",
}));
process.stderr.write(process.env.AMFAA_ROOM_HISTORY_TOKEN + " " + process.env.AMFAA_ROOM_DIAGNOSTICS_URL + "\\n");
process.stdout.write(JSON.stringify({ type: "text", sessionID: "ses_room_tool_smoke", part: { type: "text", text: "room-tool-environment-ok " + process.env.AMFAA_ROOM_COMMAND_TOKEN } }) + "\\n");
`, { mode: 0o755 });
      const childScript = `
const { runAgent } = await import("./server/agent-runner.ts");
const { DEFAULT_PARTICIPANT_STYLES } = await import("./shared/chat-style.ts");
const participant = { agentId: "codex-sol", conversationalName: "Sol", providerId: "openai", modelId: "gpt-5.6-sol", enabled: true, configurationRevision: 1 };
const epoch = "deployment-v1:" + "a".repeat(64);
const state = {
  messages: [], sessions: { "codex-sol": { id: "ses_stale", permission: "read-only", configurationFingerprint: JSON.stringify({ providerId: "openai", modelId: "gpt-5.6-sol" }), codeEpoch: epoch } }, status: "idle",
  roster: { schemaVersion: 3, revision: 1, entries: [participant] },
  settings: { roomName: "Room", topic: "Scoped tool smoke", writableAgent: "nobody", conversationEnergy: "balanced", projectPath: process.cwd(), participantStyles: structuredClone(DEFAULT_PARTICIPANT_STYLES) },
  deployment: { schemaVersion: 1, commitSha: "b".repeat(40), reference: { kind: "branch", name: "main" }, worktree: "clean", epoch, observedAt: "2026-08-29T00:00:00.000Z" },
};
const journalEntries = [];
const journal = { append: async (entry) => { journalEntries.push(entry); } };
let refreshCount = 0;
let invalidations = 0;
const context = {
  historyTool: { configDirectory: ${JSON.stringify(directory)}, url: "http://127.0.0.1/history", token: "history-placeholder" },
  refreshScopedTools: () => {
    refreshCount += 1;
    const binding = state.sessions["codex-sol"]?.id || "fresh";
    return {
      commandTool: { url: "http://127.0.0.1/command", token: "command-" + binding + "-placeholder", allowedCommands: ["help", "gh"], guide: "ROOM COMMANDS" },
      diagnosticsTool: { url: "http://127.0.0.1/diagnostics", token: "diagnostics-" + binding + "-placeholder" },
    };
  },
};
const sessionLifecycle = { invalidate: async (agent) => { invalidations += 1; delete state.sessions[agent]; } };
const result = await runAgent("codex-sol", state, "Verify scoped tools.", false, journal, undefined, undefined, undefined, sessionLifecycle, undefined, undefined, undefined, undefined, context);
const retained = JSON.stringify(journalEntries);
const leaks = ["command-ses_stale-placeholder", "command-fresh-placeholder", "history-placeholder", "diagnostics-fresh-placeholder", "http://127.0.0.1/command", "http://127.0.0.1/history", "http://127.0.0.1/diagnostics"].some((value) => retained.includes(value));
process.stdout.write(JSON.stringify({ text: result.text, sessionId: result.sessionId, refreshCount, invalidations, journalLeaksScopedValues: leaks }));
`;

      const { stdout } = await execFileAsync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", childScript], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          ALL_MY_FRIENDS_ARE_AGENTS_OPENCODE_COMMAND: openCodePath,
          AMFAA_TEST_CAPTURE_PATH: capturePath,
          GITHUB_TOKEN: "github-placeholder",
          OPENAI_API_KEY: "provider-placeholder",
          DATABASE_URL: "postgres://placeholder",
        },
        timeout: 15_000,
      });
      const capture = JSON.parse(await readFile(capturePath, "utf8"));

      expect(JSON.parse(stdout)).toEqual({
        text: "room-tool-environment-ok [REDACTED]",
        sessionId: "ses_room_tool_smoke",
        refreshCount: 2,
        invalidations: 1,
        journalLeaksScopedValues: false,
      });
      expect(capture).toEqual({
        scoped: Object.fromEntries(scopedKeys.map((key) => [key, true])),
        blocked: Object.fromEntries(blockedKeys.map((key) => [key, false])),
        commands: ["help", "gh"],
        freshBinding: true,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves only an explicitly trusted confined-writer environment", async () => {
    const environment = {
      PATH: process.env.PATH,
      HOME: "/var/empty",
      ALL_MY_FRIENDS_ARE_AGENTS_GIT_BROKER_SOCKET: "/tmp/broker.sock",
      ALL_MY_FRIENDS_ARE_AGENTS_GIT_BROKER_TOKEN: "broker-token",
    };
    const command = ["-e", "process.stdout.write(JSON.stringify(process.env))"];
    const filtered = await __testing.runProcess(process.execPath, command, process.cwd(), { environment });
    const trusted = await __testing.runProcess(process.execPath, command, process.cwd(), { environment, trustedEnvironment: true });

    expect(JSON.parse(filtered.stdout)).not.toHaveProperty("ALL_MY_FRIENDS_ARE_AGENTS_GIT_BROKER_TOKEN");
    expect(JSON.parse(trusted.stdout)).toMatchObject({
      ALL_MY_FRIENDS_ARE_AGENTS_GIT_BROKER_SOCKET: "/tmp/broker.sock",
      ALL_MY_FRIENDS_ARE_AGENTS_GIT_BROKER_TOKEN: "broker-token",
    });
  });
});

describe("agent process cancellation", () => {
  it("refuses to spawn after the process supervisor has closed", async () => {
    const supervisor = new AgentProcessSupervisor();
    await supervisor.shutdown();

    await expect(__testing.runProcess(
      process.execPath,
      ["-e", "process.stdout.write('should-not-run')"],
      process.cwd(),
      { supervisor, timeoutMs: 10_000 },
    )).rejects.toThrow("Agent process supervisor is shutting down.");
    expect(supervisor.activeCount).toBe(0);
  });

  it("releases a tracked process when the executable cannot be spawned", async () => {
    const supervisor = new AgentProcessSupervisor();

    await expect(__testing.runProcess(
      "__all_my_friends_missing_agent_command__",
      [],
      process.cwd(),
      { supervisor, timeoutMs: 10_000 },
    )).rejects.toMatchObject({ code: "ENOENT" });
    expect(supervisor.activeCount).toBe(0);
  });

  it("lets server shutdown await all owned agent processes", async () => {
    const supervisor = new AgentProcessSupervisor();
    const outcome = __testing.runProcess(
      process.execPath,
      ["-e", "setInterval(() => undefined, 1000)"],
      process.cwd(),
      { supervisor, timeoutMs: 10_000 },
    ).catch((error: unknown) => error);

    expect(supervisor.activeCount).toBe(1);
    await supervisor.shutdown();
    await expect(outcome).resolves.toMatchObject({ name: "ProcessExecutionError" });
    expect(supervisor.activeCount).toBe(0);
  });

  it.skipIf(process.platform === "win32")("kills independently grouped descendants during server shutdown", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "agent-shutdown-tree-"));
    const pidPath = path.join(directory, "descendant.pid");
    const supervisor = new AgentProcessSupervisor();
    const script = [
      "const { spawn } = require('node:child_process')", "const { writeFileSync } = require('node:fs')",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], { stdio: 'ignore', detached: true })",
      "child.unref()", "writeFileSync(process.argv[1], String(child.pid))", "setInterval(() => undefined, 1000)",
    ].join(";");
    const outcome = __testing.runProcess(process.execPath, ["-e", script, pidPath], process.cwd(), { supervisor, timeoutMs: 10_000 }).catch((error: unknown) => error);
    let descendantPid = 0;
    for (let attempt = 0; attempt < 100 && descendantPid === 0; attempt += 1) {
      try { descendantPid = Number(await readFile(pidPath, "utf8")); } catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
    }
    expect(descendantPid).toBeGreaterThan(0);
    await supervisor.shutdown();
    await expect(outcome).resolves.toMatchObject({ name: "ProcessExecutionError" });
    expect(() => process.kill(descendantPid, 0)).toThrow();
    await rm(directory, { recursive: true, force: true });
  });

  it("cancels an active generation promptly", async () => {
    const controller = new AbortController();
    const outcome = __testing.runProcess(
      process.execPath,
      ["-e", "setInterval(() => undefined, 1000)"],
      process.cwd(),
      { signal: controller.signal, timeoutMs: 10_000 },
    ).catch((error: unknown) => error);

    controller.abort();

    await expect(outcome).resolves.toMatchObject({ name: "ProcessCancelledError" });
  });

  it("terminates only processes in the requested assignment scope", async () => {
    const supervisor = new AgentProcessSupervisor();
    const first = __testing.runProcess(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], process.cwd(), { supervisor, scope: "first", timeoutMs: 10_000 }).catch((error: unknown) => error);
    const second = __testing.runProcess(process.execPath, ["-e", "setTimeout(() => process.stdout.write('ok'), 150)"], process.cwd(), { supervisor, scope: "second", timeoutMs: 10_000 });
    await supervisor.terminateScope("first");
    await expect(first).resolves.toMatchObject({ name: "ProcessExecutionError" });
    await expect(second).resolves.toMatchObject({ stdout: "ok" });
    expect(supervisor.activeCount).toBe(0);
  });

  it("lets a roster agent scope terminate work that also belongs to an assignment", async () => {
    const supervisor = new AgentProcessSupervisor();
    const outcome = __testing.runProcess(
      process.execPath,
      ["-e", "setInterval(() => undefined, 1000)"],
      process.cwd(),
      { supervisor, scope: ["agent:codex-sol", "assignment:one"], timeoutMs: 10_000 },
    ).catch((error: unknown) => error);
    await supervisor.terminateScope("agent:codex-sol");
    await expect(outcome).resolves.toMatchObject({ name: "ProcessExecutionError" });
    expect(supervisor.activeCount).toBe(0);
  });

  it.skipIf(process.platform === "win32")("terminates descendants with the cancelled agent process", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "agent-process-tree-"));
    const pidPath = path.join(directory, "grandchild.pid");
    const controller = new AbortController();
    const script = [
      "const { spawn } = require('node:child_process')",
      "const { writeFileSync } = require('node:fs')",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], { stdio: 'ignore', detached: true })",
      "child.unref()",
      "writeFileSync(process.argv[1], String(child.pid))",
      "setInterval(() => undefined, 1000)",
    ].join(";");
    const outcome = __testing.runProcess(
      process.execPath,
      ["-e", script, pidPath],
      process.cwd(),
      { signal: controller.signal, timeoutMs: 10_000 },
    ).catch((error: unknown) => error);

    let grandchildPid = 0;
    for (let attempt = 0; attempt < 100 && grandchildPid === 0; attempt += 1) {
      try {
        grandchildPid = Number(await readFile(pidPath, "utf8"));
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    expect(grandchildPid).toBeGreaterThan(0);

    controller.abort();
    await expect(outcome).resolves.toMatchObject({ name: "ProcessCancelledError" });

    let stillRunning = true;
    for (let attempt = 0; attempt < 100 && stillRunning; attempt += 1) {
      try {
        process.kill(grandchildPid, 0);
        await new Promise((resolve) => setTimeout(resolve, 10));
      } catch {
        stillRunning = false;
      }
    }
    expect(stillRunning).toBe(false);
    await rm(directory, { recursive: true, force: true });
  });
});
