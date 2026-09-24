import { describe, expect, it } from "vitest";
import { followUpAddress } from "./follow-up-address.js";

const agents = [
  { agentId: "codex-sol", name: "Sol" },
  { agentId: "claude-sonnet", name: "Claude" },
  { agentId: "cursor-grok", name: "Grok" },
] as const;
const roster = agents.map(({ agentId }) => agentId);
const context = { agents, humanNames: ["Casey"] };

describe("agent follow-up address", () => {
  it.each([
    ["Claude, can you verify this?", ["claude-sonnet"]],
    ["I agree. Claude, can you verify this?", ["claude-sonnet"]],
    ["@Claude, what do you think?", ["claude-sonnet"]],
    ["Claude and Grok, compare your views.", ["claude-sonnet", "cursor-grok"]],
    ["Claude — your turn.", ["claude-sonnet"]],
    ["Everyone, please share your view.", ["claude-sonnet", "cursor-grok"]],
    ["Each of you, what concerns you?", ["claude-sonnet", "cursor-grok"]],
    ["Claude already answered.", []],
    ["As @Claude noted, the check passed.", []],
    ["The Sol and Claude models differ.", []],
    ["The Composer product is available.", []],
    ["Everyone already agreed.", []],
    ["“@Claude, can you verify this?”", []],
    ["`@Claude, can you verify this?`", []],
  ] as const)("classifies %s", (text, expected) => {
    expect(followUpAddress(text, "codex-sol", roster, context).directAgents).toEqual(expected);
  });

  it("leaves a named human request with the human, including when an agent is mentioned referentially", () => {
    expect(followUpAddress("Casey, decide whether Sol should proceed.", "claude-sonnet", roster, context)).toMatchObject({
      humanHandoff: true, directAgents: [],
    });
    expect(followUpAddress("Casey already answered.", "claude-sonnet", roster, context).humanHandoff).toBe(false);
  });

  it("treats shared aliases as ambiguous even with an @ prefix", () => {
    expect(followUpAddress("@Claude, can you verify this?", "codex-sol", roster, { agents, humanNames: ["Claude"] }).directAgents).toEqual([]);
    expect(followUpAddress("Claude, can you verify this?", "codex-sol", roster, {
      agents: [...agents, { agentId: "cursor-composer", name: "Claude" }],
    }).directAgents).toEqual([]);
  });

  it("uses an unnegated material disagreement cue in visible prose", () => {
    expect(followUpAddress("No disagreement about A. We still disagree about B.", "codex-sol", roster, context).materialDisagreement).toBe(true);
    expect(followUpAddress("No disagreement remains.", "codex-sol", roster, context).materialDisagreement).toBe(false);
    expect(followUpAddress("“I disagree with Claude.” The recap is finished.", "codex-sol", roster, context).materialDisagreement).toBe(false);
  });
});
