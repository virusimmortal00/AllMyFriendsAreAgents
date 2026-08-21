import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_PARTICIPANT_STYLES } from "../shared/chat-style.js";
import { __testing } from "./agent-runner.js";
import type { RoomState } from "./types.js";

describe("Codex JSONL parsing", () => {
  it("extracts the session id and final agent message", () => {
    const output = [
      JSON.stringify({ type: "thread.started", thread_id: "room-session" }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "First" } }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Final" } }),
    ].join("\n");

    expect(__testing.parseCodexOutput(output)).toEqual({
      sessionId: "room-session",
      text: "Final",
    });
  });

  it("pins each Codex session to its configured model on start and resume", () => {
    expect(__testing.codexArgs("read-only", "/tmp/project", "gpt-5.6-luna")).toContain("gpt-5.6-luna");
    expect(__testing.codexArgs("read-only", "/tmp/project", "gpt-5.6-terra", "terra-session")).toEqual([
      "exec", "resume", "--model", "gpt-5.6-terra", "terra-session", "-", "--json",
    ]);
    expect(__testing.codexArgs("writable", "/tmp/project", "gpt-5.6-sol")).toContain("workspace-write");
  });

  it("pins Cursor sessions to a model while enforcing sandboxed ask mode on start and resume", () => {
    expect(__testing.cursorArgs("/tmp/project", "cursor-grok-4.6-high")).toEqual([
      "-p", "--output-format", "json", "--mode", "ask", "--sandbox", "enabled", "--trust",
      "--workspace", "/tmp/project", "--model", "cursor-grok-4.6-high",
    ]);
    expect(__testing.cursorArgs("/tmp/project", "gemini-3.1-pro", "cursor-session")).toContain("cursor-session");
  });

  it("parses Cursor's structured result contract", () => {
    expect(__testing.parseCursorOutput(JSON.stringify({
      type: "result", is_error: false, result: "A different opinion.", session_id: "cursor-session",
    }))).toEqual({ isError: false, text: "A different opinion.", sessionId: "cursor-session" });
  });

  it("extracts exact model identifiers from Cursor's account-specific catalog", () => {
    expect(__testing.parseCursorModels([
      "Available models",
      "cursor-grok-4.6-high - Cursor Grok 4.6",
      "gemini-3.1-pro - Gemini 3.1 Pro",
      "",
      "Tip: use --model <id>",
    ].join("\n"))).toEqual(new Set(["cursor-grok-4.6-high", "gemini-3.1-pro"]));
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
    expect(__testing.resolvePermission("codex-sol", state, true)).toBe("read-only");
  });

  it("allows only the selected agent to write on ordinary turns", () => {
    expect(__testing.resolvePermission("codex-sol", state, false)).toBe("writable");
    expect(__testing.resolvePermission("claude-sonnet", state, false)).toBe("read-only");
  });

  it("keeps Cursor opinion agents read-only even if stale settings select one", () => {
    const staleState = { ...state, settings: { ...state.settings, writableAgent: "cursor-grok" as const } };
    expect(__testing.resolvePermission("cursor-grok", staleState, false)).toBe("read-only");
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
    expect(prompt).toContain(`Codex [gpt-5.6 Sol]: ${JSON.stringify(state.settings.participantStyles["codex-sol"])}`);
    expect(prompt).toContain(`Claude [Claude Sonnet 5]: ${JSON.stringify(state.settings.participantStyles["claude-sonnet"])}`);
    expect(prompt).toContain("You are Codex [gpt-5.6 Sol] (Sol)");
    expect(prompt).toContain("compare everyone’s styles and the conversational context");
    expect(prompt).toContain("Do not change your own style unless the comment is clearly self-directed");
    expect(prompt).toContain("backgroundColor highlights your message text only");
    expect(prompt).toContain("local transcript magnification are application-controlled");
    expect(prompt).toContain("Tahoma, Verdana");
    expect(prompt).not.toContain("Please review the implementation.");
    expect(prompt).not.toContain("CURRENT WORKTREE DIFF");
    expect(prompt).not.toContain("DISPOSITION:");
  });

  it.each([
    ["codex-luna", "[LUNA]"],
    ["codex-terra", "[TERRA]"],
    ["codex-sol", "[SOL]"],
    ["claude-sonnet", "[CLAUDE]"],
    ["cursor-grok", "[GROK]"],
    ["cursor-gemini", "[GEMINI]"],
    ["cursor-composer", "[COMPOSER]"],
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

describe("Claude session recovery", () => {
  it("recognizes only the missing-conversation failure as recoverable", () => {
    expect(__testing.isMissingClaudeSessionError(new Error("claude exited with 1: No conversation found with session ID: stale"))).toBe(true);
    expect(__testing.isMissingClaudeSessionError(new Error("claude exited with 1: API unavailable"))).toBe(false);
  });

  it("restarts a missing read-only session with the original safety policy", () => {
    expect(__testing.claudeArgs("read-only", "fresh-session", "claude-sonnet-5")).toEqual([
      "-p",
      "--output-format",
      "json",
      "--model",
      "claude-sonnet-5",
      "--permission-mode",
      "plan",
      "--tools",
      "Read",
      "Glob",
      "Grep",
      "--session-id",
      "fresh-session",
    ]);
  });

  it("uses resume only when an existing session is available", () => {
    expect(__testing.claudeArgs("read-only", "existing-session", "claude-sonnet-5", true)).toEqual([
      "-p",
      "--output-format",
      "json",
      "--model",
      "claude-sonnet-5",
      "--resume",
      "existing-session",
    ]);
  });
});

describe("agent process cancellation", () => {
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

  it.skipIf(process.platform === "win32")("terminates descendants with the cancelled agent process", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "agent-process-tree-"));
    const pidPath = path.join(directory, "grandchild.pid");
    const controller = new AbortController();
    const script = [
      "const { spawn } = require('node:child_process')",
      "const { writeFileSync } = require('node:fs')",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], { stdio: 'ignore' })",
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
