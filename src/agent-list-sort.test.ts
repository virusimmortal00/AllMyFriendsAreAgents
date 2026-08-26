import { describe, expect, it } from "vitest";
import { agentListGroupLabel, loadAgentListSort, saveAgentListSort, sortAgentListItems } from "./agent-list-sort";

const items = [
  { agentId: "2", alias: "Zulu", authorId: "google", providerId: "cursor" },
  { agentId: "1", alias: "Alpha", authorId: "openai", providerId: "openai" },
  { agentId: "3", alias: "Bravo", authorId: "google", providerId: "openrouter" },
];

describe("agent list presentation order", () => {
  it("sorts display copies without mutating room order", () => {
    expect(sortAgentListItems(items, "room").map(({ agentId }) => agentId)).toEqual(["2", "1", "3"]);
    expect(sortAgentListItems(items, "name").map(({ agentId }) => agentId)).toEqual(["1", "3", "2"]);
    expect(sortAgentListItems(items, "maker").map(({ agentId }) => agentId)).toEqual(["3", "2", "1"]);
    expect(sortAgentListItems(items, "provider").map(({ agentId }) => agentId)).toEqual(["2", "1", "3"]);
    expect(items.map(({ agentId }) => agentId)).toEqual(["2", "1", "3"]);
    expect(agentListGroupLabel(items[0], "maker")).toBe("Google");
  });

  it("persists a versioned local preference and rejects malformed values", () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) || null, setItem: (key: string, value: string) => { values.set(key, value); } };
    saveAgentListSort(storage, "provider");
    expect(loadAgentListSort(storage)).toBe("provider");
    values.set("all-my-friends-are-agents-agent-list-view", JSON.stringify({ version: 1, sort: "answer-order" }));
    expect(loadAgentListSort(storage)).toBe("room");
  });
});
