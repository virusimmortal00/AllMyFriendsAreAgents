import { describe, expect, it } from "vitest";
import { directAddressTargets } from "./direct-address.js";
import {
  DIRECT_ADDRESS_FIXTURE_AGENTS as agents,
  DIRECT_ADDRESS_FIXTURES as examples,
} from "./direct-address-fixtures.js";

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
        text: "Sol, given the fictional sign options, describe a compromise.",
        agents,
        humanNames: ["Sol"],
        speaker: "human",
      }),
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
