import { describe, expect, it } from "vitest";
import { COMMAND_CATALOG_REVISION, commandHelpText, effectiveAllowedCommands, normalizeCommandPermissions, parseCommand, parseCommandInput, resolveRoundRobin, roomCommandGuide, ROOM_COMMANDS } from "./command-domain.js";

describe("command parser", () => {
  it("parses all commands into one typed invocation model", () => {
    expect(parseCommand("hello")).toEqual({ kind: "not-command" });
    expect(parseCommand("/task")).toEqual({ kind: "command", invocation: { command: "task", prompt: "", selection: { kind: "round-robin" } } });
    expect(parseCommand("/task ship it")).toMatchObject({ kind: "command", invocation: { command: "task", prompt: "ship it", selection: { kind: "round-robin" } } });
    expect(parseCommand("/task @codex-sol ship it")).toMatchObject({ kind: "command", invocation: { command: "task", selection: { kind: "pinned", agentId: "codex-sol" } } });
    expect(parseCommand("/pov what do you think?")).toMatchObject({ kind: "command", invocation: { command: "pov" } });
    expect(parseCommand('/poll "Best path?" "A" "B"')).toEqual({ kind: "command", invocation: { command: "poll", question: "Best path?", options: ["A", "B"] } });
    expect(parseCommand("/help")).toEqual({ kind: "command", invocation: { command: "help" } });
    expect(parseCommand("  /task ship it  ")).toMatchObject({ kind: "command", invocation: { command: "task", prompt: "ship it" } });
  });

  it("keeps malformed poll failures private and friendly", () => {
    for (const input of ["/poll question A B", '/poll "Question" "Only one"', '/poll "unterminated']) {
      expect(parseCommand(input)).toMatchObject({ kind: "private-error", message: expect.stringContaining('/poll "Question"') });
    }
  });

  it("preserves explicit structured round-robin selection for mention-prefixed prompts", () => {
    expect(parseCommandInput({ command: "task", prompt: "@claude-sonnet compare this", selection: { kind: "round-robin" } })).toEqual({ kind: "command", invocation: { command: "task", prompt: "@claude-sonnet compare this", selection: { kind: "round-robin" } } });
  });
  it("parses only the five closed GitHub selector forms with canonical positive decimals",()=>{expect(parseCommand("/gh recent")).toEqual({kind:"command",invocation:{command:"gh",selector:{kind:"recent"}}});expect(parseCommand("/gh pr 98")).toMatchObject({kind:"command",invocation:{selector:{kind:"pr",number:98}}});expect(parseCommand("/gh issue 105")).toMatchObject({kind:"command",invocation:{selector:{kind:"issue",number:105}}});expect(parseCommand("/gh ci")).toMatchObject({kind:"command",invocation:{selector:{kind:"ci"}}});expect(parseCommandInput({command:"gh",selector:{kind:"ci",number:98}})).toMatchObject({kind:"command",invocation:{selector:{kind:"ci",number:98}}});for(const unsafe of ["/gh","/gh recent extra","/gh pr","/gh pr 0","/gh pr -1","/gh pr +1","/gh pr 1.0","/gh pr 1e2","/gh pr https://github.com/x/y/pull/1","/gh ci --ref=main","/gh nope 1"])expect(parseCommand(unsafe)).toMatchObject({kind:"private-error"});expect(parseCommandInput({command:"gh",selector:{kind:"pr",number:1,owner:"attacker"} as never})).toMatchObject({kind:"private-error"});});
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
  it("does not expand legacy allowAll records until an explicit catalog-v2 grant",()=>{const legacy=normalizeCommandPermissions({allowAll:true,allowed:["task","pov","poll","help"]});expect(effectiveAllowedCommands(legacy,ROOM_COMMANDS)).not.toContain("gh");expect(effectiveAllowedCommands({allowAll:true,allowed:ROOM_COMMANDS,catalogRevision:COMMAND_CATALOG_REVISION},ROOM_COMMANDS)).toContain("gh");});
  it("filters discovery, examples, and guidance to the effective catalog", () => {
    const guide = roomCommandGuide(["poll", "help"]);
    expect(guide).toContain("room_command");
    expect(guide).toContain("Never emit raw slash-command text");
    expect(guide).toContain("soft @mention");
    expect(guide).toContain("poll:");
    expect(guide).toContain("help:");
    expect(guide).not.toContain("task:");
    expect(guide).not.toContain("pov:");
    expect(commandHelpText(["help"])).toContain("Syntax: /help");
    expect(commandHelpText(["help"])).not.toContain("/task");
  });
});
