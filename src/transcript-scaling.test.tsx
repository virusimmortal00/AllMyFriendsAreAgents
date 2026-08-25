import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

describe("transcript chrome", () => {
  it("uses the window title as the single persistent room title", () => {
    expect(app).not.toContain("TranscriptHeader");
    expect(app).toContain('<h1><span className="title-long">AllMyFriendsAreAgents — </span>{room.settings.roomName}</h1>');
  });
});
