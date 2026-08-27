import { describe, expect, it } from "vitest";
import { effectiveAllowedCommands, normalizeCommandPermissions, parseCommand, parseCommandInput, resolveRoundRobin } from "./command-domain.js";

describe("command parser", () => {
  it("parses all commands into one typed invocation model", () => {
    expect(parseCommand("hello")).toEqual({ kind: "not-command" });
    expect(parseCommand("/task")).toEqual({ kind: "command", invocation: { command: "task", prompt: "", selection: { kind: "round-robin" } } });
    expect(parseCommand("/task ship it")).toMatchObject({ kind: "command", invocation: { command: "task", prompt: "ship it", selection: { kind: "round-robin" } } });
    expect(parseCommand("/task @codex-sol ship it")).toMatchObject({ kind: "command", invocation: { command: "task", selection: { kind: "pinned", agentId: "codex-sol" } } });
    expect(parseCommand("/pov what do you think?")).toMatchObject({ kind: "command", invocation: { command: "pov" } });
    expect(parseCommand('/poll "Best path?" "A" "B"')).toEqual({ kind: "command", invocation: { command: "poll", question: "Best path?", options: ["A", "B"] } });
    expect(parseCommand("/help")).toEqual({ kind: "command", invocation: { command: "help" } });
  });

  it("keeps malformed poll failures private and friendly", () => {
    for (const input of ["/poll question A B", '/poll "Question" "Only one"', '/poll "unterminated']) {
      expect(parseCommand(input)).toMatchObject({ kind: "private-error", message: expect.stringContaining('/poll "Question"') });
    }
  });

  it("preserves explicit structured round-robin selection for mention-prefixed prompts", () => {
    expect(parseCommandInput({ command: "task", prompt: "@claude-sonnet compare this", selection: { kind: "round-robin" } })).toEqual({ kind: "command", invocation: { command: "task", prompt: "@claude-sonnet compare this", selection: { kind: "round-robin" } } });
  });
});

describe("round-robin resolution", () => {
  const candidates = [
    { agentId: "codex-sol" as const, eligible: false },
    { agentId: "claude-opus" as const, eligible: true },
    { agentId: "cursor-grok" as const, eligible: true },
  ];
  it("makes one canonical pass and skips every ineligible candidate", () => expect(resolveRoundRobin(candidates, "cursor-grok")).toMatchObject({ kind: "selected", agentId: "claude-opus", advancePointer: true }));
  it("falls back to roster head when the persisted participant was removed", () => expect(resolveRoundRobin(candidates, "cursor-composer")).toMatchObject({ kind: "selected", agentId: "claude-opus" }));
  it("leaves the pointer unchanged for pinned selection", () => expect(resolveRoundRobin(candidates, "cursor-grok", "claude-opus")).toEqual({ kind: "selected", agentId: "claude-opus", nextLastAssignedAgentId: "cursor-grok", advancePointer: false }));
  it("returns a typed empty result when all candidates are ineligible", () => expect(resolveRoundRobin(candidates.map((candidate) => ({ ...candidate, eligible: false })), "cursor-grok")).toEqual({ kind: "no-eligible-candidates", nextLastAssignedAgentId: "cursor-grok", advancePointer: false }));
});

describe("command permissions", () => {
  it("migrates missing permissions to allow-all and fails closed on malformed records", () => {
    expect(normalizeCommandPermissions(undefined)).toEqual({ allowAll: true, allowed: ["task", "pov", "poll", "help"] });
    expect(normalizeCommandPermissions({ allowAll: "yes", allowed: ["task"] })).toEqual({ allowAll: false, allowed: [] });
    expect(normalizeCommandPermissions({ allowAll: true })).toEqual({ allowAll: true, allowed: ["task", "pov", "poll", "help"] });
  });
  it("applies a server/room ceiling that an agent cannot expand", () => expect(effectiveAllowedCommands({ allowAll: true, allowed: ["task", "pov", "poll", "help"] }, ["help", "poll"])).toEqual(["poll", "help"]));
});
