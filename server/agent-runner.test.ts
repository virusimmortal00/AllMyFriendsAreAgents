import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_PARTICIPANT_STYLES } from "../shared/chat-style.js";
import { AgentProcessSupervisor, __testing, runAgent } from "./agent-runner.js";
import type { ModelDiscoveryService } from "./model-discovery.js";
import type { RoomState } from "./types.js";

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

  it("parses OpenCode JSON events and preserves multi-part text", () => {
    expect(__testing.parseOpenCodeOutput([
      JSON.stringify({ type: "step_start", sessionID: "ses_open", part: { type: "step-start" } }),
      JSON.stringify({ type: "text", sessionID: "ses_open", part: { type: "text", text: "One " } }),
      "non-protocol progress",
      JSON.stringify({ type: "text", sessionID: "ses_open", part: { type: "text", text: "answer." } }),
    ].join("\n"))).toEqual({ sessionId: "ses_open", text: "One answer." });
  });

  it("maps room permissions without replacing OpenCode provider configuration", () => {
    const environment = { PATH: "/bin", OPENCODE_CONFIG: "/tmp/config" };
    expect(__testing.opencodeEnvironment(environment, "read-only")).toMatchObject({
      OPENCODE_CONFIG: "/tmp/config",
      OPENCODE_PERMISSION: JSON.stringify({
        "*": "deny", read: "allow", glob: "allow", grep: "allow", list: "allow",
        webfetch: "allow", websearch: "allow", lsp: "allow",
      }),
    });
    expect(__testing.opencodeEnvironment(environment, "writable")).toBe(environment);
  });

  it("resumes only matching or historically OpenCode sessions", () => {
    const codex = { agentId: "codex-sol", conversationalName: "Sol", providerId: "openai", modelId: "gpt-5.6-sol", enabled: true, configurationRevision: 1 };
    const openCode = { agentId: "opencode-configured", conversationalName: "OpenCode", modelId: "configured", enabled: true, configurationRevision: 1 };
    const unversioned = { id: "legacy", permission: "read-only" as const };
    expect(__testing.resumableOpenCodeSession("codex-sol", codex, unversioned, "read-only")).toBeUndefined();
    expect(__testing.resumableOpenCodeSession("opencode-configured", openCode, unversioned, "read-only")).toBe(unversioned);
    const fingerprinted = { ...unversioned, configurationFingerprint: JSON.stringify({ harness: "opencode", providerId: "openai", modelId: "gpt-5.6-sol" }) };
    expect(__testing.resumableOpenCodeSession("codex-sol", codex, fingerprinted, "read-only")).toBe(fingerprinted);
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

  it("allows only the selected assigned agent to write on ordinary turns", () => {
    expect(__testing.resolvePermission("codex-sol", state, false, "/tmp/worktree")).toBe("writable");
    expect(__testing.resolvePermission("claude-sonnet", state, false, "/tmp/worktree")).toBe("read-only");
    expect(__testing.resolvePermission("codex-sol", state, false)).toBe("read-only");
  });

  it("allows a selected Cursor agent to write while keeping review turns read-only", () => {
    const cursorState = { ...state, settings: { ...state.settings, writableAgent: "cursor-grok" as const } };
    expect(__testing.resolvePermission("cursor-grok", cursorState, false, "/tmp/worktree")).toBe("writable");
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
    expect(prompt).toContain("CURRENT PARTICIPANT STYLES");
    expect(prompt).toContain(`Alice: ${JSON.stringify(state.humans[0].style)}`);
    expect(prompt).toContain(`Bob: ${JSON.stringify(state.humans[1].style)}`);
    expect(prompt).toContain("shared room with humans (Alice, Bob)");
    expect(prompt).toContain(`OpenCode [openai/gpt-5.6-sol]: ${JSON.stringify(state.settings.participantStyles["codex-sol"])}`);
    expect(prompt).toContain(`Claude [Claude Sonnet 5]: ${JSON.stringify(state.settings.participantStyles["claude-sonnet"])}`);
    expect(prompt).not.toContain(`Claude [Claude Opus 5]:`);
    expect(prompt).toContain("You are OpenCode [openai/gpt-5.6-sol] (Sol)");
    expect(prompt).toContain("compare everyone’s styles and the conversational context");
    expect(prompt).toContain("Do not change your own style unless the comment is clearly self-directed");
    expect(prompt).toContain("backgroundColor highlights your message text only");
    expect(prompt).toContain("local transcript magnification are application-controlled");
    expect(prompt).toContain("Tahoma, Verdana");
    expect(prompt).not.toContain("Please review the implementation.");
    expect(prompt).not.toContain("CURRENT WORKTREE DIFF");
    expect(prompt).not.toContain("DISPOSITION:");
    expect(prompt).toContain("Read-only research, including web search");
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
    expect(prompt).toContain("CURRENT WORKTREE DIFF");
    expect(prompt).toContain("Your current access is read-only");
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
    })).toEqual({ PATH: "/bin", HOME: "/tmp/home" });
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
