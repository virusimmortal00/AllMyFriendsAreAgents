import { describe, expect, it } from "vitest";
import { directAddressTargets, type DirectAddressInput } from "./direct-address.js";

const agents = [
  { agentId: "agent-sol", name: "Sol" },
  { agentId: "agent-claude", name: "Claude" },
  { agentId: "agent-grok", name: "Grok" },
  { agentId: "agent-composer", name: "Composer" },
];

// Fictional expected routing judgments. These establish a conservative
// regression boundary; they do not measure real-room recall or reply quality.
const examples: Array<{ text: string; expected: string[]; speaker?: DirectAddressInput["speaker"] }> = [
  { text: "Sol, can you take a look at this?", expected: ["agent-sol"] },
  { text: "Hey Claude, what do you think?", expected: ["agent-claude"] },
  { text: "Sol can you check the result?", expected: ["agent-sol"] },
  { text: "Claude: please review this.", expected: ["agent-claude"] },
  { text: "Sol and Claude, please compare your views.", expected: ["agent-sol", "agent-claude"] },
  { text: "Sol, Claude, and Grok, what do you think?", expected: ["agent-sol", "agent-claude", "agent-grok"] },
  { text: "What do you think, Grok?", expected: ["agent-grok"] },
  { text: "Could you explain this, Composer?", expected: ["agent-composer"] },
  { text: "Sol, thoughts?", expected: ["agent-sol"] },
  { text: "Sol is faster than Claude.", expected: [] },
  { text: "Sol has a good point.", expected: [] },
  { text: "Sol can explain this better.", expected: [] },
  { text: "Sol will review it later.", expected: [] },
  { text: "Claude said the answer was ready.", expected: [] },
  { text: "Earlier, Sol asked whether this was ready.", expected: [] },
  { text: "I agree with Grok, but Composer disagrees.", expected: [] },
  { text: "Compare the Sol and Claude models.", expected: [] },
  { text: "Does the Composer product support this?", expected: [] },
  { text: "I asked, “Sol, can you help?”", expected: [] },
  { text: "“Sol, can you help?”", expected: [] },
  { text: "> Sol, can you help?", expected: [] },
  { text: "`Sol, can you help?`", expected: [] },
  { text: "Sol?", expected: [] },
  { text: "Sol, thanks for that.", expected: [] },
  { text: "Sol, thoughts?", expected: ["agent-sol"], speaker: "agent" },
  { text: "Sol, can you check my claim?", expected: ["agent-sol"], speaker: "agent" },
];

describe("conservative direct-address recognition", () => {
  it.each(examples)("reviews $text ($speaker)", ({ text, expected, speaker }) => {
    expect(directAddressTargets({ text, agents, speaker: speaker ?? "human" })).toEqual(expected);
  });

  it("does not treat a name shared with a human or another agent as a required agent", () => {
    expect(
      directAddressTargets({ text: "Sol, can you check?", agents, humanNames: ["Sol"], speaker: "human" }),
    ).toEqual([]);
    expect(
      directAddressTargets({
        text: "Claude, can you check?",
        agents: [...agents, { agentId: "agent-second", name: "Claude" }],
        speaker: "human",
      }),
    ).toEqual([]);
  });

  it("does not resolve a disabled duplicate name to the enabled agent", () => {
    const withDisabledName = [...agents, { agentId: "agent-disabled", name: "Grok" }];
    expect(directAddressTargets({ text: "Grok, can you check?", agents: withDisabledName, speaker: "human" })).toEqual(
      [],
    );
  });
});
