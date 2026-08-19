import { describe, expect, it } from "vitest";
import { __testing } from "./agent-runner.js";

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

