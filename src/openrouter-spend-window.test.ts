import { describe, expect, it } from "vitest";
import { loadOpenRouterSpendWindow, saveOpenRouterSpendWindow } from "./openrouter-spend-window";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) || null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

describe("OpenRouter spend window preference", () => {
  it("defaults to the last 24 hours with no storage or an empty one", () => {
    expect(loadOpenRouterSpendWindow(undefined)).toBe("24h");
    expect(loadOpenRouterSpendWindow(memoryStorage())).toBe("24h");
  });

  it("persists a versioned local preference and rejects malformed values", () => {
    const storage = memoryStorage();
    saveOpenRouterSpendWindow(storage, "7d");
    expect(loadOpenRouterSpendWindow(storage)).toBe("7d");
    saveOpenRouterSpendWindow(storage, "all");
    expect(loadOpenRouterSpendWindow(storage)).toBe("all");
    storage.setItem("all-my-friends-are-agents-openrouter-spend-window", JSON.stringify({ version: 1, window: "last-decade" }));
    expect(loadOpenRouterSpendWindow(storage)).toBe("24h");
  });
});
