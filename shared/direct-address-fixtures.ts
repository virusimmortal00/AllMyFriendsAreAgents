import type { DirectAddressInput } from "./direct-address.js";

/** Fictional routing expectations, not observations of live reply quality. */
export const DIRECT_ADDRESS_FIXTURE_AGENTS = [
  { agentId: "agent-sol", name: "Sol" },
  { agentId: "agent-claude", name: "Claude" },
  { agentId: "agent-grok", name: "Grok" },
  { agentId: "agent-composer", name: "Composer" },
] as const;

export const DIRECT_ADDRESS_FIXTURES: ReadonlyArray<{
  text: string;
  expected: readonly string[];
  speaker?: DirectAddressInput["speaker"];
}> = [
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
  { text: "Claude — your turn.", expected: ["agent-claude"], speaker: "agent" },
  { text: "I agree. Sol, can you verify this?", expected: ["agent-sol"], speaker: "agent" },
  { text: "@Sol, can you verify this?", expected: ["agent-sol"], speaker: "agent" },
  { text: "As @Sol noted, the check passed.", expected: [], speaker: "agent" },
  { text: "Claude already answered.", expected: [], speaker: "agent" },
  { text: "Earlier, Sol asked whether this was ready.", expected: [], speaker: "agent" },
  { text: "I agree with Grok, but Composer disagrees.", expected: [], speaker: "agent" },
  { text: "Compare the Sol and Claude models.", expected: [], speaker: "agent" },
  { text: "Does the Composer product support this?", expected: [], speaker: "agent" },
  { text: "“Sol, can you help?”", expected: [], speaker: "agent" },
];
