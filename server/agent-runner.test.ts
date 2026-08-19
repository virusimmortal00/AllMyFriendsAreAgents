import { describe, expect, it } from "vitest";
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
      writableAgent: "codex",
      reviewMode: "read-only",
      maxRounds: 3,
      projectPath: "/tmp/project",
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
