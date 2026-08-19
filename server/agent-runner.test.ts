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
});

describe("agent permissions", () => {
  const state = {
    messages: [],
    sessions: {},
    settings: {
      topic: "Open conversation",
      writableAgent: "codex",
      reviewMode: "read-only",
      maxRounds: 3,
      projectPath: "/tmp/project",
      participantStyles: structuredClone(DEFAULT_PARTICIPANT_STYLES),
    },
    status: "idle",
  } satisfies RoomState;

  it("keeps explicit review turns read-only", () => {
    expect(__testing.resolvePermission("codex", state, true)).toBe("read-only");
  });

  it("allows only the selected agent to write on ordinary turns", () => {
    expect(__testing.resolvePermission("codex", state, false)).toBe("writable");
    expect(__testing.resolvePermission("claude", state, false)).toBe("read-only");
  });
});

describe("room prompt context", () => {
  const state = {
    messages: [
      { id: "old", speaker: "you", text: "Please review the implementation.", timestamp: "2026-08-19T12:00:00.000Z", kind: "chat" },
      { id: "topic", speaker: "system", text: "Room topic: Weekend cooking", timestamp: "2026-08-19T12:01:00.000Z", kind: "topic" },
      { id: "new", speaker: "you", text: "What should we make?", timestamp: "2026-08-19T12:02:00.000Z", kind: "chat" },
    ],
    sessions: {},
    settings: {
      topic: "Weekend cooking",
      writableAgent: "nobody",
      reviewMode: "read-only",
      maxRounds: 3,
      projectPath: process.cwd(),
      participantStyles: structuredClone(DEFAULT_PARTICIPANT_STYLES),
    },
    status: "idle",
  } satisfies RoomState;

  it("keeps ordinary chat casual and scoped to the latest topic", async () => {
    const prompt = await __testing.buildPrompt("codex", state, "Join if useful.", false, "read-only");

    expect(prompt).toContain("ROOM THEME\nWeekend cooking");
    expect(prompt).toContain("What should we make?");
    expect(prompt).toContain("NO_RESPONSE_NEEDED");
    expect(prompt).toContain("separate it with <<<NEXT>>>");
    expect(prompt).toContain("Use at most 3 messages and usually 1");
    expect(prompt).toContain("Do not split a single sentence merely for effect");
    expect(prompt).toContain("backgroundColor highlights your message text only");
    expect(prompt).toContain("local transcript magnification are application-controlled");
    expect(prompt).toContain("Tahoma, Verdana");
    expect(prompt).not.toContain("Please review the implementation.");
    expect(prompt).not.toContain("CURRENT WORKTREE DIFF");
    expect(prompt).not.toContain("DISPOSITION:");
  });

  it("adds worktree context only for an explicit review turn", async () => {
    const prompt = await __testing.buildPrompt("claude", state, "Review the changes.", true, "read-only");

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
    expect(__testing.claudeArgs("read-only", "fresh-session")).toEqual([
      "-p",
      "--output-format",
      "json",
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
    expect(__testing.claudeArgs("read-only", "existing-session", true)).toEqual([
      "-p",
      "--output-format",
      "json",
      "--resume",
      "existing-session",
    ]);
  });
});
